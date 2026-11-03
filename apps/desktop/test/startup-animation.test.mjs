/**
 * D679 / ADR 0338: a user's own video as the boot surface.
 *
 * The animation owns the first paint of a released app, so these tests are
 * weighted towards the ways it must *not* work: a missing folder, a file that
 * escapes it, a video that never ends, a stalled boot behind an opaque mask,
 * and a reload replaying a cinematic over a window someone was using. The happy
 * path is one transition; the bounds are the feature.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  parseByteRange,
  STARTUP_ANIMATION_FIRST_FRAME_TIMEOUT_MS,
  STARTUP_ANIMATION_HOLD_HINT_MS,
  STARTUP_ANIMATION_MAX_BYTES,
  STARTUP_ANIMATION_MAX_DURATION_MS,
  STARTUP_ANIMATION_REVEAL_MS,
  STARTUP_ANIMATION_SCHEME,
  STARTUP_ANIMATION_URL,
} from "@pi-desktop/shared";
import { STARTUP_STALLED_MS } from "../src/lib/startup-watchdog.ts";
import {
  INITIAL_STARTUP_ANIMATION_STATE,
  reduceStartupAnimation,
  shouldPlayStartupAnimation,
} from "../src/lib/startup-animation.ts";
import {
  resolveStartupAnimation,
  startupAnimationDirectory,
} from "../electron/main/startup-animation.ts";
import { readAppSource } from "./helpers/source-contracts.mjs";
import { loadStyles } from "./helpers/styles.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [shell, surface, hook, css, english, chinese, settingsRow, html, preload, windowBoot, startupBoot] =
  await Promise.all([
    readAppSource(),
    read("../src/components/StartupAnimation.tsx"),
    read("../src/features/app/useStartupAnimation.ts"),
    loadStyles(),
    read("../../../packages/i18n/src/locales/en/index.ts"),
    read("../../../packages/i18n/src/locales/zh-CN/index.ts"),
    read("../src/components/settings/StartupAnimationRows.tsx"),
    read("../index.html"),
    read("../electron/preload/index.ts"),
    read("../electron/main/bootstrap/window.ts"),
    read("../electron/main/bootstrap/startup.ts"),
  ]);

async function withDataDir(run) {
  const root = await mkdtemp(join(tmpdir(), "pi-startup-animation-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const RULES = { skipWhenReady: false, ready: false };

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

test("every bound is ordered so no single one can hold the window", () => {
  // The first-frame bound must fire long before the playback bound, or a file
  // that never decodes waits out the whole animation budget.
  assert.ok(
    STARTUP_ANIMATION_FIRST_FRAME_TIMEOUT_MS < STARTUP_ANIMATION_MAX_DURATION_MS,
  );
  // The hold hint is a hint, not a bound: it has to arrive while the user is
  // still looking at black, not after the watchdog has taken over.
  assert.ok(STARTUP_ANIMATION_HOLD_HINT_MS < STARTUP_ANIMATION_MAX_DURATION_MS);
  // And the whole animation must end well inside the watchdog's stalled bound,
  // so the recovery surface is never racing a mask that is still up.
  assert.ok(
    STARTUP_ANIMATION_MAX_DURATION_MS + STARTUP_ANIMATION_REVEAL_MS <
      STARTUP_STALLED_MS,
  );
  // The reveal the feature was asked for: about a second, not a UI transition.
  assert.equal(STARTUP_ANIMATION_REVEAL_MS, 1000);
});

test("the reveal duration is one number, shared by the timer and the stylesheet", () => {
  assert.match(css, /--motion-startup-reveal:\s*1000ms;/);
  assert.match(
    css,
    /\.startup-animation \{[\s\S]*transition: opacity var\(--motion-startup-reveal\)/,
  );
});

// ---------------------------------------------------------------------------
// Phase machine
// ---------------------------------------------------------------------------

test("the reveal waits for both the video and the shell", () => {
  // The order the feature was specified in: play, then black, then fade.
  const held = reduceStartupAnimation(
    INITIAL_STARTUP_ANIMATION_STATE,
    { kind: "animation-ended", reason: "ended" },
    RULES,
  );
  assert.equal(held.phase, "hold");
  const revealing = reduceStartupAnimation(held, { kind: "shell-ready" }, RULES);
  assert.equal(revealing.phase, "reveal");
  assert.equal(
    reduceStartupAnimation(revealing, { kind: "reveal-finished" }, RULES).phase,
    "done",
  );
});

test("a boot that finished first skips the black hold entirely", () => {
  const rules = { skipWhenReady: false, ready: true };
  assert.equal(
    reduceStartupAnimation(
      INITIAL_STARTUP_ANIMATION_STATE,
      { kind: "animation-ended", reason: "ended" },
      rules,
    ).phase,
    "reveal",
  );
});

test("readiness cuts the playback short only when the user asked it to", () => {
  const playedOut = reduceStartupAnimation(
    INITIAL_STARTUP_ANIMATION_STATE,
    { kind: "shell-ready" },
    { skipWhenReady: false, ready: true },
  );
  assert.equal(playedOut.phase, "video", "the default plays to the last frame");
  const cutShort = reduceStartupAnimation(
    INITIAL_STARTUP_ANIMATION_STATE,
    { kind: "shell-ready" },
    { skipWhenReady: true, ready: true },
  );
  assert.equal(cutShort.phase, "reveal");
  assert.equal(cutShort.endReason, "ready");
});

test("every failure path ends the animation the same way a clean finish does", () => {
  for (const reason of ["error", "no-first-frame", "max-duration", "skipped"]) {
    const next = reduceStartupAnimation(
      INITIAL_STARTUP_ANIMATION_STATE,
      { kind: "animation-ended", reason },
      RULES,
    );
    assert.equal(next.phase, "hold", `${reason} must not strand the surface`);
    assert.equal(next.endReason, reason);
  }
});

test("the phase only moves forward, so a late event cannot re-cover the shell", () => {
  // A `<video>` that was abandoned on a timeout can still fire `ended`, and a
  // re-render can republish readiness. Neither may pull the mask back over a
  // window the user is already working in.
  const done = { phase: "done", endReason: "ended" };
  for (const event of [
    { kind: "animation-ended", reason: "ended" },
    { kind: "shell-ready" },
    { kind: "reveal-finished" },
  ]) {
    assert.equal(reduceStartupAnimation(done, event, RULES).phase, "done");
  }
  const revealing = { phase: "reveal", endReason: "ended" };
  assert.equal(
    reduceStartupAnimation(
      revealing,
      { kind: "animation-ended", reason: "error" },
      RULES,
    ).phase,
    "reveal",
  );
});

// ---------------------------------------------------------------------------
// Whether to play at all
// ---------------------------------------------------------------------------

test("the animation plays only for a first-paint main window that wants motion", () => {
  const descriptor = {
    fileName: "intro.webm",
    extension: "webm",
    byteLength: 10,
    skipWhenReady: false,
  };
  const base = { descriptor, surface: null, reduceMotion: false, played: false };
  assert.equal(shouldPlayStartupAnimation(base), true);
  assert.equal(
    shouldPlayStartupAnimation({ ...base, descriptor: null }),
    false,
    "no file, no animation",
  );
  assert.equal(
    shouldPlayStartupAnimation({ ...base, surface: "plugin-launcher" }),
    false,
    "a secondary renderer surface is not a launch",
  );
  assert.equal(
    shouldPlayStartupAnimation({ ...base, reduceMotion: true }),
    false,
    "reduced motion drops the animation rather than shortening it",
  );
  assert.equal(
    shouldPlayStartupAnimation({ ...base, played: true }),
    false,
    "a reload must not replay a cinematic over a window in use",
  );
});

test("the reload guard survives module re-evaluation", () => {
  // A module-level flag would reset on reload, which is the exact case the
  // guard exists for; it has to live in storage the window keeps.
  assert.match(hook, /sessionStorage/);
  assert.match(hook, /STARTUP_ANIMATION_PLAYED_KEY/);
});

test("deciding to play is idempotent, so StrictMode cannot cancel the animation", () => {
  // The decision writes the spent mark, so a second evaluation would read its
  // own write and answer "already played". `StrictMode` invokes a `useState`
  // initializer twice in development and keeps the second result, which would
  // mean the animation never appears in a development build.
  assert.match(hook, /let pageLoadVerdict: boolean \| null = null;/);
  assert.match(hook, /if \(pageLoadVerdict !== null\) return pageLoadVerdict;/);
  assert.match(hook, /useState\(\(\) => decidePlayback\(descriptor\)\)/);
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

test("discovery finds a video dropped into the startup folder", async () => {
  await withDataDir(async (dataDir) => {
    const directory = startupAnimationDirectory(dataDir);
    assert.equal(directory, join(dataDir, "startup"));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "intro.mp4"), Buffer.alloc(64, 1));
    const resolved = await resolveStartupAnimation({ dataDir, settings: null });
    assert.equal(resolved?.descriptor.fileName, "intro.mp4");
    assert.equal(resolved?.descriptor.byteLength, 64);
    // The served path is a realpath (that is what confines it to the folder),
    // so it can differ from the path that was written — on macOS `/var` is a
    // link to `/private/var`.
    assert.equal(resolved?.filePath, await realpath(join(directory, "intro.mp4")));
    assert.equal(resolved?.descriptor.skipWhenReady, false);
  });
});

test("an installation that never used the feature resolves nothing", async () => {
  await withDataDir(async (dataDir) => {
    // No folder is created on the discovery path: a data directory must not
    // grow a folder just because the app booted.
    assert.equal(await resolveStartupAnimation({ dataDir, settings: null }), null);
    await mkdir(startupAnimationDirectory(dataDir), { recursive: true });
    assert.equal(
      await resolveStartupAnimation({ dataDir, settings: null }),
      null,
      "an empty folder is the same as no folder",
    );
  });
});

test("the setting can silence a file that is present", async () => {
  await withDataDir(async (dataDir) => {
    const directory = startupAnimationDirectory(dataDir);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "intro.webm"), Buffer.alloc(8, 1));
    assert.equal(
      await resolveStartupAnimation({
        dataDir,
        settings: { startupAnimation: { enabled: false } },
      }),
      null,
    );
    // Absent means on, so dropping a file in is all it takes.
    for (const settings of [null, {}, { startupAnimation: {} }, { startupAnimation: null }]) {
      assert.ok(
        await resolveStartupAnimation({ dataDir, settings }),
        `settings ${JSON.stringify(settings)} should still play`,
      );
    }
  });
});

test("skipWhenReady reaches the descriptor the renderer reads", async () => {
  await withDataDir(async (dataDir) => {
    const directory = startupAnimationDirectory(dataDir);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "intro.webm"), Buffer.alloc(8, 1));
    const resolved = await resolveStartupAnimation({
      dataDir,
      settings: { startupAnimation: { skipWhenReady: true } },
    });
    assert.equal(resolved?.descriptor.skipWhenReady, true);
  });
});

test("a symlink out of the folder is not served", async () => {
  await withDataDir(async (dataDir) => {
    const directory = startupAnimationDirectory(dataDir);
    await mkdir(directory, { recursive: true });
    const outside = join(dataDir, "secrets.webm");
    await writeFile(outside, Buffer.alloc(16, 1));
    await symlink(outside, join(directory, "intro.webm"));
    assert.equal(
      await resolveStartupAnimation({ dataDir, settings: null }),
      null,
      "the host-owned scheme must not become a reader for arbitrary files",
    );
  });
});

test("a directory named like a video is not mistaken for one", async () => {
  await withDataDir(async (dataDir) => {
    const directory = startupAnimationDirectory(dataDir);
    await mkdir(join(directory, "nested.webm"), { recursive: true });
    assert.equal(await resolveStartupAnimation({ dataDir, settings: null }), null);
    // The real file beside it still wins, and its size is what the cap is
    // applied to (the cap itself is covered in the shared unit tests).
    await writeFile(join(directory, "intro.webm"), Buffer.alloc(1024));
    const resolved = await resolveStartupAnimation({ dataDir, settings: null });
    assert.equal(resolved?.descriptor.fileName, "intro.webm");
    assert.ok(resolved.descriptor.byteLength < STARTUP_ANIMATION_MAX_BYTES);
  });
});

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

test("media range requests are answered, and a nonsense range is not", () => {
  assert.deepEqual(parseByteRange("bytes=0-", 100), { start: 0, end: 99 });
  assert.deepEqual(parseByteRange("bytes=10-19", 100), { start: 10, end: 19 });
  // A range past the end is clamped rather than refused; Chromium asks for one.
  assert.deepEqual(parseByteRange("bytes=90-999", 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRange("bytes=-20", 100), { start: 80, end: 99 });
  assert.equal(parseByteRange(null, 100), null, "no header means a plain 200");
  assert.equal(parseByteRange("bytes=100-", 100), null, "a start past the end");
  assert.equal(parseByteRange("bytes=20-10", 100), null, "an inverted range");
  assert.equal(parseByteRange("items=0-10", 100), null, "a non-byte unit");
  assert.equal(parseByteRange("bytes=0-10,20-30", 100), null, "a multi-range");
});

test("the renderer references the animation by URL, never by path", () => {
  assert.equal(STARTUP_ANIMATION_URL, `${STARTUP_ANIMATION_SCHEME}://animation`);
  assert.match(surface, /src=\{STARTUP_ANIMATION_URL\}/);
  // A single pathless URL means nothing the page sends can select another file.
  assert.doesNotMatch(surface, /filePath|dataDir/);
  assert.match(html, /media-src [^;]*pi-startup:/);
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

test("the descriptor reaches the renderer before its first paint", () => {
  // An IPC round-trip would land after the first frame, which is the one frame
  // the animation exists to own; it travels as a creation argument like the
  // locale does.
  assert.match(windowBoot, /additionalArguments: \[[\s\S]*encodeStartupAnimationArgument/);
  assert.match(preload, /startupAnimation: decodeStartupAnimationArgument\(process\.argv\)/);
  // Narrow subpath, not the package barrel: the preload is one bundled file.
  assert.match(preload, /from "@pi-desktop\/shared\/startup-animation"/);
});

test("only the first window of the process plays the animation", () => {
  assert.match(
    windowBoot,
    /windowState\.startupAnimationPlayed\s*\?\s*null\s*:\s*windowState\.startupAnimation/,
  );
  // Claimed before the window is constructed, so a second window racing this
  // one cannot also take it.
  assert.ok(
    windowBoot.indexOf("windowState.startupAnimationPlayed = true") <
      windowBoot.indexOf("windowState.mainWindow = new BrowserWindow("),
  );
});

test("the capture rig never sees a user's animation", () => {
  // Every capture scene is a frame comparison; an animation in front of them
  // would break all of them.
  assert.match(
    startupBoot,
    /PI_DESKTOP_CAPTURE !== "1"[\s\S]*resolveStartupAnimation\(/,
  );
});

test("the animation is resolved before the window and served after app ready", () => {
  const install = startupBoot.indexOf("installStartupAnimationProtocol(");
  const resolve = startupBoot.indexOf("resolveStartupAnimation({");
  const ensure = startupBoot.indexOf("await ensureWindow()");
  assert.ok(install > 0 && resolve > install, "the handler is in place first");
  assert.ok(resolve < ensure, "the descriptor exists before the window does");
});

test("a stalled launch is never left behind the opaque mask", () => {
  // The watchdog's surfaces outrank both boot surfaces, so the phase is the
  // first thing the splash expression tests.
  assert.match(shell, /const splash =\s*startupPhase !== "starting"\s*\? null/);
  assert.match(shell, /startupAnimation\.active\s*\?\s*\(\s*<StartupAnimation/);
  // Exactly one of the three surfaces is ever mounted.
  assert.equal((shell.match(/<StartupAnimation/g) ?? []).length, 1);
  assert.equal((shell.match(/<StartupSplash/g) ?? []).length, 1);
});

test("the shell becomes operable for the whole fade, not after it", () => {
  assert.match(
    shell,
    /const showSplash = startupAnimation\.active\s*\?\s*startupAnimation\.phase !== "reveal"/,
  );
  assert.match(css, /\.startup-animation\.is-revealing \{[\s\S]*pointer-events: none;/);
});

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

test("the surface is opaque black and the video is inert and silent", () => {
  assert.match(css, /\.startup-animation \{[\s\S]*background: #000;/);
  assert.match(css, /\.startup-animation-video \{[\s\S]*object-fit: cover;/);
  // Muted: an unmuted autoplay is blocked by Chromium and hostile besides.
  assert.match(surface, /\bmuted\b/);
  assert.match(surface, /\bplaysInline\b/);
  assert.match(surface, /controls=\{false\}/);
  assert.match(surface, /tabIndex=\{-1\}/);
  assert.match(surface, /data-testid="startup-animation"/);
});

test("a boot that outlasts the video stops looking like a hang", () => {
  assert.match(surface, /holdingLong \? \(/);
  assert.match(hook, /STARTUP_ANIMATION_HOLD_HINT_MS/);
  assert.match(css, /\.startup-animation-track \{/);
});

test("reduced motion is handled in the renderer and in the stylesheet", () => {
  assert.match(hook, /prefers-reduced-motion: reduce/);
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.startup-animation \{\s*transition-duration: 0\.01ms;/,
  );
});

test("the settings rows make the folder findable and name the next launch's file", () => {
  assert.match(settingsRow, /startupAnimationStatus\(\)/);
  assert.match(settingsRow, /openStartupAnimationFolder\(\)/);
  assert.match(settingsRow, /settings\.startupAnimationNone/);
  // The sub-switch is gated by the master switch, as the sidebar rows are.
  assert.match(settingsRow, /enabled \? \(/);
  for (const key of [
    "startupAnimation",
    "startupAnimationDesc",
    "startupAnimationNone",
    "startupAnimationFolder",
    "startupAnimationSkipWhenReady",
    "startupAnimationSkipWhenReadyDesc",
  ]) {
    assert.match(english, new RegExp(`${key}:`), `en is missing ${key}`);
    assert.match(chinese, new RegExp(`${key}:`), `zh-CN is missing ${key}`);
  }
});

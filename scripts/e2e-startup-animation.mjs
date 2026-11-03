#!/usr/bin/env node
/**
 * E2E-076 (D679 / ADR 0338): the user's own video as the boot surface.
 *
 * These are the two things that cannot be checked from source. Everything else
 * about the feature is unit-testable — the chooser, the bounds, the phase
 * machine, the markup — but these two are properties of Chromium's media
 * stack, Electron's scheme privileges, and the protocol handler together:
 *
 * 1. A `<video>` in a sandboxed renderer, under the page CSP, can actually
 *    decode bytes handed to it over the host-owned `pi-startup:` scheme. A
 *    regression here turns the boot surface into a black rectangle that no
 *    source assertion would notice.
 * 2. A file `<video>` cannot play does not hold the launch. The decoder
 *    reports that case inconsistently, which is exactly why the renderer has
 *    its own bounds, and only a real launch exercises them.
 *
 * Prereqs: `pnpm --filter @pi-desktop/desktop build`, a host-core binary
 * (target/debug, target/release, or PI_DESKTOP_HOST_BIN), and `ffmpeg` on PATH
 * to generate the playable fixture.
 */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTempDataDir,
  repositoryRoot,
  resolveElectronBinary,
} from "./e2e/boot.mjs";

const root = repositoryRoot();
const { appDir, electronBinary } = resolveElectronBinary(root);

if (!existsSync(join(appDir, "out/main/index.js"))) {
  console.error("desktop app not built. Run: pnpm --filter @pi-desktop/desktop build");
  process.exit(1);
}

/** A short, genuinely decodable VP9 clip; the point is that Chromium plays it. */
function writePlayableVideo(target) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-v", "error",
      "-f", "lavfi",
      "-i", "testsrc=size=640x360:rate=24:duration=1.5",
      "-c:v", "libvpx-vp9",
      "-b:v", "300k",
      "-an",
      "-y", target,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0 || !existsSync(target)) {
    console.error("ffmpeg could not write the fixture video:", result.stderr || result.error);
    process.exit(1);
  }
  return statSync(target).size;
}

/**
 * A file that passes discovery and fails playback: the extension is accepted
 * and the size is plausible, so only the decoder can reject it. This is the
 * shape of a real bad export.
 */
function writeUnplayableVideo(target) {
  writeFileSync(target, Buffer.alloc(4096, 0x41));
  return statSync(target).size;
}

const PROBE = `(() => {
  const surface = document.querySelector('[data-testid="startup-animation"]');
  const video = surface?.querySelector("video") ?? null;
  return {
    surface: !!surface,
    splash: !!document.querySelector('[data-testid="startup-splash"]'),
    recovery: !!document.querySelector('[data-testid="startup-recovery"]'),
    shell: !!document.querySelector(".app-shell"),
    revealing: surface?.classList.contains("is-revealing") ?? false,
    src: video?.getAttribute("src") ?? null,
    readyState: video?.readyState ?? null,
    currentTime: video?.currentTime ?? null,
    error: video?.error ? video.error.code : null,
    muted: video?.muted ?? null,
  };
})()`;

function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    for (;;) {
      if (await check()) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  })();
}

/**
 * Boot the app against a throwaway data directory holding one animation, and
 * hand `run` a renderer probe. Everything is torn down on either outcome.
 */
async function withLaunch(writeFixture, run) {
  const dataDir = createTempDataDir("pi-desktop-startup-animation-");
  const userDataDir = join(dataDir, "user-data");
  mkdirSync(userDataDir, { recursive: true });
  const startupDir = join(dataDir, "startup");
  mkdirSync(startupDir, { recursive: true });
  const byteLength = writeFixture(join(startupDir, "intro.webm"));

  const env = {
    ...process.env,
    PI_DESKTOP_DATA_DIR: dataDir,
    PI_DESKTOP_START_MAXIMIZED: "0",
    ELECTRON_RENDERER_URL: "",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  // Derive the port from the pid so two runs on one machine cannot collide.
  const port = 9400 + (process.pid % 200) + (writeFixture === writePlayableVideo ? 0 : 1);
  const child = spawn(
    electronBinary,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, "."],
    { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-6000); });
  child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-6000); });

  let ws = null;
  try {
    let target;
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`app exited early:\n${output}`);
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find(
          (entry) =>
            entry.type === "page" &&
            entry.url.includes("index.html") &&
            !entry.url.includes("plugin-launcher"),
        );
        return !!target;
      } catch {
        return false;
      }
    }, 40_000, "the desktop CDP target");

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await once(ws, "open");
    let sequence = 0;
    const pending = new Map();
    ws.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    };
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP ${method} timed out`));
        }, 15_000);
        timer.unref();
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params }));
      });
    const probe = async () => {
      const result = await send("Runtime.evaluate", {
        expression: PROBE,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(`probe failed: ${JSON.stringify(result.exceptionDetails)}`);
      }
      return result.result.value;
    };
    return await run({ probe, byteLength });
  } finally {
    try { ws?.close(); } catch {}
    try { child.kill("SIGKILL"); } catch {}
    if (process.env.PI_DESKTOP_KEEP_TEMP !== "1") {
      try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    }
  }
}

async function playableScenario() {
  await withLaunch(writePlayableVideo, async ({ probe, byteLength }) => {
    console.log(`playable fixture: ${byteLength} bytes`);

    // `readyState >= 2` means Chromium has frames for the current position,
    // which is only true if `pi-startup:` served playable bytes under the CSP.
    let decoded = null;
    await waitFor(async () => {
      const state = await probe();
      if (state.error) throw new Error(`the <video> reported error code ${state.error}`);
      if (state.readyState !== null && state.readyState >= 2) {
        decoded = state;
        return true;
      }
      return false;
    }, 20_000, "the boot animation to decode its first frames");

    if (!decoded.surface) throw new Error("the animation surface was not mounted");
    if (decoded.splash) throw new Error("the brand splash was mounted alongside the animation");
    if (decoded.src !== "pi-startup://animation") {
      throw new Error(`the <video> src was ${decoded.src}, not the host-owned URL`);
    }
    if (decoded.muted !== true) throw new Error("the boot animation was not muted");
    console.log(`PASS decode — readyState ${decoded.readyState}`);

    // The clock advances, so the stream is really playing rather than stuck on
    // one buffered frame.
    const startedAt = decoded.currentTime ?? 0;
    await waitFor(async () => {
      const state = await probe();
      if (!state.surface) return true; // already finished and revealed
      return (state.currentTime ?? 0) > startedAt;
    }, 10_000, "playback to advance");
    console.log("PASS playback — the stream advances");

    await waitFor(async () => {
      const state = await probe();
      if (state.recovery) throw new Error("the launch stalled into the recovery surface");
      return !state.surface && state.shell;
    }, 30_000, "the animation to reveal the shell");
    console.log("PASS reveal — the shell owns the window");
  });
}

async function unplayableScenario() {
  await withLaunch(writeUnplayableVideo, async ({ probe }) => {
    // The whole point: a bad export must cost at most the first-frame bound
    // (2s) plus the reveal (1s), not the watchdog's 180s. The allowance here is
    // boot time plus a wide margin, and it must stay far below that bound.
    const startedAt = Date.now();
    await waitFor(async () => {
      const state = await probe();
      if (state.recovery) throw new Error("an unplayable file stalled the launch");
      return !state.surface && state.shell;
    }, 45_000, "an unplayable animation to yield the shell");
    console.log(`PASS unplayable — the shell took over in ${Date.now() - startedAt}ms`);
  });
}

try {
  await playableScenario();
  await unplayableScenario();
} catch (error) {
  console.error("FAIL startup-animation —", error.message);
  process.exit(1);
}
console.log("startup animation E2E passed");
process.exit(0);

/**
 * Mid-Autumn easter egg contract.
 *
 * Two layers are covered:
 *
 * 1. The pure timeline / poem-schedule modules, which carry the timing that was
 *    tuned by hand: the moon rises 1.5x slower than the baseline while the
 *    mooncake rain, the assembly and the poem keep their own fixed rhythm, and
 *    several poem pairs float on screen at unfixed positions.
 * 2. The renderer wiring: a once-only launch gate that waits for the existing
 *    startup splash to finish, a settings row that replays it, and the assets
 *    that ship with the feature.
 *
 * All user-visible copies go through i18n, so the catalogue keys are part of
 * the contract as well.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import {
  DEFAULT_MID_AUTUMN_EGG_CONFIG,
  createMidAutumnEggPhases,
} from "../src/features/mid-autumn-egg/timeline.ts";

const featureDir = new URL("../src/features/mid-autumn-egg/", import.meta.url);
const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

const overlaySource = read("../src/features/mid-autumn-egg/MidAutumnEggOverlay.tsx");
const hostSource = read("../src/features/mid-autumn-egg/MidAutumnEggHost.tsx");
const sceneSource = read("../src/features/mid-autumn-egg/scene.ts");
const preferencesSource = read("../src/lib/mid-autumn-egg-preferences.ts");
const storeSource = read("../src/stores/mid-autumn-egg-store.ts");
const settingsPageSource = read("../src/features/settings/SettingsPage.tsx");
const appShellSource = read("../src/features/app/AppShell.tsx");

/* ------------------------------------------------------------------ *
 * Timeline
 * ------------------------------------------------------------------ */

test("a slow moon does not change the mooncake rain rhythm", () => {
  const baseline = createMidAutumnEggPhases({
    ...DEFAULT_MID_AUTUMN_EGG_CONFIG,
    moonSpeed: 1,
  });
  const slowed = createMidAutumnEggPhases(DEFAULT_MID_AUTUMN_EGG_CONFIG);

  // The moon rise is the only phase that scales.
  assert.equal(slowed.rise, baseline.rise * DEFAULT_MID_AUTUMN_EGG_CONFIG.moonSpeed);
  assert.equal(slowed.rise.toFixed(3), "1.575");
  assert.equal(baseline.rise.toFixed(3), "1.050");

  assert.equal(slowed.spawnDuration, baseline.spawnDuration);
  assert.equal(slowed.flyStagger, baseline.flyStagger);
  const round = (value) => Number(value.toFixed(3));
  assert.equal(
    round(slowed.rainEnd - slowed.rainStart),
    round(baseline.rainEnd - baseline.rainStart),
  );
  assert.equal(slowed.flyDuration, baseline.flyDuration);
  assert.equal(slowed.poemFade, baseline.poemFade);
  assert.equal(
    Number((slowed.rainStart - baseline.rainStart).toFixed(3)),
    Number((slowed.rise - baseline.rise).toFixed(3)),
  );
});

test("the phases keep the hand-tuned absolute timeline", () => {
  const phases = createMidAutumnEggPhases(DEFAULT_MID_AUTUMN_EGG_CONFIG);

  assert.equal(phases.hold, 0.25);
  assert.equal(phases.rainStart.toFixed(3), "1.825");
  assert.equal(phases.spawnDuration.toFixed(3), "1.200");
  assert.equal(phases.rainEnd.toFixed(3), "3.575");
  assert.equal(phases.flyStart.toFixed(3), "4.025");
  assert.equal(phases.done.toFixed(3), "5.325");
  assert.equal(phases.poemStart.toFixed(3), "4.975");
  assert.equal(phases.skyIn, 0.9);

  // All 520 mooncakes are spawned inside the spawn window.
  assert.equal(phases.rainRate.toFixed(3), (DEFAULT_MID_AUTUMN_EGG_CONFIG.cakes / 1.2).toFixed(3));

  // The text is assembled after the rain has landed, and the poem follows it.
  assert.ok(phases.spawnDuration < phases.rainEnd - phases.rainStart);
  assert.ok(phases.flyStart > phases.rainEnd);
  assert.ok(phases.poemStart < phases.done);
});

test("the poem data ships as vertical pairs with a famous closing pair", () => {
  const pairs = DEFAULT_MID_AUTUMN_EGG_CONFIG.poemPairs;

  assert.ok(pairs.length >= 8);
  for (const [leading, answering] of pairs) {
    assert.ok(leading.length > 0 && answering.length > 0);
    // Vertical columns stay inside the reserved height on a small viewport.
    assert.ok(Math.max(leading.length, answering.length) <= 7);
  }
  assert.deepEqual(pairs.at(-1), ["但愿人长久", "千里共婵娟"]);
});

/* ------------------------------------------------------------------ *
 * Poem schedule
 *
 * The scheduler imports its layout constants through the repo's extensionless
 * specifier convention, which node:test cannot resolve by itself, so its
 * contract is pinned at the source level here. The runtime behaviour (several
 * pairs on screen at once, at unfixed positions, cycling in a random order) is
 * verified by the screenshot harness described in the pull request.
 * ------------------------------------------------------------------ */

const poemScheduleSource = read("../src/features/mid-autumn-egg/poem-schedule.ts");

test("the poem scheduler is seeded, lane-capped and cyclic", () => {
  // A fixed seed is what keeps the layout reproducible for a given viewport.
  assert.match(poemScheduleSource, /createSeededRandom\(POEM_SEED\)/);
  assert.match(poemScheduleSource, /1664525/);
  assert.match(poemScheduleSource, /1013904223/);

  // Concurrency is bounded by lanes, and the table loops instead of growing.
  assert.match(poemScheduleSource, /maxPairs/);
  assert.match(poemScheduleSource, /cycle/);

  // Every scheduled appearance owns its lifetime, placement and drift.
  for (const field of ["start", "end", "centerX", "centerY", "drift", "fontSize"]) {
    assert.match(poemScheduleSource, new RegExp(`\\b${field}\\b`));
  }

  // Placements come from the seeded stream, not from a fixed slot table.
  assert.match(poemScheduleSource, /random\(\)/);
  assert.match(poemScheduleSource, /pairs\.map/);
});

test("the schedule keeps every pair as two vertical columns", () => {
  assert.match(poemScheduleSource, /Array\.from\(leading\)/);
  assert.match(poemScheduleSource, /Array\.from\(answering\)/);
  assert.match(poemScheduleSource, /columns/);
});

/* ------------------------------------------------------------------ *
 * Assets
 * ------------------------------------------------------------------ */

test("the two artwork assets ship as webp", () => {
  const assets = new URL("../src/assets/", import.meta.url);

  for (const name of ["mid-autumn-moon.webp", "mid-autumn-cake.webp"]) {
    const file = new URL(name, assets);
    assert.ok(existsSync(file), `${name} must exist`);
    const bytes = readFileSync(file);
    assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(bytes.subarray(8, 12).toString("ascii"), "WEBP");
    assert.ok(bytes.length > 4096, `${name} looks like a real image`);
  }

  // The animation must not carry base64 artwork or an embedded html document.
  assert.equal(sceneSource.includes("data:image"), false);
  assert.equal(sceneSource.includes("srcdoc"), false);
  assert.equal(overlaySource.includes("iframe"), false);
  assert.equal(overlaySource.includes("data:image"), false);
  assert.equal(readdirSync(featureDir).some((name) => name.endsWith(".html")), false);
});

/* ------------------------------------------------------------------ *
 * Once-only launch gate
 * ------------------------------------------------------------------ */

test("the seen flag is a guarded renderer preference", () => {
  assert.match(preferencesSource, /pi\.desktop\.midAutumnEggSeen/);
  assert.match(preferencesSource, /export function hasSeenMidAutumnEgg\(\): boolean/);
  assert.match(preferencesSource, /export function markMidAutumnEggSeen\(\): void/);
  // Storage access must never throw into the app.
  assert.match(preferencesSource, /catch\s*\{/);
  assert.equal(/window\.localStorage/.test(preferencesSource), false);
});

test("the launch gate waits for the existing startup splash", () => {
  // The gate is explicit about both signals instead of racing the splash.
  assert.match(hostSource, /ready/);
  assert.match(hostSource, /showSplash/);
  assert.match(hostSource, /hasSeenMidAutumnEgg\(\)/);
  assert.match(hostSource, /markMidAutumnEggSeen\(\)/);
  // Marking before showing is what makes it a single automatic playback.
  assert.ok(
    hostSource.indexOf("markMidAutumnEggSeen()") < hostSource.indexOf("showMidAutumnEgg()"),
    "the flag must be written before the overlay opens",
  );
  // It must not touch or replace the boot/loading surface.
  assert.equal(/StartupSplash|setSplashPhase|splashPhase/.test(hostSource), false);
  assert.equal(hostSource.includes("any"), false);
  assert.match(appShellSource, /<MidAutumnEggHost[^>]*showSplash=\{showSplash\}/);
});

test("the overlay is dismissible from its top-right corner", () => {
  assert.match(overlaySource, /role="dialog"/);
  assert.match(overlaySource, /aria-modal/);
  assert.match(overlaySource, /settings\.closeEasterEgg/);
  assert.match(overlaySource, /Escape/);
  assert.match(overlaySource, /createMidAutumnEggScene\(/);
  assert.match(overlaySource, /\.destroy\(\)/);
  assert.match(overlaySource, /mid-autumn-moon\.webp/);
  assert.match(overlaySource, /mid-autumn-cake\.webp/);
  assert.equal(overlaySource.includes(": any"), false);
});

/* ------------------------------------------------------------------ *
 * Replay from settings
 * ------------------------------------------------------------------ */

test("settings exposes the egg and replays it through the store", () => {
  assert.match(storeSource, /useMidAutumnEggStore/);
  for (const field of ["open", "show", "hide"]) assert.match(storeSource, new RegExp(field));
  assert.match(settingsPageSource, /settings\.easterEggs/);
  assert.match(settingsPageSource, /settings\.midAutumnEgg/);
  assert.match(settingsPageSource, /settings\.playMidAutumnEgg/);
  assert.match(settingsPageSource, /useMidAutumnEggStore/);
});

test("every catalogue carries the easter egg strings", () => {
  const locales = readdirSync(new URL("../../../packages/i18n/src/locales/", import.meta.url), {
    withFileTypes: true,
  }).filter((entry) => entry.isDirectory());

  assert.ok(locales.length >= 8);
  for (const locale of locales) {
    const catalogue = readFileSync(
      new URL(`../../../packages/i18n/src/locales/${locale.name}/index.ts`, import.meta.url),
      "utf8",
    );
    for (const key of [
      "easterEggs",
      "midAutumnEgg",
      "midAutumnEggDesc",
      "playMidAutumnEgg",
      "closeEasterEgg",
    ]) {
      assert.match(catalogue, new RegExp(`\\b${key}\\b`), `${locale.name} is missing ${key}`);
    }
  }
});

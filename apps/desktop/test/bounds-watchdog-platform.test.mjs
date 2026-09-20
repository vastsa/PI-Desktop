/**
 * The Stage Manager bounds watchdog is macOS-only (D447).
 *
 * Behavioral: the platform rule is the whole decision — macOS keeps the
 * recovery watchdog, every other platform turns it off.
 *
 * Contract: `createWindow` clears the interval before it can read CG bounds or
 * re-layer the window, so no platform other than macOS repeats a
 * `setAlwaysOnTop(false)` that a window manager answers by raising the window.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readMainModule } from "./helpers/source-contracts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const windowSource = await readMainModule("bootstrap/window.ts");

/** The `boundsWatchdog` interval body, from its `setInterval` to its closing. */
function watchdogBody() {
  // The source used to be a bare `const boundsWatchdog = setInterval(...)`;
  // it became `const boundsWatchdog: NodeJS.Timeout | null =
  // process.platform === "darwin" ? setInterval(...) : null` when the watchdog
  // stopped being registered on non-macOS platforms. Anchor on `setInterval(`
  // after the declaration so either form is accepted.
  const declaration = windowSource.indexOf("const boundsWatchdog");
  assert.notEqual(declaration, -1, "the bounds watchdog interval must exist");
  const start = windowSource.indexOf("setInterval(", declaration);
  assert.notEqual(start, -1, "the bounds watchdog must use setInterval");
  const end = windowSource.indexOf("}, 1500)", start);
  assert.notEqual(end, -1, "the watchdog must keep its 1500ms cadence");
  return windowSource.slice(start, end);
}

test("the bounds watchdog turns itself off outside macOS", () => {
  const body = watchdogBody();
  const guard = body.indexOf('if (process.platform !== "darwin")');
  assert.notEqual(guard, -1, "the watchdog must be gated on darwin");
  // The guard has to clear the interval, or it keeps ticking forever.
  const guardBlock = body.slice(guard, body.indexOf("const cg = readCgBounds();", guard));
  assert.match(guardBlock, /clearInterval\(boundsWatchdog\);/);
  assert.match(guardBlock, /return;/);
  // And it has to run before the watchdog can touch the window layer, which is
  // what Mutter answers by raising the window.
  assert.ok(
    guard < body.indexOf("setAlwaysOnTop(false)"),
    "the platform guard must precede the always-on-top reset",
  );
  assert.ok(
    guard < body.indexOf("ensureStableBounds(true)"),
    "the platform guard must precede shelf recovery",
  );
  // macOS keeps the Stage Manager path intact (D039, D053, D083).
  assert.match(body, /readCgBounds\(\)/);
  assert.match(body, /ensureStableBounds\(true\)/);
});

test("no other platform path re-layers the window on a timer", () => {
  // A repeating timer that clears the always-on-top layer is exactly what
  // Mutter turns into a raise, so it may only exist behind the darwin guard.
  const intervals = windowSource.split("setInterval(").slice(1);
  for (const chunk of intervals) {
    if (!chunk.includes("setAlwaysOnTop")) continue;
    assert.match(
      windowSource,
      /if \(process\.platform !== "darwin"\) \{\s*(?:if \(boundsWatchdog\) )?clearInterval\(boundsWatchdog\);\s*return;\s*\}/,
      "a window-layer timer must be macOS-only",
    );
  }
});

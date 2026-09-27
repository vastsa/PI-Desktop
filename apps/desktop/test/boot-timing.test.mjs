import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, join } from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const {
  BootTiming,
  raceWithTimeout,
  timingMessage,
  UPDATE_CHECK_TIMEOUT_CODE,
} = await import("../electron/main/boot-timing.ts");

test("timingMessage is greppable like sidecar [timing] lines", () => {
  assert.equal(
    timingMessage("boot", "host", { elapsedMs: 12, durationMs: 9, ok: true }),
    "[timing] kind=boot phase=host elapsedMs=12 durationMs=9 ok=true",
  );
});

test("BootTiming records elapsed-from-start and per-phase duration", async () => {
  const lines = [];
  const clock = new BootTiming((message, data) => {
    lines.push({ message, data });
  }, 1_000);
  clock.mark("when-ready");
  await clock.span("host", async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.match(lines[0].message, /phase=when-ready/);
  assert.equal(lines[0].data.kind, "boot");
  assert.ok(lines[0].data.elapsedMs >= 0);
  assert.match(lines[1].message, /phase=host/);
  assert.equal(lines[1].data.ok, true);
  assert.ok(lines[1].data.durationMs >= 15);
});

test("BootTiming marks failed spans without swallowing the error", async () => {
  const lines = [];
  const clock = new BootTiming((message) => lines.push(message));
  await assert.rejects(
    clock.span("sidecar", async () => {
      throw new Error("spawn failed");
    }),
    /spawn failed/,
  );
  assert.match(lines[0], /phase=sidecar .*ok=false/);
});

test("raceWithTimeout settles without cancelling the slower work", async () => {
  let finished = false;
  const slow = new Promise((resolve) => {
    setTimeout(() => {
      finished = true;
      resolve("late");
    }, 40);
  });
  await assert.rejects(raceWithTimeout(slow, 5, "update check"), (error) => {
    assert.equal(error.code, UPDATE_CHECK_TIMEOUT_CODE);
    assert.match(error.message, /update check timed out/);
    return true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(finished, true);
});

test("main boot path records the spans needed to diagnose a blank first window", async () => {
  const mainSource = await readFile(
    new URL("../electron/main/index.ts", import.meta.url),
    "utf8",
  );
  for (const phase of [
    "when-ready",
    "host",
    "sidecar",
    "plugin-restore",
    "window-created",
    "window-loaded",
    "window-shown",
    "window-ready",
    "backends-ready",
  ]) {
    assert.match(mainSource, new RegExp(`"${phase}"`), phase);
  }
  assert.doesNotMatch(mainSource, /readSystemClipboard|clipboardHistory\.start|clipboardHistory\.stop/);
  assert.doesNotMatch(mainSource, /phase=clipboard|availableFormats\(\)|clipboard\.readImage\(\)/);
  assert.match(
    mainSource,
    /const pluginStarted = Date.now\(\);\s*try \{/,
    "plugin restore duration must be in scope for both success and failure marks",
  );
});

test("renderer bootstrap emits a greppable boot timing line", async () => {
  const storeSource = await readFile(
    new URL("../src/stores/app-store.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    storeSource,
    /\[timing\] kind=boot phase=renderer-bootstrap durationMs=/,
  );
});

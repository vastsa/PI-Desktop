import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const temp = await mkdtemp(join(tmpdir(), "pi-lifecycle-dialog-broker-"));
after(async () => rm(temp, { recursive: true, force: true }));
const bundlePath = join(temp, "lifecycle-dialog.mjs");
await build({
  entryPoints: [join(root, "apps/desktop/electron/main/bootstrap/lifecycle-dialog.ts")],
  outfile: bundlePath,
  bundle: true,
  platform: "node",
  format: "esm",
});
const { createLifecycleDialogBroker } = await import(pathToFileURL(bundlePath).href);

function createBroker() {
  const scheduled = [];
  const cancelled = [];
  const errors = [];
  let sequence = 0;
  const broker = createLifecycleDialogBroker({
    createRequestId: () => `request-${++sequence}`,
    schedule(callback) {
      const timer = { callback };
      scheduled.push(timer);
      return timer;
    },
    cancelSchedule(timer) {
      cancelled.push(timer);
    },
    onError(error) {
      errors.push(error);
    },
  });
  return { broker, scheduled, cancelled, errors };
}

const options = (overrides = {}) => ({
  windowId: 17,
  kind: "quit-confirmation",
  send() {},
  dismiss() {},
  fallback: async () => "cancel",
  ...overrides,
});

test("uses native fallback until the main renderer has acknowledged readiness", async () => {
  const { broker } = createBroker();
  let sent = false;
  let fallbackCount = 0;
  let dismissCount = 0;
  const result = await broker.request(options({
    send() { sent = true; },
    dismiss() { dismissCount += 1; },
    fallback: async () => { fallbackCount += 1; return "cancel"; },
  }));
  assert.equal(result, "cancel");
  assert.equal(sent, false);
  assert.equal(fallbackCount, 1);
  assert.equal(dismissCount, 0);
});

test("accepts only a valid response from the requesting renderer", async () => {
  const { broker, scheduled, cancelled } = createBroker();
  broker.markReady(17);
  let emitted;
  const pending = broker.request(options({ send(request) { emitted = request; } }));
  assert.deepEqual(emitted, { requestId: "request-1", kind: "quit-confirmation" });
  assert.equal(broker.respond(99, emitted.requestId, "confirm"), false);
  assert.equal(broker.respond(17, emitted.requestId, "tray"), false);
  assert.equal(broker.respond(17, emitted.requestId, "cancel"), true);
  assert.equal(await pending, "cancel");
  assert.deepEqual(cancelled, [scheduled[0]]);
});

test("dismisses stale renderer UI and falls back on timeout or process loss", async () => {
  const timed = createBroker();
  timed.broker.markReady(17);
  let timeoutFallbacks = 0;
  let timedDismissed;
  const timeoutResult = timed.broker.request(options({
    dismiss(requestId) { timedDismissed = requestId; },
    fallback: async () => { timeoutFallbacks += 1; return "confirm"; },
  }));
  timed.scheduled[0].callback();
  assert.equal(await timeoutResult, "confirm");
  assert.equal(timeoutFallbacks, 1);
  assert.equal(timedDismissed, "request-1");
  assert.equal(timed.broker.respond(17, "request-1", "cancel"), false);

  const crashed = createBroker();
  crashed.broker.markReady(17);
  let crashFallbacks = 0;
  let crashDismissed;
  const crashResult = crashed.broker.request(options({
    kind: "close-behavior",
    dismiss(requestId) { crashDismissed = requestId; },
    fallback: async () => { crashFallbacks += 1; return "quit"; },
  }));
  crashed.broker.markUnavailable(17);
  assert.equal(await crashResult, "quit");
  assert.equal(crashFallbacks, 1);
  assert.equal(crashDismissed, "request-1");
});

test("fails open and records an unusable native fallback", async () => {
  const { broker, errors } = createBroker();
  const result = await broker.request(options({
    fallback: async () => { throw new Error("native dialog unavailable"); },
  }));
  assert.equal(result, "confirm");
  assert.equal(errors.length, 1);
});

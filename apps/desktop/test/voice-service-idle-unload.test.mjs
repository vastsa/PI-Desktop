import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { StubVoiceController } from "./helpers/voice-runtime-stub.mjs";

// Redirect `electron` / `@pi-desktop/voice-runtime` to stubs and esbuild-
// transform the service's TypeScript so it runs on this realm's ESM pipeline,
// where the fake clock below can intercept its timers.
register(
  new URL("./helpers/voice-service-stubs-hook.mjs", import.meta.url).href,
);

const { VoiceService } = await import("../electron/main/voice-service.ts");

const MODEL_IDLE_UNLOAD_MS = 10 * 60 * 1000;

// Manual fake clock for the idle-unload timer.
function fakeClock(t) {
  const pending = new Map();
  let now = 0;
  let seq = 0;
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    seq += 1;
    pending.set(seq, { callback, at: now + (delay ?? 0) });
    return { id: seq, ref() {}, unref() {}, hasRef: () => true };
  });
  t.mock.method(globalThis, "clearTimeout", (handle) => {
    pending.delete(handle?.id);
  });
  return {
    advance(ms) {
      now += ms;
      for (const [id, job] of [...pending.entries()]) {
        if (job.at <= now) {
          pending.delete(id);
          job.callback();
        }
      }
    },
  };
}

async function startedService(t) {
  const clock = fakeClock(t);
  const service = new VoiceService("unused-model-cache-dir", () => null);
  await service.start();
  const controller = StubVoiceController.last;
  assert.ok(controller, "stub controller was constructed");
  return { service, controller, modelManager: controller.modelManager, clock };
}

test("unloads the model one idle window after a recording settles in a terminal phase", async (t) => {
  const { service, modelManager, clock } = await startedService(t);

  await service.stop(); // → phase "done", schedules the idle unload
  assert.equal(modelManager.unloadCalls, 0);

  clock.advance(MODEL_IDLE_UNLOAD_MS - 1);
  assert.equal(modelManager.unloadCalls, 0, "must not unload early");

  clock.advance(1);
  assert.equal(modelManager.unloadCalls, 1);
});

test("an error phase schedules the idle unload as well", async (t) => {
  const { controller, modelManager, clock } = await startedService(t);

  controller.setPhase("error");
  clock.advance(MODEL_IDLE_UNLOAD_MS);
  assert.equal(modelManager.unloadCalls, 1);
});

test("starting the next recording cancels the pending idle unload", async (t) => {
  const { service, controller, modelManager, clock } = await startedService(t);

  await service.stop(); // schedules the unload
  clock.advance(MODEL_IDLE_UNLOAD_MS - 60 * 1000);
  controller.setPhase("idle"); // renderer acknowledged the result
  await service.start(); // new recording cancels the pending timer

  clock.advance(MODEL_IDLE_UNLOAD_MS * 2);
  assert.equal(
    modelManager.unloadCalls,
    0,
    "unload must stay cancelled while recording",
  );

  // Once that recording settles, the timer arms again.
  await service.stop();
  clock.advance(MODEL_IDLE_UNLOAD_MS);
  assert.equal(modelManager.unloadCalls, 1);
});

test("a rejected next start re-arms the idle unload", async (t) => {
  const { service, controller, modelManager, clock } = await startedService(t);

  await service.stop();
  controller.start = async () => {
    throw new Error("fixture start failure");
  };

  await assert.rejects(service.start(), /fixture start failure/);
  clock.advance(MODEL_IDLE_UNLOAD_MS);
  assert.equal(modelManager.unloadCalls, 1);
});

test("a recording that began after scheduling is never interrupted by the unload", async (t) => {
  const { service, controller, modelManager, clock } = await startedService(t);

  await service.stop(); // schedules the unload
  // A new recording reaches "listening" without passing through
  // service.start() (a race with the renderer); the callback must re-check
  // the live phase and skip the unload.
  controller.setPhase("listening");
  clock.advance(MODEL_IDLE_UNLOAD_MS * 2);
  assert.equal(modelManager.unloadCalls, 0);
});

test("dispose cancels the pending idle unload and cannot re-arm it", async (t) => {
  const { service, modelManager, clock } = await startedService(t);

  await service.stop(); // schedules the unload
  service.dispose(); // also drives the controller's idle stateChange
  clock.advance(MODEL_IDLE_UNLOAD_MS * 2);
  assert.equal(modelManager.unloadCalls, 0);
});

test("cancel() from an idle phase still schedules exactly one idle unload", async (t) => {
  const { service, controller, modelManager, clock } = await startedService(t);

  controller.setPhase("idle"); // schedules once
  service.cancel(); // idle cancel emits no fresh terminal stateChange in real code; re-scheduling is idempotent
  clock.advance(MODEL_IDLE_UNLOAD_MS);
  assert.equal(modelManager.unloadCalls, 1);
});

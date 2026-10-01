import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { binding, dependencies, loadModules, owner } from "./helpers/live-voice-service-fixture.mjs";

function trackTimers(t) {
  const scheduled = new Set();
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    const handle = set(() => {
      scheduled.delete(handle);
      callback(...args);
    }, delay);
    scheduled.add(handle);
    return handle;
  });
  t.mock.method(globalThis, "clearTimeout", (handle) => {
    scheduled.delete(handle);
    clear(handle);
  });
  return scheduled;
}

async function prepare(service, workTarget) {
  const status = await service.status();
  return service.prepare(owner, {
    requestId: randomUUID(),
    bindingId: binding.id,
    expectedSettingsRevision: status.settingsRevision,
    initialMuted: true,
    ...(workTarget ? { workTarget } : {}),
  });
}

test("twenty connect, failure, owner-loss and disable cycles release Main resources and pending controls", async (t) => {
  const { LiveCallService, MicrophoneLeaseRegistry } = await loadModules(t);
  const timers = trackTimers(t);
  const leases = new MicrophoneLeaseRegistry(() => false);
  const workScopes = new Set();
  const backgroundLeases = new Set();
  const activeAdapters = new Set();
  const released = [];
  let cycle = 0;
  let service;
  const { deps, state } = dependencies({
    acquireMicrophone: (callId) => {
      const release = leases.acquire("live", callId);
      return () => { release(); released.push(callId); };
    },
    acquireBackgroundThrottlingLease: (callId) => {
      backgroundLeases.add(callId);
      return () => backgroundLeases.delete(callId);
    },
    resolveWorkBinding: async (target) => ({ ...target, workBindingRevision: 1, label: "Fixture work" }),
    openWorkScope: (callId) => workScopes.add(callId),
    closeWorkScope: (callId) => workScopes.delete(callId),
    receiveWorkCandidate: async () => undefined,
    createAdapter: (context) => {
      state.adapters.push(context);
      activeAdapters.add(context.callId);
      return {
        adapterId: "codex-live", mediaKind: "webrtc",
        connect: async () => {
          if (cycle % 5 === 1) throw Object.assign(new Error("fixture handshake failed"), { errorCode: "LIVE_NETWORK_ERROR" });
          return { answerSdp: "v=0\r\n" };
        },
        close: async () => activeAdapters.delete(context.callId),
      };
    },
    sendControl: (_owner, control) => {
      state.controls.push(control);
      if (control.kind === "release-media") {
        queueMicrotask(() => service.reportMedia(owner, { callId: control.callId, kind: "released" }));
      }
    },
  });
  service = new LiveCallService(deps);
  t.after(() => service.endForLifecycle("app-quit", owner, true));
  for (cycle = 0; cycle < 20; cycle += 1) {
    state.settings.liveVoice.enabled = true;
    const prepared = await prepare(service, { workSessionId: "fixture-session", contextEnabled: false });
    const connecting = service.connect(owner, { callId: prepared.callId, offerSdp: "v=0\r\n" });
    if (cycle % 5 === 1) {
      await assert.rejects(connecting, { errorCode: "LIVE_NETWORK_ERROR" });
    } else {
      await connecting;
      service.reportMedia(owner, { callId: prepared.callId, kind: "microphone-active", active: true });
      service.reportMedia(owner, { callId: prepared.callId, kind: "phase", phase: "connected" });
      service.reportMedia(owner, { callId: prepared.callId, kind: "playback-activity", active: false, ready: true });
      service.notifyWorkOperation(prepared.callId, {
        operationId: `operation-${cycle}`, admission: "accepted", execution: "queued", queueEntryId: `queue-${cycle}`,
      }, `delegation-${cycle}`);
      const navigation = service.navigateWorkSession(prepared.callId, "fixture-session")
        .then(() => "unexpected success", (error) => error.errorCode);
      if (cycle % 5 === 2) await service.endForLifecycle("renderer-gone", owner, true);
      else if (cycle % 5 === 3) await service.invalidateProvider(binding.providerId);
      else if (cycle % 5 === 4) {
        state.settings.liveVoice.enabled = false;
        await service.settingsWritten(state.settings);
      } else await service.end(owner, { callId: prepared.callId, reason: "user-ended" });
      assert.equal(await navigation, "LIVE_STALE_CALL");
    }
    assert.equal(leases.isHeld(), false, `cycle ${cycle}: microphone released`);
    assert.equal(service.hasMicrophoneReservation(owner), false);
    assert.equal(backgroundLeases.size, 0);
    assert.equal(activeAdapters.size, 0);
    assert.equal(workScopes.size, 0);
    assert.equal(timers.size, 0, `cycle ${cycle}: all service deadlines, heartbeats and feedback timers cleared`);
    assert.equal(released.length, cycle + 1);
    assert.equal(state.adapters.at(-1).signal.aborted, true);
    const events = state.events.length;
    state.adapters.at(-1).onEvent({ kind: "activity", assistantSpeaking: true });
    assert.equal(state.events.length, events, "closed adapter events cannot update the UI");
  }
});

test("invalidating a different coding provider leaves Live connected and selected-provider invalidation closes it", async (t) => {
  const { LiveCallService } = await loadModules(t);
  let service;
  const { deps, state, provider } = dependencies({
    sendControl: (_owner, control) => {
      state.controls.push(control);
      if (control.kind === "release-media") {
        queueMicrotask(() => service.reportMedia(owner, { callId: control.callId, kind: "released" }));
      }
    },
  });
  service = new LiveCallService(deps);
  t.after(() => service.endForLifecycle("app-quit", owner, true));
  const prepared = await prepare(service);
  await service.connect(owner, { callId: prepared.callId, offerSdp: "v=0\r\n" });
  service.reportMedia(owner, { callId: prepared.callId, kind: "phase", phase: "connected" });
  await service.invalidateProvider("different-coding-provider");
  assert.equal((await service.status()).call.phase, "connected");
  assert.equal(state.releasedMic.length, 0);
  provider.hasSecret = false;
  await service.invalidateProvider(binding.providerId);
  const status = await service.status();
  assert.equal(status.call.phase, "ended");
  assert.equal(status.bindings[0].selectable, false);
  assert.equal(status.bindings[0].reason, "missing-credentials");
  assert.equal(state.releasedMic.length, 1);
  assert.equal(state.adapters.length, 1, "invalidation never chooses a fallback account");
});

test("provider error sentinels do not enter public call views or controls", async (t) => {
  const { LiveCallService } = await loadModules(t);
  const secret = "Bearer fixture-secret-SDP-private-workspace";
  let service;
  const { deps, state } = dependencies({
    sendControl: (_owner, control) => {
      state.controls.push(control);
      if (control.kind === "release-media") {
        queueMicrotask(() => service.reportMedia(owner, { callId: control.callId, kind: "released" }));
      }
    },
  });
  deps.authResolver.resolve = async () => { throw Object.assign(new Error(secret), { errorCode: "LIVE_AUTH_REQUIRED" }); };
  service = new LiveCallService(deps);
  const prepared = await prepare(service);
  await assert.rejects(service.connect(owner, { callId: prepared.callId, offerSdp: "v=0\r\n" }), { errorCode: "LIVE_AUTH_REQUIRED" });
  const status = await service.status();
  assert.equal(status.call.error.code, "LIVE_AUTH_REQUIRED");
  assert.equal(JSON.stringify({ prepared, status, events: state.events, controls: state.controls }).includes(secret), false);
  assert.equal(state.transcripts.length, 0);
  assert.equal(state.adapters.length, 0);
  assert.equal(state.releasedMic.length, 1);
});

test("a failed call logs one root cause with its code while the view keeps only the code", async (t) => {
  const { LiveCallService } = await loadModules(t);
  const secret = "Bearer fixture-secret-SDP-private-workspace";
  const records = [];
  let service;
  const { deps, state } = dependencies({
    log: (level, message, data) => records.push({ level, message, data }),
    sendControl: (_owner, control) => {
      state.controls.push(control);
      if (control.kind === "release-media") {
        queueMicrotask(() => service.reportMedia(owner, { callId: control.callId, kind: "released" }));
      }
    },
  });
  deps.authResolver.resolve = async () => { throw Object.assign(new Error(secret), { errorCode: "LIVE_AUTH_REQUIRED" }); };
  service = new LiveCallService(deps);
  t.after(() => service.endForLifecycle("app-quit", owner, true));
  const prepared = await prepare(service);
  await assert.rejects(service.connect(owner, { callId: prepared.callId, offerSdp: "v=0\r\n" }), { errorCode: "LIVE_AUTH_REQUIRED" });

  const status = await service.status();
  assert.equal(status.call.error.code, "LIVE_AUTH_REQUIRED");
  assert.equal(JSON.stringify({ prepared, status, events: state.events, controls: state.controls }).includes(secret), false);

  const failures = records.filter((record) => record.message === "live voice call failed");
  assert.equal(failures.length, 1, "one root-cause record, not one per teardown step");
  assert.equal(failures[0].level, "warn");
  assert.equal(failures[0].data.code, "LIVE_AUTH_REQUIRED");
  assert.equal(failures[0].data.adapterId, "codex-live");
  assert.equal(failures[0].data.stage, "handshake");
  assert.equal(failures[0].data.reason, secret, "the raw reason stays in the log channel, which redacts it");
});

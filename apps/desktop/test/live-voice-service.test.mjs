import assert from "node:assert/strict";
import test from "node:test";
import { binding, dependencies, loadModules, otherOwner, owner, requestId } from "./helpers/live-voice-service-fixture.mjs";

test("Live call follows prepare, connect, mute, in-memory transcript, reject-only delegation, and end", async (t) => {
  const { LiveCallService } = await loadModules(t);
  const { deps, state } = dependencies();
  const service = new LiveCallService(deps);
  const status = await service.status();
  assert.equal(status.enabled, true);
  assert.equal(status.bindings[0].selectable, true);

  const prepared = await service.prepare(owner, { requestId, bindingId: binding.id, expectedSettingsRevision: status.settingsRevision, initialMuted: true });
  assert.equal(service.hasMicrophoneReservation(owner), true);
  assert.equal(service.hasMicrophoneReservation(otherOwner), false);
  let ended = false;
  t.after(async () => {
    if (ended) return;
    const ending = service.end(owner, { callId: prepared.callId, reason: "user-ended" }).catch(() => undefined);
    try { service.reportMedia(owner, { callId: prepared.callId, kind: "released" }); } catch { /* the service may already have cleaned up */ }
    await ending;
  });
  const connected = await service.connect(owner, { callId: prepared.callId, offerSdp: "v=0\r\n" });
  assert.equal(connected.answerSdp, "v=0\r\n");
  service.reportMedia(owner, { callId: prepared.callId, kind: "microphone-active", active: true });
  service.reportMedia(owner, { callId: prepared.callId, kind: "phase", phase: "connected" });

  const muted = await service.setMuted(owner, { callId: prepared.callId, muted: false, captureEpoch: 1 });
  assert.equal(muted.muted, false);
  await assert.rejects(service.setMuted(otherOwner, { callId: prepared.callId, muted: true, captureEpoch: 2 }), { errorCode: "LIVE_INVALID_OWNER" });

  state.adapters[0].onEvent({ kind: "transcript", id: "part-1", role: "assistant", text: "hello", final: false });
  state.adapters[0].onEvent({ kind: "transcript", id: "part-1", role: "assistant", text: "hello there", final: true });
  assert.equal(state.transcripts.length, 2);
  assert.equal(state.transcripts[1].segment.text, "hello there");

  await service.reportDelegation(owner, { callId: prepared.callId, delegationId: "delegation-1", instruction: "Read the project files" });
  assert.equal(state.controls.at(-1).kind, "reject-delegation");
  assert.equal(state.controls.at(-1).reason, "EXECUTION_NOT_CONNECTED");
  assert.equal(state.adapters.length, 1, "delegation does not create another runtime or agent");
  service.reportControlApplied(owner, { callId: prepared.callId, actionId: state.controls.at(-1).actionId, applied: true });

  const endPromise = service.end(owner, { callId: prepared.callId, reason: "user-ended" });
  assert.equal(state.controls.at(-1).kind, "release-media");
  service.reportMedia(owner, { callId: prepared.callId, kind: "released" });
  await endPromise;
  ended = true;
  assert.equal(state.releasedMic.length, 1);
  assert.equal(service.hasMicrophoneReservation(owner), false);
  assert.equal((await service.status()).call.phase, "ended");
});

test("an explicitly bound work call forwards only the declared tool candidate to its fixed work scope", async (t) => {
  const { LiveCallService } = await loadModules(t);
  const received = [];
  const opened = [];
  const closed = [];
  const { deps, state } = dependencies({
    resolveWorkBinding: async (target) => ({
      workSessionId: target.workSessionId,
      workBindingRevision: 7,
      label: "Fixture / Login",
      contextEnabled: target.contextEnabled,
    }),
    openWorkScope: (callId, workBinding) => opened.push({ callId, workBinding }),
    closeWorkScope: (callId) => closed.push(callId),
    receiveWorkCandidate: async (candidate, deliverReceipt) => {
      received.push(candidate);
      await deliverReceipt({ status: "received", operationId: "operation-1", providerRequestId: candidate.providerRequestId, execution: "not_started" });
    },
  });
  const service = new LiveCallService(deps);
  const status = await service.status();
  const prepared = await service.prepare(owner, {
    requestId,
    bindingId: binding.id,
    expectedSettingsRevision: status.settingsRevision,
    initialMuted: true,
    workTarget: { workSessionId: "session-a" },
  });
  t.after(async () => {
    const ending = service.end(owner, { callId: prepared.callId, reason: "user-ended" }).catch(() => undefined);
    try { service.reportMedia(owner, { callId: prepared.callId, kind: "released" }); } catch { /* the service may already have cleaned up */ }
    await ending;
  });
  await service.connect(owner, { callId: prepared.callId, offerSdp: "v=0\r\n" });

  const context = state.adapters[0];
  assert.equal(context.workProfile.version, 1);
  assert.match(context.workProfile.instructions, /work session/i);
  await context.onWorkCandidate({
    providerRequestId: "delegation-1",
    toolName: "delegate_to_work_session",
    arguments: { instruction: "Check the login flow" },
  }, async (receipt) => ({ status: "sent", deliveryId: receipt.operationId }));

  assert.equal(opened.length, 1);
  assert.equal(opened[0].workBinding.workSessionId, "session-a");
  assert.deepEqual(received, [{
    callId: prepared.callId,
    workBindingRevision: 7,
    workSessionId: "session-a",
    providerRequestId: "delegation-1",
    instruction: "Check the login flow",
  }]);
  const endPromise = service.end(owner, { callId: prepared.callId, reason: "user-ended" });
  service.reportMedia(owner, { callId: prepared.callId, kind: "released" });
  await endPromise;
  assert.deepEqual(closed, [prepared.callId]);
});

test("Live operation controls require the owner and forward only call-scoped operation IDs", async (t) => {
  const { LiveCallService } = await loadModules(t);
  const routed = [];
  const { deps } = dependencies({
    resolveWorkBinding: async (target) => ({
      workSessionId: target.workSessionId,
      workBindingRevision: 1,
      label: "Fixture / Target",
      contextEnabled: target.contextEnabled,
    }),
    openWorkScope: () => undefined,
    receiveWorkCandidate: async () => undefined,
    stopWorkOperation: async (input) => { routed.push({ kind: "stop", ...input }); return { status: "requested" }; },
    cancelQueuedWorkOperation: async (input) => { routed.push({ kind: "cancel", ...input }); return { status: "canceled" }; },
  });
  const service = new LiveCallService(deps);
  const status = await service.status();
  const prepared = await service.prepare(owner, {
    requestId,
    bindingId: binding.id,
    expectedSettingsRevision: status.settingsRevision,
    initialMuted: true,
    workTarget: { workSessionId: "session-a" },
  });
  t.after(async () => {
    const ending = service.end(owner, { callId: prepared.callId, reason: "user-ended" }).catch(() => undefined);
    try { service.reportMedia(owner, { callId: prepared.callId, kind: "released" }); } catch { /* the service may already have cleaned up */ }
    await ending;
  });
  await service.connect(owner, { callId: prepared.callId, offerSdp: "v=0\r\n" });
  service.reportMedia(owner, { callId: prepared.callId, kind: "phase", phase: "connected" });

  await assert.rejects(service.stopWorkOperation(otherOwner, { callId: prepared.callId, operationId: "operation-a" }), { errorCode: "LIVE_INVALID_OWNER" });
  assert.deepEqual(await service.stopWorkOperation(owner, { callId: prepared.callId, operationId: "operation-a" }), { status: "requested" });
  assert.deepEqual(await service.cancelQueuedWorkOperation(owner, { callId: prepared.callId, operationId: "operation-b" }), { status: "canceled" });
  assert.deepEqual(routed, [
    { kind: "stop", callId: prepared.callId, operationId: "operation-a" },
    { kind: "cancel", callId: prepared.callId, operationId: "operation-b" },
  ]);
});

test("work feedback waits for a quiet window and reports local delivery separately from task execution", async (t) => {
  const { LiveCallService } = await loadModules(t);
  let now = 1_000;
  const { deps, state } = dependencies({
    now: () => now,
    scheduleWorkFeedbackWake: (callback, delayMs) => {
      assert.equal(delayMs, 700);
      state.feedbackWake = callback;
      state.feedbackTimer = setTimeout(() => {}, 60_000);
      return state.feedbackTimer;
    },
    resolveWorkBinding: async (target) => ({
      workSessionId: target.workSessionId,
      workBindingRevision: 7,
      label: "Fixture / Login",
      contextEnabled: target.contextEnabled,
    }),
    openWorkScope: () => undefined,
    receiveWorkCandidate: async () => undefined,
  });
  const service = new LiveCallService(deps);
  const status = await service.status();
  const prepared = await service.prepare(owner, {
    requestId,
    bindingId: binding.id,
    expectedSettingsRevision: status.settingsRevision,
    initialMuted: true,
    workTarget: { workSessionId: "session-a" },
  });
  t.after(async () => {
    const ending = service.end(owner, { callId: prepared.callId, reason: "user-ended" }).catch(() => undefined);
    try { service.reportMedia(owner, { callId: prepared.callId, kind: "released" }); } catch { /* the service may already have cleaned up */ }
    await ending;
  });
  await service.connect(owner, { callId: prepared.callId, offerSdp: "v=0\r\n" });
  service.reportMedia(owner, { callId: prepared.callId, kind: "phase", phase: "connected" });

  service.notifyWorkOperation(prepared.callId, {
    operationId: "operation-queued",
    admission: "accepted",
    execution: "queued",
    queueEntryId: "queue-1",
  }, "delegation-1");
  assert.equal(state.events.at(-1).workOperations.at(-1).feedbackStatus, "pending");
  assert.equal(state.controls.some((control) => control.kind === "work-feedback"), false);

  service.reportMedia(owner, { callId: prepared.callId, kind: "activity", assistantSpeaking: true });
  service.reportMedia(owner, { callId: prepared.callId, kind: "playback-activity", active: true, ready: true });
  service.reportMedia(owner, { callId: prepared.callId, kind: "activity", assistantSpeaking: false });
  assert.equal(state.controls.some((control) => control.kind === "work-feedback"), false);

  service.reportMedia(owner, { callId: prepared.callId, kind: "playback-activity", active: false, ready: true });
  now += 700;
  clearTimeout(state.feedbackTimer);
  state.feedbackWake();
  const feedback = state.controls.at(-1);
  assert.equal(feedback.kind, "work-feedback");
  assert.equal(feedback.delegationId, "delegation-1");
  assert.equal(feedback.feedback.callId, prepared.callId);
  assert.equal(feedback.feedback.delivery, "speak-when-idle");

  service.reportControlApplied(owner, { callId: prepared.callId, actionId: feedback.actionId, applied: true });
  await new Promise((resolve) => setImmediate(resolve));
  const operation = state.events.at(-1).workOperations.find((item) => item.operationId === "operation-queued");
  assert.equal(operation.execution, "queued");
  assert.equal(operation.feedbackStatus, "sent");
});

test("a shared terminal turn produces one feedback item and updates every linked operation", async (t) => {
  const { LiveCallService } = await loadModules(t);
  let now = 2_000;
  const { deps, state } = dependencies({
    now: () => now,
    scheduleWorkFeedbackWake: (callback, delayMs) => {
      assert.equal(delayMs, 700);
      state.feedbackWake = callback;
      state.feedbackTimer = setTimeout(() => {}, 60_000);
      return state.feedbackTimer;
    },
    resolveWorkBinding: async (target) => ({
      workSessionId: target.workSessionId,
      workBindingRevision: 7,
      label: "Fixture / Login",
      contextEnabled: target.contextEnabled,
    }),
    openWorkScope: () => undefined,
    receiveWorkCandidate: async () => undefined,
  });
  const service = new LiveCallService(deps);
  const status = await service.status();
  const prepared = await service.prepare(owner, {
    requestId,
    bindingId: binding.id,
    expectedSettingsRevision: status.settingsRevision,
    initialMuted: true,
    workTarget: { workSessionId: "session-a" },
  });
  t.after(async () => {
    const ending = service.end(owner, { callId: prepared.callId, reason: "user-ended" }).catch(() => undefined);
    try { service.reportMedia(owner, { callId: prepared.callId, kind: "released" }); } catch { /* the service may already have cleaned up */ }
    await ending;
  });
  await service.connect(owner, { callId: prepared.callId, offerSdp: "v=0\r\n" });
  service.reportMedia(owner, { callId: prepared.callId, kind: "phase", phase: "connected" });

  for (const operationId of ["operation-one", "operation-two"]) {
    service.notifyWorkOperation(prepared.callId, {
      operationId,
      admission: "accepted",
      execution: "completed",
      turnId: "turn-shared",
      summary: "The shared task completed.",
    }, `delegation-${operationId}`, "The shared task completed.");
  }
  service.reportMedia(owner, { callId: prepared.callId, kind: "playback-activity", active: false, ready: true });
  now += 700;
  clearTimeout(state.feedbackTimer);
  state.feedbackWake();

  const feedbackControls = state.controls.filter((control) => control.kind === "work-feedback");
  assert.equal(feedbackControls.length, 1);
  service.reportControlApplied(owner, { callId: prepared.callId, actionId: feedbackControls[0].actionId, applied: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.events.at(-1).workOperations.map((operation) => operation.feedbackStatus), ["sent", "sent"]);
});

test("PCM Live service waits for the port lease, gates capture, and forwards output without exposing auth", async (t) => {
  const { LiveCallService } = await loadModules(t);
  const pcmBinding = { id: "gemini-main", adapterId: "gemini-live", providerId: "google-key", modelId: "gemini-live-model", voice: "Kore" };
  const { deps, state } = dependencies();
  state.settings.liveVoice = { enabled: true, selectedBindingId: pcmBinding.id, bindings: [pcmBinding] };
  const provider = {
    id: pcmBinding.providerId, name: "Google", vendorKey: "google", enabled: true, authKind: "api_key",
    apiStyle: "google_generative_ai", hasSecret: true, models: [], supportsReasoning: false, supportedThinkingLevels: [],
  };
  const inputFrames = [];
  const outputFrames = [];
  const bridgeConfig = {};
  const bridge = {
    portNonce: "a58f6ff6-e877-40b5-8476-f9dfe9650796",
    ready: Promise.resolve(),
    setMuted: async () => undefined,
    sendOutput: (frame) => outputFrames.push(frame),
    reportPlayback: () => undefined,
    interrupt: async () => [],
    requestRelease: async () => undefined,
    close: () => undefined,
  };
  deps.authResolver.provider = async (providerId) => providerId === provider.id ? { provider } : null;
  deps.authResolver.resolve = async () => ({ provider, auth: { kind: "api-key", apiKey: "secret-test-key", baseUrl: "https://generativelanguage.googleapis.com" } });
  deps.createPcmBridge = (input) => { Object.assign(bridgeConfig, input); return bridge; };
  deps.createAdapter = (context) => {
    state.adapters.push(context);
    return {
      adapterId: "gemini-live",
      mediaKind: "pcm",
      connect: async () => ({}),
      sendInputPcm: (bytes) => inputFrames.push(bytes),
      close: async () => undefined,
    };
  };
  const service = new LiveCallService(deps);
  const status = await service.status();
  assert.equal(status.bindings[0].selectable, true);
  const pcmRequestId = "bd56d49e-aef0-47e1-a2df-630003fa0f35";
  const prepared = await service.prepare(owner, {
    requestId: pcmRequestId,
    bindingId: pcmBinding.id,
    expectedSettingsRevision: status.settingsRevision,
    initialMuted: true,
  });
  assert.equal(prepared.mediaKind, "pcm");
  assert.equal(prepared.inputSampleRate, 16000);
  assert.equal(prepared.portNonce, bridge.portNonce);
  assert.equal(bridgeConfig.inputSampleRate, 16000);
  assert.equal(service.hasMicrophoneReservation(owner), true);

  const bytes = new Uint8Array([1, 0, 2, 0]);
  bridgeConfig.onInput(bytes, 0);
  assert.equal(inputFrames.length, 0, "Main ignores input before the provider is connected and unmuted");
  await service.connect(owner, { callId: prepared.callId });
  service.reportMedia(owner, { callId: prepared.callId, kind: "microphone-active", active: true });
  service.reportMedia(owner, { callId: prepared.callId, kind: "phase", phase: "connected" });
  await service.setMuted(owner, { callId: prepared.callId, muted: false, captureEpoch: 1 });
  bridgeConfig.onInput(bytes, 1);
  assert.equal(inputFrames.length, 1);
  state.adapters[0].onEvent({ kind: "audio", bytes, responseId: "response-1", itemId: "item-1", contentIndex: 0 });
  assert.equal(outputFrames[0].responseId, "response-1");
  assert.equal(JSON.stringify(state.events).includes("secret-test-key"), false);

  const ending = service.end(owner, { callId: prepared.callId, reason: "user-ended" });
  service.reportMedia(owner, { callId: prepared.callId, kind: "released" });
  await ending;
  assert.equal(service.hasMicrophoneReservation(owner), false);
});

test("an active binding cannot be rewritten by settings save, while unrelated settings remain writable", async (t) => {
  const { LiveCallService } = await loadModules(t);
  const { deps } = dependencies();
  const service = new LiveCallService(deps);
  const status = await service.status();
  const prepared = await service.prepare(owner, { requestId, bindingId: binding.id, expectedSettingsRevision: status.settingsRevision, initialMuted: true });
  let ended = false;
  t.after(async () => {
    if (ended) return;
    const ending = service.end(owner, { callId: prepared.callId, reason: "user-ended" }).catch(() => undefined);
    try { service.reportMedia(owner, { callId: prepared.callId, kind: "released" }); } catch { /* the service may already have cleaned up */ }
    await ending;
  });
  const changedBinding = { ...binding, voice: "marin" };
  assert.throws(() => service.beginSettingsWrite({ liveVoice: { enabled: true, selectedBindingId: binding.id, bindings: [changedBinding] }, voice: { enabled: false } }), { errorCode: "LIVE_SETTINGS_IN_USE" });
  const release = service.beginSettingsWrite({ liveVoice: { enabled: true, selectedBindingId: binding.id, bindings: [binding] }, voice: { enabled: true } });
  release();
  const endPromise = service.end(owner, { callId: prepared.callId, reason: "user-ended" });
  service.reportMedia(owner, { callId: prepared.callId, kind: "released" });
  await endPromise;
  ended = true;
});

test("cancel by requestId tombstones an in-flight prepare before it can acquire an adapter", async (t) => {
  const { LiveCallService } = await loadModules(t);
  const { deps, state } = dependencies();
  const service = new LiveCallService(deps);
  const status = await service.status();
  let resolveSettings;
  deps.loadSettings = () => new Promise((resolve) => { resolveSettings = resolve; });

  const preparePromise = service.prepare(owner, { requestId, bindingId: binding.id, expectedSettingsRevision: status.settingsRevision, initialMuted: true });
  assert.throws(() => service.beginSettingsWrite({ liveVoice: { enabled: true, selectedBindingId: binding.id, bindings: [{ ...binding, voice: "marin" }] } }), { errorCode: "LIVE_SETTINGS_IN_USE" });
  const endPromise = service.end(owner, { requestId, reason: "user-cancelled-start" });
  assert.equal(state.controls.at(-1).kind, "release-media");
  service.reportMedia(owner, { callId: state.events.at(-1).callId, kind: "released" });
  await endPromise;
  resolveSettings(state.settings);
  await assert.rejects(preparePromise, { errorCode: "LIVE_STALE_CALL" });
  assert.equal(state.adapters.length, 0);
  assert.equal(state.releasedMic.length, 1);
});

test("the microphone lease prevents Live and Dictation from owning capture together", async (t) => {
  const { MicrophoneLeaseRegistry } = await loadModules(t);
  let dictationActive = true;
  const leases = new MicrophoneLeaseRegistry(() => dictationActive);
  const releaseDictation = leases.acquire("dictation", "dictation-1");
  assert.throws(() => leases.acquire("live", "live-1"), { errorCode: "LIVE_MICROPHONE_BUSY" });
  releaseDictation();
  dictationActive = false;
  const releaseLive = leases.acquire("live", "live-1");
  assert.equal(leases.isHeld(), true);
  releaseLive();
  assert.equal(leases.isHeld(), false);
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createProductionWorkHarness, settleUntil, WORK_INSTRUCTION, WORK_RESULT, WORK_SESSION_ID } from "./helpers/live-work-production.mjs";

async function codexHarness(t) {
  const originals = new Map(["window", "navigator", "RTCPeerConnection", "AudioContext"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const listeners = new Map();
  const tracks = [{ enabled: true, stopped: false, stop() { this.stopped = true; } }];
  const sent = [];
  const peers = [];
  const controls = [];
  const requests = [];
  const settings = { liveVoice: { enabled: true, selectedBindingId: "codex-main", bindings: [{ id: "codex-main", adapterId: "codex-live", providerId: "codex-fixture", voice: "cove" }] } };
  const provider = { id: "codex-fixture", name: "Codex fixture", vendorKey: "openai-codex", enabled: true, authKind: "oauth", hasSecret: true, models: [], supportsReasoning: false, supportedThinkingLevels: [] };
  const owner = { webContentsId: 8, frameProcessId: 2, frameRoutingId: 3, url: "file:///fixture/index.html" };
  let service;
  const emit = (channel, payload) => { for (const listener of listeners.get(channel) ?? []) listener(payload); };
  const ipc = {
    on(channel, listener) {
      const entries = listeners.get(channel) ?? new Set(); entries.add(listener); listeners.set(channel, entries);
      return () => entries.delete(listener);
    },
    onLiveVoicePort: () => () => {},
    async invoke(channel, input) {
      const routes = {
        "pi-desktop/settings/get": () => settings,
        "pi-desktop/voice/live/status": () => service.status(),
        "pi-desktop/voice/live/prepare": () => service.prepare(owner, input),
        "pi-desktop/voice/live/connect": () => service.connect(owner, input),
        "pi-desktop/voice/live/setMuted": () => service.setMuted(owner, input),
        "pi-desktop/voice/live/reportMedia": () => service.reportMedia(owner, input),
        "pi-desktop/voice/live/reportPlayback": () => service.reportPlayback(owner, input),
        "pi-desktop/voice/live/reportDelegation": () => service.reportDelegation(owner, input),
        "pi-desktop/voice/live/reportControlApplied": () => service.reportControlApplied(owner, input),
        "pi-desktop/voice/live/end": () => service.end(owner, input),
        "pi-desktop/voice/live/heartbeat": () => service.heartbeat(owner, input.callId),
      };
      assert.ok(routes[channel], `unexpected fixture IPC: ${channel}`);
      return { ok: true, data: await routes[channel]() };
    },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    piDesktop: ipc, location: { origin: "null" }, addEventListener() {}, removeEventListener() {},
  } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => tracks, getTracks: () => tracks }) } } });
  class FakePeer extends EventTarget {
    connectionState = "new"; iceGatheringState = "complete"; localDescription = null;
    channel = {
      readyState: "open", onmessage: null, onerror: null, failSend: false,
      send(value) { if (this.failSend) throw new Error("synthetic DataChannel failure"); sent.push(JSON.parse(value)); },
      close() { this.readyState = "closed"; },
    };
    constructor() { super(); peers.push(this); }
    createDataChannel() { return this.channel; }
    addTrack() {}
    async createOffer() { return { type: "offer", sdp: "v=0\r\n" }; }
    async setLocalDescription(value) { this.localDescription = value; }
    async setRemoteDescription(value) { assert.equal(value.sdp, "v=0\r\n"); this.connectionState = "connected"; this.dispatchEvent(new Event("connectionstatechange")); }
    close() { this.connectionState = "closed"; this.dispatchEvent(new Event("connectionstatechange")); }
  }
  Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: FakePeer });
  Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: class {
    state = "running"; async resume() {} async close() { this.state = "closed"; }
  } });
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  const { LiveCallService } = await server.ssrLoadModule("/electron/main/live-voice/call-service.ts");
  const { createCodexAdapter } = await server.ssrLoadModule("/electron/main/live-voice/codex-adapter.ts");
  const { LiveCallController } = await server.ssrLoadModule("/src/features/voice/live/live-call-controller.ts");
  const production = await createProductionWorkHarness(t, server, {
    onOperation(callId, update) { const op = update.operation; service.notifyWorkOperation(callId, op, op.providerRequestId, op.resultSummary, update.intent); },
  });
  let now = 1_000;
  let wake;
  const timers = [];
  service = new LiveCallService({
    loadSettings: async () => settings,
    authResolver: { provider: async () => ({ provider }), resolve: async () => ({ provider, auth: { kind: "codex-oauth", accessToken: "synthetic-codex-token", accountId: "synthetic-account" } }) },
    createAdapter: (context) => createCodexAdapter(context, {
      async assertEndpoint(url) { assert.match(url, /^https:\/\/chatgpt\.com\/backend-api\/codex\/realtime\/calls\?/); },
      async fetchImpl(url, init) { requests.push({ url, init }); return new Response("v=0\r\n", { status: 201 }); },
    }),
    createPcmBridge() { throw new Error("Codex must not use PCM transport"); },
    sendView: (_owner, view) => emit("pi-desktop/voice/live/event/changed", view),
    sendControl: (_owner, event) => { controls.push(event); emit("pi-desktop/voice/live/event/control", event); },
    sendTranscript: (_owner, event) => emit("pi-desktop/voice/live/event/transcript", event),
    ownerAlive: () => true, acquireMicrophone: () => () => {},
    resolveWorkBinding: async () => ({ workSessionId: WORK_SESSION_ID, workBindingRevision: 3, label: "Production fixture", contextEnabled: false }),
    openWorkScope: (callId, binding) => production.openCall(callId, binding),
    closeWorkScope: production.bridge.closeCall, receiveWorkCandidate: production.bridge.receiveCandidate,
    now: () => now,
    scheduleWorkFeedbackWake(callback) {
      const timer = setTimeout(() => {}, 2 ** 30); timer.unref(); timers.push(timer);
      wake = () => { clearTimeout(timer); callback(); }; return timer;
    },
  });
  const controller = new LiveCallController();
  t.after(async () => {
    await controller.end();
    const status = await service.status();
    if (status.call && !["ended", "failed"].includes(status.call.phase)) {
      await service.end(owner, { callId: status.call.callId, reason: "user-ended" });
    }
    for (const timer of timers) clearTimeout(timer);
  });
  await controller.refreshStatus();
  await controller.start({ workTarget: { workSessionId: WORK_SESSION_ID } });
  const callId = controller.getSnapshot().call.callId;
  service.reportMedia(owner, { callId, kind: "playback-activity", active: false, ready: true });
  return {
    ...production, controller, service, callId, owner, sent, peers, tracks, requests, controls,
    candidate(id = randomUUID(), instruction = WORK_INSTRUCTION) {
      peers[0].channel.onmessage({ data: JSON.stringify({ type: "delegation.created", item: { type: "delegation", target: "client", id, content: [{ type: "input_text", text: instruction }] } }) });
    },
    advanceFeedback() { now += 1_000; const callback = wake; wake = undefined; callback?.(); },
  };
}

test("Codex concrete SDP adapter and renderer DataChannel reach production WorkBridge and terminal feedback", async (t) => {
  const h = await codexHarness(t);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].init.headers.Authorization, "Bearer synthetic-codex-token");
  assert.equal(JSON.parse(h.requests[0].init.body).session.model, "gpt-live-1-codex");
  h.candidate("codex-request-1");
  await settleUntil(() => h.prompts.length === 1, "the DataChannel request reaches registered Main admission");
  assert.equal(h.prompts[0].voiceOrigin.callId, h.callId);
  assert.deepEqual(h.persistedMessages[0].voiceOrigin, h.prompts[0].voiceOrigin);
  assert.equal(h.sent[0].type, "delegation.context.append");
  assert.equal(h.sent[0].delegation_item_id, "codex-request-1");
  h.candidate("codex-request-1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.prompts.length, 1);
  h.endTurn();
  await settleUntil(() => h.results.size === 1, "the exact terminal result is ready");
  h.advanceFeedback();
  await settleUntil(() => h.sent.some((message) => JSON.stringify(message).includes(WORK_RESULT)), "result crosses the actual renderer DataChannel control handler");
  assert.doesNotMatch(JSON.stringify(h.controller.getSnapshot()), /synthetic-codex-token|synthetic-account|Authorization/);
  await h.controller.end();
  assert.equal(h.tracks[0].stopped, true);
  assert.equal(h.peers[0].channel.readyState, "closed");
});

test("Codex DataChannel receipt failure cannot admit a production work task", async (t) => {
  const h = await codexHarness(t);
  h.peers[0].channel.failSend = true;
  h.candidate("codex-send-failure");
  await settleUntil(() => h.updates.some((update) => update.operation.admission === "rejected"), "failed local receipt is rejected");
  assert.equal(h.prompts.length, 0);
  assert.equal(h.persistedMessages.length, 0);
});

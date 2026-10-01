import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { LIVE_WORK_TOOL_NAME } from "@pi-desktop/voice-runtime/live";
import { createProductionWorkHarness, WORK_SESSION_ID } from "./live-work-production.mjs";

export class FixtureLiveSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent = [];
  receiptCallbacks = [];
  holdReceipts = false;
  terminated = false;

  constructor(profile) { super(); this.profile = profile; }

  send(body, callback) {
    const message = JSON.parse(body);
    this.sent.push(message);
    const receipt = Boolean(message.toolResponse || message.item?.type === "function_call_output");
    if (receipt && this.holdReceipts) this.receiptCallbacks.push(callback);
    else queueMicrotask(() => callback?.());
    if (message.setup) queueMicrotask(() => this.receive({ setupComplete: {} }));
    if (message.type === "session.update") {
      queueMicrotask(() => this.receive({ type: "session.updated", session: message.session }));
    }
  }

  receive(value) { this.emit("message", typeof value === "string" ? value : JSON.stringify(value)); }
  close() { this.readyState = 3; this.emit("close", 1000); }
  terminate() { this.terminated = true; this.close(); }
  settleReceipt(error) { this.receiptCallbacks.shift()?.(error); }

  candidate(id, instruction, extra = {}) {
    this.receive(this.profile === "gemini-live"
      ? { toolCall: { functionCalls: [{ id, name: LIVE_WORK_TOOL_NAME, args: { instruction, ...extra } }] } }
      : { type: "response.function_call_arguments.done", call_id: id, name: LIVE_WORK_TOOL_NAME, arguments: JSON.stringify({ instruction, ...extra }) });
  }

  receipts() { return this.sent.filter((item) => item.toolResponse || item.item?.type === "function_call_output"); }
  feedback() { return this.sent.filter((item) => item.clientContent || item.type === "conversation.item.create" && item.item?.type === "message"); }
}

export async function createAdapterWorkHarness(t, profile) {
  const socket = new FixtureLiveSocket(profile);
  const connectionRequests = [];
  const key = `live-adapter-transport-${randomUUID()}`;
  globalThis[key] = async (request) => {
    connectionRequests.push(request);
    // The listener is attached after openLiveWebSocket resolves.
    if (profile !== "gemini-live") setImmediate(() => socket.receive({ type: "session.created", session: {} }));
    return socket;
  };
  const server = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom", optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [{
      name: "live-provider-external-transport-fixture",
      enforce: "pre",
      resolveId(source) {
        if (source === "./websocket-transport" || /\/live-voice\/websocket-transport(?:\.ts)?$/.test(source)) return "\0live-socket-fixture";
      },
      load(id) {
        if (id === "\0live-socket-fixture") return `export const openLiveWebSocket = (input) => globalThis[${JSON.stringify(key)}](input);`;
      },
    }],
  });
  t.after(async () => { delete globalThis[key]; await server.close(); });
  const { LiveCallService } = await server.ssrLoadModule("/electron/main/live-voice/call-service.ts");
  const { createGeminiAdapter } = await server.ssrLoadModule("/electron/main/live-voice/gemini-adapter.ts");
  const { createOpenAIRealtimeAdapter } = await server.ssrLoadModule("/electron/main/live-voice/openai-realtime-adapter.ts");
  let service;
  const production = await createProductionWorkHarness(t, server, {
    onOperation(callId, update) {
      const op = update.operation;
      service.notifyWorkOperation(callId, op, op.providerRequestId, op.resultSummary, update.intent);
    },
  });
  const binding = profile === "gemini-live"
    ? { id: "test-binding", adapterId: "gemini-live", providerId: "fixture-provider", modelId: "fixture-live-model", voice: "Kore" }
    : { id: "test-binding", adapterId: "openai-realtime", providerId: "fixture-provider", modelId: "fixture-live-model", voice: "marin", wireProfile: profile };
  const provider = {
    id: "fixture-provider", name: "Fixture", enabled: true, authKind: "api_key", hasSecret: true,
    vendorKey: profile === "gemini-live" ? "google" : "openai",
    apiStyle: profile === "gemini-live" ? "google_generative_ai" : "responses",
    baseUrl: "https://fixture.invalid/v1", models: [], supportsReasoning: false, supportedThinkingLevels: [],
  };
  const settings = { liveVoice: { enabled: true, bindings: [binding], selectedBindingId: binding.id } };
  const owner = { webContentsId: 9, frameProcessId: 2, frameRoutingId: 3, url: "file:///fixture/index.html" };
  const views = [];
  const audio = [];
  const timers = new Set();
  let now = 1_000;
  let pendingWake;
  let bridgeInput;
  let playbackIdle = true;
  let adapter;
  service = new LiveCallService({
    loadSettings: async () => settings,
    authResolver: {
      provider: async () => ({ provider }),
      resolve: async () => ({ provider, auth: { kind: "api-key", apiKey: "synthetic-live-secret", baseUrl: provider.baseUrl } }),
    },
    createAdapter(context) {
      adapter = profile === "gemini-live" ? createGeminiAdapter(context) : createOpenAIRealtimeAdapter(context);
      return adapter;
    },
    createPcmBridge(input) {
      bridgeInput = input;
      return {
        portNonce: "fixture-pcm-port", ready: Promise.resolve(), async setMuted() {},
        sendOutput(frame) { audio.push(frame); playbackIdle = false; input.onPlaybackStateChanged(); },
        reportPlayback() {}, isPlaybackIdle: () => playbackIdle,
        async interrupt() { playbackIdle = true; input.onPlaybackStateChanged(); return []; },
        async requestRelease() { input.onReleased(); }, close() {},
      };
    },
    sendView(_owner, view) { views.push(view); }, sendControl() {}, sendTranscript() {},
    ownerAlive: () => true, acquireMicrophone: () => () => {},
    resolveWorkBinding: async () => ({ workSessionId: WORK_SESSION_ID, workBindingRevision: 3, label: "Production fixture", contextEnabled: false }),
    openWorkScope: (callId, workBinding) => production.openCall(callId, workBinding),
    closeWorkScope: production.bridge.closeCall,
    receiveWorkCandidate: production.bridge.receiveCandidate,
    now: () => now,
    scheduleWorkFeedbackWake(callback) {
      const timer = setTimeout(() => {}, 2 ** 30);
      timer.unref();
      timers.add(timer);
      pendingWake = () => { clearTimeout(timer); callback(); };
      return timer;
    },
  });
  const status = await service.status();
  const prepared = await service.prepare(owner, {
    requestId: randomUUID(), bindingId: binding.id, expectedSettingsRevision: status.settingsRevision,
    initialMuted: true, workTarget: { workSessionId: WORK_SESSION_ID },
  });
  t.after(async () => {
    const call = (await service.status()).call;
    if (call && !["ended", "failed"].includes(call.phase)) {
      await service.end(owner, { callId: prepared.callId, reason: "user-ended" });
    }
    for (const timer of timers) clearTimeout(timer);
  });
  await service.connect(owner, { callId: prepared.callId });
  service.reportMedia(owner, { callId: prepared.callId, kind: "phase", phase: "connected" });
  return {
    ...production, socket, server, service, owner, prepared, binding, connectionRequests, views, audio,
    get historyReadsAfterTerminal() { return production.historyReadsAfterTerminal; },
    get adapter() { return adapter; },
    drainPlayback() { playbackIdle = true; bridgeInput.onPlaybackStateChanged(); },
    advanceFeedback() { now += 1_000; const wake = pendingWake; pendingWake = undefined; wake?.(); },
  };
}

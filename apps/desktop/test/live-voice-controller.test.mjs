import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

test("renderer and Main complete a Codex Live user path without invoking an Agent", async (t) => {
  const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalAudioContextDescriptor = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  const listeners = new Map();
  const sentDataChannelMessages = [];
  const tracks = [{ enabled: true, stopped: false, stop() { this.stopped = true; } }];
  const stream = { getAudioTracks: () => tracks, getTracks: () => tracks };
  const settings = {
    liveVoice: {
      enabled: true,
      selectedBindingId: "codex-main",
      bindings: [{ id: "codex-main", adapterId: "codex-live", providerId: "codex-account-a", voice: "cove" }],
    },
    voice: { enabled: true, deviceId: null, languages: ["en"], chineseVariant: "simplified", modelId: "local-model" },
  };
  const provider = {
    id: "codex-account-a", name: "Codex", vendorKey: "openai-codex", enabled: true,
    authKind: "oauth", hasSecret: true, models: [], supportsReasoning: false, supportedThinkingLevels: [],
  };
  const owner = { webContentsId: 8, frameProcessId: 2, frameRoutingId: 3, url: "file:///app/index.html" };
  const sentViews = [];
  const sentControls = [];
  const sentTranscripts = [];
  const createdAdapters = [];
  let service;

  const emit = (channel, payload) => {
    for (const listener of listeners.get(channel) ?? []) listener(payload);
  };
  const ipc = {
    platform: "linux",
    channels: {},
    on(channel, listener) {
      const channelListeners = listeners.get(channel) ?? new Set();
      channelListeners.add(listener);
      listeners.set(channel, channelListeners);
      return () => channelListeners.delete(listener);
    },
    onLiveVoicePort: () => () => undefined,
    invoke: async (channel, ...args) => {
      let data;
      switch (channel) {
        case "pi-desktop/settings/get": data = settings; break;
        case "pi-desktop/voice/live/status": data = await service.status(); break;
        case "pi-desktop/voice/live/prepare": data = await service.prepare(owner, args[0]); break;
        case "pi-desktop/voice/live/connect": data = await service.connect(owner, args[0]); break;
        case "pi-desktop/voice/live/setMuted": data = await service.setMuted(owner, args[0]); break;
        case "pi-desktop/voice/live/reportMedia": data = service.reportMedia(owner, args[0]); break;
        case "pi-desktop/voice/live/reportPlayback": service.reportPlayback(owner, args[0]); data = { ok: true }; break;
        case "pi-desktop/voice/live/reportDelegation": data = await service.reportDelegation(owner, args[0]); break;
        case "pi-desktop/voice/live/reportControlApplied": service.reportControlApplied(owner, args[0]); data = { ok: true }; break;
        case "pi-desktop/voice/live/end": data = await service.end(owner, args[0]); break;
        case "pi-desktop/voice/live/heartbeat": data = service.heartbeat(owner, args[0].callId); break;
        default: throw new Error(`Unexpected IPC request: ${channel}`);
      }
      return { ok: true, data };
    },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    piDesktop: ipc,
    location: { origin: "null" },
    addEventListener() {},
  } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: async () => stream } } });
  const originalPeer = globalThis.RTCPeerConnection;
  class FakeAudioContext {
    state = "running";
    sampleRate = 48_000;
    async resume() {}
    async close() { this.state = "closed"; }
  }
  Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: FakeAudioContext });
  const peerInstances = [];
  class FakeDataChannel {
    readyState = "open";
    onmessage = null;
    onerror = null;
    send(value) { sentDataChannelMessages.push(value); }
    close() { this.readyState = "closed"; }
  }
  class FakePeer extends EventTarget {
    connectionState = "new";
    iceGatheringState = "complete";
    localDescription = null;
    channel = new FakeDataChannel();
    createDataChannel() { return this.channel; }
    addTrack() {}
    async createOffer() { return { type: "offer", sdp: "v=0\r\n" }; }
    async setLocalDescription(description) { this.localDescription = description; }
    async setRemoteDescription() {
      this.connectionState = "connected";
      this.dispatchEvent(new Event("connectionstatechange"));
    }
    close() {
      this.connectionState = "closed";
      this.dispatchEvent(new Event("connectionstatechange"));
    }
    constructor() { super(); peerInstances.push(this); }
  }
  globalThis.RTCPeerConnection = FakePeer;
  t.after(() => {
    if (originalWindowDescriptor) Object.defineProperty(globalThis, "window", originalWindowDescriptor);
    else delete globalThis.window;
    if (originalNavigatorDescriptor) Object.defineProperty(globalThis, "navigator", originalNavigatorDescriptor);
    else delete globalThis.navigator;
    if (originalAudioContextDescriptor) Object.defineProperty(globalThis, "AudioContext", originalAudioContextDescriptor);
    else delete globalThis.AudioContext;
    if (originalPeer === undefined) delete globalThis.RTCPeerConnection;
    else globalThis.RTCPeerConnection = originalPeer;
  });

  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  let controller;
  try {
    const { LiveCallService } = await server.ssrLoadModule("/electron/main/live-voice/call-service.ts");
    const { getLiveCallController } = await server.ssrLoadModule("/src/features/voice/live/live-call-controller.ts");
    service = new LiveCallService({
      loadSettings: async () => settings,
      authResolver: {
        provider: async (id) => id === provider.id ? { provider } : null,
        resolve: async () => ({ provider, auth: { kind: "codex-oauth", accessToken: "opaque-test-token", accountId: "account-a" } }),
      },
      createAdapter: (context) => {
        createdAdapters.push(context);
        return { adapterId: "codex-live", mediaKind: "webrtc", connect: async () => ({ answerSdp: "v=0\r\n" }), close: async () => undefined };
      },
      createPcmBridge: () => { throw new Error("Codex path created a PCM bridge"); },
      sendView: (_owner, view) => { sentViews.push(view); emit("pi-desktop/voice/live/event/changed", view); },
      sendControl: (_owner, event) => { sentControls.push(event); emit("pi-desktop/voice/live/event/control", event); },
      sendTranscript: (_owner, event) => { sentTranscripts.push(event); emit("pi-desktop/voice/live/event/transcript", event); },
      ownerAlive: () => true,
      acquireMicrophone: () => () => undefined,
    });
    controller = getLiveCallController();
    await controller.refreshStatus();
    settings.liveVoice.selectedBindingId = undefined;
    await controller.refreshStatus();
    await assert.rejects(controller.start(), (error) => error.code === "LIVE_NOT_CONFIGURED");
    settings.liveVoice.selectedBindingId = "codex-main";
    await controller.refreshStatus();
    await controller.start();
    assert.equal(controller.getSnapshot().call.phase, "connected");
    assert.equal(controller.getSnapshot().call.muted, true);
    assert.equal(peerInstances.length, 1);
    const connectedView = sentViews.at(-1);
    emit("pi-desktop/voice/live/event/changed", { ...connectedView, revision: connectedView.revision - 1, phase: "failed" });
    assert.equal(controller.getSnapshot().call.phase, "connected");

    peerInstances[0].channel.onmessage({ data: JSON.stringify({ type: "output_transcript.added", text: "Hello from the voice provider." }) });
    assert.equal(controller.getSnapshot().transcripts.at(-1).text, "Hello from the voice provider.");
    peerInstances[0].channel.onmessage({ data: JSON.stringify({
      type: "delegation.created",
      item: { type: "delegation", target: "client", id: "request-1", content: [{ type: "input_text", text: "Read a local file" }] },
    }) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sentControls.at(-1).kind, "reject-delegation");
    assert.match(sentDataChannelMessages.at(-1), /did not create a new task/);
    assert.equal(createdAdapters.length, 1);

    await controller.toggleMute();
    assert.equal(controller.getSnapshot().call.muted, false);
    assert.equal(tracks[0].enabled, true);
    await controller.toggleMute();
    assert.equal(controller.getSnapshot().call.muted, true);
    assert.equal(tracks[0].enabled, false);

    await controller.end();
    assert.equal(controller.getSnapshot().call.phase, "ended");
    assert.equal(controller.getSnapshot().stopping, false);
    assert.equal(tracks[0].stopped, true);
    assert.equal(sentViews.at(-1).phase, "ended");
    assert.equal(controller.getSnapshot().transcripts.length, 1);
    assert.doesNotMatch(JSON.stringify(controller.getSnapshot()), /opaque-test-token/);
  } finally {
    if (controller) await controller.end().catch(() => undefined);
  }
});

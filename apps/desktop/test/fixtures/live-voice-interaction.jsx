import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC, KEYBOARD_SHORTCUTS, keybindingMatchesEvent, resolveKeybinding } from "@pi-desktop/shared";
import { useAppStore } from "../../src/stores/app-store";
import { PortalVisibilityProvider } from "../../src/lib/portal-visibility";
import { LiveVoiceControls } from "../../src/features/voice/live/LiveVoiceControls";
import { ToastHost } from "../../src/components/Toast";
import { LiveVoiceStatusHost } from "../../src/features/voice/live/LiveVoiceStatusHost";
import { LiveVoiceWidget } from "../../src/features/voice/live/LiveVoiceWidget";
import { getLiveCallController } from "../../src/features/voice/live/live-call-controller";
import { runLiveVoiceShortcut } from "../../src/features/voice/live/live-voice-shortcuts";

// Only external IPC/provider/media edges are fake. No controller or UI method is replaced.
const listeners = new Map();
const gates = new Map();
const counts = Object.fromEntries([
  "prepare", "connect", "getUserMedia", "audioContext", "end", "released", "contextClose",
  "play", "pause", "mute", "peer", "trackStop",
].map((key) => [key, 0]));
const requests = { prepare: [], mute: [], end: [], unexpected: [] };
const errors = [];
const tracks = [];
const contexts = [];
const peers = [];
const settings = {
  liveVoice: { enabled: false, selectedBindingId: "fixture-selected", bindings: [
    { id: "fixture-selected", adapterId: "codex-live", providerId: "fixture-provider", voice: "cove" },
    { id: "fixture-other", adapterId: "codex-live", providerId: "fixture-other-provider", voice: "cove" },
  ] },
  voice: { deviceId: null }, keybindings: {}, language: "en",
};
const status = {
  enabled: false, settingsRevision: 1, selectedBindingId: "fixture-selected", call: null,
  bindings: [
    { bindingId: "fixture-selected", adapterId: "codex-live", providerLabel: "Selected fixture account", configured: true, credentialsPresent: true, selectable: true },
    { bindingId: "fixture-other", adapterId: "codex-live", providerLabel: "Other ready account", configured: true, credentialsPresent: true, selectable: true },
  ],
};
const sessions = ["Alpha", "Beta"].map((title, index) => ({
  id: `fixture-session-${index + 1}`, title, source: "desktop", projectPath: "/fixture/project",
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", messageCount: 0,
}));
let call;
let callNumber = 0;
let rejectPlayback = false;
let rejectReleaseReport = false;
const ending = new Map();
// The widget window is a view of the call: main pushes the owner's view into it
// and forwards its presses back to the owner frame. Both directions are faked
// here so the mounted production widget runs its real code path.
const widgetReports = { presentation: null, actions: [], errorCode: undefined, decisionWaiting: false };
const emit = (channel, value) => {
  for (const listener of listeners.get(channel) ?? []) listener(structuredClone(value));
};
const waitAt = (name) => gates.get(name)?.promise ?? Promise.resolve();
function pushWidgetState() {
  emit(IPC.event.liveVoiceWidgetState, {
    call,
    ...(widgetReports.errorCode ? { errorCode: widgetReports.errorCode } : {}),
    ...(widgetReports.decisionWaiting ? { decisionWaiting: true } : {}),
  });
}
function updateCall(patch) {
  call = { ...call, ...patch, revision: (call?.revision ?? 0) + 1 };
  status.call = call;
  emit(IPC.event.liveVoiceChanged, call);
  // Main forwards the same authoritative view to the docked widget.
  pushWidgetState();
  return structuredClone(call);
}
function beginClosing() {
  if (!call || ["closing", "ended", "failed"].includes(call.phase)) return;
  updateCall({ phase: "closing" });
  emit(IPC.event.liveVoiceControl, { callId: call.callId, kind: "release-media" });
}
async function handleInvoke(channel, request) {
  switch (channel) {
    case IPC.invoke.settingsGet: return structuredClone(settings);
    case IPC.invoke.liveVoiceStatus: return structuredClone(status);
    case IPC.invoke.liveVoicePrepare: {
      counts.prepare += 1;
      requests.prepare.push(structuredClone(request));
      call = {
        callId: `fixture-call-${++callNumber}`, revision: 0, bindingId: request.bindingId,
        adapterId: "codex-live", phase: "preparing", muted: request.initialMuted,
        microphoneActive: false, userSpeaking: false, assistantSpeaking: false, mediaRelease: "pending",
        ...(request.workTarget ? { workBinding: {
          ...request.workTarget, workBindingRevision: 1,
          label: sessions.find((session) => session.id === request.workTarget.workSessionId)?.title ?? "Fixture session",
          contextEnabled: request.shareSelectedSessionContext === true,
        } } : {}),
      };
      // A new call starts blank: main drops the previous call's failure code and
      // its waiting-decision flag.
      widgetReports.errorCode = undefined;
      widgetReports.decisionWaiting = false;
      updateCall({});
      const prepared = {
        callId: call.callId, requestId: request.requestId, bindingId: call.bindingId,
        adapterId: call.adapterId, mediaKind: "webrtc", initialMuted: request.initialMuted,
        inputSampleRate: 24000, outputSampleRate: 24000, revision: call.revision,
      };
      await waitAt("prepare");
      return prepared;
    }
    case IPC.invoke.liveVoiceConnect:
      counts.connect += 1;
      await waitAt("connect");
      return { answerSdp: "v=0\r\n", revision: call.revision };
    case IPC.invoke.liveVoiceSetMuted:
      counts.mute += 1;
      requests.mute.push(structuredClone(request));
      return updateCall({ muted: request.muted });
    case IPC.invoke.liveVoiceReportMedia:
      if (request.kind === "released") {
        counts.released += 1;
        await waitAt("released");
        if (rejectReleaseReport) throw Object.assign(new Error("Fixture release acknowledgement refused"), { code: "LIVE_MEDIA_RELEASE_UNCONFIRMED" });
        return updateCall({ microphoneActive: false, mediaRelease: "confirmed" });
      }
      if (request.kind === "microphone-active") return updateCall({ microphoneActive: request.active });
      if (request.kind === "phase") return updateCall({ phase: request.phase });
      if (request.kind === "playback-blocked") return updateCall({ playbackBlocked: request.blocked });
      return structuredClone(call);
    case IPC.invoke.liveVoiceEnd: {
      counts.end += 1;
      requests.end.push(structuredClone(request));
      const key = request.callId ?? request.requestId;
      if (!ending.has(key)) ending.set(key, (async () => {
        beginClosing();
        await waitAt("end");
        if (call) updateCall({ phase: "ended" });
        return { ok: true };
      })());
      return ending.get(key);
    }
    case IPC.invoke.liveVoiceHeartbeat:
    case IPC.invoke.liveVoiceReportPlayback:
    case IPC.invoke.liveVoiceReportControlApplied:
      return { ok: true };
    case IPC.invoke.liveVoiceWidgetVisibility:
      // Main turns the widget's measured box into the window's bounds.
      widgetReports.presentation = structuredClone(request);
      return { ok: true };
    case IPC.invoke.liveVoiceWidgetAction:
      // Main validates the sender, then hands the press to the owner frame.
      widgetReports.actions.push(request.action);
      emit(IPC.event.liveVoiceWidgetAction, { action: request.action });
      return { ok: true };
    case IPC.invoke.liveVoiceWidgetOwnerState:
      // What only the owner frame knows — its failure code and whether the bound
      // session waits on a decision — cached for that call and pushed into the
      // widget exactly as main does.
      if (request.callId !== call?.callId) return { ok: true };
      widgetReports.errorCode = request.errorCode ?? undefined;
      widgetReports.decisionWaiting = request.decisionWaiting === true;
      pushWidgetState();
      return { ok: true };
      widgetReports.errorCode = request.code ?? undefined;
      pushWidgetState();
      return { ok: true };
    default:
      requests.unexpected.push(channel);
      throw new Error(`Unexpected fixture IPC: ${channel}`);
  }
}
window.piDesktop = {
  platform: navigator.platform.includes("Mac") ? "darwin" : "linux",
  on(channel, listener) {
    const group = listeners.get(channel) ?? new Set();
    listeners.set(channel, group); group.add(listener);
    return () => group.delete(listener);
  },
  onLiveVoicePort: () => () => {},
  async invoke(channel, request) { return { ok: true, data: await handleInvoke(channel, request) }; },
};
Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
  async getUserMedia() {
    counts.getUserMedia += 1;
    const track = { enabled: true, readyState: "live", stop() {
      if (this.readyState !== "ended") counts.trackStop += 1;
      this.readyState = "ended"; this.enabled = false;
    } };
    tracks.push(track);
    await waitAt("microphone");
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  },
} });
class FakePeer extends EventTarget {
  connectionState = "new";
  iceGatheringState = "complete";
  localDescription = null;
  channel = Object.assign(new EventTarget(), {
    readyState: "open", send() {}, close() { this.readyState = "closed"; },
  });
  constructor() { super(); counts.peer += 1; peers.push(this); }
  createDataChannel() { return this.channel; }
  addTrack() {}
  async createOffer() { return { type: "offer", sdp: "v=0\r\n" }; }
  async setLocalDescription(description) { this.localDescription = description; }
  async setRemoteDescription() {
    if (this.connectionState === "closed") throw new DOMException("Fixture peer is closed", "InvalidStateError");
    this.connectionState = "connected";
    this.dispatchEvent(new Event("connectionstatechange"));
    this.ontrack?.({ streams: [{}] });
  }
  close() { this.connectionState = "closed"; this.dispatchEvent(new Event("connectionstatechange")); }
}
window.RTCPeerConnection = FakePeer;
class FakeAudioContext {
  state = "running";
  sampleRate = 48000;
  destination = {};
  constructor() { counts.audioContext += 1; contexts.push(this); }
  async resume() { this.state = "running"; }
  async close() { counts.contextClose += 1; await waitAt("contextClose"); this.state = "closed"; }
  createMediaElementSource() { return { connect() {}, disconnect() {} }; }
  createAnalyser() { return { fftSize: 1024, connect() {}, disconnect() {}, getFloatTimeDomainData(samples) { samples.fill(0); } }; }
  createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
}
window.AudioContext = FakeAudioContext;
const mediaSources = new WeakMap();
Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
  configurable: true, get() { return mediaSources.get(this) ?? null; }, set(value) { mediaSources.set(this, value); },
});
HTMLMediaElement.prototype.play = async function () {
  counts.play += 1;
  if (rejectPlayback) throw Object.assign(new Error("Fixture playback blocked"), { code: "LIVE_PLAYBACK_FAILED" });
};
HTMLMediaElement.prototype.pause = function () { counts.pause += 1; };
window.addEventListener("error", (event) => errors.push(event.message));
window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));

await i18n.use(initReactI18next).init({
  lng: "en", fallbackLng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false },
});
useAppStore.setState({ sessions, activeSessionId: sessions[0].id, settings });
const controller = getLiveCallController();
/** Set by the fixture shell so a scenario can resize the emulated widget window. */
let setFixtureWidgetWidth = () => {};

function SimulatedShell() {
  const [route, setRoute] = useState("chat");
  const [hidden, setHidden] = useState(false);
  // The window main gives the widget is a fixed width until the bar reports the
  // box it needs; the scenario can narrow it to prove the bar neither folds nor
  // under-reports its width.
  const [widgetWidth, setWidgetWidth] = useState(420);
  useEffect(() => {
    setFixtureWidgetWidth = setWidgetWidth;
  }, []);
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  useEffect(() => {
    useAppStore.setState({ page: route });
  }, [route]);
  useEffect(() => {
    // Production matcher + dispatcher, not the unrelated full AppShell runtime.
    const onKeyDown = (event) => {
      if (event.repeat || event.defaultPrevented) return;
      const platform = window.piDesktop.platform;
      const shortcut = KEYBOARD_SHORTCUTS.find((item) => ["voiceToggle", "voiceCancel"].includes(item.id)
        && keybindingMatchesEvent(resolveKeybinding(item, settings.keybindings, platform), event, platform));
      if (shortcut && runLiveVoiceShortcut(shortcut.id)) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  return (
    <div style={{ minHeight: "100vh", padding: 32 }}>
      <nav aria-label="Fixture shell navigation" style={{ display: "flex", gap: 16 }}>
        <button onClick={() => setRoute("settings")}>Fixture settings route</button>
        <button onClick={() => { setRoute("chat"); setHidden(false); }}>Fixture chat route</button>
        <button onClick={() => setHidden((value) => !value)}>Fixture toggle composer visibility</button>
        <button onClick={() => useAppStore.setState({ activeSessionId: sessions[1].id })}>Fixture switch session</button>
      </nav>
      <main><p>Simulated shell boundary, not a mounted AppShell.</p></main>
      {route === "chat" ? (
        <PortalVisibilityProvider visible={!hidden}>
          <div data-fixture-composer hidden={hidden} style={{ position: "absolute", bottom: 72, left: 64 }}>
            <LiveVoiceControls t={i18n.t.bind(i18n)} workSessionId={activeSessionId} workSessionLabel="Fixture project / Alpha" />
          </div>
        </PortalVisibilityProvider>
      ) : <p data-fixture-settings>Settings route: composer unmounted</p>}
      <LiveVoiceStatusHost />
      {/* The docked widget window, mounted in the same document: it is the call
          chrome now, and its presses travel through the widget IPC channels.
          The wrapper is the fixed-width surface the real window is: without it a
          wrapped status line would go unnoticed, because the fixture document is
          wider than the window the bar is drawn in. */}
      <div data-fixture-widget-window style={{ width: widgetWidth, overflow: "hidden" }}>
        <LiveVoiceWidget />
      </div>
      <ToastHost />
    </div>
  );
}
createRoot(document.getElementById("root")).render(<SimulatedShell />);
window.liveVoiceFixture = {
  hold(name) {
    if (gates.has(name)) throw new Error(`Gate already held: ${name}`);
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    gates.set(name, { promise, resolve });
  },
  release(name) {
    const gate = gates.get(name);
    if (!gate) throw new Error(`Gate not held: ${name}`);
    gates.delete(name); gate.resolve();
  },
  async configure(patch) {
    if (patch.enabled !== undefined) status.enabled = settings.liveVoice.enabled = patch.enabled;
    if (patch.selectedAvailable !== undefined) {
      status.bindings[0].selectable = patch.selectedAvailable;
      status.bindings[0].credentialsPresent = patch.selectedAvailable;
      status.bindings[0].reason = patch.selectedAvailable ? undefined : "missing-credentials";
    }
    status.settingsRevision += 1;
    emit(IPC.event.settingsChanged, { liveVoice: settings.liveVoice });
    await controller.refreshStatus();
  },
  blockPlayback(blocked) { rejectPlayback = blocked; },
  beginClosing,
  setPhase(phase) { updateCall({ phase }); },
  switchSession(sessionId) { useAppStore.setState({ activeSessionId: sessionId }); },
  failReleaseReport() { rejectReleaseReport = true; },
  terminal() { updateCall({ phase: "ended" }); },
  terminalUnconfirmed() {
    updateCall({ phase: "failed", mediaRelease: "unconfirmed", error: {
      code: "LIVE_MEDIA_RELEASE_UNCONFIRMED", stage: "cleanup", retriable: false,
    } });
  },
  async attemptStart() {
    try { await controller.start(); return null; }
    catch (error) { return error && typeof error === "object" && "code" in error ? error.code : "unknown"; }
  },
  transcript(text) {
    emit(IPC.event.liveVoiceTranscript, { callId: call.callId,
      segment: { id: "fixture-transcript", role: "assistant", text, final: true, timestamp: 0 } });
  },
  // Narrow the window main gives the widget, so a status line no longer fits: a
  // bar that folds or under-reports its width fails the assertion after it.
  // The pending queues live in the owner window's store; the widget window has
  // none. Seeding one here exercises the "owner reports it, main forwards it"
  // path end to end instead of the bar reading a store it does not have.
  pendingAsk(sessionId, question) {
    useAppStore.setState((state) => ({
      pendingAsks: {
        ...state.pendingAsks,
        [sessionId]: [{
          requestId: "ask-fixture",
          sessionId,
          toolCallId: "call_ask",
          questions: [{ question, options: [{ label: "yes" }] }],
        }],
      },
    }));
  },
  clearPendingAsks() {
    useAppStore.setState({ pendingAsks: {} });
  },
  setWidgetWindowWidth(width) { setFixtureWidgetWidth(width); },
  inspect() {
    return {
      snapshot: controller.getSnapshot(), counts, requests, errors,
      tracks: tracks.map(({ enabled, readyState }) => ({ enabled, readyState })),
      contexts: contexts.map(({ state }) => ({ state })),
      peers: peers.map(({ connectionState }) => ({ connectionState })), held: [...gates.keys()],
      widget: {
        presentation: widgetReports.presentation,
        actions: [...widgetReports.actions],
        visible: widgetReports.presentation?.visible === true,
        ownerState: { errorCode: widgetReports.errorCode ?? null, decisionWaiting: widgetReports.decisionWaiting },
      },
    };
  },
};

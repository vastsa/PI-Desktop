import {
  parseCodexMessage,
  codexDelegationFeedback,
  codexWorkFeedbackMessage,
  isPlaybackSignalActive,
} from "@pi-desktop/voice-runtime/live";
import type {
  LiveCallView,
  LiveControlEvent,
  LiveStatus,
  LiveTranscriptSegment,
} from "@pi-desktop/shared";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";
import { liveVoiceApi, liveError } from "./live-voice-api";
import { LivePcmSession } from "./live-pcm-session";
import pcmWorkletUrl from "./pcm-worklet.js?url";

export type LiveVoiceSnapshot = {
  status: LiveStatus | null;
  call: LiveCallView | null;
  transcripts: LiveTranscriptSegment[];
  starting: boolean;
  stopping: boolean;
  errorCode?: string;
};

const EMPTY_SNAPSHOT: LiveVoiceSnapshot = {
  status: null,
  call: null,
  transcripts: [],
  starting: false,
  stopping: false,
};
const MAX_TRANSCRIPTS = 40;
const ICE_GATHER_TIMEOUT_MS = 10_000;

type StartResources = {
  requestId: string;
  callId?: string;
  microphoneRequest?: Promise<MediaStream>;
  microphoneRequestSettled?: boolean;
  stream?: MediaStream;
  streamStopped?: boolean;
  context?: AudioContext;
  port?: MessagePort;
  pcm?: LivePcmSession;
  peer?: RTCPeerConnection;
  channel?: RTCDataChannel;
  audio?: HTMLAudioElement;
  playbackAnalyser?: AnalyserNode;
  playbackSource?: MediaElementAudioSourceNode;
  playbackGain?: GainNode;
  playbackMonitorFrame?: number;
  playbackActive?: boolean;
  heartbeat?: ReturnType<typeof setInterval>;
  captureEpoch: number;
  releasePromise?: Promise<boolean>;
  releaseReportPromise?: Promise<void>;
  localReleaseSettled?: boolean;
  mainTerminationSettled?: boolean;
  releaseAckSettled?: boolean;
  releaseFailed?: boolean;
  abort: AbortController;
  completedControlActions?: Set<string>;
};

/** Window-lifetime owner for Live media. React subscriptions never own it. */
export class LiveCallController {
  private snapshot: LiveVoiceSnapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private readonly resources = new Map<string, StartResources>();
  private readonly pendingPorts = new Map<string, { port: MessagePort; nonce: string }>();
  private readonly portWaiters = new Map<string, { nonce: string; resolve: (port: MessagePort) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly disposers: Array<() => void> = [];
  private readonly terminalCallIds = new Set<string>();
  private generation = 0;
  private microphoneDeviceId: string | null = null;

  constructor() {
    this.disposers.push(
      liveVoiceApi.onView((view) => this.handleView(view)),
      liveVoiceApi.onControl((event) => this.handleControl(event)),
      liveVoiceApi.onTranscript((event) => this.handleTranscript(event.callId, event.segment)),
      api.onSettingsChanged((patch) => {
        const voice = patch.voice;
        if (voice && typeof voice === "object" && "deviceId" in voice) {
          const deviceId = (voice as { deviceId?: unknown }).deviceId;
          this.microphoneDeviceId = typeof deviceId === "string" && deviceId ? deviceId : null;
        }
      }),
    );
    this.disposers.push(window.piDesktop?.onLiveVoicePort?.() ?? (() => undefined));
    window.addEventListener("message", this.handlePortMessage);
    window.addEventListener("pagehide", this.handlePageHide, { once: true });
    void this.refreshStatus();
    void api.getSettings().then((settings) => {
      this.microphoneDeviceId = settings.voice?.deviceId ?? null;
    }).catch(() => undefined);
  }

  readonly getSnapshot = (): LiveVoiceSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async refreshStatus(): Promise<void> {
    try {
      const status = await liveVoiceApi.status();
      this.patch({ status });
    } catch (error) {
      this.patch({ errorCode: errorCode(error) });
    }
  }

  async start(options: { workTarget?: { workSessionId: string }; shareSelectedSessionContext?: boolean } = {}): Promise<void> {
    if (this.snapshot.starting || this.snapshot.stopping || isLive(this.snapshot.call?.phase)) return;
    if (this.snapshot.call?.error?.code === "LIVE_MEDIA_RELEASE_UNCONFIRMED" || this.snapshot.errorCode === "LIVE_MEDIA_RELEASE_UNCONFIRMED") {
      this.patch({ errorCode: "LIVE_MEDIA_RELEASE_UNCONFIRMED" });
      throw liveError("LIVE_MEDIA_RELEASE_UNCONFIRMED");
    }
    const generation = ++this.generation;
    const cachedStatus = this.snapshot.status;
    if (!cachedStatus?.enabled) throw liveError("LIVE_DISABLED");
    const selectedId = cachedStatus.selectedBindingId;
    const selected = cachedStatus.bindings.find((item) => item.bindingId === selectedId && item.selectable);
    if (!selected) throw liveError("LIVE_NOT_CONFIGURED");

    const currentSessionId = options.workTarget?.workSessionId ?? useAppStore.getState().activeSessionId;
    const workTarget = currentSessionId ? { workSessionId: currentSessionId } : undefined;
    const requestId = crypto.randomUUID();
    const resources: StartResources = { requestId, abort: new AbortController(), captureEpoch: 0, completedControlActions: new Set() };
    this.resources.set(requestId, resources);
    this.patch({ starting: true, stopping: false, errorCode: undefined, transcripts: [] });

    let prepareRequest: ReturnType<typeof liveVoiceApi.prepare> | undefined;
    let micRequest: Promise<MediaStream> | undefined;
    try {
      // Browser activation is transient: begin permission and AudioContext work
      // synchronously in the click handler. Main reserves the microphone lease
      // as soon as it accepts prepare, before this renderer permission prompt.
      prepareRequest = liveVoiceApi.prepare({
        requestId,
        bindingId: selected.bindingId,
        expectedSettingsRevision: cachedStatus.settingsRevision,
        initialMuted: true,
        ...(workTarget ? { workTarget } : {}),
        ...(options.shareSelectedSessionContext !== undefined ? { shareSelectedSessionContext: options.shareSelectedSessionContext } : {}),
      });
      void prepareRequest.then((prepared) => {
        if (resources.abort.signal.aborted || generation !== this.generation) {
          void liveVoiceApi.end({ callId: prepared.callId, reason: "user-cancelled-start" }).catch(() => undefined);
        }
      }).catch(() => undefined);
      micRequest = requestMicrophone(this.microphoneDeviceId);
      resources.microphoneRequest = micRequest;
      void micRequest.then((stream) => {
        resources.microphoneRequestSettled = true;
        resources.stream = stream;
        if (resources.abort.signal.aborted || generation !== this.generation) this.stopCapture(resources);
      }, () => {
        resources.microphoneRequestSettled = true;
      });
      resources.context = new AudioContext({ sampleRate: 48_000 });
      void resources.context.resume().catch(() => undefined);
      if (!prepareRequest || !micRequest) throw liveError("LIVE_MEDIA_UNSUPPORTED");
      const [stream, freshStatus, prepared] = await Promise.all([
        abortableMicrophone(micRequest, resources.abort.signal),
        liveVoiceApi.status(),
        prepareRequest,
      ]);
      resources.callId = prepared.callId;
      this.resources.set(prepared.callId, resources);
      if (generation !== this.generation) throw liveError("LIVE_STALE_CALL");
      const freshBinding = freshStatus.bindings.find((item) => item.bindingId === selected.bindingId && item.selectable);
      if (!freshStatus.enabled || freshStatus.settingsRevision !== cachedStatus.settingsRevision || freshStatus.selectedBindingId !== cachedStatus.selectedBindingId || !freshBinding) {
        await liveVoiceApi.end({ callId: prepared.callId, reason: "user-cancelled-start" }).catch(() => undefined);
        throw liveError("LIVE_SETTINGS_IN_USE");
      }
      this.patch({ status: freshStatus });
      if (generation !== this.generation || resources.abort.signal.aborted) throw liveError("LIVE_STALE_CALL");
      resources.stream = stream;
      if (resources.stream.getAudioTracks().length !== 1) throw liveError("LIVE_MEDIA_UNSUPPORTED");
      await liveVoiceApi.reportMedia({ callId: prepared.callId, kind: "microphone-active", active: true });
      this.patchCallIfNewer({ callId: prepared.callId, revision: prepared.revision, bindingId: prepared.bindingId, adapterId: prepared.adapterId, phase: "acquiring-mic", muted: true, microphoneActive: true, userSpeaking: false, assistantSpeaking: false, mediaRelease: "pending" });

      if (prepared.mediaKind === "pcm") {
        if (!prepared.portNonce) throw liveError("LIVE_PROTOCOL_ERROR");
        const port = await this.waitForPort(prepared.callId, prepared.portNonce, resources.abort.signal);
        resources.port = port;
        const context = resources.context;
        if (!context) throw liveError("LIVE_MEDIA_UNSUPPORTED");
        resources.pcm = await LivePcmSession.create({
          callId: prepared.callId,
          portNonce: prepared.portNonce,
          port,
          stream: resources.stream,
          inputSampleRate: prepared.inputSampleRate,
          workletUrl: pcmWorkletUrl,
          context,
          onFailure: (error) => void this.failActive(prepared.callId, error),
          onPlayback: (cursors) => void liveVoiceApi.reportPlayback({ callId: prepared.callId, cursors }).catch((error) => this.failActive(prepared.callId, error)),
        });
        await resources.pcm.start(Promise.resolve(), resources.abort.signal);
        await liveVoiceApi.reportMedia({ callId: prepared.callId, kind: "phase", phase: "connecting" });
        await liveVoiceApi.connect({ callId: prepared.callId });
      } else {
        await this.connectWebRtc(prepared.callId, resources);
      }
      if (generation !== this.generation || resources.abort.signal.aborted) throw liveError("LIVE_STALE_CALL");
      await liveVoiceApi.reportMedia({ callId: prepared.callId, kind: "phase", phase: "connected" });
      this.patch({ starting: false });
      resources.heartbeat = setInterval(() => {
        void liveVoiceApi.heartbeat(prepared.callId).catch((error) => this.failActive(prepared.callId, error));
      }, 5_000);
    } catch (error) {
      void micRequest?.then((stream) => stopStream(stream)).catch(() => undefined);
      try {
        if (resources.callId) {
          await liveVoiceApi.end({ callId: resources.callId, reason: resources.abort.signal.aborted ? "user-cancelled-start" : "network-error" });
        } else {
          await liveVoiceApi.end({ requestId, reason: "user-cancelled-start" });
          resources.mainTerminationSettled = true;
        }
      } catch (endError) {
        this.patch({ errorCode: errorCode(endError) });
      }
      await this.releaseResources(resources, Boolean(resources.callId));
      const currentCall = this.snapshot.call;
      const terminalCall = currentCall?.phase === "ended" || currentCall?.phase === "failed";
      const preserveCall = terminalCall && (!resources.callId || resources.callId === currentCall.callId);
      const cancelled = resources.abort.signal.aborted && (generation !== this.generation || this.snapshot.stopping);
      this.patch({
        starting: false,
        ...(preserveCall ? {} : { call: null }),
        ...(!cancelled
          ? { errorCode: resources.releaseFailed ? "LIVE_MEDIA_RELEASE_UNCONFIRMED" : currentCall?.error?.code ?? errorCode(error) }
          : resources.releaseFailed ? { errorCode: "LIVE_MEDIA_RELEASE_UNCONFIRMED" } : {}),
      });
      this.completeResourceLifecycle(resources);
      throw error;
    } finally {
      if (this.snapshot.starting && generation === this.generation && !resources.callId) this.patch({ starting: false });
    }
  }

  async cancelStart(): Promise<void> {
    const resource = this.snapshot.starting ? [...this.resources.values()].at(-1) : undefined;
    if (!resource) return;
    this.generation += 1;
    resource.abort.abort();
    this.patch({ starting: false, stopping: true });
    try {
      if (resource.callId) await liveVoiceApi.end({ callId: resource.callId, reason: "user-cancelled-start" });
      else {
        await liveVoiceApi.end({ requestId: resource.requestId, reason: "user-cancelled-start" });
        resource.mainTerminationSettled = true;
        resource.releaseAckSettled = true;
      }
    } catch (error) {
      this.patch({ errorCode: errorCode(error) });
    }
    await this.releaseResources(resource, Boolean(resource.callId));
    this.completeResourceLifecycle(resource);
  }

  async toggleMute(): Promise<void> {
    const call = this.snapshot.call;
    if (this.snapshot.stopping || !call || call.phase !== "connected") return;
    const resources = this.resources.get(call.callId);
    if (!resources) return;
    const muted = !call.muted;
    const captureEpoch = resources.captureEpoch + 1;
    resources.captureEpoch = captureEpoch;
    try {
      if (resources.pcm) resources.pcm.applyGate(muted, captureEpoch);
      else for (const track of resources.stream?.getAudioTracks() ?? []) track.enabled = !muted;
      const updated = await liveVoiceApi.setMuted({ callId: call.callId, muted, captureEpoch });
      this.patch({ call: updated });
    } catch (error) {
      for (const track of resources.stream?.getAudioTracks() ?? []) track.enabled = false;
      resources.pcm?.applyGate(true, captureEpoch + 1);
      this.patch({ call: { ...call, muted: true }, errorCode: errorCode(error) });
      await this.failActive(call.callId, error);
    }
  }

  async resumePlayback(): Promise<void> {
    const call = this.snapshot.call;
    if (this.snapshot.stopping || !call) return;
    const resources = this.resources.get(call.callId);
    if (!resources) return;
    try {
      await resources.context?.resume();
      await resources.pcm?.resumePlayback();
      await resources.audio?.play();
      await liveVoiceApi.reportMedia({ callId: call.callId, kind: "playback-blocked", blocked: false });
      if (this.snapshot.errorCode === "LIVE_PLAYBACK_FAILED" || this.snapshot.errorCode === "LIVE_PLAYBACK_BLOCKED") {
        this.patch({ errorCode: undefined });
      }
    } catch (error) {
      this.patch({ errorCode: errorCode(error) });
    }
  }

  async end(): Promise<void> {
    const call = this.snapshot.call;
    if (!call) return this.cancelStart();
    const resources = this.resources.get(call.callId);
    this.patch({ stopping: true });
    try {
      await liveVoiceApi.end({ callId: call.callId, reason: "user-ended" });
      const latest = this.snapshot.call;
      if (resources && latest?.callId === call.callId && (latest.phase === "ended" || latest.phase === "failed")) {
        resources.mainTerminationSettled = true;
        if (!resources.releaseReportPromise) resources.releaseAckSettled = true;
        this.completeResourceLifecycle(resources);
      } else if (!resources && latest?.callId === call.callId && (latest.phase === "ended" || latest.phase === "failed")) {
        this.patch({ stopping: false });
      }
    } catch (error) {
      const latest = this.snapshot.call;
      const awaitingRelease = resources
        ? !resources.localReleaseSettled || !resources.mainTerminationSettled || Boolean(resources.callId && !resources.releaseAckSettled)
        : latest?.callId === call.callId && latest.phase === "closing";
      this.patch({ errorCode: errorCode(error), stopping: awaitingRelease });
    }
  }

  private async connectWebRtc(callId: string, resources: StartResources): Promise<void> {
    const stream = resources.stream;
    if (!stream) throw liveError("LIVE_MEDIA_UNSUPPORTED");
    const peer = new RTCPeerConnection({ iceServers: [] });
    resources.peer = peer;
    const channel = peer.createDataChannel("oai-events");
    resources.channel = channel;
    channel.onmessage = (event) => this.handleCodexData(callId, resources, event.data);
    channel.onerror = () => void this.failActive(callId, liveError("LIVE_NETWORK_ERROR"));
    channel.onclose = () => {
      if (!resources.abort.signal.aborted) void this.failActive(callId, liveError("LIVE_NETWORK_ERROR"));
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "failed" && !resources.abort.signal.aborted) void this.failActive(callId, liveError("LIVE_NETWORK_ERROR"));
    };
    for (const track of stream.getAudioTracks()) {
      track.enabled = false;
      peer.addTrack(track, stream);
    }
    peer.ontrack = (event) => {
      const audio = document.createElement("audio");
      audio.autoplay = true;
      audio.setAttribute("playsinline", "");
      audio.setAttribute("aria-hidden", "true");
      audio.style.position = "fixed";
      audio.style.width = "1px";
      audio.style.height = "1px";
      audio.style.opacity = "0";
      const remoteStream = event.streams[0] ?? new MediaStream([event.track]);
      audio.srcObject = remoteStream;
      document.body.append(audio);
      resources.audio?.remove();
      resources.audio = audio;
      if (resources.context) this.startPlaybackMonitor(callId, resources, audio);
      void audio.play().then(
        () => liveVoiceApi.reportMedia({ callId, kind: "playback-blocked", blocked: false }).catch(() => undefined),
        () => liveVoiceApi.reportMedia({ callId, kind: "playback-blocked", blocked: true }).catch(() => undefined),
      );
    };
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await waitForIceGathering(peer, resources.abort.signal);
    const offerSdp = peer.localDescription?.sdp;
    if (!offerSdp) throw liveError("LIVE_PROTOCOL_ERROR");
    await liveVoiceApi.reportMedia({ callId, kind: "phase", phase: "connecting" });
    const result = await liveVoiceApi.connect({ callId, offerSdp });
    if (!result.answerSdp) throw liveError("LIVE_PROTOCOL_ERROR");
    await peer.setRemoteDescription({ type: "answer", sdp: result.answerSdp });
    await Promise.all([
      waitForPeerConnection(peer, resources.abort.signal),
      waitForDataChannel(channel, resources.abort.signal),
    ]);
  }

  private handleCodexData(callId: string, resources: StartResources, raw: unknown): void {
    if (typeof raw !== "string" || raw.length > 2 * 1024 * 1024) {
      void this.failActive(callId, liveError("LIVE_PROTOCOL_ERROR"));
      return;
    }
    try {
      const value: unknown = JSON.parse(raw);
      for (const event of parseCodexMessage(value)) {
        switch (event.kind) {
          case "delegation":
            void liveVoiceApi.reportDelegation({ callId, delegationId: event.delegationId, instruction: event.instruction }).catch((error) => this.failActive(callId, error));
            break;
          case "transcript":
            this.handleTranscript(callId, { id: event.id, role: event.role, text: event.text, final: event.final, timestamp: Date.now() });
            break;
          case "activity":
            void liveVoiceApi.reportMedia({ callId, kind: "activity", userSpeaking: event.userSpeaking, assistantSpeaking: event.assistantSpeaking }).catch((error) => this.failActive(callId, error));
            break;
          case "error":
            void this.failActive(callId, liveError(event.code));
            break;
          default:
            break;
        }
      }
    } catch (error) {
      void this.failActive(callId, liveError("LIVE_PROTOCOL_ERROR", String(error)));
    }
  }

  private startPlaybackMonitor(callId: string, resources: StartResources, audio: HTMLAudioElement): void {
    this.stopPlaybackMonitor(resources);
    const context = resources.context;
    if (!context) return;
    let source: MediaElementAudioSourceNode | undefined;
    try {
      source = context.createMediaElementSource(audio);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1_024;
      const gain = context.createGain();
      gain.gain.value = 1;
      source.connect(analyser);
      analyser.connect(gain);
      gain.connect(context.destination);
      resources.playbackSource = source;
      resources.playbackAnalyser = analyser;
      resources.playbackGain = gain;
      const samples = new Float32Array(analyser.fftSize);
      const report = (active: boolean) => {
        if (resources.playbackActive === active) return;
        resources.playbackActive = active;
        void liveVoiceApi.reportMedia({ callId, kind: "playback-activity", active, ready: true }).catch(() => undefined);
      };
      const sample = () => {
        if (resources.abort.signal.aborted) return;
        if (context.state === "closed") {
          report(true);
          return;
        }
        if (context.state !== "running") report(true);
        else {
          analyser.getFloatTimeDomainData(samples);
          report(isPlaybackSignalActive(samples));
        }
        resources.playbackMonitorFrame = requestAnimationFrame(sample);
      };
      report(context.state !== "running");
      resources.playbackMonitorFrame = requestAnimationFrame(sample);
    } catch {
      // Preserve audio output, but keep Main fail-closed if monitoring fails.
      try { source?.connect(context.destination); } catch { /* audio remains unavailable through this context */ }
      resources.playbackActive = true;
      void liveVoiceApi.reportMedia({ callId, kind: "playback-activity", active: true, ready: true }).catch(() => undefined);
      this.stopPlaybackMonitor(resources);
    }
  }

  private stopPlaybackMonitor(resources: StartResources): void {
    if (resources.playbackMonitorFrame !== undefined) cancelAnimationFrame(resources.playbackMonitorFrame);
    resources.playbackMonitorFrame = undefined;
    resources.playbackSource?.disconnect();
    resources.playbackAnalyser?.disconnect();
    resources.playbackGain?.disconnect();
    resources.playbackSource = undefined;
    resources.playbackAnalyser = undefined;
    resources.playbackGain = undefined;
  }

  private readonly handlePortMessage = (event: MessageEvent): void => {
    // Electron serializes file:// as the opaque "null" origin on window.postMessage.
    // The source-window check and per-call nonce still bind this transfer to our renderer.
    const trustedFileOrigin = window.location.protocol === "file:" && event.origin === "null";
    if (event.source !== window || (!trustedFileOrigin && event.origin !== window.location.origin) || !event.data || typeof event.data !== "object") return;
    const data = event.data as { kind?: unknown; callId?: unknown; nonce?: unknown };
    const port = event.ports[0];
    if (data.kind !== "pi-desktop-live-voice-port" || typeof data.callId !== "string" || typeof data.nonce !== "string" || !/^[0-9a-f-]{36}$/i.test(data.nonce) || !port || event.ports.length !== 1) return;
    const waiter = this.portWaiters.get(data.callId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.portWaiters.delete(data.callId);
      if (waiter.nonce === data.nonce) waiter.resolve(port);
      else {
        port.close();
        waiter.reject(liveError("LIVE_INVALID_OWNER"));
      }
      return;
    }
    for (const [priorId, priorPort] of this.pendingPorts) {
      priorPort.port.close();
      this.pendingPorts.delete(priorId);
    }
    this.pendingPorts.set(data.callId, { port, nonce: data.nonce });
  };

  private waitForPort(callId: string, nonce: string, signal: AbortSignal): Promise<MessagePort> {
    const pending = this.pendingPorts.get(callId);
    if (pending) {
      this.pendingPorts.delete(callId);
      if (pending.nonce === nonce) return Promise.resolve(pending.port);
      pending.port.close();
      return Promise.reject(liveError("LIVE_INVALID_OWNER"));
    }
    return new Promise<MessagePort>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.portWaiters.delete(callId);
        signal.removeEventListener("abort", onAbort);
        reject(liveError("LIVE_TIMEOUT"));
      }, 3_000);
      const onAbort = () => {
        clearTimeout(timer);
        this.portWaiters.delete(callId);
        reject(liveError("LIVE_STALE_CALL"));
      };
      this.portWaiters.set(callId, {
        nonce,
        resolve: (port) => {
          signal.removeEventListener("abort", onAbort);
          resolve(port);
        },
        reject,
        timer,
      });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private handleView(view: LiveCallView): void {
    if (this.terminalCallIds.has(view.callId)) return;
    const current = this.snapshot.call;
    if (current?.callId === view.callId && view.revision < current.revision) return;
    const resources = this.resources.get(view.callId) ?? (view.phase === "preparing"
      ? [...this.resources.values()].find((item) => !item.callId)
      : undefined);
    if (resources && !resources.callId) {
      resources.callId = view.callId;
      this.resources.set(view.callId, resources);
    }
    if (view.phase === "closing") {
      this.patch({ call: view, stopping: true });
      return;
    }
    if (view.phase === "ended" || view.phase === "failed") {
      this.terminalCallIds.add(view.callId);
      while (this.terminalCallIds.size > 16) this.terminalCallIds.delete(this.terminalCallIds.values().next().value as string);
      if (resources) {
        resources.mainTerminationSettled = true;
        if (!resources.releaseReportPromise) resources.releaseAckSettled = true;
        this.patch({ call: view, stopping: !resources.localReleaseSettled || !resources.releaseAckSettled });
        void this.releaseResources(resources, view.mediaRelease === "pending").then(() => this.completeResourceLifecycle(resources));
      } else {
        this.patch({ call: view, starting: false, stopping: false });
      }
      return;
    }
    this.patch({ call: view });
  }

  private handleControl(event: LiveControlEvent): void {
    const resources = this.resources.get(event.callId);
    if (!resources) return;
    if (event.kind === "release-media") {
      void this.releaseResources(resources, true);
      return;
    }
    if (event.kind === "playback-reset") {
      resources.pcm?.resetPlayback(event.playbackEpoch);
      return;
    }
    if (event.kind === "work-receipt") {
      this.sendCodexControl(event.callId, event.actionId, event.delegationId, event.receipt, resources);
      return;
    }
    if (event.kind === "work-navigation") {
      const completed = resources.completedControlActions ?? (resources.completedControlActions = new Set());
      if (completed.has(event.actionId)) {
        void liveVoiceApi.reportControlApplied({ callId: event.callId, actionId: event.actionId, applied: true });
        return;
      }
      void useAppStore.getState().selectSession(event.sessionId).then(() => {
        completed.add(event.actionId);
        while (completed.size > 256) completed.delete(completed.values().next().value as string);
        return liveVoiceApi.reportControlApplied({ callId: event.callId, actionId: event.actionId, applied: true });
      }).catch(() => liveVoiceApi.reportControlApplied({
        callId: event.callId,
        actionId: event.actionId,
        applied: false,
        errorCode: "LIVE_WORK_SESSION_UNAVAILABLE",
      }));
      return;
    }
    if (event.kind === "work-feedback") {
      const call = this.snapshot.call;
      const feedbackBytes = new TextEncoder().encode(event.feedback.content).byteLength;
      if (
        !call || call.callId !== event.callId ||
        call.workBinding?.workBindingRevision !== event.feedback.workBindingRevision ||
        event.feedback.callId !== event.callId || !event.feedback.feedbackId ||
        feedbackBytes === 0 || feedbackBytes > 1_200 || !event.delegationId.trim()
      ) {
        void liveVoiceApi.reportControlApplied({ callId: event.callId, actionId: event.actionId, applied: false, errorCode: "LIVE_WORK_FEEDBACK_UNDELIVERED" });
        return;
      }
      this.sendCodexWorkFeedback(event.callId, event.actionId, event.delegationId, event.feedback, resources);
      return;
    }
    if (event.kind !== "reject-delegation") return;
    this.sendCodexControl(event.callId, event.actionId, event.delegationId, undefined, resources);
  }

  private sendCodexWorkFeedback(
    callId: string,
    actionId: string,
    delegationId: string,
    feedback: Extract<LiveControlEvent, { kind: "work-feedback" }>['feedback'],
    resources: StartResources,
  ): void {
    const completed = resources.completedControlActions ?? (resources.completedControlActions = new Set());
    if (completed.has(actionId)) {
      void liveVoiceApi.reportControlApplied({ callId, actionId, applied: true });
      return;
    }
    try {
      const channel = resources.channel;
      if (!channel || channel.readyState !== "open") throw liveError("LIVE_NETWORK_ERROR");
      channel.send(codexWorkFeedbackMessage(delegationId, feedback));
      completed.add(actionId);
      while (completed.size > 256) completed.delete(completed.values().next().value as string);
      void liveVoiceApi.reportControlApplied({ callId, actionId, applied: true });
    } catch (error) {
      void liveVoiceApi.reportControlApplied({ callId, actionId, applied: false, errorCode: errorCode(error) });
    }
  }

  private sendCodexControl(
    callId: string,
    actionId: string,
    delegationId: string,
    receipt: { status: "received"; operationId: string; providerRequestId: string; execution: "not_started" } | { status: "rejected"; providerRequestId: string; code: string } | undefined,
    resources: StartResources,
  ): void {
    const completed = resources.completedControlActions ?? (resources.completedControlActions = new Set());
    if (completed.has(actionId)) {
      void liveVoiceApi.reportControlApplied({ callId, actionId, applied: true });
      return;
    }
    const channel = resources.channel;
    try {
      if (!channel || channel.readyState !== "open") throw liveError("LIVE_NETWORK_ERROR");
      channel.send(codexDelegationFeedback(delegationId, receipt?.status === "received" ? { operationId: receipt.operationId, status: "received" } : undefined));
      completed.add(actionId);
      while (completed.size > 256) completed.delete(completed.values().next().value as string);
      void liveVoiceApi.reportControlApplied({ callId, actionId, applied: true });
    } catch (error) {
      void liveVoiceApi.reportControlApplied({ callId, actionId, applied: false, errorCode: errorCode(error) });
    }
  }

  private handleTranscript(callId: string, segment: LiveTranscriptSegment): void {
    const call = this.snapshot.call;
    if (!call || call.callId !== callId) return;
    const current = this.snapshot.transcripts;
    const index = current.findIndex((item) => item.id === segment.id && item.role === segment.role);
    const next = index >= 0
      ? current.map((item, itemIndex) => itemIndex === index ? segment : item)
      : [...current, segment].slice(-MAX_TRANSCRIPTS);
    this.patch({ transcripts: next });
  }

  private async failActive(callId: string, error: unknown): Promise<void> {
    const resources = this.resources.get(callId);
    if (!resources) return;
    this.patch({ errorCode: errorCode(error) });
    await liveVoiceApi.end({ callId, reason: "network-error" }).catch(() => undefined);
  }

  private releaseResources(resources: StartResources, notifyMain: boolean): Promise<void> {
    if (!resources.releasePromise) {
      resources.releasePromise = this.releaseResourcesOnce(resources).then((released) => {
        resources.localReleaseSettled = true;
        if (!released) {
          resources.releaseFailed = true;
          this.patch({ errorCode: "LIVE_MEDIA_RELEASE_UNCONFIRMED" });
        }
        this.completeResourceLifecycle(resources);
        return released;
      });
    }
    if (notifyMain && resources.callId && !resources.releaseReportPromise) {
      const released = resources.pcm
        ? resources.releasePromise.then((ok) => {
          if (!ok) throw liveError("LIVE_MEDIA_RELEASE_UNCONFIRMED");
        })
        : this.reportMicrophoneReleased(resources).then(async () => {
          await liveVoiceApi.reportMedia({ callId: resources.callId!, kind: "released" });
        });
      resources.releaseReportPromise = released.catch(() => {
        resources.releaseFailed = true;
        this.patch({ errorCode: "LIVE_MEDIA_RELEASE_UNCONFIRMED" });
      }).finally(() => {
        resources.releaseAckSettled = true;
        this.completeResourceLifecycle(resources);
      });
    }
    return resources.releaseReportPromise ?? resources.releasePromise.then(() => undefined);
  }

  private async reportMicrophoneReleased(resources: StartResources): Promise<void> {
    if (resources.microphoneRequest && !resources.microphoneRequestSettled) {
      await resources.microphoneRequest.then(() => undefined, () => undefined);
    }
    if (!this.stopCapture(resources)) {
      throw liveError("LIVE_MEDIA_RELEASE_UNCONFIRMED");
    }
  }

  private stopCapture(resources: StartResources): boolean {
    if (resources.streamStopped || !resources.stream) return true;
    try {
      stopStream(resources.stream);
      resources.streamStopped = true;
      return true;
    } catch {
      return false;
    }
  }

  private async releaseResourcesOnce(resources: StartResources): Promise<boolean> {
    let released = true;
    const cleanup = (action: () => void) => {
      try { action(); } catch { released = false; }
    };
    const cleanupAsync = async (action: () => Promise<unknown> | undefined) => {
      try { await action(); } catch { released = false; }
    };
    if (resources.heartbeat) clearInterval(resources.heartbeat);
    resources.abort.abort();
    cleanup(() => this.stopPlaybackMonitor(resources));
    if (!this.stopCapture(resources)) released = false;
    cleanup(() => resources.channel?.close());
    cleanup(() => resources.peer?.close());
    cleanup(() => {
      resources.audio?.pause();
      if (resources.audio) resources.audio.srcObject = null;
      resources.audio?.remove();
    });
    if (resources.pcm) await cleanupAsync(() => resources.pcm?.release());
    if (!resources.pcm && resources.context && resources.context.state !== "closed") {
      await cleanupAsync(() => resources.context?.close());
    }
    if (resources.port && resources.pcm === undefined) cleanup(() => resources.port!.close());
    return released;
  }

  private completeResourceLifecycle(resources: StartResources): void {
    if (!resources.localReleaseSettled || !resources.mainTerminationSettled) return;
    if (resources.callId && !resources.releaseAckSettled) return;
    if (!resources.callId || this.snapshot.call?.callId === resources.callId) {
      this.patch({ starting: false, stopping: false });
    }
    this.resources.delete(resources.requestId);
    if (resources.callId) this.resources.delete(resources.callId);
  }

  private readonly handlePageHide = (): void => {
    const call = this.snapshot.call;
    if (call) void liveVoiceApi.end({ callId: call.callId, reason: "renderer-gone" }).catch(() => undefined);
    else void this.cancelStart();
    for (const dispose of this.disposers) dispose();
  };

  private patch(patch: Partial<LiveVoiceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private patchCallIfNewer(call: LiveCallView): void {
    const current = this.snapshot.call;
    if (current?.callId === call.callId && current.revision > call.revision) return;
    this.patch({ call });
  }
}

let controller: LiveCallController | null = null;

export function getLiveCallController(): LiveCallController {
  controller ??= new LiveCallController();
  return controller;
}

function requestMicrophone(deviceId: string | null): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(liveError("LIVE_MEDIA_UNSUPPORTED"));
  return navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
}

function abortableMicrophone(promise: Promise<MediaStream>, signal: AbortSignal): Promise<MediaStream> {
  return new Promise<MediaStream>((resolve, reject) => {
    const onAbort = () => reject(liveError("LIVE_STALE_CALL"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((stream) => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) {
        stopStream(stream);
        reject(liveError("LIVE_STALE_CALL"));
      } else resolve(stream);
    }, (error: unknown) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    if (signal.aborted) onAbort();
  });
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

function isLive(phase?: LiveCallView["phase"]): boolean {
  return phase !== undefined && !["idle", "ended", "failed"].includes(phase);
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "name" in error && error.name === "NotAllowedError") return "LIVE_MICROPHONE_DENIED";
  if (error && typeof error === "object" && "name" in error && ["NotFoundError", "NotReadableError", "OverconstrainedError"].includes(String(error.name))) {
    return "LIVE_MICROPHONE_UNAVAILABLE";
  }
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : error && typeof error === "object" && "errorCode" in error && typeof error.errorCode === "string"
      ? error.errorCode
      : "LIVE_NETWORK_ERROR";
}

async function waitForIceGathering(peer: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  if (peer.iceGatheringState === "complete") return;
  await waitEvent(peer, "icegatheringstatechange", () => peer.iceGatheringState === "complete", signal, ICE_GATHER_TIMEOUT_MS);
}

async function waitForPeerConnection(peer: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  if (peer.connectionState === "connected") return;
  if (signal.aborted) throw liveError("LIVE_STALE_CALL");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(liveError("LIVE_TIMEOUT")), 15_000);
    const onChange = () => {
      if (peer.connectionState === "connected") finish();
      else if (peer.connectionState === "failed" || peer.connectionState === "closed") finish(liveError("LIVE_NETWORK_ERROR"));
    };
    const onAbort = () => finish(liveError("LIVE_STALE_CALL"));
    const finish = (error?: Error) => {
      clearTimeout(timer);
      peer.removeEventListener("connectionstatechange", onChange);
      signal.removeEventListener("abort", onAbort);
      error ? reject(error) : resolve();
    };
    peer.addEventListener("connectionstatechange", onChange);
    signal.addEventListener("abort", onAbort, { once: true });
    onChange();
  });
}

async function waitForDataChannel(channel: RTCDataChannel, signal: AbortSignal): Promise<void> {
  if (channel.readyState === "open") return;
  if (signal.aborted) throw liveError("LIVE_STALE_CALL");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(liveError("LIVE_TIMEOUT")), 15_000);
    const onOpen = () => finish();
    const onError = () => finish(liveError("LIVE_NETWORK_ERROR"));
    const onClose = () => finish(liveError("LIVE_NETWORK_ERROR"));
    const onAbort = () => finish(liveError("LIVE_STALE_CALL"));
    const finish = (error?: Error) => {
      clearTimeout(timer);
      channel.removeEventListener("open", onOpen);
      channel.removeEventListener("error", onError);
      channel.removeEventListener("close", onClose);
      signal.removeEventListener("abort", onAbort);
      error ? reject(error) : resolve();
    };
    channel.addEventListener("open", onOpen, { once: true });
    channel.addEventListener("error", onError, { once: true });
    channel.addEventListener("close", onClose, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
    if (channel.readyState === "open") finish();
  });
}

function waitEvent<T extends EventTarget>(target: T, name: string, predicate: () => boolean, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(liveError("LIVE_TIMEOUT")), timeoutMs);
    const onEvent = () => { if (predicate()) finish(); };
    const onAbort = () => finish(liveError("LIVE_STALE_CALL"));
    const finish = (error?: Error) => {
      clearTimeout(timer);
      target.removeEventListener(name, onEvent);
      signal.removeEventListener("abort", onAbort);
      error ? reject(error) : resolve();
    };
    target.addEventListener(name, onEvent);
    signal.addEventListener("abort", onAbort, { once: true });
    onEvent();
  });
}

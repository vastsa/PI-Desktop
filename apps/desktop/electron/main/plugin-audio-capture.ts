import { randomUUID } from "node:crypto";
import type { AudioCapture, AudioCaptureFactory } from "@pi-desktop/voice-runtime";
import type {
  PluginAudioCaptureState,
  PluginAudioInputFrame,
  PluginAudioInputSession,
  PluginAudioOpenInputOptions,
} from "@pi-desktop/plugin-sdk";

const error = (code: string, message: string) => Object.assign(new Error(message), { code });
const MAX_CAPTURE_MS = 60_000;

type Capture = {
  owner: object;
  session: PluginAudioInputSession;
  device: AudioCapture | null;
  startedAtMs: number;
  sequence: number;
  awaiting: number | null;
  droppedFrames: number;
  timer?: ReturnType<typeof setTimeout>;
};

/** Owns devices and backpressure, independently of the plugin process lifetime. */
export class PluginAudioCapture {
  private current: Capture | null = null;
  private factory: () => AudioCaptureFactory | undefined;

  constructor(factory: () => AudioCaptureFactory | undefined) {
    this.factory = factory;
  }

  private backend(): AudioCaptureFactory {
    const factory = this.factory();
    if (!factory) throw error("UNSUPPORTED", "host audio capture backend not available");
    return factory;
  }

  async getDevices() {
    const factory = this.backend();
    await this.checkPermission(factory);
    return factory.getDevices();
  }

  private async checkPermission(factory: AudioCaptureFactory): Promise<void> {
    const status = await factory.checkPermission();
    if (status === "granted") return;
    if (status === "denied" || !(await factory.requestPermission())) {
      throw error("PERMISSION_DENIED", "Microphone access was denied by the operating system");
    }
  }

  async open(
    owner: object,
    options: PluginAudioOpenInputOptions,
    isLive: () => boolean,
    deliver: (frame: PluginAudioInputFrame) => void,
  ): Promise<PluginAudioInputSession> {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw error("INVALID_ARGUMENT", "audio input options must be an object");
    }
    if ((options.sampleRate !== undefined && options.sampleRate !== 16000)
      || (options.channels !== undefined && options.channels !== 1)
      || [options.echoCancellation, options.noiseSuppression, options.autoGainControl].some((x) => x !== undefined && x !== false)) {
      throw error("UNSUPPORTED", "Capture supports mono PCM16 at 16000 Hz without audio processing");
    }
    if (options.deviceId !== undefined && (typeof options.deviceId !== "string" || !/^(|0|[1-9]\d*)$/.test(options.deviceId))) {
      throw error("INVALID_ARGUMENT", "Invalid audio input device id");
    }
    const factory = this.backend();
    if (this.current) throw error("RESOURCE_BUSY", "A plugin microphone capture is already active");
    // Reserve before permission prompts/async device startup; unload revokes this identity.
    const capture: Capture = {
      owner, session: { streamId: randomUUID(), sampleRate: 16000, channels: 1, deviceId: options.deviceId ?? "" },
      device: null, startedAtMs: Date.now(), sequence: 0, awaiting: null, droppedFrames: 0,
    };
    this.current = capture;
    try {
      await this.checkPermission(factory);
      this.assertCurrent(capture, isLive);
      if (options.deviceId) {
        const devices = await factory.getDevices();
        this.assertCurrent(capture, isLive);
        const device = devices.find((device) => device.deviceId === options.deviceId);
        if (!device) throw error("INVALID_ARGUMENT", "Audio input device no longer exists");
        capture.session.label = device.label;
      }
      const device = factory.create(options.deviceId || null);
      capture.device = device;
      device.onFrame((samples) => {
        if (this.current !== capture || !isLive()) return;
        const sequence = capture.sequence++;
        // One unacknowledged frame per owner; a blocked plugin cannot grow the IPC queue.
        if (capture.awaiting !== null) { capture.droppedFrames++; return; }
        if (samples.length > 4096) { capture.droppedFrames++; return; }
        const data = new Uint8Array(samples.length * 2);
        const view = new DataView(data.buffer);
        for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i]!, true);
        capture.awaiting = sequence;
        try {
          deliver({ ...capture.session, sequence, timestampMs: Date.now(), format: "pcm16", data });
        } catch {
          this.release(owner);
        }
      });
      await device.start();
      this.assertCurrent(capture, isLive);
      capture.startedAtMs = Date.now();
      capture.timer = setTimeout(() => this.release(owner), MAX_CAPTURE_MS);
      capture.timer.unref();
      return { ...capture.session };
    } catch (failure) {
      if (this.current === capture) this.release(owner);
      else capture.device?.cancel();
      throw failure;
    }
  }

  private assertCurrent(capture: Capture, isLive: () => boolean): void {
    if (this.current !== capture || !isLive()) throw error("PLUGIN_UNLOADED", "Audio capture owner was unloaded");
  }

  acknowledge(owner: object, streamId: string, sequence: number): void {
    const capture = this.current;
    if (capture?.owner === owner && capture.session.streamId === streamId && capture.awaiting === sequence) capture.awaiting = null;
  }

  state(owner: object): PluginAudioCaptureState {
    const capture = this.current;
    if (!capture || capture.owner !== owner) return { active: false, droppedFrames: 0 };
    return { ...capture.session, active: capture.device?.isActive ?? false, startedAtMs: capture.startedAtMs, droppedFrames: capture.droppedFrames };
  }

  close(owner: object, streamId: string): void {
    if (typeof streamId !== "string" || !streamId) throw error("INVALID_ARGUMENT", "streamId is required");
    const capture = this.current;
    if (!capture) return;
    if (capture.owner !== owner || capture.session.streamId !== streamId) throw error("PERMISSION_DENIED", "Audio stream belongs to another capture");
    this.release(owner);
  }

  release(owner: object): void {
    const capture = this.current;
    if (!capture || capture.owner !== owner) return;
    this.current = null;
    clearTimeout(capture.timer);
    capture.device?.cancel();
  }
}

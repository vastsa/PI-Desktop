/**
 * PvRecorder-based audio capture backend.
 * Implements AudioCaptureFactory from @pi-desktop/voice-runtime.
 *
 * Also serves as the real backend for the pi.audio plugin capture APIs,
 * replacing the previous UNSUPPORTED stubs.
 */

import { systemPreferences } from "electron";
import type {
  AudioCapture,
  AudioCaptureFactory,
  AudioInputDevice,
} from "@pi-desktop/voice-runtime";
import {
  CAPTURE_SAMPLE_RATE,
  FRAME_LENGTH,
  convertFrames,
} from "@pi-desktop/voice-runtime";

/** Lazily loaded PvRecorder module. */
let PvRecorderModule: typeof import("@picovoice/pvrecorder-node") | null = null;

async function loadPvRecorder() {
  if (!PvRecorderModule) {
    PvRecorderModule = await import("@picovoice/pvrecorder-node");
  }
  return PvRecorderModule;
}

// ---------------------------------------------------------------------------
// macOS Microphone Permission
// ---------------------------------------------------------------------------

export async function checkMicrophonePermission(): Promise<
  "granted" | "denied" | "undetermined"
> {
  if (process.platform !== "darwin") return "granted";

  const status = systemPreferences.getMediaAccessStatus("microphone");
  switch (status) {
    case "granted":
      return "granted";
    case "denied":
    case "restricted":
      return "denied";
    case "not-determined":
      return "undetermined";
    default:
      return "undetermined";
  }
}

export async function requestMicrophonePermission(): Promise<boolean> {
  if (process.platform !== "darwin") return true;
  return systemPreferences.askForMediaAccess("microphone");
}

// ---------------------------------------------------------------------------
// PvRecorderCapture — single recording session
// ---------------------------------------------------------------------------

class PvRecorderCapture implements AudioCapture {
  private recorder: InstanceType<
    (typeof import("@picovoice/pvrecorder-node"))["PvRecorder"]
  > | null = null;
  private frameCallback: ((frame: Int16Array) => void) | null = null;
  private frames: Int16Array[] = [];
  private readLoop: Promise<void> | undefined;
  private stopping = false;
  private readError: Error | undefined;

  constructor(private readonly deviceIndex: number) {}

  get isActive(): boolean {
    return this.recorder !== null && !this.stopping;
  }

  onFrame(cb: (frame: Int16Array) => void): void {
    this.frameCallback = cb;
  }

  async start(): Promise<void> {
    if (this.recorder) throw new Error("Capture already active");

    const { PvRecorder } = await loadPvRecorder();
    const recorder = new PvRecorder(FRAME_LENGTH, this.deviceIndex);

    try {
      if (recorder.sampleRate !== CAPTURE_SAMPLE_RATE) {
        throw new Error(
          `PvRecorder reported ${recorder.sampleRate} Hz; expected ${CAPTURE_SAMPLE_RATE} Hz`,
        );
      }

      this.frames = [];
      this.stopping = false;
      this.readError = undefined;
      recorder.start();
      this.recorder = recorder;
      this.readLoop = this.readFrames(recorder);
    } catch (error) {
      recorder.release();
      throw error;
    }
  }

  async stop(): Promise<Float32Array> {
    const recorder = this.recorder;
    if (!recorder) throw new Error("Capture not active");

    this.stopping = true;
    let stopError: Error | undefined;

    try {
      if (recorder.isRecording) recorder.stop();
    } catch (error) {
      stopError = error instanceof Error ? error : new Error(String(error));
    }

    try {
      await this.readLoop;
    } finally {
      recorder.release();
      this.recorder = null;
      this.readLoop = undefined;
    }

    if (stopError) throw stopError;
    if (this.readError) throw this.readError;

    return convertFrames(this.frames);
  }

  cancel(): void {
    this.stopping = true;
    try {
      if (this.recorder?.isRecording) this.recorder.stop();
    } catch {
      // Best-effort
    }
    try {
      this.recorder?.release();
    } catch {
      // Best-effort
    }
    this.recorder = null;
    this.frames = [];
  }

  private async readFrames(
    recorder: InstanceType<
      (typeof import("@picovoice/pvrecorder-node"))["PvRecorder"]
    >,
  ): Promise<void> {
    try {
      while (!this.stopping && recorder.isRecording) {
        const frame: Int16Array = await recorder.read();
        if (this.stopping) continue;
        this.frames.push(frame);
        try {
          this.frameCallback?.(frame);
        } catch {
          // Frame callback errors must not fail the recording
        }
      }
    } catch (error) {
      if (!this.stopping) {
        this.readError =
          error instanceof Error ? error : new Error(String(error));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// PvRecorderBackend — AudioCaptureFactory implementation
// ---------------------------------------------------------------------------

export class PvRecorderBackend implements AudioCaptureFactory {
  async getDevices(): Promise<AudioInputDevice[]> {
    const { PvRecorder } = await loadPvRecorder();
    const names: string[] = PvRecorder.getAvailableDevices();

    return names.map((label, index) => ({
      deviceId: String(index),
      label,
      isDefault: index === 0,
    }));
  }

  create(deviceId: string | null): AudioCapture {
    const index = deviceId !== null ? parseInt(deviceId, 10) : -1;
    return new PvRecorderCapture(isNaN(index) ? -1 : index);
  }

  async checkPermission(): Promise<"granted" | "denied" | "undetermined"> {
    return checkMicrophonePermission();
  }

  async requestPermission(): Promise<boolean> {
    return requestMicrophonePermission();
  }
}

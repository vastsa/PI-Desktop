/**
 * VoiceService — orchestrates voice input in the Electron main process.
 *
 * Lazily loads @pi-desktop/voice-runtime on first use so that Voice disabled
 * means zero import overhead at startup.
 */

import { app, BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { PvRecorderBackend, checkMicrophonePermission, requestMicrophonePermission } from "./audio-backend";
import type {
  AudioCaptureFactory,
  AudioInputDevice,
  ModelState,
  VoiceResult,
  VoiceSettings,
  VoiceState,
} from "@pi-desktop/voice-runtime";

// Lazy-loaded runtime classes
type VoiceControllerT = import("@pi-desktop/voice-runtime").VoiceController;
type TranscriptionEngineT = import("@pi-desktop/voice-runtime").TranscriptionEngine;
type ModelManagerT = import("@pi-desktop/voice-runtime").ModelManager;

// The recommended whisper-large-v3-turbo weights alone hold ~1.5 GiB of
// main-process memory once loaded, and transcription buffers sit on top of
// that. Unloading after a quiet spell keeps an idle app from pinning that
// memory forever (issue #1528); the model reloads from disk in a few seconds
// on the next recording.
const MODEL_IDLE_UNLOAD_MS = 10 * 60 * 1000;

// Phases in which no recording or transcription can be in flight, so the
// loaded model is safe to drop.
const TERMINAL_VOICE_PHASES = new Set(["idle", "done", "error"]);

export class VoiceService {
  private controller: VoiceControllerT | null = null;
  private engine: TranscriptionEngineT | null = null;
  private modelManager: ModelManagerT | null = null;
  private captureFactory: AudioCaptureFactory;
  private settings: VoiceSettings;
  private disposed = false;
  private releaseMicrophoneLease: (() => void) | null = null;
  private modelIdleUnloadTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly modelCacheDir: string,
    private readonly getWindow: () => BrowserWindow | null,
    private readonly acquireMicrophoneLease: (token: string) => () => void = () => () => undefined,
  ) {
    this.captureFactory = new PvRecorderBackend();
    // Will be overridden from app settings
    this.settings = {
      enabled: false,
      deviceId: null,
      languages: ["zh", "en"],
      chineseVariant: "simplified",
      modelId: "",
    };
  }

  // ---- Settings ----

  updateSettings(patch: Partial<VoiceSettings>): void {
    this.settings = { ...this.settings, ...patch };
  }

  getSettings(): VoiceSettings {
    return { ...this.settings };
  }

  // ---- Lazy initialization ----

  private async ensureRuntime(): Promise<void> {
    if (this.controller) return;

    const {
      VoiceController,
      TranscriptionEngine,
      ModelManager,
    } = await import("@pi-desktop/voice-runtime");

    this.modelManager = new ModelManager(this.modelCacheDir);
    this.engine = new TranscriptionEngine(this.modelManager);
    this.controller = new VoiceController(
      this.engine,
      this.captureFactory,
      () => this.settings,
    );

    // Forward state changes to renderer
    this.controller.on("stateChange", (state: VoiceState) => {
      this.sendToRenderer("voice:stateChanged", state);
      if (TERMINAL_VOICE_PHASES.has(state.phase)) {
        this.releaseCurrentMicrophoneLease();
        this.scheduleModelIdleUnload();
      }
    });
  }

  /**
   * Drop the loaded model after MODEL_IDLE_UNLOAD_MS without a recording.
   * The timer is cancelled whenever a new recording starts and re-checked
   * against the live phase before unloading, so an in-flight recording is
   * never interrupted.
   */
  private scheduleModelIdleUnload(): void {
    if (this.disposed || !this.controller) return;
    this.cancelModelIdleUnload();
    this.modelIdleUnloadTimer = setTimeout(() => {
      this.modelIdleUnloadTimer = null;
      if (this.disposed) return;
      const phase = this.controller?.state.phase;
      if (!phase || !TERMINAL_VOICE_PHASES.has(phase)) return;
      try {
        this.modelManager?.unload();
      } catch {
        // Best-effort trim; the model reloads on next use either way.
      }
    }, MODEL_IDLE_UNLOAD_MS);
    this.modelIdleUnloadTimer.unref?.();
  }

  private cancelModelIdleUnload(): void {
    if (this.modelIdleUnloadTimer) {
      clearTimeout(this.modelIdleUnloadTimer);
      this.modelIdleUnloadTimer = null;
    }
  }

  // ---- Recording lifecycle ----

  async start(overrides?: Partial<VoiceSettings>): Promise<void> {
    if (this.disposed) throw new Error("VoiceService is disposed");

    this.cancelModelIdleUnload();

    try {
      if (overrides) {
        this.updateSettings(overrides);
      }

      await this.ensureRuntime();
      this.releaseCurrentMicrophoneLease();
      this.releaseMicrophoneLease = this.acquireMicrophoneLease(randomUUID());
      await this.controller!.start();
    } catch (error) {
      this.releaseCurrentMicrophoneLease();
      // A rejected start may leave the controller in a terminal phase without
      // emitting stateChange; do not strand the pending idle unload.
      this.scheduleModelIdleUnload();
      throw error;
    }
  }

  async stop(): Promise<VoiceResult> {
    if (!this.controller) throw new Error("Voice not started");
    try {
      return await this.controller.stop();
    } finally {
      this.releaseCurrentMicrophoneLease();
    }
  }

  cancel(): void {
    this.controller?.cancel();
    this.releaseCurrentMicrophoneLease();
    // Cancelling from an idle phase emits no stateChange, so schedule here
    // too; scheduling twice is harmless.
    this.scheduleModelIdleUnload();
  }

  getState(): VoiceState {
    return (
      this.controller?.state ?? {
        phase: "idle" as const,
        durationSeconds: 0,
        volumeLevel: 0,
      }
    );
  }

  // ---- Devices ----

  async getDevices(): Promise<AudioInputDevice[]> {
    return this.captureFactory.getDevices();
  }

  // ---- Models ----

  getModels(): ModelState[] {
    return this.modelManager?.getAllStates() ?? [];
  }

  async downloadModel(modelId: string): Promise<void> {
    await this.ensureRuntime();
    const gen = this.modelManager!.download(modelId);
    for await (const progress of gen) {
      this.sendToRenderer("voice:modelProgress", { modelId, progress });
    }
  }

  async deleteModel(modelId: string): Promise<void> {
    await this.ensureRuntime();
    await this.modelManager!.deleteModel(modelId);
  }

  // ---- Permissions ----

  async checkPermission(): Promise<"granted" | "denied" | "undetermined"> {
    return checkMicrophonePermission();
  }

  async requestPermission(): Promise<boolean> {
    return requestMicrophonePermission();
  }

  // ---- Lifecycle ----

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelModelIdleUnload();
    this.controller?.dispose();
    this.releaseCurrentMicrophoneLease();
    this.engine?.shutdown();
    this.controller = null;
    this.engine = null;
    this.modelManager = null;
  }

  // ---- IPC helpers ----

  private sendToRenderer(channel: string, data: unknown): void {
    try {
      const win = this.getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send(channel, data);
      }
    } catch {
      // Window may be closing
    }
  }

  private releaseCurrentMicrophoneLease(): void {
    this.releaseMicrophoneLease?.();
    this.releaseMicrophoneLease = null;
  }
}

export function createVoiceService(
  modelCacheDir: string,
  getWindow: () => BrowserWindow | null,
  acquireMicrophoneLease?: (token: string) => () => void,
): VoiceService {
  const service = new VoiceService(modelCacheDir, getWindow, acquireMicrophoneLease);
  app.once("before-quit", () => service.dispose());
  return service;
}

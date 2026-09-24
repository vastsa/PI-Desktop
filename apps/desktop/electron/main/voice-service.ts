/**
 * VoiceService — orchestrates voice input in the Electron main process.
 *
 * Lazily loads @pi-desktop/voice-runtime on first use so that Voice disabled
 * means zero import overhead at startup.
 */

import { BrowserWindow } from "electron";
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

export class VoiceService {
  private controller: VoiceControllerT | null = null;
  private engine: TranscriptionEngineT | null = null;
  private modelManager: ModelManagerT | null = null;
  private captureFactory: AudioCaptureFactory;
  private settings: VoiceSettings;
  private disposed = false;

  constructor(
    private readonly modelCacheDir: string,
    private readonly getWindow: () => BrowserWindow | null,
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
    });
  }

  // ---- Recording lifecycle ----

  async start(overrides?: Partial<VoiceSettings>): Promise<void> {
    if (this.disposed) throw new Error("VoiceService is disposed");

    if (overrides) {
      this.updateSettings(overrides);
    }

    await this.ensureRuntime();
    await this.controller!.start();
  }

  async stop(): Promise<VoiceResult> {
    if (!this.controller) throw new Error("Voice not started");
    return this.controller.stop();
  }

  cancel(): void {
    this.controller?.cancel();
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
    this.controller?.dispose();
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
}

// ---- Voice Phase ----
export type VoicePhase =
  | "idle"
  | "preparing"
  | "ready"
  | "starting"
  | "listening"
  | "transcribing"
  | "done"
  | "error"
  | "cancelling";

// ---- Voice State ----
export interface VoiceState {
  phase: VoicePhase;
  /** Recording duration in seconds, updated in real-time during listening. */
  durationSeconds: number;
  /** Current volume level 0–1, updated in real-time during listening. */
  volumeLevel: number;
  /** Error message when phase is "error". */
  error?: string;
  /** Transcription result when phase is "done". */
  result?: VoiceResult;
}

export interface VoiceResult {
  text: string;
  speechSeconds: number;
  transcribeSeconds: number;
  language: string;
}

// ---- Voice Settings ----
export type ChineseVariant = "simplified" | "traditional-taiwan" | "traditional-hong-kong";

export interface VoiceSettings {
  enabled: boolean;
  /** Device ID; null means system default. */
  deviceId: string | null;
  /** Language codes, e.g. ["zh", "en"]. */
  languages: string[];
  /** Chinese output variant. */
  chineseVariant: ChineseVariant;
  /** Model catalog ID. */
  modelId: string;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  enabled: false,
  deviceId: null,
  languages: ["zh", "en"],
  chineseVariant: "simplified",
  modelId: "",
};

// ---- Model ----
export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  languages: string[];
  sizeBytes: number;
  hfRepo: string;
  /** Immutable Hugging Face commit used for the download. */
  hfRevision: string;
  hfFilename: string;
  sha256: string;
  supportsStreaming: boolean;
  recommended: boolean;
}

export type ModelStatus =
  | "not-downloaded"
  | "downloading"
  | "downloaded"
  | "loading"
  | "loaded"
  | "error";

export interface ModelState {
  info: ModelInfo;
  status: ModelStatus;
  downloadProgress?: number;
  localPath?: string;
  error?: string;
}

// ---- Audio Capture Interface ----
export interface AudioInputDevice {
  deviceId: string;
  label: string;
  isDefault: boolean;
}

export interface AudioCapture {
  start(): Promise<void>;
  stop(): Promise<Float32Array>;
  cancel(): void;
  onFrame(cb: (frame: Int16Array) => void): void;
  readonly isActive: boolean;
}

export interface AudioCaptureFactory {
  getDevices(): Promise<AudioInputDevice[]>;
  create(deviceId: string | null): AudioCapture;
  checkPermission(): Promise<"granted" | "denied" | "undetermined">;
  requestPermission(): Promise<boolean>;
}

// ---- Transcription ----
export interface TranscribeOptions {
  language: string;
  chineseVariant?: ChineseVariant;
}

export interface TranscriptionStream {
  feed(chunk: Float32Array): void;
  finalize(): Promise<string>;
  cancel(): void;
}

/**
 * Renderer-side IPC wrapper for voice operations.
 * Uses window.piDesktop bridge exposed by the preload script.
 * All invoke calls return Result<T>; unwrap extracts .data or throws.
 */

import { IPC, type Result } from "@pi-desktop/shared";
import type {
  AudioInputDevice,
  ModelState,
  VoiceSettings,
  VoiceState,
} from "@pi-desktop/voice-runtime";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const VOICE_PHASES = new Set([
  "idle",
  "preparing",
  "ready",
  "starting",
  "listening",
  "transcribing",
  "done",
  "error",
  "cancelling",
]);

const MODEL_STATUSES = new Set([
  "not-downloaded",
  "downloading",
  "downloaded",
  "loading",
  "loaded",
  "error",
]);

function isVoiceState(value: unknown): value is VoiceState {
  if (!isRecord(value) || typeof value.phase !== "string" || !VOICE_PHASES.has(value.phase)) {
    return false;
  }
  return (
    typeof value.durationSeconds === "number" &&
    Number.isFinite(value.durationSeconds) &&
    typeof value.volumeLevel === "number" &&
    Number.isFinite(value.volumeLevel)
  );
}

function isAudioInputDevice(value: unknown): value is AudioInputDevice {
  return (
    isRecord(value) &&
    typeof value.deviceId === "string" &&
    typeof value.label === "string" &&
    typeof value.isDefault === "boolean"
  );
}

function isModelState(value: unknown): value is ModelState {
  if (!isRecord(value) || !isRecord(value.info) || typeof value.status !== "string") {
    return false;
  }
  const info = value.info;
  return (
    MODEL_STATUSES.has(value.status) &&
    typeof info.id === "string" &&
    typeof info.name === "string" &&
    typeof info.description === "string" &&
    typeof info.sizeBytes === "number" &&
    Number.isFinite(info.sizeBytes) &&
    typeof info.recommended === "boolean"
  );
}

function isModelProgress(value: unknown): value is { modelId: string; progress: number } {
  return (
    isRecord(value) &&
    typeof value.modelId === "string" &&
    typeof value.progress === "number" &&
    Number.isFinite(value.progress)
  );
}

async function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const bridge = window.piDesktop;
  if (!bridge) throw new Error("piDesktop bridge unavailable");
  const result: Result<T> = await bridge.invoke<T>(channel, ...args);
  if (!result.ok) {
    throw new Error(result.error.message || "IPC call failed");
  }
  return result.data;
}

export const voiceIpc = {
  start: (settings?: Partial<VoiceSettings>) =>
    invoke(IPC.invoke.voiceStart, settings),

  stop: () => invoke(IPC.invoke.voiceStop),

  cancel: () => invoke(IPC.invoke.voiceCancel),

  getState: () => invoke(IPC.invoke.voiceGetState),

  getDevices: async (): Promise<AudioInputDevice[]> => {
    const value = await invoke<unknown>(IPC.invoke.voiceGetDevices);
    return Array.isArray(value) ? value.filter(isAudioInputDevice) : [];
  },

  getModels: async (): Promise<ModelState[]> => {
    const value = await invoke<unknown>(IPC.invoke.voiceGetModels);
    return Array.isArray(value) ? value.filter(isModelState) : [];
  },

  downloadModel: (modelId: string) =>
    invoke(IPC.invoke.voiceDownloadModel, { modelId }),

  deleteModel: (modelId: string) =>
    invoke(IPC.invoke.voiceDeleteModel, { modelId }),

  updateSettings: (settings: Partial<VoiceSettings>) =>
    invoke(IPC.invoke.voiceUpdateSettings, settings),

  checkPermission: () =>
    invoke<string>(IPC.invoke.voiceCheckPermission),

  requestPermission: () =>
    invoke<boolean>(IPC.invoke.voiceRequestPermission),

  onStateChanged: (callback: (state: VoiceState) => void) => {
    const bridge = window.piDesktop;
    if (!bridge) return () => {};
    return bridge.on(IPC.event.voiceStateChanged, (payload) => {
      if (isVoiceState(payload)) callback(payload);
    });
  },

  onModelProgress: (callback: (data: { modelId: string; progress: number }) => void) => {
    const bridge = window.piDesktop;
    if (!bridge) return () => {};
    return bridge.on(IPC.event.voiceModelProgress, (payload) => {
      if (isModelProgress(payload)) callback(payload);
    });
  },
};

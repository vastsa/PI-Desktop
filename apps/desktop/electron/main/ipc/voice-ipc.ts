/**
 * Voice IPC handler registration.
 * Follows the same pattern as speech-ipc.ts and other IPC modules.
 */

import { IPC } from "@pi-desktop/shared";
import type { IpcRegistrar } from "./types";
import type { VoiceService } from "../voice-service";
import type { ChineseVariant, VoiceSettings } from "@pi-desktop/voice-runtime";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isChineseVariant(value: unknown): value is ChineseVariant {
  return (
    value === "simplified" ||
    value === "traditional-taiwan" ||
    value === "traditional-hong-kong"
  );
}

/** Parse renderer-provided voice settings at the main-process boundary. */
export function parseVoiceSettings(
  input: unknown,
  allowUndefined = false,
): Partial<VoiceSettings> | undefined {
  if (input === undefined && allowUndefined) return undefined;
  if (!isRecord(input)) throw new Error("Invalid voice settings");

  const result: Partial<VoiceSettings> = {};
  if ("enabled" in input) {
    if (typeof input.enabled !== "boolean") throw new Error("Invalid voice enabled flag");
    result.enabled = input.enabled;
  }
  if ("deviceId" in input) {
    if (input.deviceId !== null && typeof input.deviceId !== "string") {
      throw new Error("Invalid voice device id");
    }
    if (typeof input.deviceId === "string" && input.deviceId.length > 256) {
      throw new Error("Voice device id is too long");
    }
    result.deviceId = input.deviceId;
  }
  if ("languages" in input) {
    if (
      !Array.isArray(input.languages) ||
      input.languages.length === 0 ||
      input.languages.length > 16 ||
      !input.languages.every(
        (language): language is string =>
          typeof language === "string" && language.length > 0 && language.length <= 32,
      )
    ) {
      throw new Error("Invalid voice languages");
    }
    result.languages = input.languages;
  }
  if ("chineseVariant" in input) {
    if (!isChineseVariant(input.chineseVariant)) {
      throw new Error("Invalid Chinese voice variant");
    }
    result.chineseVariant = input.chineseVariant;
  }
  if ("modelId" in input) {
    if (typeof input.modelId !== "string" || input.modelId.length > 200) {
      throw new Error("Invalid voice model id");
    }
    result.modelId = input.modelId;
  }
  return result;
}

export function parseVoiceModelId(input: unknown): string {
  if (!isRecord(input) || typeof input.modelId !== "string" || input.modelId.length === 0) {
    throw new Error("Invalid voice model id");
  }
  return input.modelId;
}

export function registerVoiceIpc({
  registrar,
  voiceService,
}: {
  registrar: IpcRegistrar;
  voiceService: VoiceService;
}): void {
  const { handle } = registrar;

  handle(IPC.invoke.voiceStart, (settings: unknown) =>
    voiceService.start(parseVoiceSettings(settings, true)),
  );

  handle(IPC.invoke.voiceStop, () => voiceService.stop());

  handle(IPC.invoke.voiceCancel, async () => {
    voiceService.cancel();
    return { ok: true };
  });

  handle(IPC.invoke.voiceGetState, async () => voiceService.getState());

  handle(IPC.invoke.voiceGetDevices, async () => voiceService.getDevices());

  handle(IPC.invoke.voiceGetModels, async () => voiceService.getModels());

  handle(IPC.invoke.voiceDownloadModel, (input: unknown) => {
    return voiceService.downloadModel(parseVoiceModelId(input));
  });

  handle(IPC.invoke.voiceDeleteModel, (input: unknown) => {
    return voiceService.deleteModel(parseVoiceModelId(input));
  });

  handle(IPC.invoke.voiceUpdateSettings, async (input: unknown) =>
    voiceService.updateSettings(parseVoiceSettings(input) ?? {}),
  );

  handle(IPC.invoke.voiceCheckPermission, () =>
    voiceService.checkPermission(),
  );

  handle(IPC.invoke.voiceRequestPermission, () =>
    voiceService.requestPermission(),
  );
}

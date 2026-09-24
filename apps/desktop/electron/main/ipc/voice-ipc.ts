/**
 * Voice IPC handler registration.
 * Follows the same pattern as speech-ipc.ts and other IPC modules.
 */

import { IPC } from "@pi-desktop/shared";
import type { IpcRegistrar } from "./types";
import type { VoiceService } from "../voice-service";

export function registerVoiceIpc({
  registrar,
  voiceService,
}: {
  registrar: IpcRegistrar;
  voiceService: VoiceService;
}): void {
  const { handle } = registrar;

  handle(IPC.invoke.voiceStart, (settings: unknown) =>
    voiceService.start(settings as any),
  );

  handle(IPC.invoke.voiceStop, () => voiceService.stop());

  handle(IPC.invoke.voiceCancel, async () => {
    voiceService.cancel();
    return { ok: true };
  });

  handle(IPC.invoke.voiceGetState, async () => voiceService.getState());

  handle(IPC.invoke.voiceGetDevices, () => voiceService.getDevices());

  handle(IPC.invoke.voiceGetModels, async () => voiceService.getModels());

  handle(IPC.invoke.voiceDownloadModel, (input: unknown) => {
    const { modelId } = input as { modelId: string };
    return voiceService.downloadModel(modelId);
  });

  handle(IPC.invoke.voiceDeleteModel, (input: unknown) => {
    const { modelId } = input as { modelId: string };
    return voiceService.deleteModel(modelId);
  });

  handle(IPC.invoke.voiceUpdateSettings, async (input: unknown) =>
    voiceService.updateSettings(input as any),
  );

  handle(IPC.invoke.voiceCheckPermission, () =>
    voiceService.checkPermission(),
  );

  handle(IPC.invoke.voiceRequestPermission, () =>
    voiceService.requestPermission(),
  );
}

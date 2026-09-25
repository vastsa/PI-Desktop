/**
 * Renderer-side IPC wrapper for voice operations.
 * Uses window.piDesktop bridge exposed by the preload script.
 * All invoke calls return Result<T>; unwrap extracts .data or throws.
 */

import { IPC } from "@pi-desktop/shared";

async function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const bridge = window.piDesktop;
  if (!bridge) throw new Error("piDesktop bridge unavailable");
  const result = await bridge.invoke<T>(channel, ...args);
  if (!(result as any).ok) {
    throw new Error((result as any).message ?? "IPC call failed");
  }
  return (result as any).data;
}

export const voiceIpc = {
  start: (settings?: Record<string, unknown>) =>
    invoke(IPC.invoke.voiceStart, settings),

  stop: () => invoke(IPC.invoke.voiceStop),

  cancel: () => invoke(IPC.invoke.voiceCancel),

  getState: () => invoke(IPC.invoke.voiceGetState),

  getDevices: () => invoke<unknown[]>(IPC.invoke.voiceGetDevices),

  getModels: () => invoke<unknown[]>(IPC.invoke.voiceGetModels),

  downloadModel: (modelId: string) =>
    invoke(IPC.invoke.voiceDownloadModel, { modelId }),

  deleteModel: (modelId: string) =>
    invoke(IPC.invoke.voiceDeleteModel, { modelId }),

  updateSettings: (settings: Record<string, unknown>) =>
    invoke(IPC.invoke.voiceUpdateSettings, settings),

  checkPermission: () =>
    invoke<string>(IPC.invoke.voiceCheckPermission),

  requestPermission: () =>
    invoke<boolean>(IPC.invoke.voiceRequestPermission),

  onStateChanged: (callback: (state: unknown) => void) => {
    const bridge = window.piDesktop;
    if (!bridge) return () => {};
    return bridge.on(IPC.event.voiceStateChanged, callback);
  },

  onModelProgress: (callback: (data: { modelId: string; progress: number }) => void) => {
    const bridge = window.piDesktop;
    if (!bridge) return () => {};
    return bridge.on(IPC.event.voiceModelProgress, callback as (...args: unknown[]) => void);
  },
};

/**
 * Renderer-side IPC wrapper for voice operations.
 */

const { ipcRenderer } = window.require("electron");

export const voiceIpc = {
  start: (settings?: Record<string, unknown>) =>
    ipcRenderer.invoke("pi-desktop/voice/start", settings),

  stop: () => ipcRenderer.invoke("pi-desktop/voice/stop"),

  cancel: () => ipcRenderer.invoke("pi-desktop/voice/cancel"),

  getState: () => ipcRenderer.invoke("pi-desktop/voice/getState"),

  getDevices: () => ipcRenderer.invoke("pi-desktop/voice/getDevices"),

  getModels: () => ipcRenderer.invoke("pi-desktop/voice/getModels"),

  downloadModel: (modelId: string) =>
    ipcRenderer.invoke("pi-desktop/voice/downloadModel", { modelId }),

  deleteModel: (modelId: string) =>
    ipcRenderer.invoke("pi-desktop/voice/deleteModel", { modelId }),

  updateSettings: (settings: Record<string, unknown>) =>
    ipcRenderer.invoke("pi-desktop/voice/updateSettings", settings),

  checkPermission: () =>
    ipcRenderer.invoke("pi-desktop/voice/checkPermission"),

  requestPermission: () =>
    ipcRenderer.invoke("pi-desktop/voice/requestPermission"),

  onStateChanged: (callback: (state: unknown) => void) => {
    const handler = (_event: unknown, state: unknown) => callback(state);
    ipcRenderer.on("pi-desktop/voice/event/stateChanged", handler);
    return () => {
      ipcRenderer.removeListener("pi-desktop/voice/event/stateChanged", handler);
    };
  },

  onModelProgress: (callback: (data: { modelId: string; progress: number }) => void) => {
    const handler = (_event: unknown, data: { modelId: string; progress: number }) => callback(data);
    ipcRenderer.on("pi-desktop/voice/event/modelProgress", handler);
    return () => {
      ipcRenderer.removeListener("pi-desktop/voice/event/modelProgress", handler);
    };
  },
};

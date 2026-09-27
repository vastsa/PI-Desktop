import { contextBridge, ipcRenderer } from "electron";
import { IPC, IPC_WHITELIST } from "@pi-desktop/shared";

const LOCALE_ARGUMENT_PREFIX = "--pi-desktop-locale=";

function readOsLocale(): string | undefined {
  return process.argv
    .find((argument) => argument.startsWith(LOCALE_ARGUMENT_PREFIX))
    ?.slice(LOCALE_ARGUMENT_PREFIX.length);
}

function assertChannel(channel: string) {
  if (!IPC_WHITELIST.has(channel)) {
    throw new Error(`IPC channel not allowed: ${channel}`);
  }
}

const api = {
  invoke: async <T = unknown>(channel: string, ...args: unknown[]): Promise<T> => {
    assertChannel(channel);
    return ipcRenderer.invoke(channel, ...args) as Promise<T>;
  },
  on: (channel: string, listener: (...args: unknown[]) => void) => {
    assertChannel(channel);
    const wrapped = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
      listener(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  channels: IPC,
  // Synchronous platform info so the renderer can style window chrome
  // (traffic lights on macOS vs. controls overlay on Windows/Linux)
  // before first paint, without an IPC round-trip.
  platform: process.platform,
  // `app.getLocale()` is resolved in the main process and passed as a renderer
  // creation argument. This keeps the locale available before first paint
  // without importing Electron's main-only `app` module in the sandbox.
  locale: readOsLocale(),
};

contextBridge.exposeInMainWorld("piDesktop", api);

export type PiDesktopPreloadApi = typeof api;

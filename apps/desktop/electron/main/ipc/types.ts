import type { IpcMain, IpcMainInvokeEvent } from "electron";

/** The small registration surface shared by domain-specific IPC modules. */
export type IpcRegistrar = {
  readonly ipcMain: IpcMain;
  handle(
    channel: string,
    handler: (...args: any[]) => Promise<any>,
  ): void;
  handleWithEvent(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<any>,
  ): void;
  assertMainWindowSender(event: IpcMainInvokeEvent): void;
};

import type { BrowserWindow, IpcMainInvokeEvent, WebFrameMain } from "electron";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { WebContents } from "electron";
import type { LiveOwner } from "./call-service";
import { getModuleDirectory } from "../module-path";

export function liveOwnerFromInvoke(event: IpcMainInvokeEvent, mainWindow: BrowserWindow | null): LiveOwner {
  const frame = event.senderFrame;
  if (
    !mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed() ||
    event.sender !== mainWindow.webContents || !frame || frame !== event.sender.mainFrame ||
    frame !== mainWindow.webContents.mainFrame || frame.url !== event.sender.getURL() ||
    !isTrustedRendererUrl(frame.url)
  ) {
    throw Object.assign(new Error("Live Voice is available only in the trusted main window"), { errorCode: "LIVE_INVALID_OWNER" });
  }
  return {
    webContentsId: event.sender.id,
    frameProcessId: frame.processId,
    frameRoutingId: frame.routingId,
    url: frame.url,
  };
}

export function liveOwnerFrame(mainWindow: BrowserWindow | null, owner: LiveOwner): WebFrameMain | null {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return null;
  const frame = mainWindow.webContents.mainFrame;
  if (
    mainWindow.webContents.id !== owner.webContentsId ||
    frame.processId !== owner.frameProcessId ||
    frame.routingId !== owner.frameRoutingId ||
    frame.url !== mainWindow.webContents.getURL() ||
    !isTrustedRendererUrl(frame.url)
  ) return null;
  return frame;
}

export function liveOwnerFromWebContents(mainWindow: BrowserWindow | null, contents: WebContents): LiveOwner | null {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed() || contents !== mainWindow.webContents || contents.isDestroyed()) return null;
  const frame = contents.mainFrame;
  if (frame.url !== contents.getURL() || !isTrustedRendererUrl(frame.url)) return null;
  return {
    webContentsId: contents.id,
    frameProcessId: frame.processId,
    frameRoutingId: frame.routingId,
    url: frame.url,
  };
}

export function isTrustedRendererUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "file:") {
      if (url.search || url.hash) return false;
      return (
        resolve(fileURLToPath(url)) ===
        resolve(getModuleDirectory(import.meta.url), "../renderer/index.html")
      );
    }
    if (url.protocol !== "http:") return false;
    const configured = process.env.ELECTRON_RENDERER_URL;
    if (!configured) return false;
    const expected = new URL(configured);
    return expected.protocol === "http:" && !expected.username && !expected.password &&
      url.origin === expected.origin && url.pathname === expected.pathname && !url.username && !url.password;
  } catch {
    return false;
  }
}

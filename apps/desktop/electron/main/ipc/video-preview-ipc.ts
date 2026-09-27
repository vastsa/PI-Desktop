import { dialog, protocol } from "electron";
import { IPC } from "@pi-desktop/shared";
import type { IpcRegistrar } from "./types";
import { VIDEO_SCHEME, VideoPreviewService } from "../video-preview";

export function registerVideoPreviewIpc(
  registrar: IpcRegistrar,
  resolvePath: (ref: string) => Promise<string | null>,
  getWindow: () => Electron.BrowserWindow | null,
): void {
  const service = new VideoPreviewService(resolvePath, async (name) => {
    const window = getWindow();
    const options = { defaultPath: name };
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    return result.canceled ? null : result.filePath ?? null;
  });
  protocol.handle(VIDEO_SCHEME, (request) => service.respond(request));
  const watched = new Set<number>();
  registrar.handleWithEvent(IPC.invoke.fsVideoSource, async (event, input: { path: string }) => {
    registrar.assertMainWindowSender(event);
    if (!watched.has(event.sender.id)) {
      watched.add(event.sender.id);
      event.sender.on("did-start-navigation", (_event, _url, inPlace, isMainFrame) => {
        if (isMainFrame && !inPlace) service.clear();
      });
      event.sender.once("destroyed", () => { watched.delete(event.sender.id); service.clear(); });
    }
    return service.acquire(String(input?.path ?? ""));
  });
  registrar.handleWithEvent(IPC.invoke.fsVideoRelease, async (event, input: { url: string }) => {
    registrar.assertMainWindowSender(event);
    service.release(String(input?.url ?? ""));
    return { ok: true };
  });
  registrar.handleWithEvent(IPC.invoke.fsVideoSave, async (event, input: { url: string }) => {
    registrar.assertMainWindowSender(event);
    return service.save(String(input?.url ?? ""));
  });
}

import { IPC, type LanAdminAction } from "@pi-desktop/shared";
import { onConfirmedQuit } from "../bootstrap/confirmed-quit";
import type { IpcRegistrar } from "../ipc/types";
import { lanWebUiAssets } from "./assets";
import { createLanWebUiService } from "./service";
import type { LanWorkspaceDeps } from "./workspace";

/** Desktop-only administration of the LAN WebUI (Settings → System). */
export function registerLanWebUiIpc(options: {
  registrar: Pick<IpcRegistrar, "handleWithEvent" | "assertMainWindowSender">;
  dataDir: string;
  workspace: Omit<LanWorkspaceDeps, "organization" | "notifyDesktop">;
  sendToRenderer(channel: string, payload: unknown): void;
  log(level: "info" | "warn", message: string, data?: unknown): void;
}): void {
  const service = createLanWebUiService({
    workspace: options.workspace,
    dataDir: options.dataDir,
    assets: lanWebUiAssets,
    sendToRenderer: options.sendToRenderer,
    log: options.log,
  });
  options.registrar.handleWithEvent(IPC.invoke.lanWebUiAdmin, async (event, action: LanAdminAction) => {
    options.registrar.assertMainWindowSender(event);
    return service.admin(action);
  });
  onConfirmedQuit(() => {
    void service.dispose().catch(() => options.log("warn", "lan webui disposal failed"));
  });
}

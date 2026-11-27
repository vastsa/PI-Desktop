import { IPC } from "@pi-desktop/shared";
import type { IpcMainInvokeEvent } from "electron";
import { readSidebarBackup, writeSidebarBackup } from "../sidebar-preferences";
import { getLanOrganization } from "../lan-webui/organization";
import type { IpcRegistrar } from "./types";

export function registerSidebarPreferencesIpc({ registrar, dataDir }: {
  registrar: Pick<IpcRegistrar, "handleWithEvent" | "assertMainWindowSender">;
  dataDir: string;
}): void {
  const assertSender = (event: IpcMainInvokeEvent) => {
    registrar.assertMainWindowSender(event);
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame
      || event.senderFrame.url !== event.sender.getURL()) {
      throw Object.assign(new Error("Sidebar preferences require the trusted Main top frame"), { errorCode: "PERMISSION_DENIED" });
    }
  };
  // LAN WebUI organization edits not yet applied by the renderer are kept on
  // top of every renderer snapshot, so a stale write cannot undo them.
  const organization = getLanOrganization(dataDir);
  registrar.handleWithEvent(IPC.invoke.sidebarPreferencesGet, async event => {
    assertSender(event);
    return organization.overlay(readSidebarBackup(dataDir));
  });
  registrar.handleWithEvent(IPC.invoke.sidebarPreferencesSet, async (event, value: unknown) => {
    assertSender(event);
    writeSidebarBackup(dataDir, organization.overlay(value));
    organization.rendererWrote();
  });
}

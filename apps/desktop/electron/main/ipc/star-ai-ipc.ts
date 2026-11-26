import { IPC } from "@pi-desktop/shared";
import { starAiError } from "../star-ai-session";
import type { StarAiAccount } from "../star-ai-account";
import type { IpcRegistrar } from "./types";

export function registerStarAiIpc(registrar: IpcRegistrar, account: StarAiAccount) {
  const handle = (channel: string, run: (input?: unknown) => Promise<unknown>) => {
    registrar.handleWithEvent(channel, async (event, input) => {
      registrar.assertMainWindowSender(event);
      if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
        throw starAiError("PERMISSION_DENIED", "StarAI sign-in requires the main application window.");
      }
      return run(input);
    });
  };
  handle(IPC.invoke.starAiLogin, account.login);
  handle(IPC.invoke.starAiCatalog, account.catalog);
  handle(IPC.invoke.starAiActivate, account.activate);
  handle(IPC.invoke.starAiLogout, account.logout);
}

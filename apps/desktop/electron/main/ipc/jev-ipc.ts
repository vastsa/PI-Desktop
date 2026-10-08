/**
 * The Jev key check channel.
 *
 * One job, separate from the provider channels: Jev owns no provider row, and
 * its credential lives under a fixed Host secret reference rather than a
 * provider id. The handler only asks TypeSafe; it stores nothing, so a key
 * that fails the check never reaches the secret store.
 */
import { IPC } from "@pi-desktop/shared";
import { probeJevApiKey } from "../jev-probe";
import type { Logger } from "../logger";
import type { IpcRegistrar } from "./types";

export type JevIpcDependencies = {
  registrar: IpcRegistrar;
  logger: Pick<Logger, "app">;
};

export function registerJevIpc({ registrar, logger }: JevIpcDependencies): void {
  registrar.handle(IPC.invoke.jevTest, async (apiKey: unknown) => {
    const result = await probeJevApiKey(typeof apiKey === "string" ? apiKey : "");
    logger.app("provider", result.ok ? "info" : "warn", "TypeSafe Jev key check", {
      data: { ok: result.ok, status: result.status },
    });
    return result;
  });
}

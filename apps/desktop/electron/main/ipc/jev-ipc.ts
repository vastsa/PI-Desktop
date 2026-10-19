/** Jev System One credential check IPC. The handler stores nothing. */
import {
  DEFAULT_JEV_CLASSIFIER_BINDING,
  IPC,
  normalizeJevClassifierBinding,
  type JevKeyCheckInput,
} from "@pi-desktop/shared";
import { assertJevUserEndpoint } from "../jev-endpoint-policy";
import { probeJevApiKey } from "../jev-probe";
import type { Logger } from "../logger";
import type { IpcRegistrar } from "./types";

export type JevIpcDependencies = {
  registrar: IpcRegistrar;
  logger: Pick<Logger, "app">;
};

export function registerJevIpc({ registrar, logger }: JevIpcDependencies): void {
  registrar.handle(IPC.invoke.jevTest, async (input: unknown) => {
    // Older renderer callers sent only the key. Keep that shape bound to the
    // official endpoint while all new calls state their destination explicitly.
    const legacy = typeof input === "string";
    const request = legacy ? { apiKey: input } : (input ?? {}) as Partial<JevKeyCheckInput>;
    const binding = legacy
      ? { ...DEFAULT_JEV_CLASSIFIER_BINDING }
      : normalizeJevClassifierBinding(request.binding);
    const result = binding
      ? await probeJevApiKey(
          typeof request.apiKey === "string" ? request.apiKey : "",
          binding,
          { assertEndpoint: assertJevUserEndpoint },
        )
      : { ok: false, message: "The System One endpoint or model is invalid." };
    logger.app("provider", result.ok ? "info" : "warn", "Jev System One key check", {
      data: { ok: result.ok, status: result.status },
    });
    return result;
  });
}

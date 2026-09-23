import { IPC } from "@pi-desktop/shared";
import { genericModelConfig } from "@pi-desktop/agent-runtime";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import { modelConfigFromModelsDev, type ModelsDevCatalog } from "../models-dev-catalog";
import { VendorOAuth } from "../oauth";

/** Keep OAuth credentials and catalog-backed model configuration in main. */
export function createVendorAccounts(options: {
  getHost: () => HostProcess | null;
  sendToRenderer: (channel: string, payload: unknown) => void;
  safeOpenExternal: (url: string) => Promise<unknown>;
  logger: Logger;
  modelsDevCatalog: ModelsDevCatalog;
}): VendorOAuth {
  return new VendorOAuth({
    call: <T,>(method: string, params?: unknown): Promise<T> => {
      const host = options.getHost();
      if (!host) throw new Error("host unavailable");
      return host.call<T>(method, params);
    },
    emit: (event) => options.sendToRenderer(IPC.event.providersOauth, event),
    openExternal: async (url) => { await options.safeOpenExternal(url); },
    log: (level, message, data) => options.logger.app("provider", level, message, { data }),
    modelConfigFor: async ({ vendorKey, option }) => {
      await options.modelsDevCatalog.ensureLoaded();
      const model = options.modelsDevCatalog.findModel({
        vendorKey, baseUrl: option.baseUrl, modelId: option.modelId,
      });
      return model
        ? modelConfigFromModelsDev(model, option.baseUrl)
        : genericModelConfig(option.modelId, option.baseUrl);
    },
  });
}

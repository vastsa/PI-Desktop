import { IPC, ErrorCodes, type ModelBinding, type OAuthRespondInput, type ThinkingLevel } from "@pi-desktop/shared";
import { OAUTH_AUTH_KIND, type VendorOAuth } from "../oauth";
import { discoverProviderModels } from "../model-discovery";
import { genericModelConfig, modelConfigWithBinding, mergeProviderHeaders } from "@pi-desktop/agent-runtime";
import { modelConfigFromModelsDev, modelInfoFromModelsDev, type ModelsDevCatalog } from "../models-dev-catalog";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import type { IpcRegistrar } from "./types";

type RuntimeProvider = {
  id: string;
  name: string;
  vendorKey?: string;
  baseUrl?: string;
  modelId?: string;
  models?: ModelBinding[];
  defaultModelId?: string;
  apiKey?: string;
  authKind?: string;
  apiStyle?: string;
  hasSecret?: boolean;
  hasOauth?: boolean;
  oauthAccountLabel?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  supportsVision?: boolean;
};

export type ProviderIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  modelsDevCatalog: Pick<ModelsDevCatalog, "refresh" | "ensureLoaded" | "loadLocal" | "getStatus" | "findModel" | "modelsForProvider">;
  vendorOAuth: VendorOAuth;
  logger: Pick<Logger, "app">;
  enrichProvider: (provider: RuntimeProvider, selectedModelId?: string) => any;
  listRuntimeProviders: () => Promise<RuntimeProvider[]>;
  enrichProviderList: (result: { providers: RuntimeProvider[] }) => Promise<unknown>;
  bindingForModel: (provider: Pick<RuntimeProvider, "models">, modelId: string) => ModelBinding | undefined;
};

/** Register provider catalog, model discovery, OAuth and secret channels. */
export function registerProviderIpc({
  registrar,
  getHost,
  modelsDevCatalog,
  vendorOAuth,
  logger,
  enrichProvider,
  listRuntimeProviders,
  enrichProviderList,
  bindingForModel,
}: ProviderIpcDependencies): void {
  let host: HostProcess | null = null;
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    registrar.handle(channel, async (...args) => {
      host = getHost();
      return fn(...args);
    });
  };
  handle(IPC.invoke.providersList, async () => {
    return enrichProviderList({ providers: await listRuntimeProviders() });
  });
  handle(IPC.invoke.providersRefreshModelCatalog, async () => {
    const refreshed = await modelsDevCatalog.refresh();
    return { refreshed, status: modelsDevCatalog.getStatus() };
  });
  // Status only: the snapshot is bundled with the release and this reports what
  // is loaded, so the settings footer never has to browse the catalog.
  handle(IPC.invoke.providersModelCatalogStatus, async () => {
    await modelsDevCatalog.ensureLoaded();
    return { status: modelsDevCatalog.getStatus() };
  });
  handle(IPC.invoke.providersCreate, async (input: unknown) => {
    if (!host) throw new Error("host unavailable");
    const result = await host.call<{ provider: RuntimeProvider }>(
      "providers.create",
      input,
    );
    await modelsDevCatalog.ensureLoaded();
    return { ...result, provider: enrichProvider(result.provider) };
  });
  handle(IPC.invoke.providersUpdate, async (input: unknown) => {
    if (!host) throw new Error("host unavailable");
    const result = await host.call<{ provider?: RuntimeProvider | null }>(
      "providers.update",
      input,
    );
    await modelsDevCatalog.ensureLoaded();
    return result.provider
      ? { ...result, provider: enrichProvider(result.provider) }
      : result;
  });
  handle(IPC.invoke.providersDelete, async (id: string) => {
    if (!host) throw new Error("host unavailable");
    return host.call("providers.delete", { id });
  });
  handle(IPC.invoke.providersTest, async (id: string) => {
    if (!host) throw new Error("host unavailable");
    // Config-level validation first (secret present etc.)
    const local = await host.call<{ ok: boolean; message?: string }>(
      "providers.testConnection",
      { id },
    );
    if (!local.ok) return { ...local, network: "skipped" };
    const detail = await host.call<{
      provider?: { baseUrl?: string; authKind?: string; headers?: Record<string, string> };
    }>("providers.get", { id });
    // A vendor account proves itself by resolving auth — refreshing the token
    // if it has expired — not by probing /models with a key it does not have.
    if (detail.provider?.authKind === OAUTH_AUTH_KIND) {
      try {
        await vendorOAuth.resolveAuth(id);
        return { ok: true, network: "ok" };
      } catch (e) {
        return {
          ok: false,
          network: "failed",
          errorCode: ErrorCodes.PROVIDER_UNAUTHORIZED,
          message: e instanceof Error ? e.message : String(e),
        };
      }
    }
    const baseUrl = detail.provider?.baseUrl;
    if (!baseUrl) return { ...local, network: "skipped" };
    const secret = await host.call<{ value?: string }>("providers.getSecret", { id });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
        headers: mergeProviderHeaders(
          secret.value ? { Authorization: `Bearer ${secret.value}` } : {},
          detail.provider?.headers,
        ),
        signal: controller.signal,
      });
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          network: "failed",
          status: res.status,
          errorCode: ErrorCodes.PROVIDER_UNAUTHORIZED,
        };
      }
      if (res.status === 429) {
        return {
          ok: false,
          network: "failed",
          status: res.status,
          errorCode: ErrorCodes.PROVIDER_RATE_LIMITED,
        };
      }
      return { ok: res.ok, network: res.ok ? "ok" : "failed", status: res.status };
    } catch (e) {
      return {
        ok: false,
        network: "failed",
        errorCode: ErrorCodes.TIMEOUT,
        message: e instanceof Error ? e.message : String(e),
      };
    } finally {
      clearTimeout(timer);
    }
  });
  // Vendor-account login. The renderer drives the conversation but never sees
  // credential material: it gets progress events and a provider row id.
  handle(IPC.invoke.providersOauthVendors, async () => {
    return { vendors: await vendorOAuth.listVendors() };
  });
  handle(IPC.invoke.providersOauthStart, async (vendorId: unknown) => {
    if (typeof vendorId !== "string" || !vendorId) {
      throw new Error("vendorId required");
    }
    return vendorOAuth.start(vendorId);
  });
  handle(IPC.invoke.providersOauthRespond, async (input: unknown) => {
    const request = (input ?? {}) as OAuthRespondInput;
    if (!request.loginId || !request.promptId) {
      throw new Error("loginId and promptId required");
    }
    return { ok: vendorOAuth.respond(request) };
  });
  handle(IPC.invoke.providersOauthCancel, async (loginId: unknown) => {
    return { ok: typeof loginId === "string" && vendorOAuth.cancel(loginId) };
  });
  handle(IPC.invoke.providersOauthDelete, async (providerId: unknown) => {
    if (typeof providerId !== "string" || !providerId) {
      throw new Error("providerId required");
    }
    await vendorOAuth.deleteAccount(providerId);
    return { ok: true };
  });
  handle(
    IPC.invoke.providersListModels,
    async (
      input?:
        | string
          | {
            providerId?: string;
            baseUrl?: string;
            apiKey?: string;
            apiStyle?: string;
            headers?: Record<string, string>;
            source?: "cache" | "refresh";
          },
    ) => {
      if (!host) throw new Error("host unavailable");
      const req = typeof input === "string" ? { providerId: input } : input ?? {};
      const providers = req.source === "cache"
        ? (await host.call<{ providers: RuntimeProvider[] }>("providers.list", {
            includeDisabled: true,
          })).providers
        : await listRuntimeProviders();
      const provider = req.providerId
        ? providers.find((p) => p.id === req.providerId)
        : undefined;
      const baseUrl = (req.baseUrl ?? provider?.baseUrl ?? "").trim();
      const apiStyle = req.apiStyle ?? provider?.apiStyle ?? "chat_completions";
      // Cache hydration must stay fast; the renderer already requests a live
      // refresh after it has painted the cached list. Live requests load the
      // shared models.dev snapshot once; cache reads use only local files.
      if (req.source === "cache") {
        await modelsDevCatalog.loadLocal();
      } else {
        await modelsDevCatalog.ensureLoaded();
      }
      const decorate = (
        model: {
          modelId: string;
          displayName: string;
          capabilities?: string[];
          input?: readonly ("text" | "image")[];
          contextWindow?: number;
          maxTokens?: number;
          source?: "bundled" | "discovered" | "user";
        },
        // Vendor accounts can span wire APIs, so a model may need a style of
        // its own rather than the row's.
        modelApiStyle: string = apiStyle,
      ) => {
        const modelsDevModel = modelsDevCatalog.findModel({
          vendorKey: provider?.vendorKey || "custom",
          baseUrl,
          modelId: model.modelId,
        });
        const catalogModelConfig = modelsDevModel
          ? modelConfigFromModelsDev(modelsDevModel, baseUrl)
          : genericModelConfig(model.modelId, baseUrl);
        const storedModel = provider ? bindingForModel(provider, model.modelId) : undefined;
        const modelConfig = modelConfigWithBinding(catalogModelConfig, storedModel);
        const info = modelsDevModel
          ? modelInfoFromModelsDev(modelsDevModel, provider?.id ?? "")
          : {
              modelId: model.modelId,
              displayName: model.displayName,
              providerId: provider?.id ?? "",
              modalities: modelConfig.modalities,
              reasoning: false,
              capabilities: ["text"] as Array<"text" | "tools" | "vision" | "reasoning" | "json">,
              supportedThinkingLevels: [] as ThinkingLevel[],
              source: model.source ?? ("discovered" as const),
            };
        return {
          ...info,
          modelId: model.modelId,
          displayName: info.displayName || modelConfig.name,
          providerId: provider?.id ?? "",
          contextWindow: modelConfig.contextWindow,
          maxTokens: modelConfig.maxTokens,
          // Published modalities, taken before the binding is applied. This
          // record is what the settings panel compares its checkboxes against,
          // so letting a stored override shape it would make the override its
          // own justification and the panel could never show what models.dev
          // actually says.
          modalities: catalogModelConfig.modalities ?? { input: ["text"], output: ["text"] },
          // ModelInfo is catalog metadata. Keep its published reasoning fields
          // intact; Composer and runtime resolve the exact user binding when
          // they need effective per-provider capabilities.
          ...(modelsDevModel ? { catalogSource: "models.dev" as const } : {}),
        };
      };

      /*
        A configured model must carry its published record even when the live
        endpoint no longer lists it, because the settings panel reads image and
        PDF support from that record. Discovery stays the authority on what the
        service offers — these ids are only the ones the user already configured,
        never the catalog at large — so nothing new becomes selectable.
      */
      const withConfiguredBindings = <T extends { modelId: string }>(
        discovered: readonly T[],
      ): Array<T | ReturnType<typeof decorate>> => {
        if (!provider?.models?.length) return [...discovered];
        const seen = new Set(discovered.map((model) => model.modelId.toLowerCase()));
        const extra = provider.models
          .filter((binding) => !seen.has(binding.id.toLowerCase()))
          .map((binding) =>
            decorate({
              modelId: binding.id,
              displayName: binding.id,
              source: "user" as const,
            }),
          );
        return [...discovered, ...extra];
      };

      const cacheForCurrentProvider = async (models: unknown[]) => {
        if (!provider || req.source === "cache") return;
        const savedBaseUrl = (provider.baseUrl ?? "").trim().replace(/\/+$/, "");
        const requestBaseUrl = baseUrl.replace(/\/+$/, "");
        const usesSavedEndpoint =
          requestBaseUrl === savedBaseUrl &&
          apiStyle === (provider.apiStyle ?? "chat_completions");
        if (!usesSavedEndpoint) return;
        try {
          const latestProvider = (await listRuntimeProviders()).find(
            (candidate) => candidate.id === provider.id,
          );
          const endpointStillCurrent =
            (latestProvider?.baseUrl ?? "").trim().replace(/\/+$/, "") ===
              requestBaseUrl &&
            (latestProvider?.apiStyle ?? "chat_completions") === apiStyle;
          if (endpointStillCurrent) {
            await host!.call("providers.cacheModels", {
              providerId: provider.id,
              models,
            });
          }
        } catch (e) {
          logger.app("provider", "warn", "model cache update failed", {
            data: {
              providerId: provider.id,
              error: e instanceof Error ? e.message : String(e),
            },
          });
        }
      };

      // A signed-in vendor account has no key to probe /models with, and pi-ai
      // already knows which models the account may use (Copilot narrows the
      // list to the subscription).
      if (req.source !== "cache" && provider?.authKind === OAUTH_AUTH_KIND) {
        try {
          const options = await vendorOAuth.listModels(provider.id);
          if (options.length > 0) {
            return {
              models: withConfiguredBindings(
                options.map((option) =>
                  decorate(
                    {
                      modelId: option.modelId,
                      displayName: option.modelId,
                    },
                    option.apiStyle,
                  ),
                ),
              ),
              source: "remote" as const,
            };
          }
        } catch (e) {
          logger.app("provider", "warn", "vendor account model list failed", {
            data: {
              providerId: provider.id,
              error: e instanceof Error ? e.message : String(e),
            },
          });
        }
      }

      if (req.source === "cache" && provider) {
        const cached = await host.call<{
          models: Array<{
            modelId: string;
            displayName: string;
            capabilities?: string[];
            contextWindow?: number;
            source?: "bundled" | "discovered" | "user";
          }>;
        }>("providers.listModels", { providerId: provider.id });
        // Keep every configured binding visible when the endpoint cache is
        // partial or empty. Decorating these ids through models.dev or generic
        // defaults preserves the per-model state for offline editing too.
        const cachedById = new Map(cached.models.map((model) => [model.modelId, model]));
        for (const binding of provider.models ?? []) {
          if (!cachedById.has(binding.id)) {
            cachedById.set(binding.id, {
              modelId: binding.id,
              displayName: binding.id,
              source: "user" as const,
            });
          }
        }
        if (cachedById.size > 0) {
          return {
            models: [...cachedById.values()].map((model) => decorate(model)),
            source: "cache" as const,
          };
        }
        const fallbackModelId = provider.defaultModelId;
        const fallback = fallbackModelId
          ? [decorate({
              modelId: fallbackModelId,
              displayName: fallbackModelId,
              source: "user",
            })]
          : [];
        return { models: fallback, source: "fallback" as const };
      }

      // Dialog edits can omit the key to reuse the stored secret; the raw key
      // never travels back to the renderer either way.
      let apiKey = req.apiKey ?? "";
      if (!apiKey && provider) {
        const secret = await host.call<{ value?: string }>("providers.getSecret", {
          id: provider.id,
        });
        apiKey = secret.value ?? "";
      }

      /*
        The service itself is the authority on which models it serves, so the
        live endpoint is asked first and models.dev is only consulted to enrich
        what came back (`decorate` above). Asking the catalog first would offer
        every published model for the vendor, including ones this deployment
        does not host and ones the key is not entitled to.
      */
      let discoveryError: string | undefined;
      if (baseUrl) {
        try {
          const discovered = await discoverProviderModels({
            baseUrl,
            apiKey,
            apiStyle,
            headers: req.headers ?? provider?.headers,
          });
          if (discovered.length > 0) {
            const models = discovered.map((model) => decorate(model));
            // Only what the endpoint actually served is cached; a configured id
            // it never offered must not be recorded as discovered.
            await cacheForCurrentProvider(models);
            return {
              models: withConfiguredBindings(models),
              source: "remote" as const,
            };
          }
        } catch (e) {
          discoveryError = e instanceof Error ? e.message : String(e);
          logger.app("provider", "warn", "model discovery failed", {
            data: { providerId: provider?.id, error: discoveryError },
          });
        }
      }

      // The endpoint published nothing usable (no /models route, an auth error,
      // or an empty list). The catalog is the fallback, not the primary source.
      const catalogModels = modelsDevCatalog.modelsForProvider({
        vendorKey: provider?.vendorKey,
        baseUrl,
        providerId: provider?.id ?? "",
      });
      if (catalogModels.length > 0) {
        return {
          models: withConfiguredBindings(
            catalogModels.map((model) => decorate(model)),
          ),
          source: "catalog" as const,
          ...(discoveryError ? { error: discoveryError } : {}),
        };
      }

      // Last resort: the provider's configured model, so pickers stay usable
      // for gateways without a /models endpoint.
      const fallbackModelId = provider?.models?.[0]?.id ?? provider?.defaultModelId;
      const fallback = fallbackModelId
        ? [decorate({ modelId: fallbackModelId, displayName: fallbackModelId })]
        : [];
      return { models: fallback, source: "fallback", error: discoveryError };
    },
  );

  // Secret material never crosses to the renderer: set/delete/has only.
  handle(IPC.invoke.secretsSet, async (input: { secretRef: string; value: string }) => {
    if (!host) throw new Error("host unavailable");
    return host.call("secrets.set", {
      secretRef: input?.secretRef,
      value: input?.value,
    });
  });
  handle(IPC.invoke.secretsDelete, async (secretRef: string) => {
    if (!host) throw new Error("host unavailable");
    return host.call("secrets.delete", { secretRef });
  });
  handle(IPC.invoke.secretsHas, async (secretRef: string) => {
    if (!host) throw new Error("host unavailable");
    return host.call("secrets.has", { secretRef });
  });

}

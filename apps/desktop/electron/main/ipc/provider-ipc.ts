import {
  IPC,
  ErrorCodes,
  inferEndpointProfile,
  normalizeApiStyle,
  resolveBindingLimits,
  type ModelBinding,
  type ProviderReorderInput,
  type OAuthRespondInput,
} from "@pi-desktop/shared";
import { OAUTH_AUTH_KIND, type VendorOAuth } from "../oauth";
import { probeProviderEndpoint } from "../model-discovery";
import {
  probeDiscoveryCandidates,
  type DiscoveryAttempt,
} from "../provider-endpoint-probe";
import { modelConfigWithBinding } from "@pi-desktop/agent-runtime";
import {
  catalogModelConfigFor,
  modelInfoFromModelsDev,
  type ModelsDevCatalog,
} from "../models-dev-catalog";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import type { IpcRegistrar } from "./types";
/**
 * One line explaining why a candidate sweep found nothing: every endpoint that
 * was tried and what it answered. The list is the explanation the settings
 * dialog shows, so a failed discovery never has to be a silent 404.
 */
function describeSweepFailure(
  attempts: readonly DiscoveryAttempt[],
): string | undefined {
  const failed = attempts.filter((attempt) => attempt.error);
  if (failed.length === 0) return undefined;
  return failed
    .map((attempt) => `${attempt.baseUrl}: ${attempt.error}`)
    .join("; ");
}


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
  modelsDevCatalog: Pick<
    ModelsDevCatalog,
    | "refresh"
    | "ensureLoaded"
    | "loadLocal"
    | "getStatus"
    | "findModel"
    | "anthropicThinkingFor"
    | "modelsForProvider"
  >;
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
  handle(IPC.invoke.providersReorder, async (input: ProviderReorderInput) => {
    if (!host) throw new Error("host unavailable");
    return host.call("providers.reorder", input);
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
  /**
   * Look one model id up in the local models.dev snapshot.
   *
   * A hand-typed custom id is not in any provider's model list yet, so the
   * settings picker has no other channel for its published limits. This is a
   * snapshot read: it loads the bundled catalog, performs no network request,
   * and never asks the host, so a slow or offline catalog cannot block the
   * picker. `providerId` is echoed back on the record; `vendorKey` / `baseUrl`
   * only disambiguate which published provider a duplicate id belongs to.
   */
  handle(
    IPC.invoke.providersLookupModel,
    async (input: {
      modelId?: string;
      baseUrl?: string;
      providerId?: string;
      vendorKey?: string;
    }) => {
      const modelId = (input?.modelId ?? "").trim();
      if (!modelId) return { info: null };
      await modelsDevCatalog.ensureLoaded();
      /*
        A hand-typed id on a custom endpoint names no publisher itself, so the
        host decides whose records to read — the same anchor the discovered list
        uses. A host the registry does not know keeps the caller's key (usually
        `custom`), where the snapshot only answers an unambiguous id. Pure: this
        stays a snapshot read with no network request or host call.
      */
      const declaredKey = input?.vendorKey;
      const lookupVendorKey =
        declaredKey && declaredKey !== "custom"
          ? declaredKey
          : typeof input?.baseUrl === "string" && input.baseUrl
            ? (inferEndpointProfile({ baseUrl: input.baseUrl })?.providerKey ?? declaredKey)
            : declaredKey;
      const model = modelsDevCatalog.findModel({
        vendorKey: lookupVendorKey,
        baseUrl: input?.baseUrl,
        modelId,
      });
      return {
        info: model
          ? modelInfoFromModelsDev(model, input?.providerId ?? "")
          : null,
      };
    },
  );
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
  handle(
    IPC.invoke.providersSetSecret,
    async (input: { id: string; secretValue?: string }) => {
      if (!host) throw new Error("host unavailable");
      const result = await host.call<{ provider?: RuntimeProvider | null }>(
        "providers.setSecret",
        input,
      );
      await modelsDevCatalog.ensureLoaded();
      return result.provider
        ? { ...result, provider: enrichProvider(result.provider) }
        : result;
    },
  );
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
      provider?: {
        baseUrl?: string;
        authKind?: string;
        apiStyle?: string;
        headers?: Record<string, string>;
      };
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
      /*
        The same request builder discovery uses, so "the list loaded" and "the
        connection test passed" can never describe two different endpoints: one
        URL rule, one auth rule, one wire style, for a real at-least-once check.
      */
      const probe = await probeProviderEndpoint({
        baseUrl,
        apiKey: secret.value,
        apiStyle: detail.provider?.apiStyle,
        headers: detail.provider?.headers,
        signal: controller.signal,
      });
      return { ok: true, network: "ok", status: probe.status };
    } catch (e) {
      const status = (e as { status?: unknown }).status;
      if (status === 401 || status === 403) {
        return {
          ok: false,
          network: "failed",
          status,
          errorCode: ErrorCodes.PROVIDER_UNAUTHORIZED,
        };
      }
      if (status === 429) {
        return {
          ok: false,
          network: "failed",
          status,
          errorCode: ErrorCodes.PROVIDER_RATE_LIMITED,
        };
      }
      if (typeof status === "number") {
        return { ok: false, network: "failed", status };
      }
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
      /*
        Static endpoint resolution, the same layer the settings dialog uses:
        which URL this row will really address, which wire style the evidence
        implies, and the same-origin addresses worth asking. Pure; no model id
        takes part in it.
      */
      const profile = inferEndpointProfile({
        baseUrl,
        // A persisted style this release does not know is read the way the rest
        // of the row is read: as Chat Completions.
        apiStyle: normalizeApiStyle(apiStyle),
        explicitApiStyle: true,
        providerKey: provider?.vendorKey,
      });
      // The address that answers may be a resolved candidate. The requested URL
      // stays the key for cache writes: the cache belongs to the saved endpoint,
      // not to a suggestion.
      let endpointBaseUrl = profile?.effectiveBaseUrl ?? baseUrl;
      /*
        Which publisher's metadata this row is read against.

        A custom endpoint on a published host still serves that vendor's models,
        so when the row names no publisher itself the registry's identity for
        the host anchors the models.dev lookup. That is a host fact, not a guess
        from a model name. An unknown host keeps `custom`, where the catalog
        only answers an unambiguous id — metadata missing beats metadata wrong.
      */
      const catalogVendorKey =
        provider?.vendorKey && provider.vendorKey !== "custom"
          ? provider.vendorKey
          : (profile?.providerKey ?? "custom");


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
        // its own rather than the row's. The endpoint is per call too: the live
        // branch decorates with the candidate that answered.
        modelApiStyle: string = apiStyle,
        catalogBaseUrl: string = endpointBaseUrl,
      ) => {
        const modelsDevModel = modelsDevCatalog.findModel({
          vendorKey: catalogVendorKey,
          baseUrl: catalogBaseUrl,
          modelId: model.modelId,
        });
        const catalogModelConfig = catalogModelConfigFor(modelsDevCatalog, {
          vendorKey: catalogVendorKey,
          baseUrl: catalogBaseUrl,
          apiStyle: modelApiStyle,
          modelId: model.modelId,
        });
        const storedModel = provider ? bindingForModel(provider, model.modelId) : undefined;
        const resolvedModel = resolveBindingLimits(catalogModelConfig, storedModel);
        const modelConfig = modelConfigWithBinding(
          resolvedModel.catalogConfig,
          resolvedModel.binding,
        );
        const info = modelsDevModel
          ? modelInfoFromModelsDev(modelsDevModel, provider?.id ?? "")
          : {
              modelId: model.modelId,
              displayName: model.displayName,
              providerId: provider?.id ?? "",
              modalities: modelConfig.modalities,
              reasoning: catalogModelConfig.reasoning,
              ...(catalogModelConfig.reasoningOptions
                ? { reasoningOptions: catalogModelConfig.reasoningOptions }
                : {}),
              ...(catalogModelConfig.thinkingLevelMap
                ? { thinkingLevelMap: catalogModelConfig.thinkingLevelMap }
                : {}),
              capabilities: [
                "text",
                ...(catalogModelConfig.reasoning ? ["reasoning" as const] : []),
              ] as Array<"text" | "tools" | "vision" | "reasoning" | "json">,
              supportedThinkingLevels: [...(catalogModelConfig.supportedThinkingLevels ?? [])],
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

      // A signed-in vendor account has no API key. VendorOAuth.listModels
      // reads that account's model endpoint; pi-ai is only the fallback.
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

        The typed Base URL is a starting point, not the answer: resolution offers
        the same-origin candidates that could serve this row and the sweep asks
        them in order. Whatever answers becomes the effective base URL the row is
        actually ran — automatic, but never hidden.
      */
      let discoveryError: string | undefined;
      let resolution: {
        effectiveBaseUrl?: string;
        discoveryStyle?: string;
        apiStyleHint?: string;
        evidence?: string;
      } = {};
      if (baseUrl) {
        try {
          const sweep = profile
            ? await probeDiscoveryCandidates({
                origin: profile.origin,
                candidates: profile.candidates,
                apiKey,
                headers: req.headers ?? provider?.headers,
              })
            : { attempts: [] };
          const outcome = sweep.outcome;
          if (outcome) {
            endpointBaseUrl = outcome.effectiveBaseUrl;
            resolution = {
              effectiveBaseUrl: outcome.effectiveBaseUrl,
              discoveryStyle: outcome.discoveryStyle,
              ...(outcome.apiStyleHint ? { apiStyleHint: outcome.apiStyleHint } : {}),
              evidence: outcome.evidence.type,
            };
            const models = outcome.models.map((model) => decorate(model));
            // Only what the endpoint actually served is cached; a configured id
            // it never offered must not be recorded as discovered.
            await cacheForCurrentProvider(models);
            return {
              models: withConfiguredBindings(models),
              source: "remote" as const,
              ...resolution,
            };
          }
          discoveryError = describeSweepFailure(sweep.attempts);
          if (discoveryError) {
            logger.app("provider", "warn", "model discovery failed", {
              data: { providerId: provider?.id, error: discoveryError },
            });
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
      // The list is the service's own published set, so a key that can call an
      // embedding or image endpoint sees it here too; nothing is preselected
      // from those, and `recommendModels` still picks chat models only.
      const catalogModels = modelsDevCatalog.modelsForProvider({
        vendorKey: catalogVendorKey,
        baseUrl: endpointBaseUrl,
        providerId: provider?.id ?? "",
        includeNonChat: true,
      });
      if (catalogModels.length > 0) {
        return {
          models: withConfiguredBindings(
            catalogModels.map((model) => decorate(model)),
          ),
          source: "catalog" as const,
          ...resolution,
          ...(discoveryError ? { error: discoveryError } : {}),
        };
      }

      // Last resort: the provider's configured model, so pickers stay usable
      // for gateways without a /models endpoint.
      const fallbackModelId = provider?.models?.[0]?.id ?? provider?.defaultModelId;
      const fallback = fallbackModelId
        ? [decorate({ modelId: fallbackModelId, displayName: fallbackModelId })]
        : [];
      return { models: fallback, source: "fallback", ...resolution, error: discoveryError };
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

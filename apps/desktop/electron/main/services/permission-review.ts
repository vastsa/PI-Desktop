import {
  OAUTH_AUTH_KIND,
  THINKING_LEVELS,
  canonicalThinkingLevel,
  modelIdsMatch,
  resolveBindingContextWindow,
  type ThinkingLevel,
} from "@pi-desktop/shared";
import {
  capabilitiesFromModelConfig,
  clampThinkingLevel,
  genericModelConfig,
  modelConfigWithBinding,
  optionalProviderHeaders,
  reviewPermissionAction,
  type RuntimeProviderConfig,
} from "@pi-desktop/agent-runtime";
import type { PermissionReviewResult, ReviewAction } from "@pi-desktop/host-runtime";
import type { HostProcess } from "../host-process";
import { modelConfigFromModelsDev, type ModelsDevCatalog } from "../models-dev-catalog";
import type { RuntimeProvider } from "../runtime/provider-catalog";
import type { VendorOAuth } from "../oauth";

type ReviewSettings = {
  defaultProviderId?: string;
  defaultModelId?: string;
  autoReview?: { providerId?: string; modelId?: string; thinkingLevel?: string };
};

type ReviewSession = { providerId?: string; modelId?: string };

function validThinkingLevel(value: unknown): ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)
    ? value as ThinkingLevel : "off";
}

/** Resolve an independent reviewer using the exact configured binding. */
export function createPermissionReviewResolver(dependencies: {
  getHost: () => HostProcess | null;
  modelsDevCatalog: ModelsDevCatalog;
  vendorOAuth: VendorOAuth;
  report: (code: "model_unavailable" | "context_unavailable") => void;
}) {
  return async (action: ReviewAction, signal: AbortSignal, sessionId: string): Promise<PermissionReviewResult> => {
    const host = dependencies.getHost();
    if (!host || signal.aborted) return reviewPermissionAction(undefined, action, "off", { signal });
    try {
      const settings = await host.call<ReviewSettings>("settings.get");
      const current = await host.call<{ session?: ReviewSession }>("session.get", { id: sessionId, messageLimit: 1 });
      if (signal.aborted || !current.session || host !== dependencies.getHost()) throw new Error("Session unavailable");
      if (Boolean(settings.autoReview?.providerId) !== Boolean(settings.autoReview?.modelId)) {
        throw new Error("Incomplete reviewer model binding");
      }
      const pinned = Boolean(settings.autoReview?.providerId);
      const thinkingLevel = validThinkingLevel(settings.autoReview?.thinkingLevel);
      const rows = await host.call<{ providers: RuntimeProvider[] }>("providers.list", { includeDisabled: false });
      const providerId = pinned
        ? settings.autoReview!.providerId
        : current.session.providerId ?? settings.defaultProviderId;
      const row = rows.providers.find((provider) => provider.id === providerId && provider.enabled !== false);
      if (!row || row.extensionAgentKey) throw new Error("Reviewer provider unavailable");
      const modelId = pinned
        ? settings.autoReview!.modelId
        : current.session.modelId ?? settings.defaultModelId ?? row.models?.[0]?.id;
      if (!modelId || (pinned && !row.models?.some((binding) => modelIdsMatch(binding.id, modelId)))) {
        throw new Error("Reviewer model unavailable");
      }
      const vendorBinding = row.authKind === OAUTH_AUTH_KIND
        ? await dependencies.vendorOAuth.bindingFor(row.id, modelId) : undefined;
      if (row.authKind === OAUTH_AUTH_KIND && !vendorBinding) throw new Error("Account model unavailable");
      const secret = row.authKind === OAUTH_AUTH_KIND || row.authKind === "none"
        ? undefined : (await host.call<{ value?: string }>("providers.getSecret", { id: row.id })).value;
      if (!secret && row.authKind !== OAUTH_AUTH_KIND && row.authKind !== "none") {
        throw new Error("Review provider credential unavailable");
      }
      if (signal.aborted || host !== dependencies.getHost()) throw new Error("Review context changed");
      const baseUrl = vendorBinding?.baseUrl ?? row.baseUrl;
      const catalog = dependencies.modelsDevCatalog.findModel({
        vendorKey: row.vendorKey, baseUrl: row.baseUrl, modelId,
      });
      const baseConfig = vendorBinding?.modelConfig ??
        (catalog ? modelConfigFromModelsDev(catalog, baseUrl) : genericModelConfig(modelId, baseUrl ?? ""));
      const limits = resolveBindingContextWindow(baseConfig,
        row.models?.find((binding) => modelIdsMatch(binding.id, modelId)));
      const modelConfig = modelConfigWithBinding(limits.catalogConfig, limits.binding);
      const capabilities = capabilitiesFromModelConfig(modelConfig);
      const provider: RuntimeProviderConfig = {
        id: row.id,
        name: row.name,
        ...(row.vendorKey ? { vendorKey: row.vendorKey } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        modelId,
        apiKey: secret ?? "",
        ...(row.authKind ? { authKind: row.authKind } : {}),
        ...(vendorBinding?.apiStyle ?? row.apiStyle
          ? { apiStyle: vendorBinding?.apiStyle ?? row.apiStyle } : {}),
        ...optionalProviderHeaders(row.headers),
        supportsReasoning: capabilities.supportsReasoning,
        supportedThinkingLevels: [...capabilities.supportedThinkingLevels],
        modelConfig,
        ...(row.authKind === OAUTH_AUTH_KIND
          ? { resolveAuth: () => dependencies.vendorOAuth.resolveAuth(row.id) } : {}),
      };
      const result = await reviewPermissionAction(provider, action,
        canonicalThinkingLevel(clampThinkingLevel(capabilities, thinkingLevel)), { signal });
      return { ...result, reviewerProviderId: row.id, reviewerModelId: modelId };
    } catch {
      dependencies.report("model_unavailable");
      return reviewPermissionAction(undefined, action, "off", { signal });
    }
  };
}

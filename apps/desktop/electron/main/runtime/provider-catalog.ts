import {
  ErrorCodes as SharedErrorCodes,
  SESSION_THINKING_LEVELS,
  defaultCommandShellForPlatform,
  isCommandShellId,
  resolveBindingLimits,
  validateNetworkProxy,
  validateSpeechSettings,
  type CommandShellId,
  type ModelBinding,
  type SessionThinkingLevel,
} from "@pi-desktop/shared";
import {
  capabilitiesFromModelConfig,
  modelConfigWithBinding,
  visionFromModelConfig,
  type ThinkingCapabilities,
} from "@pi-desktop/agent-runtime";
import type { HostProcess } from "../host-process";
import {
  catalogModelConfigFor,
  type ModelsDevCatalog,
} from "../models-dev-catalog";

const ErrorCodes = {
  ...SharedErrorCodes,
  COMMAND_SHELL_INVALID: "COMMAND_SHELL_INVALID",
} as const;

export type RuntimeProvider = {
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
  /** Plugin-owned trusted agent key; no host secret is associated with it. */
  extensionAgentKey?: string;
  hasSecret?: boolean;
  hasOauth?: boolean;
  oauthAccountLabel?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  supportsVision?: boolean;
};

export type RuntimeSession = {
  providerId?: string;
  modelId?: string;
  thinkingLevel?: SessionThinkingLevel;
};

export type SessionCapabilityDefaults = {
  defaultProviderId?: string;
  defaultModelId?: string;
};

export type ProviderCatalogRuntimeDependencies = {
  getHost: () => HostProcess | null;
  modelsDevCatalog: ModelsDevCatalog;
};

export function createProviderCatalogRuntime({
  getHost,
  modelsDevCatalog,
}: ProviderCatalogRuntimeDependencies) {
  const bindingForModel = (
    provider: Pick<RuntimeProvider, "models">,
    modelId: string,
  ): ModelBinding | undefined =>
    provider.models?.find((binding) =>
      binding.id.trim().toLowerCase() === modelId.trim().toLowerCase(),
    );

  const modelsDevModelFor = (provider: RuntimeProvider, modelId: string) =>
    modelsDevCatalog.findModel({
      vendorKey: provider.vendorKey,
      baseUrl: provider.baseUrl,
      modelId,
    });

  /**
   * Apply the exact provider/model binding before exposing a model to a
   * subagent. The catalog supplies the baseline, but an explicit binding owns
   * the effective thinking capability for the endpoint.
   */
  const effectiveSubagentModelConfig = (
    provider: Pick<RuntimeProvider, "models">,
    modelId: string,
    catalogModelConfig: Parameters<typeof modelConfigWithBinding>[0],
  ) => {
    const resolved = resolveBindingLimits(
      catalogModelConfig,
      bindingForModel(provider, modelId),
    );
    const modelConfig = modelConfigWithBinding(
      resolved.catalogConfig,
      resolved.binding,
    );
    return {
      modelConfig,
      capabilities: capabilitiesFromModelConfig(modelConfig),
    };
  };

  const enrichProvider = <T extends RuntimeProvider>(
    provider: T,
    selectedModelId?: string,
  ): T & ThinkingCapabilities & { supportsVision: boolean } => {
    const modelId =
      selectedModelId ||
      provider.modelId ||
      provider.models?.[0]?.id ||
      provider.defaultModelId ||
      "";
    const storedModel = bindingForModel(provider, modelId);
    const catalogModelConfig = catalogModelConfigFor(modelsDevCatalog, {
      vendorKey: provider.vendorKey,
      baseUrl: provider.baseUrl,
      apiStyle: provider.apiStyle,
      modelId,
    });
    const resolved = resolveBindingLimits(
      catalogModelConfig,
      storedModel,
    );
    const modelConfig = modelConfigWithBinding(
      resolved.catalogConfig,
      resolved.binding,
    );
    const models = provider.models?.map((binding) => {
      const catalogModelConfig = catalogModelConfigFor(modelsDevCatalog, {
        vendorKey: provider.vendorKey,
        baseUrl: provider.baseUrl,
        apiStyle: provider.apiStyle,
        modelId: binding.id,
      });
      const bindingResolved = resolveBindingLimits(
        catalogModelConfig,
        binding,
      );
      const effective = modelConfigWithBinding(
        bindingResolved.catalogConfig,
        bindingResolved.binding,
      );
      return {
        ...binding,
        contextWindow: effective.contextWindow,
        maxTokens: effective.maxTokens,
        // An inherited window keeps its catalog provenance on the exposed row,
        // so saving this form cannot freeze a models.dev value into a snapshot
        // of its own.
        ...(bindingResolved.binding.contextWindowSource
          ? { contextWindowSource: bindingResolved.binding.contextWindowSource }
          : {}),
      };
    });
    return {
      ...provider,
      ...(models ? { models } : {}),
      ...(catalogModelConfig.source !== "generic"
        ? {
            contextWindow: modelConfig.contextWindow,
            maxOutputTokens: modelConfig.maxTokens,
          }
        : {}),
      ...capabilitiesFromModelConfig(modelConfig),
      supportsVision: visionFromModelConfig(modelConfig),
    };
  };

  const normalizeThinkingLevel = (value: unknown): SessionThinkingLevel =>
    typeof value === "string" &&
    (SESSION_THINKING_LEVELS as readonly string[]).includes(value)
      ? (value as SessionThinkingLevel)
      : "off";

  const normalizeSettings = <T>(
    settings: T,
  ): T & { defaultCommandShell: CommandShellId } => {
    const value = (
      settings && typeof settings === "object" ? settings : {}
    ) as T & { defaultCommandShell?: unknown };
    return {
      ...(value as T),
      infiniteProviderRetry: (value as T & { infiniteProviderRetry?: unknown })
        .infiniteProviderRetry === true,
      keepAwakeWhileRunning: (value as T & { keepAwakeWhileRunning?: unknown })
        .keepAwakeWhileRunning === true,
      defaultCommandShell: isCommandShellId(value.defaultCommandShell)
        ? value.defaultCommandShell
        : defaultCommandShellForPlatform(process.platform),
    } as T & { defaultCommandShell: CommandShellId };
  };

  const validateSettingsWrite = <T>(settings: T): T => {
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      return settings;
    }
    const value = settings as T & {
      defaultCommandShell?: unknown;
      infiniteProviderRetry?: unknown;
      keepAwakeWhileRunning?: unknown;
      networkProxy?: unknown;
    };
    if (
      Object.prototype.hasOwnProperty.call(value, "defaultCommandShell") &&
      !isCommandShellId(value.defaultCommandShell)
    ) {
      throw Object.assign(new Error("defaultCommandShell is invalid"), {
        errorCode: ErrorCodes.COMMAND_SHELL_INVALID,
      });
    }
    if (
      Object.prototype.hasOwnProperty.call(value, "infiniteProviderRetry") &&
      typeof value.infiniteProviderRetry !== "boolean"
    ) {
      throw Object.assign(new Error("infiniteProviderRetry is invalid"), {
        errorCode: ErrorCodes.INVALID_PARAMS,
      });
    }
    if (
      Object.prototype.hasOwnProperty.call(value, "keepAwakeWhileRunning") &&
      typeof value.keepAwakeWhileRunning !== "boolean"
    ) {
      throw Object.assign(new Error("keepAwakeWhileRunning is invalid"), {
        errorCode: ErrorCodes.INVALID_PARAMS,
      });
    }
    if (Object.prototype.hasOwnProperty.call(value, "networkProxy")) {
      const proxy = validateNetworkProxy(value.networkProxy);
      if (!proxy.ok) {
        throw Object.assign(new Error(proxy.error), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      value.networkProxy = proxy.value;
    }
    if (Object.prototype.hasOwnProperty.call(value, "speech")) {
      (value as T & { speech?: unknown }).speech = validateSpeechSettings(
        (value as { speech?: unknown }).speech,
      );
    }
    return settings;
  };

  const listRuntimeProviders = async (includeDisabled = true) => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    const result = await host.call<{ providers: RuntimeProvider[] }>(
      "providers.list",
      { includeDisabled },
    );
    await modelsDevCatalog.ensureLoaded();
    return result.providers;
  };

  const enrichProviderList = async <T extends RuntimeProvider>(result: {
    providers: T[];
  }) => {
    await modelsDevCatalog.ensureLoaded();
    return {
      ...result,
      providers: result.providers.map((provider) => enrichProvider(provider)),
    };
  };

  const loadSessionCapabilityDefaults =
    async (): Promise<SessionCapabilityDefaults> => {
      const host = getHost();
      if (!host) return {};
      try {
        const settings = await host.call<SessionCapabilityDefaults>("settings.get");
        return {
          defaultProviderId: settings?.defaultProviderId,
          defaultModelId: settings?.defaultModelId,
        };
      } catch {
        return {};
      }
    };

  const sessionCapabilityContext = async () => {
    const [providers, defaults] = await Promise.all([
      listRuntimeProviders(),
      loadSessionCapabilityDefaults(),
    ]);
    return { providers, defaults };
  };

  const resolveSessionCapabilityTarget = (
    session: RuntimeSession,
    providers: readonly RuntimeProvider[],
    defaults?: SessionCapabilityDefaults,
  ): { provider: RuntimeProvider; modelId: string } | null => {
    const pinnedProvider = session.providerId
      ? providers.find((item) => item.id === session.providerId)
      : undefined;
    const provider =
      pinnedProvider ||
      (defaults?.defaultProviderId
        ? providers.find((item) => item.id === defaults.defaultProviderId)
        : undefined);
    if (!provider) return null;
    const pinnedModelId =
      pinnedProvider && session.modelId ? session.modelId : undefined;
    const inheritedModelId =
      provider.id === defaults?.defaultProviderId
        ? defaults.defaultModelId
        : undefined;
    const modelId =
      pinnedModelId ||
      inheritedModelId ||
      provider.models?.[0]?.id ||
      provider.defaultModelId;
    if (!modelId) return null;
    return { provider, modelId };
  };

  const enrichSession = <T extends RuntimeSession>(
    session: T,
    providers: readonly RuntimeProvider[],
    defaults?: SessionCapabilityDefaults,
  ): T & ThinkingCapabilities & { supportsVision: boolean } => {
    const target = resolveSessionCapabilityTarget(session, providers, defaults);
    if (!target) {
      return {
        ...session,
        supportsReasoning: false,
        supportsVision: false,
        supportedThinkingLevels: ["off"],
      };
    }
    const { provider, modelId } = target;
    const resolved = resolveBindingLimits(
      catalogModelConfigFor(modelsDevCatalog, {
        vendorKey: provider.vendorKey,
        baseUrl: provider.baseUrl,
        apiStyle: provider.apiStyle,
        modelId,
      }),
      bindingForModel(provider, modelId),
    );
    const modelConfig = modelConfigWithBinding(
      resolved.catalogConfig,
      resolved.binding,
    );
    return {
      ...session,
      ...capabilitiesFromModelConfig(modelConfig),
      supportsVision: visionFromModelConfig(modelConfig),
    };
  };

  return {
    bindingForModel,
    modelsDevModelFor,
    effectiveSubagentModelConfig,
    enrichProvider,
    normalizeThinkingLevel,
    normalizeSettings,
    validateSettingsWrite,
    listRuntimeProviders,
    enrichProviderList,
    sessionCapabilityContext,
    enrichSession,
  };
}

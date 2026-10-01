import { PI_VENDOR_ALIASES, relayChatMetadata, settingsOperationMetadata } from "./pi-model-metadata.ts";
import {
  createModels,
  getSupportedThinkingLevels,
  InMemoryModelsStore,
  type Api,
  type Model,
  type Models,
  type MutableModels,
  type ModelType,
  type ModelTypeMap,
  type Provider,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { matchNamedPreset, resolveBindingLimits, THINKING_LEVELS, type ModelBinding, type ModelInfo } from "@pi-desktop/shared";
import { genericModelConfig, modelConfigFromPi, modelConfigWithBinding, type ModelConfig } from "@pi-desktop/agent-runtime";

/** Compatibility type names only. The independent models.dev catalog is removed. */
export type ModelsDevModel = Model<Api>;
export type ModelsDevCatalogStatus = {
  loaded: boolean;
  source: "bundled" | "remote" | "empty";
  catalogPath: string;
  fetchedAt?: string;
  providerCount: number;
  modelCount: number;
  lastError?: string;
};
export type ModelsDevCatalogOptions = {
  /** Accepted for existing boot callers; Pi packages own the offline catalog. */
  catalogPath?: string;
  providers?: readonly Provider[];
  now?: () => number;
};
export type CatalogAccount = { id: string; vendorKey?: string; baseUrl?: string; apiStyle?: string; models?: ModelBinding[] };
type CatalogTarget = { providerId?: string; vendorKey?: string; baseUrl?: string; modelId: string };

export function normalizedApiUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return undefined;
  }
}
export function apiMatches(left: string | undefined, right: string | undefined): boolean {
  const value = normalizedApiUrl(left);
  return value !== undefined && value === normalizedApiUrl(right);
}

/** A projection, not a second metadata source. Non-chat operations never reach this shape. */
export function modelInfoFromModelsDev(model: Model<Api>, providerId: string): ModelInfo {
  return {
    providerId,
    modelId: model.id,
    displayName: model.name,
    reasoning: model.reasoning,
    supportedThinkingLevels: getSupportedThinkingLevels(model),
    thinkingLevelMap: model.thinkingLevelMap,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    modalities: { input: [...model.input], output: ["text"] },
    limit: { context: model.contextWindow, output: model.maxTokens },
    // Pi's request-wide tier format is not the historical display-tier format.
    cost: {
      input: model.cost.input,
      output: model.cost.output,
      cacheRead: model.cost.cacheRead,
      cacheWrite: model.cost.cacheWrite,
    },
    capabilities: ["text", "tools", ...(model.reasoning ? ["reasoning" as const] : []), ...(model.input.includes("image") ? ["vision" as const] : [])],
    source: "discovered",
    catalogSource: "pi",
  };
}
export function modelConfigFromModelsDev(model: Model<Api>, baseUrl?: string): ModelConfig {
  return { ...modelConfigFromPi(model), ...(baseUrl ? { baseUrl } : {}) };
}

export function catalogModelConfigFor(
  catalog: Pick<ModelsDevCatalog, "findModel"> & Partial<Pick<ModelsDevCatalog, "modelConfigFor">>,
  input: CatalogTarget & { apiStyle?: string },
): ModelConfig {
  if (catalog.modelConfigFor) return catalog.modelConfigFor(input);
  const model = catalog.findModel(input);
  return model ? modelConfigFromModelsDev(model, input.baseUrl) : genericModelConfig(input.modelId, input.baseUrl ?? "");
}

/**
 * Pi catalog/Models adapter. Startup is cache-only. Each OAuth/account collection
 * remains owned by its existing account owner and can be attached without copying
 * credentials or introducing a second refresh authority. Public discovery IDs
 * still live in Rust's chat-only cache, not in a second metadata database.
 */
export class ModelsDevCatalog {
  private readonly models;
  private readonly accounts = new Map<string, MutableModels>();
  private readonly removedAccounts = new Set<string>();
  private readonly accountRows = new Map<string, CatalogAccount>();
  private readonly originalProviders = new WeakMap<Provider, Provider>();
  private readonly publishedModels = new WeakMap<Model<Api>, Model<Api>>();
  private readonly effectiveConfigs = new WeakMap<Model<Api>, ModelConfig>();
  private readonly now: () => number;
  private loaded = false;
  private fetchedAt?: string;
  private lastError?: string;
  private loading?: Promise<boolean>;

  constructor(options: ModelsDevCatalogOptions = {}) {
    this.now = options.now ?? Date.now;
    this.models = createModels({
      modelsStore: new InMemoryModelsStore(),
      // Catalog reads must never discover ambient credentials or user files.
      authContext: { env: async () => undefined, fileExists: async () => false },
    });
    for (const provider of options.providers ?? builtinProviders()) this.models.setProvider(provider);
  }

  /** Attach the account owner's existing Models; never replace its auth/store. */
  setAccountModels(providerId: string, models: MutableModels): void {
    if (this.removedAccounts.has(providerId)) return;
    this.accounts.set(providerId, models);
    const row = this.accountRows.get(providerId);
    if (row) { this.accountRows.delete(providerId); this.configureAccount(row); }
  }
  deleteAccount(providerId: string): void {
    this.removedAccounts.add(providerId);
    this.accounts.delete(providerId);
    this.accountRows.delete(providerId);
  }

  /** Apply persisted explicit overrides at the Pi provider boundary, not per consumer.
   * The wrapper retains upstream auth, refresh and non-chat operations unchanged.
   * Its cache is keyed by the upstream model identity, so refresh replaces stale
   * projections and deleting an override restores the untouched upstream record.
   */
  configureAccount(row: CatalogAccount): void {
    if (this.removedAccounts.has(row.id)) return;
    const previous = this.accountRows.get(row.id);
    const signature = (value: CatalogAccount) => JSON.stringify([value.vendorKey, value.baseUrl, value.apiStyle, value.models]);
    if (previous && signature(previous) === signature(row) && this.accounts.has(row.id)) return;
    row = structuredClone(row);
    this.accountRows.set(row.id, row);
    let collection = this.accounts.get(row.id);
    if (!collection) {
      collection = createModels({ modelsStore: new InMemoryModelsStore(), authContext: { env: async () => undefined, fileExists: async () => false } });
      for (const provider of this.models.getProviders()) collection.setProvider(provider);
      this.accounts.set(row.id, collection);
    }
    const key = this.providerKeyForRow(row) ?? row.vendorKey;
    const current = key ? collection.getProvider(key) : undefined;
    if (!current) return;
    const original = this.originalProviders.get(current) ?? current;
    const cache = new WeakMap<Model<Api>, Model<Api>>();
    const project = (model: Model<Api>): Model<Api> => {
      const cached = cache.get(model);
      if (cached) return cached;
      const binding = row.models?.find((entry) => entry.id.trim().toLowerCase() === model.id.trim().toLowerCase());
      const baseline = modelConfigFromPi(model);
      const limits = resolveBindingLimits(baseline, binding);
      const configured = modelConfigWithBinding(limits.catalogConfig, limits.binding);
      const selected = binding?.thinkingLevels.filter((level) => baseline.supportedThinkingLevels?.includes(level));
      const thinkingLevelMap = { ...configured.thinkingLevelMap };
      if (selected?.length) {
        for (const level of THINKING_LEVELS) {
          if (!selected.includes(level)) thinkingLevelMap[level] = null;
        }
      }
      // A saved unsupported level never re-enables a native null mapping (Sol
      // cannot send off/none). Keep the persisted request, normalize execution.
      for (const level of THINKING_LEVELS) {
        if (model.thinkingLevelMap?.[level] === null) thinkingLevelMap[level] = null;
      }
      const reasoning = selected?.length
        ? selected.some((level) => level !== "off")
        : model.reasoning;
      const supportedThinkingLevels = getSupportedThinkingLevels({ ...model, reasoning, thinkingLevelMap });
      const config = { ...configured, reasoning, thinkingLevelMap, supportedThinkingLevels };
      const effective = {
        ...model,
        ...config,
        id: model.id,
        provider: model.provider,
        cost: model.cost,
      };
      cache.set(model, effective);
      this.publishedModels.set(effective, model);
      this.effectiveConfigs.set(effective, config);
      return effective;
    };
    const wrapped: Provider = {
      ...original,
      getModels: () => original.getModels().map(project),
      getAllModels: () => (original.getAllModels?.() ?? original.getModels()).map((model) =>
        !model.type || model.type === "chat" ? project(model) : model),
    };
    this.originalProviders.set(wrapped, original);
    collection.setProvider(wrapped);
  }

  modelConfigFor(input: CatalogTarget, unpublishedConfig?: ModelConfig): ModelConfig {
    const model = this.findModel(input);
    const binding = input.providerId ? this.accountRows.get(input.providerId)?.models?.find((entry) => entry.id.trim().toLowerCase() === input.modelId.trim().toLowerCase()) : undefined;
    if (model) {
      // A wrapped account provider already applied its binding inside
      // `configureAccount`. An unidentified relay has no wrapper to apply it,
      // so the stored row is resolved here — otherwise a `user` pin on a relay
      // hit would be silently replaced by the published number while still
      // claiming `user` provenance (spec §9.1: a user limit is never replaced).
      const projected = this.effectiveConfigs.get(model);
      let config = projected;
      if (!config) {
        const baseline = modelConfigFromPi(model);
        if (binding) {
          const limits = resolveBindingLimits(baseline, binding);
          config = modelConfigWithBinding(limits.catalogConfig, limits.binding);
        } else {
          config = baseline;
        }
      }
      return { ...config, ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}) };
    }
    // Hand-typed custom IDs have no published metadata. Preserve historical
    // explicit limits without pretending that the generic seed is a catalog.
    const limits = resolveBindingLimits(unpublishedConfig ?? genericModelConfig(input.modelId, input.baseUrl ?? ""), binding);
    return modelConfigWithBinding(limits.catalogConfig, limits.binding);
  }

  async loadLocal(): Promise<boolean> {
    if (this.loaded) return true;
    if (!this.loading) this.loading = this.models.refresh({ allowNetwork: false }).then((result) => {
      this.loaded = true;
      this.lastError = result.errors.size ? "Pi catalog cache initialization failed" : undefined;
      return this.models.getModelsOfType("chat").length > 0;
    }).finally(() => { this.loading = undefined; });
    return this.loading;
  }
  ensureLoaded(): Promise<boolean> { return this.loadLocal(); }

  async refresh(): Promise<boolean> {
    await this.ensureLoaded();
    const collections = new Set<Models>([this.models, ...this.accounts.values()]);
    const results = await Promise.all([...collections].map((models) => models.refresh({ allowNetwork: true, force: true })));
    if (results.some((result) => result.aborted || result.errors.size > 0)) {
      // Error text may contain an endpoint or auth detail; do not project it to UI.
      this.lastError = "Pi model refresh failed; last-known models remain available";
      return false;
    }
    this.fetchedAt = new Date(this.now()).toISOString();
    this.lastError = undefined;
    return true;
  }

  getStatus(): ModelsDevCatalogStatus {
    return {
      loaded: this.loaded,
      source: !this.loaded ? "empty" : this.fetchedAt ? "remote" : "bundled",
      catalogPath: "@earendil-works/pi-ai",
      fetchedAt: this.fetchedAt,
      providerCount: this.models.getProviders().length,
      modelCount: this.models.getModelsOfType("chat").length,
      lastError: this.lastError,
    };
  }

  providerKeyForRow(input: { vendorKey?: string; baseUrl?: string }): string | undefined {
    const key = input.vendorKey?.trim().toLowerCase();
    const alias = key ? PI_VENDOR_ALIASES[key] ?? key : undefined;
    if (alias && alias !== "custom" && this.models.getProvider(alias)) return alias;
    const preset = matchNamedPreset(input);
    const presetKey = preset ? PI_VENDOR_ALIASES[preset.vendorKey] ?? preset.vendorKey : undefined;
    if (presetKey && this.models.getProvider(presetKey)) return presetKey;
    const candidates = this.models.getProviders().filter((provider) => apiMatches(provider.baseUrl, input.baseUrl));
    return candidates.length === 1 ? candidates[0].id : undefined;
  }

  publishedModelFor(input: CatalogTarget): Model<Api> | undefined {
    const model = this.findModel(input);
    return model ? this.publishedModels.get(model) ?? model : undefined;
  }

  findModel(input: CatalogTarget): Model<Api> | undefined {
    return this.findModelOfType("chat", input);
  }

  findModelOfType<T extends ModelType>(type: T, input: CatalogTarget): ModelTypeMap[T] | undefined {
    if (input.providerId && this.removedAccounts.has(input.providerId)) return undefined;
    const models = (input.providerId && this.accounts.get(input.providerId)) || this.models;
    const providerId = this.providerKeyForRow(input) ?? input.vendorKey;
    if (!providerId || !models.getProvider(providerId)) {
      if (input.baseUrl && this.models.getProviders().filter(provider => apiMatches(provider.baseUrl, input.baseUrl)).length > 1) return undefined;
      return type === "chat" ? relayChatMetadata(this.models, input.modelId) as ModelTypeMap[T] | undefined : undefined;
    }
    const exact = models.getModelOfType(type, providerId, input.modelId);
    if (exact) return exact;
    const id = input.modelId.trim().toLowerCase();
    return models.getModelsOfType(type, providerId).find((model) => model.id.toLowerCase() === id);
  }

  settingsMetadataFor(input: CatalogTarget): ModelInfo | undefined {
    const vendor = this.providerKeyForRow(input);
    return settingsOperationMetadata(input.providerId ?? "", vendor, input.modelId)[0];
  }

  modelsForProvider(input: { providerId: string; vendorKey?: string; baseUrl?: string; includeNonChat?: boolean }): ModelInfo[] {
    if (this.removedAccounts.has(input.providerId)) return [];
    const models = this.accounts.get(input.providerId) ?? this.models;
    const providerId = this.providerKeyForRow(input) ?? input.vendorKey;
    if (!providerId) return [];
    const chat = models.getModelsOfType("chat", providerId).map((model) => modelInfoFromModelsDev(model, input.providerId));
    if (!input.includeNonChat) return chat;
    const seen = new Set(chat.map(model => model.modelId.toLowerCase()));
    const extra = settingsOperationMetadata(input.providerId, providerId).filter(model => !seen.has(model.modelId.toLowerCase()));
    return [...chat, ...extra];
  }
}

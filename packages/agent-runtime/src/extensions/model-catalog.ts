import type { Api, Model } from "@earendil-works/pi-ai";

/** Host-owned metadata snapshot. Never contains authentication or endpoint data. */
export type TrustedExtensionHostModel = {
  providerId: string;
  providerName: string;
  available: boolean;
  model: Model<Api>;
};

/** Explicit projection: endpoints, arbitrary headers and adapter internals stay private. */
export function publicExtensionModel(model: Model<Api>): Model<Api> {
  return {
    id: model.id, name: model.name, provider: model.provider, api: model.api,
    baseUrl: "", reasoning: model.reasoning, input: [...model.input],
    contextWindow: model.contextWindow, maxTokens: model.maxTokens,
    cost: { input: model.cost.input, output: model.cost.output,
      cacheRead: model.cost.cacheRead, cacheWrite: model.cost.cacheWrite },
  };
}

export function createExtensionModelCatalog(options: {
  hostModels: () => readonly TrustedExtensionHostModel[] | undefined;
  current: () => { model: Model<Api>; name: string };
  agents: () => Array<{ providerId: string; name: string; models: Model<Api>[] }>;
}) {
  const rows = (): TrustedExtensionHostModel[] => {
    const current = options.current();
    // Older embedding hosts may omit the snapshot. An explicitly empty snapshot
    // is authoritative: do not re-advertise a removed/disabled host model.
    const host = options.hostModels() ?? [{ providerId: current.model.provider,
      providerName: current.name, available: true, model: current.model }];
    const result = new Map<string, TrustedExtensionHostModel>();
    for (const row of [...host, ...options.agents().flatMap((agent) =>
      agent.models.map((model) => ({ providerId: agent.providerId,
        providerName: agent.name, available: true, model })))]) {
      result.set(JSON.stringify([row.providerId, row.model.id]), row);
    }
    return [...result.values()];
  };
  const available = () => rows().filter((row) => row.available);
  return {
    getAll: () => rows().map((row) => publicExtensionModel(row.model)),
    getAvailable: () => available().map((row) => publicExtensionModel(row.model)),
    find: (providerId: string, modelId: string) => {
      const row = rows().find((item) => item.providerId === providerId && item.model.id === modelId);
      return row ? publicExtensionModel(row.model) : undefined;
    },
    getProviderDisplayName: (providerId: string) => rows().find((row) => row.providerId === providerId)?.providerName ?? providerId,
    getProviderAuthStatus: (providerId: string) => ({
      configured: available().some((row) => row.providerId === providerId),
      source: options.agents().some((agent) => agent.providerId === providerId) ? "plugin" : "host",
    }),
    hasConfiguredAuth: (model: { provider?: string }) => available().some((row) => row.providerId === model.provider),
  };
}

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createExtensionModelRegistry,
  type ExtensionModelRegistry,
  type HostModelDescriptor,
} from "./provider-access.js";

function descriptor(
  overrides: Partial<HostModelDescriptor> = {},
): HostModelDescriptor {
  return {
    providerId: "provider-one",
    providerName: "Provider One",
    modelId: "model-one",
    label: "model-one (Provider One)",
    baseUrl: "https://api.example/v1",
    supportsReasoning: false,
    supportsImages: false,
    hasSecret: true,
    hasOauth: false,
    authKind: "api_key",
    toolCall: true,
    thinkingLevels: ["off"],
    contextWindow: 128_000,
    maxTokens: 8_192,
    cost: { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 0.5 },
    modalities: { input: ["text"], output: ["text"] },
    ...overrides,
  };
}

function model(provider: string, id: string, name = id): Model<Api> {
  return {
    id,
    name,
    api: "openai-completions",
    provider,
    baseUrl: "https://plugin.example/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 4_096,
  };
}

/** A host call that serves `rows()` and records the methods it was asked for. */
function hostCall(rows: () => HostModelDescriptor[], methods: string[] = []) {
  return async (method: string): Promise<unknown> => {
    methods.push(method);
    return { models: rows() };
  };
}

async function registryWith(
  rows: () => HostModelDescriptor[],
  extra: Model<Api>[] = [],
  extraProviderNames: Array<{ providerId: string; name: string }> = [],
): Promise<{ registry: ExtensionModelRegistry; methods: string[] }> {
  const methods: string[] = [];
  const registry = await createExtensionModelRegistry({
    callHost: hostCall(rows, methods),
    sessionId: "session-one",
    extraModels: () => extra,
    extraProviderNames: () => extraProviderNames,
  });
  return { registry, methods };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createExtensionModelRegistry", () => {
  it("projects a descriptor into a Model<Api>", async () => {
    const { registry, methods } = await registryWith(() => [
      descriptor({ modelApi: "responses", supportsReasoning: true, supportsImages: true }),
    ]);
    expect(methods).toEqual(["extensions.providers.list"]);
    expect(registry.getAll()).toEqual([
      {
        id: "model-one",
        name: "model-one (Provider One)",
        api: "openai-responses",
        provider: "provider-one",
        baseUrl: "https://api.example/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 0.5 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
    ]);
  });

  it("falls back to the provider style, neutral defaults, and no image input", async () => {
    const { registry } = await registryWith(() => [
      descriptor({
        apiStyle: "anthropic_messages",
        contextWindow: undefined,
        maxTokens: undefined,
        cost: undefined,
      }),
    ]);
    const [model] = registry.getAvailable();
    expect(model.api).toBe("anthropic-messages");
    expect(model.input).toEqual(["text"]);
    expect(model.reasoning).toBe(false);
    expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(model.contextWindow).toBe(128_000);
    expect(model.maxTokens).toBe(8_192);
  });

  it("serves the same ready set from getAll and getAvailable", async () => {
    const { registry } = await registryWith(() => [
      descriptor(),
      descriptor({ modelId: "model-two", label: "model-two (Provider One)" }),
    ]);
    expect(registry.getAll()).toHaveLength(2);
    expect(registry.getAvailable()).toEqual(registry.getAll());
  });

  it("deduplicates by provider/id with extraModels() winning", async () => {
    const { registry } = await registryWith(
      () => [descriptor(), descriptor({ providerId: "provider-two", modelId: "model-two" })],
      [model("provider-one", "model-one", "Plugin override"), model("provider-three", "model-three")],
    );
    const models = registry.getAll();
    expect(models).toHaveLength(3);
    expect(models.find((entry) => entry.provider === "provider-one")?.name).toBe(
      "Plugin override",
    );
    expect(registry.find("provider-one", "model-one")?.name).toBe("Plugin override");
    expect(registry.find("provider-three", "model-three")?.name).toBe("model-three");
    expect(registry.find("provider-one", "missing")).toBeUndefined();
  });

  it("answers display names from the catalogue and falls back to the raw id", async () => {
    const { registry } = await registryWith(() => [descriptor()]);
    expect(registry.getProviderDisplayName("provider-one")).toBe("Provider One");
    expect(registry.getProviderDisplayName("unknown-provider")).toBe("unknown-provider");
  });

  it("projects a model alias into the display name and falls back to the label", async () => {
    const { registry } = await registryWith(() => [
      descriptor({ alias: "Fast Model" }),
      descriptor({ modelId: "model-two", label: "model-two (Provider One)", alias: "   " }),
    ]);
    expect(registry.find("provider-one", "model-one")?.name).toBe("Fast Model");
    expect(registry.find("provider-one", "model-two")?.name).toBe("model-two (Provider One)");
  });

  it("reports truthful auth status without key material", async () => {
    const { registry } = await registryWith(() => [
      descriptor({ providerId: "secret" }),
      descriptor({ providerId: "oauth", hasSecret: true, hasOauth: true, authKind: "oauth" }),
      descriptor({ providerId: "none", hasSecret: false, authKind: "none" }),
      descriptor({ providerId: "unconfigured", hasSecret: false, authKind: "api_key" }),
    ]);
    expect(registry.getProviderAuthStatus("secret")).toEqual({
      configured: true,
      source: "stored",
    });
    expect(registry.getProviderAuthStatus("oauth")).toEqual({
      configured: true,
      source: "stored",
    });
    // `authKind === "none"` needs no credential, so the source is omitted and a
    // caller can tell it apart from a provider with a stored key.
    expect(registry.getProviderAuthStatus("none")).toEqual({ configured: true });
    expect(registry.getProviderAuthStatus("unconfigured")).toEqual({ configured: false });
    expect(registry.getProviderAuthStatus("absent")).toEqual({ configured: false });
    expect(JSON.stringify(registry.getProviderAuthStatus("secret"))).not.toContain("key");
  });

  it("answers hasConfiguredAuth for a configured catalogue row and a plugin-owned provider", async () => {
    const { registry } = await registryWith(
      () => [
        descriptor(),
        descriptor({ providerId: "unconfigured", modelId: "model-two", hasSecret: false, authKind: "api_key" }),
      ],
      [model("plugin", "agent-model")],
    );
    expect(registry.hasConfiguredAuth(model("provider-one", "model-one"))).toBe(true);
    expect(registry.hasConfiguredAuth(model("unconfigured", "model-two"))).toBe(false);
    // A plugin-registered agent provider owns its transport, so it needs no host
    // credential: the pre-catalogue answer was `true` and is restored here.
    expect(registry.hasConfiguredAuth(model("plugin", "agent-model"))).toBe(true);
  });

  it("reports a plugin-owned provider as configured with the runtime source and its agent name", async () => {
    const provider = "agent-extension:commandcode";
    const { registry } = await registryWith(
      () => [],
      [model(provider, "cc-1", "Command Code 1")],
      [{ providerId: provider, name: "Command Code" }],
    );
    expect(registry.getProviderAuthStatus(provider)).toEqual({
      configured: true,
      source: "runtime",
    });
    expect(registry.getProviderDisplayName(provider)).toBe("Command Code");
    expect(registry.hasConfiguredAuth(model(provider, "cc-1"))).toBe(true);
  });

  it("replaces the snapshot on refresh and never throws", async () => {
    let rows = [descriptor()];
    const { registry, methods } = await registryWith(() => rows);
    expect(registry.getAll()).toHaveLength(1);

    rows = [descriptor(), descriptor({ modelId: "model-two" })];
    const refreshed = await registry.refresh({ force: true });
    expect(refreshed.aborted).toBe(false);
    expect([...refreshed.errors]).toEqual([]);
    expect(registry.getAll()).toHaveLength(2);
    expect(methods).toHaveLength(2);

    const failure = new Error("PERMISSION_DENIED");
    const calls: string[] = [];
    const failing = await createExtensionModelRegistry({
      callHost: async (method) => {
        calls.push(method);
        if (calls.length > 1) throw failure;
        return { models: [descriptor()] };
      },
      sessionId: "session-one",
      extraModels: () => [],
      extraProviderNames: () => [],
    });
    const failed = await failing.refresh();
    expect(failed.aborted).toBe(false);
    expect([...failed.errors]).toEqual([["extensions.providers.list", failure]]);
    // A failed refresh keeps the previous snapshot instead of emptying it.
    expect(failing.getAll()).toHaveLength(1);
  });

  it("honors an aborted refresh signal without touching the snapshot", async () => {
    const { registry, methods } = await registryWith(() => [descriptor()]);
    const controller = new AbortController();
    controller.abort();
    const aborted = await registry.refresh({ signal: controller.signal });
    expect(aborted.aborted).toBe(true);
    expect([...aborted.errors]).toEqual([]);
    expect(methods).toHaveLength(1);
    expect(registry.getAll()).toHaveLength(1);
  });

  it("keeps serving extraModels() when the catalogue call rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const registry = await createExtensionModelRegistry({
      callHost: async () => {
        throw new Error("host unavailable");
      },
      sessionId: "session-one",
      extraModels: () => [model("plugin", "agent-model", "Plugin agent")],
      extraProviderNames: () => [],
    });
    expect(registry.getAll().map((entry) => entry.name)).toEqual(["Plugin agent"]);
    expect(registry.getAvailable()).toEqual(registry.getAll());
    expect(registry.find("plugin", "agent-model")?.name).toBe("Plugin agent");
    expect(registry.getProviderDisplayName("plugin")).toBe("plugin");
    // A plugin-owned provider is configured through its own transport.
    expect(registry.getProviderAuthStatus("plugin")).toEqual({
      configured: true,
      source: "runtime",
    });
  });
  it("discards a refresh aborted during the fetch instead of installing it", async () => {
    const batches: HostModelDescriptor[][] = [
      [descriptor()],
      [descriptor(), descriptor({ modelId: "model-two" })],
    ];
    const controller = new AbortController();
    let call = 0;
    const registry = await createExtensionModelRegistry({
      callHost: async () => {
        const rows = batches[call] ?? [];
        call += 1;
        // The caller cancels while the second (refresh) round trip is in flight.
        if (call > 1) controller.abort();
        return { models: rows };
      },
      sessionId: "session-one",
      extraModels: () => [],
      extraProviderNames: () => [],
    });
    expect(registry.getAll()).toHaveLength(1);

    const aborted = await registry.refresh({ signal: controller.signal });
    expect(aborted.aborted).toBe(true);
    expect([...aborted.errors]).toEqual([]);
    // The fetched rows are dropped: the snapshot is not installed.
    expect(registry.getAll()).toHaveLength(1);
  });
  it("reports an abort as aborted even when the fetch itself failed", async () => {
    const controller = new AbortController();
    let call = 0;
    const registry = await createExtensionModelRegistry({
      callHost: async () => {
        call += 1;
        if (call === 1) return { models: [descriptor()] };
        // The abort surfaces as a transport failure; the caller must still see
        // the abort, not the failure it caused.
        controller.abort();
        throw new Error("transport failed");
      },
      sessionId: "session-one",
      extraModels: () => [],
      extraProviderNames: () => [],
    });
    const result = await registry.refresh({ signal: controller.signal });
    expect(result.aborted).toBe(true);
    expect([...result.errors]).toEqual([]);
  });

});

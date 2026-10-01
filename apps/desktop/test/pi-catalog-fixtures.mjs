import { createProvider } from "@earendil-works/pi-ai";

/** Real Pi providers with inert execution and explicit fixture-only auth. */
export function fixtureProvider(id, models, options = {}) {
  return createProvider({
    id,
    baseUrl: `https://${id}.example/v1`,
    auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "fixture-only" } }) } },
    models: models.map((model) => ({
      id: model.id,
      name: model.id,
      provider: id,
      api: "openai-completions",
      reasoning: false,
      input: ["text"],
      contextWindow: 128_000,
      maxTokens: 8_192,
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
      ...model,
    })),
    api: {
      stream: () => { throw new Error("fixture must not execute"); },
      streamSimple: () => { throw new Error("fixture must not execute"); },
    },
    ...options,
  });
}

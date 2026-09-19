import { expect, it } from "vitest";
import { createExtensionModelCatalog, type TrustedExtensionHostModel } from "./model-catalog.js";

const model = { id: "same", name: "Same", provider: "a", api: "openai-completions", baseUrl: "private",
  headers: { Authorization: "private" }, reasoning: false, input: ["text" as const],
  contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

it("refreshes an existing registry, distinguishes unavailable auth, and protects its snapshot", () => {
  let rows: TrustedExtensionHostModel[] = [
    { providerId: "a", providerName: "Same name", available: true, model },
    { providerId: "b", providerName: "Same name", available: false, model: { ...model, provider: "b" } },
  ];
  const registry = createExtensionModelCatalog({ hostModels: () => rows,
    current: () => ({ model, name: "A" }), agents: () => [] });
  expect(registry.getAll()).toHaveLength(2);
  expect(registry.getAvailable()).toHaveLength(1);
  expect(registry.find("b", "same")?.provider).toBe("b");
  expect(registry.hasConfiguredAuth({ provider: "b" })).toBe(false);
  expect(registry.getProviderAuthStatus("missing").configured).toBe(false);
  const selected = registry.getAvailable()[0];
  selected.input.length = 0;
  selected.cost.input = 99;
  expect(registry.getAvailable()[0].input).toEqual(["text"]);
  expect(registry.getAvailable()[0].cost.input).toBe(0);
  expect(JSON.stringify(registry.getAll())).not.toContain("private");
  rows = [];
  expect(registry.getAvailable()).toEqual([]);
  expect(registry.find("a", "same")).toBeUndefined();
});

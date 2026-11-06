import { expect, it } from "vitest";
import { normalizeContext, type Message, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { genericModelConfig } from "./model-capabilities.js";
import { buildProviderModel } from "./provider-binding.js";

const baseUrl = "https://native.invalid/v1";
const read = { name: "Read", description: "Read", parameters: Type.Object({ path: Type.String() }) };
const search = { ...read, name: "Search" };
const messages: Message[] = [
  { role: "system", content: "", sections: { runtime: "Base", skills: "Old catalog" }, toolsAdded: [read], timestamp: 1 },
  { role: "user", content: "Find files", timestamp: 2 },
  { role: "system", content: "", sections: { skills: "New catalog" }, toolsAdded: [search], timestamp: 3 },
];
type Payload = { messages: Array<{ role: string; content?: unknown; tools?: unknown[] }>; tools?: Array<{ function: { name: string; parameters: unknown } }> };
async function payload(instructions: boolean, additions: boolean, route = baseUrl, transcript = messages): Promise<Payload> {
  const model = buildProviderModel({
    id: "fixture", name: "Fixture", modelId: "exact", baseUrl: route, apiKey: "", authKind: "none",
    supportsReasoning: false, supportedThinkingLevels: ["off"],
    modelConfig: {
      ...genericModelConfig("exact", baseUrl), source: "pi",
      transcriptBinding: { modelId: "exact", api: "openai-completions", baseUrl },
      compat: { supportsMidConvoSystemMessages: instructions, supportsMidConvoToolAdditions: additions },
    },
  });
  let captured: Payload | undefined;
  const response = stream(model as Model<"openai-completions">, normalizeContext({ messages: transcript }), {
    apiKey: "fixture",
    fetch: async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return new Response('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    },
  });
  expect((await response.result()).stopReason).toBe("stop");
  if (!captured) throw new Error("No payload captured");
  return captured;
}

it("uses native additions only when both instruction and tool capabilities are verified", async () => {
  const original = structuredClone(messages);
  const native = await payload(true, true);
  expect(native.tools?.map((tool) => tool.function.name)).toEqual(["Read"]);
  expect(native.messages.slice(0, 2).map((message) => message.role)).toEqual(["system", "user"]);
  expect(native.messages.slice(2).some((message) => message.tools?.length === 1)).toBe(true);
  const partial = await payload(true, false);
  expect(partial.tools?.map((tool) => tool.function.name)).toEqual(["Read", "Search"]);
  expect(partial.messages.filter((message) => message.role === "system")).toHaveLength(2);
  const relay = await payload(true, true, "https://relay.invalid/v1");
  expect(relay.messages.map((message) => message.role)).toEqual(["system", "user"]);
  expect(relay.tools?.map((tool) => tool.function.name)).toEqual(["Read", "Search"]);
  expect(JSON.stringify(relay.messages)).toContain("New catalog");
  expect(JSON.stringify(relay.messages)).not.toContain("Old catalog");
  expect(await payload(true, true)).toEqual(native);
  expect(messages).toEqual(original);
});

it("folds removals and same-name replacements into the active request tool set", async () => {
  const replacement = { ...read, parameters: Type.Object({ file: Type.String() }) };
  const request = await payload(true, true, baseUrl, [...messages, {
    role: "system", content: "", timestamp: 4,
    toolsRemoved: [{ name: "Read" }, { name: "Search" }], toolsAdded: [replacement],
  }]);
  expect(request.tools).toEqual([expect.objectContaining({ function: expect.objectContaining({ name: "Read", parameters: replacement.parameters }) })]);
  expect(request.messages.some((message) => message.tools)).toBe(false);
});

it("projects per-skill changes and revocations with native and fallback model support", async () => {
  const catalog: Message[] = [
    { role: "system", content: "", timestamp: 1, sections: {
      runtime: "Base", skills: "Load skills", "skill:a": "Alpha", "skill:b": "Bravo", "skill:c": "Charlie",
    } },
    { role: "user", content: "Continue", timestamp: 2 },
    { role: "system", content: "", timestamp: 3, sections: { "skill:a": "Alpha updated", "skill:b": null } },
  ];
  const before = await payload(true, false, baseUrl, catalog.slice(0, 2));
  const native = await payload(true, false, baseUrl, catalog);
  expect(native.messages.slice(0, before.messages.length)).toEqual(before.messages);
  expect(JSON.stringify(native.messages.at(-1))).toContain("Alpha updated");
  expect(JSON.stringify(native.messages.at(-1))).not.toContain("Charlie");
  for (const route of [baseUrl, "https://relay.invalid/v1"]) {
    const fallback = await payload(false, false, route, catalog);
    expect(fallback.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(JSON.stringify(fallback.messages)).toContain("Alpha updated");
    expect(JSON.stringify(fallback.messages)).toContain("Charlie");
    expect(JSON.stringify(fallback.messages)).not.toContain("Bravo");
  }
});

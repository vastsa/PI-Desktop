import type { Agent } from "@earendil-works/pi-agent-core";
import { DesktopAgentRuntime } from "./runtime.js";
import { describe, expect, it } from "vitest";
import { normalizeContext, type Message, type Model } from "@earendil-works/pi-ai";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { modelConfigFromPi } from "./model-capabilities.js";
import { buildProviderModel, type RuntimeProviderConfig } from "./provider-binding.js";

function flashProvider(): RuntimeProviderConfig {
  const flash = Object.values(DEEPSEEK_MODELS).find((model) => model.id === "deepseek-flash");
  if (!flash) throw new Error("Missing published Flash model");
  return {
    id: "flash-fixture", name: "Flash fixture", modelId: flash.id, baseUrl: flash.baseUrl,
    apiKey: "fixture", authKind: "api_key", supportsReasoning: true, supportedThinkingLevels: ["high"],
    // Main sends this projection across the sidecar boundary.
    modelConfig: JSON.parse(JSON.stringify(modelConfigFromPi(flash))),
  };
}

type Payload = { messages: Array<{ role: string; content?: unknown }> };
async function request(messages: Message[], baseUrl?: string): Promise<Payload> {
  const provider = flashProvider();
  const model = buildProviderModel({ ...provider, ...(baseUrl ? { baseUrl } : {}) });
  let captured: Payload | undefined;
  const response = stream(model as Model<"openai-completions">, normalizeContext({ messages }), {
    apiKey: "fixture",
    fetch: async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return new Response('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    },
  });
  expect((await response.result()).stopReason).toBe("stop");
  if (!captured) throw new Error("No Flash request captured");
  return captured;
}

describe("published Flash transcript compatibility", () => {
  it("enables system updates independently of native tool-state capabilities", () => {
    const provider = flashProvider();
    expect(provider.modelConfig?.compat?.supportsMidConvoSystemMessages).toBe(true);
    expect(buildProviderModel(provider).compat).toMatchObject({
      supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: false,
      supportsMidConvoToolChanges: false, supportsAdditionalTools: false, supportsToolSearch: false,
    });
    expect(buildProviderModel({ ...provider, baseUrl: "https://api.deepseek.com/" }).compat)
      .toMatchObject({ supportsMidConvoSystemMessages: true });
  });

  it.each([
    { modelId: "deepseek-flash-alias" },
    { baseUrl: "https://relay.example/v1" }, { baseUrl: "http://api.deepseek.com" },
    { baseUrl: "https://api.deepseek.com/v1" }, { baseUrl: "https://api.deepseek.com:8443" },
    { baseUrl: "https://api.deepseek.com?route=other" }, { baseUrl: "https://api.deepseek.com#fragment" },
    { baseUrl: "https://user@api.deepseek.com" },
  ])("retains conservative fallback on a changed binding: %j", (overrides) => {
    expect(buildProviderModel({ ...flashProvider(), ...overrides }).compat)
      .toMatchObject({ supportsMidConvoSystemMessages: false });
  });

  it("checks the selected wire API rather than the provider-wide style", () => {
    const provider = flashProvider();
    expect(buildProviderModel({ ...provider, apiStyle: "responses" })).toMatchObject({
      api: "openai-completions", compat: { supportsMidConvoSystemMessages: true },
    });
    expect(buildProviderModel({ ...provider, modelConfig: { ...provider.modelConfig!, api: "openai-responses" } }))
      .toMatchObject({ api: "openai-responses", compat: { supportsMidConvoSystemMessages: false } });
  });

  it("requires the original Pi binding even when the endpoint and model name look official", () => {
    const provider = flashProvider();
    for (const modelConfig of [undefined,
      { ...provider.modelConfig!, source: "generic" as const },
      { ...provider.modelConfig!, transcriptBinding: undefined },
    ]) {
      expect(buildProviderModel({ ...provider, modelConfig }).compat)
        .toMatchObject({ supportsMidConvoSystemMessages: false });
    }
  });

  it("appends skill changes and revocations without rewriting the previous wire prefix", async () => {
    const baseline: Message[] = [
      { role: "system", content: "", timestamp: 1, sections: {
        runtime: "Base rules", skills: "Load skills on demand", "skill:a": "Old Alpha", "skill:b": "Bravo",
      } },
      { role: "user", content: "First request", timestamp: 2 },
    ];
    const changed: Message[] = [...baseline,
      { role: "system", content: "", timestamp: 3, sections: { "skill:a": "New Alpha", "skill:b": null } },
      { role: "user", content: "Continue", timestamp: 4 },
    ];
    const before = await request(baseline);
    const after = await request(changed);
    expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
    expect(after.messages.map((message) => message.role)).toEqual(["system", "user", "system", "user"]);
    expect(JSON.stringify(after.messages[2])).toContain("New Alpha");
    expect(JSON.stringify(after.messages[2])).toContain("skill:b");
    const relay = await request(changed, "https://relay.example/v1");
    expect(relay.messages.map((message) => message.role)).toEqual(["system", "user", "user"]);
    expect(JSON.stringify(relay.messages)).toContain("New Alpha");
    expect(JSON.stringify(relay.messages)).not.toContain("Old Alpha");
    expect(JSON.stringify(relay.messages)).not.toContain("Bravo");
  });
});


describe("Flash reasoning after Desktop session restoration", () => {
  it.each([
    { providerId: "flash-fixture", modelId: "deepseek-flash", sameModel: true },
    { providerId: undefined, modelId: undefined, sameModel: true },
    { providerId: "another-account", modelId: "deepseek-flash", sameModel: false },
    { providerId: "flash-fixture", modelId: "another-model", sameModel: false },
  ])("preserves source identity when restoring %j", async ({ providerId, modelId, sameModel }) => {
    const provider = { ...flashProvider(), vendorKey: "deepseek" };
    let captured: Payload | undefined;
    const runtime = new DesktopAgentRuntime({
      sessionId: "restore-flash", mode: "agent", provider, thinkingLevel: "high",
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      history: [{
        id: "old-answer", role: "assistant", content: "answer", thinking: "private plan",
        providerId, modelId, status: "complete", createdAt: "2026-10-01T00:00:00.000Z",
      }],
      host: { call: async <T>(): Promise<T> => undefined as T }, onEvent: () => {},
    });
    const agent = (runtime as unknown as { agent: Agent }).agent;
    agent.streamFunction = (model, context) => stream(model as Model<"openai-completions">, context, {
      apiKey: "fixture", fetch: async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return new Response('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
      },
    });
    try {
      await runtime.prompt("Continue", "new-user", "new-turn");
      expect(captured).toBeDefined();
      const assistant = captured!.messages.find((message) => message.role === "assistant");
      if (sameModel) {
        expect(assistant).toMatchObject({ content: "answer", reasoning_content: "private plan" });
      } else {
        expect(assistant?.content).toBe("answer");
        expect(JSON.stringify(captured)).not.toContain("private plan");
      }
    } finally { await runtime.dispose(); }
  });
});

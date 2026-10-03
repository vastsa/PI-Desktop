import { describe, expect, it } from "vitest";
import type { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type Api, type Model, type AssistantMessage, type StreamFunction } from "@earendil-works/pi-ai";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { modelConfigFromPi } from "./model-capabilities.js";
import { runtimeFixture, pluginTools } from "./test-helpers/fixed-tool-fixture.js";

const base = Object.values(DEEPSEEK_MODELS).find((model) => model.id === "deepseek-flash")!;
const routes: { api: Api; compat?: Model<Api>["compat"]; native?: boolean; label: string }[] = [
  { label: "Chat Completions", api: "openai-completions" },
  { label: "Claude without native transitions", api: "anthropic-messages" },
  { label: "Claude with native transitions", api: "anthropic-messages", compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true } },
  { label: "OpenAI Responses fallback", api: "openai-responses" },
  { label: "Codex fallback", api: "openai-codex-responses" },
  { label: "Gemini", api: "google-generative-ai" },
  { label: "Kimi native additions", api: "openai-completions", native: true, compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true } },
  { label: "OpenAI native additions", api: "openai-responses", native: true, compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true } },
  { label: "Codex native search", api: "openai-codex-responses", native: true, compat: { supportsMidConvoSystemMessages: true, supportsToolSearch: true } },
  { label: "Codex native additions", api: "openai-codex-responses", native: true, compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true } },
  { label: "Pi transcript", api: "pi-messages", native: true },
];
// Cache markers move with the last message; they are not model input text.
function semantic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semantic);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "cache_control" && key !== "cachePoint")
    .map(([key, item]) => [key, semantic(item)]));
  return value;
}
function payloadView(value: unknown): { tools: unknown; system: unknown; messages: unknown[] } {
  const p = value as Record<string, unknown>;
  const config = p.config as Record<string, unknown> | undefined;
  const context = p.context as Record<string, unknown> | undefined;
  return { tools: p.tools ?? p.toolConfig ?? config?.tools,
    system: p.system ?? p.instructions ?? config?.systemInstruction,
    messages: (p.messages ?? p.input ?? p.contents ?? context?.messages ?? []) as unknown[] };
}

describe("ToolSearch user path through every Desktop-selectable Pi request adapter", () => {
  it.each(routes)("preserves schemas and history for $label", async ({ api, compat, native }) => {
    const model = { ...base, id: "fixture-model", provider: "fixture", api,
      baseUrl: "https://fixture.invalid", compat, reasoning: false } as Model<Api>;
    const adapter: { stream: StreamFunction } = await import(`@earendil-works/pi-ai/api/${api}`);
    // Synthetic token satisfies Codex's local parser; no real auth is read.
    const key = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64")}.fixture`;
    const f = runtimeFixture([], pluginTools, { id: "fixture", name: "Fixture", modelId: model.id,
      baseUrl: model.baseUrl, apiKey: key, authKind: "api_key", supportsReasoning: false,
      supportedThinkingLevels: ["off"], modelConfig: modelConfigFromPi(model) });
    const requests: ReturnType<typeof payloadView>[] = [];
    const captureErrors: string[] = [];
    const calls: { name: string; arguments: Record<string, string> }[] = [
      { name: "ToolSearch", arguments: { query: "plugin_alpha" } }, { name: "plugin_alpha", arguments: {} },
      { name: "ToolSearch", arguments: { query: "plugin_beta" } }, { name: "plugin_beta", arguments: {} },
    ];
    const agent = (f.runtime as unknown as { agent: Agent }).agent;
    agent.streamFunction = async (resolved, context) => {
      if (resolved.api !== api) captureErrors.push(`Wrong adapter: ${resolved.api}`);
      let captured: unknown;
      // Run the serializer and stop at the external request boundary, before
      // network access or cloud credential lookup.
      const probe = adapter.stream(resolved, context, { apiKey: key, maxTokens: 1024,
        onPayload: (payload) => { captured = payload; throw new Error("fixture payload captured"); },
      });
      const outcome = await probe.result();
      if (captured === undefined) captureErrors.push(outcome.errorMessage ?? "No payload");
      else if (JSON.stringify(captured).includes("tool_activation")) captureErrors.push("Activation metadata leaked");
      requests.push(payloadView(semantic(captured ?? {})));
      const call = calls.shift();
      const message: AssistantMessage = { role: "assistant", api, provider: resolved.provider, model: resolved.id,
        content: call ? [{ type: "toolCall", id: `call-${requests.length}`, ...call }] : [{ type: "text", text: "Done." }],
        stopReason: call ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: call ? "toolUse" : "stop", message });
      return stream;
    };
    try {
      await f.prompt();
      expect(captureErrors).toEqual([]);
      expect(f.errors).toEqual([]);
      expect(f.executed).toEqual(["plugin_alpha", "plugin_beta"]);
      expect(requests).toHaveLength(5);
      expect(requests[0].messages.length).toBeGreaterThan(0);
      if (!native) expect(JSON.stringify(requests[0].tools)).toContain("plugin_beta");
      else {
        expect(JSON.stringify(requests[0].tools) ?? "").not.toContain("plugin_beta");
        expect(JSON.stringify(requests.at(-1)?.messages)).toContain("plugin_beta");
      }
      for (let index = 1; index < requests.length; index++) {
        expect(requests[index].tools).toEqual(requests[0].tools);
        expect(requests[index].system).toEqual(requests[0].system);
        const previous = requests[index - 1].messages;
        expect(requests[index].messages.slice(0, previous.length)).toEqual(previous);
      }
    } finally { await f.runtime.dispose(); }
  });
});

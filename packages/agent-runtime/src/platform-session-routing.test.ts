import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEventEnvelope } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";
import { SubagentRun, type SubagentRunOptions } from "./subagent.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";
import { genericModelConfig } from "./model-capabilities.js";

const platform: RuntimeProviderConfig = {
  id: "platform", name: "Platform", vendorKey: "ai-aggregation-platform",
  baseUrl: "https://ai.yykkj.com/v1", authKind: "api_key_and_base_url",
  apiKey: "dummy", apiStyle: "chat_completions", modelId: "fixture-chat",
  supportsReasoning: false, supportedThinkingLevels: ["off"],
};

const runtimes: DesktopAgentRuntime[] = [];
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("Unexpected network request")));
});
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  vi.unstubAllGlobals();
});

function session(provider: RuntimeProviderConfig, events: AgentEventEnvelope[] = []) {
  const runtime = new DesktopAgentRuntime({
    sessionId: "platform-session", turnId: "turn-1", mode: "agent",
    provider, thinkingLevel: "off", systemPrompt: "Return a short response.",
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: { async call<T>(method: string): Promise<T> { throw new Error(`Unexpected host I/O: ${method}`); } },
    onEvent: (event) => events.push(event),
  });
  runtimes.push(runtime);
  return runtime;
}

function subagent(provider: RuntimeProviderConfig, overrides: Partial<SubagentRunOptions> = {}) {
  return new SubagentRun({
    definition: { name: "reviewer", description: "Review fixture", tools: [], prompt: "Review.", source: "builtin" },
    sessionId: "platform-session", turnId: "turn-1", parentToolCallId: "task-1",
    task: "Report the result.", provider, thinkingLevel: "off", systemPrompt: "Return a short response.",
    tools: [], onEvent: () => {}, ...overrides,
  });
}

/** A fresh stream for each call; both the real agent loop and pi-ai adapter run. */
function completion(text: string): Response {
  return new Response([
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [
      { index: 0, delta: { role: "assistant", content: text }, finish_reason: null },
    ] })}`,
    'data: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    "data: [DONE]",
  ].join("\n\n") + "\n\n", { headers: { "content-type": "text/event-stream" } });
}

const invalidProviders: Array<[string, Partial<RuntimeProviderConfig>]> = [
  ["foreign endpoint", { baseUrl: "https://outside.invalid/v1" }],
  ["foreign vendor", { vendorKey: "openai" }],
  ["vendor OAuth", { authKind: "oauth" }],
  ["anonymous auth", { authKind: "none" }],
  ["unsupported protocol", { apiStyle: "google_generative_ai" }],
  ["credential header override", { headers: { Authorization: "Bearer other-dummy" } }],
];

for (const owner of ["session", "subagent"] as const) {
  const create = owner === "session" ? session : subagent;
  describe(`${owner} public platform boundary`, () => {
    it.each(invalidProviders)("refuses %s before transport", (_name, override) => {
      expect(() => create({ ...platform, ...override })).toThrow(expect.objectContaining({
        errorCode: "PLATFORM_PROVIDER_REQUIRED",
      }));
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("refuses missing credentials and never asks an OAuth resolver for a replacement", () => {
      const resolveAuth = vi.fn(async () => ({ apiKey: "oauth-dummy" }));
      expect(() => create({ ...platform, apiKey: "  " })).toThrow(/API key/);
      expect(() => create({ ...platform, resolveAuth })).toThrow(/account authentication/);
      expect(resolveAuth).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("completes through the gateway despite foreign publisher routing metadata", async () => {
      const fetcher = vi.mocked(globalThis.fetch).mockImplementation(async () => completion("Platform result"));
      const provider = { ...platform, modelConfig: {
        ...genericModelConfig(platform.modelId, "https://publisher.invalid/v1"),
        api: "anthropic-messages", headers: { Authorization: "Bearer publisher-dummy" },
      } };
      const events: AgentEventEnvelope[] = [];
      if (owner === "session") await session(provider, events).prompt("Hello.");
      else {
        const result = await subagent(provider, { onEvent: (event) => events.push(event) }).run();
        expect(result).toMatchObject({ status: "completed", report: "Platform result", modelId: platform.modelId });
      }
      expect(events.some(({ event }) => event.type === "message_end" && event.message.content === "Platform result")).toBe(true);
      expect(events.filter(({ event }) => event.type === "error")).toEqual([]);
      expect(fetcher).toHaveBeenCalledTimes(1);
      const [input, init] = fetcher.mock.calls[0];
      expect(String(input)).toBe("https://ai.yykkj.com/v1/chat/completions");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer dummy");
      expect(init?.redirect).toBe("error");
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: platform.modelId, stream: true });
    });
  });
}

it("subagent fallback swaps platform model and key together after a model-not-found error", async () => {
  const fetcher = vi.mocked(globalThis.fetch)
    .mockResolvedValueOnce(new Response('{"error":{"message":"model not found"}}', {
      status: 404, headers: { "content-type": "application/json" },
    }))
    .mockImplementation(async () => completion("Fallback result"));
  const fallback = { ...platform, id: "platform-backup", modelId: "backup-chat", apiKey: "dummy-backup" };
  const result = await subagent(platform, { fallbackModels: [{ key: "platform-backup/backup-chat", provider: fallback }] }).run();
  expect(result).toMatchObject({ status: "completed", modelId: "backup-chat" });
  expect(result.report).toMatch(/Fallback result$/);
  expect(result.modelFailures).toEqual([expect.objectContaining({ model: "platform/fixture-chat", code: "MODEL_NOT_CONFIGURED" })]);
  expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
    "https://ai.yykkj.com/v1/chat/completions", "https://ai.yykkj.com/v1/chat/completions",
  ]);
  expect(fetcher.mock.calls.map(([, init]) => new Headers(init?.headers).get("authorization"))).toEqual([
    "Bearer dummy", "Bearer dummy-backup",
  ]);
  expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).model)).toEqual([
    "fixture-chat", "backup-chat",
  ]);
});

it("subagent fallback refuses a foreign saved endpoint without making its request", async () => {
  const fetcher = vi.mocked(globalThis.fetch).mockResolvedValue(new Response('{"error":{"message":"model not found"}}', {
    status: 404, headers: { "content-type": "application/json" },
  }));
  const result = await subagent(platform, { fallbackModels: [{
    key: "legacy/backup-chat", provider: { ...platform, id: "legacy", baseUrl: "https://outside.invalid/v1" },
  }] }).run();
  expect(result.status).toBe("failed");
  expect(result.error?.message).toMatch(/only supports AI Aggregation Platform/);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(String(fetcher.mock.calls[0][0])).toBe("https://ai.yykkj.com/v1/chat/completions");
});

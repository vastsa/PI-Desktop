import { createServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentEventEnvelope } from "@pi-desktop/shared";
import { Type } from "typebox";
import { SubagentRun, type SubagentRunOptions } from "./subagent.js";
import { genericModelConfig } from "./model-capabilities.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";
import { PROVIDER_RATE_LIMIT_MAX_RETRIES, PROVIDER_TRANSIENT_MAX_RETRIES } from "./provider-retry.js";

type Request = { model: string; messages: Array<{ role: string; content: unknown }>; reasoning_effort?: string };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function answer(res: ServerResponse, model: string, tool = false) {
  const delta = tool
    ? { role: "assistant", tool_calls: [{ index: 0, id: "once", type: "function", function: { name: "Edit", arguments: "{}" } }] }
    : { role: "assistant", content: "Completed with retained work." };
  const base = { id: "fixture", object: "chat.completion.chunk", created: 1, model };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
  res.end("data: [DONE]\n\n");
}

async function fixture(options: {
  fail?: string[];
  failureStatus?: Record<string, number>;
  editFirst?: boolean;
  onRequest?: (request: Request) => void;
} = {}) {
  const requests: Request[] = [];
  const headers: Array<string | undefined> = [];
  let edits = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const request = JSON.parse(raw) as Request;
    requests.push(request);
    headers.push(req.headers.authorization);
    options.onRequest?.(request);
    const status = options.failureStatus?.[request.model]
      ?? ((options.fail ?? ["primary"]).includes(request.model) ? 404 : undefined);
    if (options.editFirst && requests.length === 1) {
      answer(res, request.model, true);
    } else if (status) {
      res.writeHead(status, { "content-type": "application/json", "retry-after": "0" });
      res.end(JSON.stringify({ error: { message: status === 404 ? "model not found" : `Fixture HTTP ${status}` } }));
    } else {
      answer(res, request.model);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture address");
  const provider = (modelId: string): RuntimeProviderConfig => ({
    id: modelId, name: modelId, modelId,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: `fixture-${modelId}`, authKind: "api_key_and_base_url", apiStyle: "openai-chat",
    supportsReasoning: false, supportedThinkingLevels: ["off"],
  });
  const events: AgentEventEnvelope[] = [];
  const tool: AgentTool = {
    name: "Edit", label: "Edit", description: "Record a mutation once.", parameters: Type.Object({}),
    execute: async () => { edits++; return { content: [{ type: "text", text: "Saved exactly once" }], details: {} }; },
  };
  const run = (overrides: Partial<SubagentRunOptions> = {}) => new SubagentRun({
    definition: { name: "worker", description: "Fixture", tools: ["Edit"], prompt: "Finish.", source: "user" },
    sessionId: "s", parentToolCallId: "task", task: "Finish the work.", systemPrompt: "Finish the work.",
    provider: provider("primary"), thinkingLevel: "off", tools: [tool],
    fallbackModels: [{ key: "secondary/secondary", provider: provider("secondary") }],
    onEvent: (event) => events.push(event), ...overrides,
  }).run();
  return { run, provider, requests, headers, events, edits: () => edits };
}

describe("subagent model fallback over real transport", () => {
  const chain = ["primary", "secondary", "third", "fourth", "unused"];

  it.each([0, 1, 2, 3])("succeeds after %i unavailable models and stops at the first working model", async (failedCount) => {
    const failedModels = chain.slice(0, failedCount);
    const attempts = chain.slice(0, failedCount + 1);
    const f = await fixture({ fail: failedModels });
    const changes: string[] = [];
    const result = await f.run({
      fallbackModels: chain.slice(1).map((id) => ({ key: `${id}/${id}`, provider: f.provider(id) })),
      onModelChange: (provider) => changes.push(provider.modelId),
    });
    expect(result.status).toBe("completed");
    expect(result.modelId).toBe(chain[failedCount]);
    expect(result.report).toContain("Completed with retained work.");
    expect(result.error).toBeUndefined();
    expect(f.requests.map((request) => request.model)).toEqual(attempts);
    expect(f.headers).toEqual(attempts.map((id) => `Bearer fixture-${id}`));
    expect(changes).toEqual(attempts.slice(1));
    expect(result.modelFailures ?? []).toEqual(failedModels.map((id) =>
      expect.objectContaining({ model: `${id}/${id}`, code: "MODEL_NOT_CONFIGURED" })));
    for (const request of f.requests) {
      const users = request.messages.filter((message) => message.role === "user");
      expect(users).toHaveLength(1);
      expect(JSON.stringify(users[0].content)).toContain("Finish the work.");
      expect(request.messages.some((message) => message.role === "assistant")).toBe(false);
    }
  });

  it.each([1, 2, 3])("preserves completed tool work and credentials through %i unavailable models", async (failedCount) => {
    const failedModels = chain.slice(0, failedCount);
    const attempts = ["primary", ...chain.slice(0, failedCount + 1)];
    const finalModel = chain[failedCount];
    const f = await fixture({ editFirst: true, fail: failedModels });
    const result = await f.run({
      fallbackModels: chain.slice(1).map((id) => ({ key: `${id}/${id}`, provider: f.provider(id) })),
    });
    expect(result.status).toBe("completed");
    expect(result.modelId).toBe(finalModel);
    expect(f.requests.map((request) => request.model)).toEqual(attempts);
    expect(f.headers).toEqual(attempts.map((id) => `Bearer fixture-${id}`));
    expect(f.edits()).toBe(1);
    for (const request of f.requests.slice(1)) {
      expect(request.messages.filter((message) => message.role === "user")).toHaveLength(1);
      const tools = request.messages.filter((message) => message.role === "tool");
      expect(tools).toHaveLength(1);
      expect(String(tools[0].content)).toContain("Saved exactly once");
    }
    expect(result.toolCalls).toBe(1);
    expect(result.usage?.outputTokens).toBe(10);
    expect(result.modelFailures).toEqual(failedModels.map((id) =>
      expect.objectContaining({ model: `${id}/${id}`, code: "MODEL_NOT_CONFIGURED" })));
    expect(f.events.every((event) => event.parentToolCallId === "task")).toBe(true);
    expect(f.events.some((event) => event.event.type === "message_end" && event.event.message.modelId === finalModel)).toBe(true);
  });

  it("fails explicitly after four unavailable models without wrapping around", async () => {
    const failedModels = chain.slice(0, 4);
    const f = await fixture({ fail: failedModels });
    const result = await f.run({
      fallbackModels: failedModels.slice(1).map((id) => ({ key: `${id}/${id}`, provider: f.provider(id) })),
    });
    expect(result.status).toBe("failed");
    expect(result.modelId).toBe("fourth");
    expect(result.error?.code).toBe("MODEL_NOT_CONFIGURED");
    expect(f.requests.map((request) => request.model)).toEqual(failedModels);
    expect(result.modelFailures?.map((failure) => failure.model)).toEqual(failedModels.map((id) => `${id}/${id}`));
    expect(result.report).not.toContain("Completed with retained work.");
    for (const id of failedModels) expect(result.report).toContain(`Model ${id}/${id} failed`);
  });

  it("continues through unauthorized, forbidden, and missing models", async () => {
    const f = await fixture({ failureStatus: { primary: 401, secondary: 403, third: 404 } });
    const result = await f.run({
      fallbackModels: chain.slice(1).map((id) => ({ key: `${id}/${id}`, provider: f.provider(id) })),
    });
    expect(result.status).toBe("completed");
    expect(result.modelId).toBe("fourth");
    expect(f.requests.map((request) => request.model)).toEqual(chain.slice(0, 4));
    expect(result.modelFailures?.map((failure) => failure.code)).toEqual([
      "PROVIDER_UNAUTHORIZED", "PROVIDER_UNAUTHORIZED", "MODEL_NOT_CONFIGURED",
    ]);
  });

  it.each([429, 503])("exhausts HTTP %i retries separately for two models before the third succeeds", async (status) => {
    const f = await fixture({ failureStatus: { primary: status, secondary: status } });
    const result = await f.run({
      fallbackModels: chain.slice(1).map((id) => ({ key: `${id}/${id}`, provider: f.provider(id) })),
    });
    const retries = status === 429 ? PROVIDER_RATE_LIMIT_MAX_RETRIES : PROVIDER_TRANSIENT_MAX_RETRIES;
    expect(result.status).toBe("completed");
    expect(result.modelId).toBe("third");
    expect(f.requests.map((request) => request.model)).toEqual([
      ...Array(retries + 1).fill("primary"), ...Array(retries + 1).fill("secondary"), "third",
    ]);
    expect(result.modelFailures).toEqual(["primary", "secondary"].map((id) => expect.objectContaining({
      model: `${id}/${id}`, code: status === 429 ? "PROVIDER_RATE_LIMITED" : "PROVIDER_ERROR",
    })));
  });

  it("tries alternatives in order once, skips unresolved bindings visibly, and reports exhaustion", async () => {
    const f = await fixture({ fail: ["primary", "secondary", "third"] });
    const result = await f.run({ fallbackModels: [
      { key: "alias/primary", provider: f.provider("primary") },
      { key: "missing/model" },
      { key: "secondary/secondary", provider: f.provider("secondary") },
      { key: "alias/secondary", provider: f.provider("secondary") },
      { key: "third/third", provider: f.provider("third") },
    ] });
    expect(result.status).toBe("failed");
    expect(result.modelId).toBe("third");
    expect(f.requests.map((request) => request.model)).toEqual(["primary", "secondary", "third"]);
    expect(result.modelFailures?.map((failure) => failure.model)).toEqual(["primary/primary", "missing/model", "secondary/secondary", "third/third"]);
    expect(result.report).toContain("missing/model");
  });

  it("does not call alternatives on success or when none are configured", async () => {
    const f = await fixture({ fail: [] });
    expect((await f.run()).status).toBe("completed");
    expect(f.requests.map((request) => request.model)).toEqual(["primary"]);
    const failing = await fixture();
    expect((await failing.run({ fallbackModels: [] })).status).toBe("failed");
    expect(failing.requests.map((request) => request.model)).toEqual(["primary"]);
  });

  it("stops before fallback when the owner cancels", async () => {
    const controller = new AbortController();
    const f = await fixture({ onRequest: () => controller.abort() });
    expect((await f.run({ signal: controller.signal })).status).toBe("aborted");
    expect(f.requests.map((request) => request.model)).toEqual(["primary"]);
  });

  it("re-clamps inherited thinking from the original selection for each model", async () => {
    const f = await fixture();
    const next: RuntimeProviderConfig = { ...f.provider("secondary"), supportsReasoning: true, supportedThinkingLevels: ["off", "high"],
      modelConfig: { ...genericModelConfig("secondary", f.provider("secondary").baseUrl!), reasoning: true, supportedThinkingLevels: ["off", "high"] as const } };
    const changes: string[] = [];
    const result = await f.run({ inheritedThinkingLevel: "high", fallbackModels: [{ key: "s/secondary", provider: next }],
      onModelChange: (_, level) => changes.push(level) });
    expect(result.thinkingLevel).toBe("high");
    expect(changes).toEqual(["high"]);
    expect(f.requests[1].reasoning_effort).toBe("high");
  });
  it("does not retry a host tool failure through another model", async () => {
    const f = await fixture({ editFirst: true });
    await f.run({ resolveToolOutcome: () => ({ isError: true, terminate: true }) });
    expect(f.edits()).toBe(1);
    expect(f.requests.map((request) => request.model)).toEqual(["primary"]);
  });

  it("keeps thinking omission and honors cancellation during the switch", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const result = await f.run({ thinkingLevel: "omit", signal: controller.signal,
      onModelChange: () => controller.abort() });
    expect(result.status).toBe("aborted");
    expect(f.requests.map((request) => request.model)).toEqual(["primary"]);
    const g = await fixture();
    const omitted = await g.run({ thinkingLevel: "omit" });
    expect(omitted.thinkingLevel).toBe("omit");
    expect(g.requests.every((request) => request.reasoning_effort === undefined)).toBe(true);
  });

  it("skips a fallback whose window cannot hold the carried context (ADR 0299)", async () => {
    const f = await fixture({ failureStatus: { primary: 413 } });
    const base = f.provider("secondary");
    const small: RuntimeProviderConfig = {
      ...base,
      modelConfig: {
        ...genericModelConfig("secondary", base.baseUrl!),
        contextWindow: 4_096,
        maxTokens: 1_024,
      },
    };
    const result = await f.run({
      initialMessages: [{ role: "user", content: "z".repeat(12_000), timestamp: 1 }],
      fallbackModels: [{ key: "secondary/secondary", provider: small }],
    });
    // The carried context (~3 000 tokens) never reaches the 2 048-token safe
    // budget of the fallback, so the fallback is skipped without a request and
    // the run reports the actionable overflow instead of the raw provider text.
    expect(result.status).toBe("failed");
    expect(f.requests.map((request) => request.model)).toEqual(["primary"]);
    expect(result.error?.code).toBe("SUBAGENT_CONTEXT_OVERFLOW");
    expect(result.error?.message).toContain("larger context window");
    expect(result.modelFailures).toEqual([
      expect.objectContaining({ model: "primary/primary", code: "CONTEXT_TOO_LARGE" }),
      expect.objectContaining({ model: "secondary/secondary", code: "SUBAGENT_CONTEXT_OVERFLOW" }),
    ]);
  });

});

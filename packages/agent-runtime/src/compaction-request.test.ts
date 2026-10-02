import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Api, Model, Models, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import {
  OPENCODE_CLIENT_HEADER,
  OPENCODE_CLIENT_VALUE,
  OPENCODE_SESSION_HEADER,
  OPENCODE_USER_AGENT,
} from "./opencode-session-headers.js";
import {
  compactionRequestOptions,
  withCompactionRequestHeaders,
} from "./compaction-request.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

const provider: RuntimeProviderConfig = {
  id: "row-uuid",
  name: "OpenCode Go",
  vendorKey: "opencode-go",
  baseUrl: "https://opencode.ai/zen/go/v1",
  modelId: "glm-5.3-flash",
  apiKey: "sk-test",
  apiStyle: "opencode_go",
  supportsReasoning: false,
  supportedThinkingLevels: ["off"],
};

const model = {
  id: "glm-5.3-flash",
  name: "GLM-5.3-Flash",
  api: "openai-completions",
  provider: "row-uuid",
  baseUrl: "https://opencode.ai/zen/go/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as Model<Api>;

const context = { messages: [] };

describe("compactionRequestOptions", () => {
  it("carries the session id pi-agent-core's per-call fallback replaced", () => {
    const options = compactionRequestOptions({
      provider,
      sessionId: "session-1",
      model,
      context,
      options: { maxTokens: 4_096, sessionId: "01a0a579-0c7a-760e-b538-69727ac66e11" },
    });
    expect(options.sessionId).toBe("session-1");
    expect(options.maxTokens).toBe(4_096);
    expect(options.headers).toMatchObject({
      [OPENCODE_SESSION_HEADER]: "session-1",
      [OPENCODE_CLIENT_HEADER]: OPENCODE_CLIENT_VALUE,
      "User-Agent": OPENCODE_USER_AGENT,
    });
  });

  it("keeps a provider row's own headers and adds none for other providers", () => {
    const options = compactionRequestOptions({
      provider: {
        ...provider,
        apiStyle: "chat_completions",
        vendorKey: "openai",
        baseUrl: "https://api.openai.com/v1",
        headers: { "X-Team": "platform" },
      },
      sessionId: "session-1",
      model: { ...model, provider: "openai", baseUrl: "https://api.openai.com/v1" },
      context,
      options: undefined,
    });
    expect(options.headers).toEqual({ "X-Team": "platform" });
  });

  it("clears a caller-supplied fetch for a Google model, with or without row headers", () => {
    const callerFetch = vi.fn(async () => new Response("ok"));
    const googleModel = {
      ...model,
      provider: "google",
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    } as Model<Api>;
    const googleProvider: RuntimeProviderConfig = {
      ...provider,
      id: "google",
      name: "Google Gemini",
      vendorKey: "google",
      apiStyle: "google_generative_ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      modelId: "gemini-3.8-flash",
    };

    const withRowHeaders = compactionRequestOptions({
      provider: { ...googleProvider, headers: { "X-Team": "platform" } },
      sessionId: "session-1",
      model: googleModel,
      context,
      options: { fetch: callerFetch },
    });
    const withoutRowHeaders = compactionRequestOptions({
      provider: googleProvider,
      sessionId: "session-1",
      model: googleModel,
      context,
      options: { fetch: callerFetch },
    });

    expect(withRowHeaders.fetch).toBeUndefined();
    expect(withRowHeaders.headers).toMatchObject({ "X-Team": "platform" });
    expect(withoutRowHeaders.fetch).toBeUndefined();
    expect(callerFetch).not.toHaveBeenCalled();
  });
});

describe("withCompactionRequestHeaders", () => {
  it("stamps the headers on completeSimple and leaves the collection otherwise intact", async () => {
    const completeSimple = vi.fn(
      async (_model: Model<Api>, _context: unknown, _options?: unknown) =>
        "assistant-message",
    );
    const getModel = vi.fn(() => model);
    const collection = { completeSimple, getModel } as unknown as Models;

    const wrapped = withCompactionRequestHeaders(collection, provider, "session-1");
    await wrapped.completeSimple(model, context as never, { maxTokens: 4_096 });

    expect(completeSimple).toHaveBeenCalledOnce();
    expect(completeSimple.mock.calls[0]?.[2]).toMatchObject({
      sessionId: "session-1",
      maxTokens: 4_096,
      headers: { [OPENCODE_SESSION_HEADER]: "session-1" },
    });
    // Every other member is still the collection's own.
    expect(wrapped.getModel("row-uuid", "glm-5.3-flash")).toBe(model);
    expect(getModel).toHaveBeenCalledWith("row-uuid", "glm-5.3-flash");
  });

  it("reports the bounded payload shape for every wire API", async () => {
    const completeSimple = vi.fn(
      async (_model: Model<Api>, _context: unknown, options: ModelsSimpleStreamOptions) => {
        await options.onPayload?.(
          { messages: [{ role: "user", content: "private" }], max_tokens: 512 },
          model,
        );
        return "assistant-message";
      },
    );
    const shapes: unknown[] = [];
    const collection = { completeSimple } as unknown as Models;
    const wrapped = withCompactionRequestHeaders(
      collection,
      provider,
      "session-1",
      undefined,
      (shape) => shapes.push(shape),
    );

    await wrapped.completeSimple(model, { messages: [{ role: "user" }] } as never);

    expect(shapes).toEqual([
      {
        api: "openai-completions",
        topLevelFields: ["messages", "max_tokens"],
        roleCounts: { user: 1 },
        toolCount: 0,
        outputLimit: 512,
      },
    ]);
  });
});

describe("compaction summary conversation key", () => {
  /** A collection whose one request hands its own payload to the option hook. */
  function recordPayload(api: string, seed: Record<string, unknown> = {}) {
    const summaryModel = { ...model, api } as Model<Api>;
    const calls: { payload: Record<string, unknown>; result: unknown }[] = [];
    const collection = {
      completeSimple: async (
        _model: unknown,
        _context: unknown,
        options: ModelsSimpleStreamOptions,
      ) => {
        const payload: Record<string, unknown> = { input: [], ...seed };
        const result = await options.onPayload?.(payload, summaryModel);
        calls.push({ payload, result });
        return "assistant-message";
      },
    } as unknown as Models;
    return {
      model: summaryModel,
      calls,
      wrapped: withCompactionRequestHeaders(collection, provider, "session-1"),
    };
  }

  it.each(["openai-responses", "openai-codex-responses"])(
    "carries the session id as the prompt cache key for %s",
    async (api) => {
      const { model: summaryModel, calls, wrapped } = recordPayload(api);

      await wrapped.completeSimple(summaryModel, context as never, { maxTokens: 4_096 });

      const [call] = calls;
      const sent = (call?.result === undefined ? call?.payload : call?.result) as Record<string, unknown>;
      expect(sent.prompt_cache_key).toBe("session-1");
      // The adapter's own object stays untouched; the key rides the replacement.
      expect(call?.payload.prompt_cache_key).toBeUndefined();
    },
  );

  it.each(["openai-completions", "anthropic-messages", "google-generative-ai"])(
    "leaves a %s payload exactly as the adapter built it",
    async (api) => {
      const { model: summaryModel, calls, wrapped } = recordPayload(api);

      await wrapped.completeSimple(summaryModel, context as never, { maxTokens: 4_096 });

      const [call] = calls;
      expect(call?.result).toBeUndefined();
      expect(call?.payload).not.toHaveProperty("prompt_cache_key");
    },
  );

  it("keeps a prompt cache key the adapter already set", async () => {
    const { model: summaryModel, calls, wrapped } = recordPayload("openai-responses", {
      prompt_cache_key: "explicit-key",
    });

    await wrapped.completeSimple(summaryModel, context as never, { maxTokens: 4_096 });

    const [call] = calls;
    expect(call?.result).toBeUndefined();
    expect(call?.payload.prompt_cache_key).toBe("explicit-key");
  });

  it("clamps a long session id the way the Responses adapter does", async () => {
    const collection = {
      completeSimple: async (
        _model: unknown,
        _context: unknown,
        options: ModelsSimpleStreamOptions,
      ) => {
        const payload: Record<string, unknown> = { input: [] };
        const result = await options.onPayload?.(
          payload,
          { ...model, api: "openai-responses" } as Model<Api>,
        );
        return result === undefined ? payload : result;
      },
    } as unknown as Models;
    const summaryModel = { ...model, api: "openai-responses" } as Model<Api>;
    const wrapped = withCompactionRequestHeaders(collection, provider, "s".repeat(80));

    const sent = (await wrapped.completeSimple(summaryModel, context as never, {
      maxTokens: 4_096,
    })) as unknown as Record<string, unknown>;

    expect(sent.prompt_cache_key).toBe("s".repeat(64));
  });

  it("keeps an existing hook's replacement and mutation semantics", async () => {
    const replaced = { input: [], replaced: true };
    const { model: summaryModel, calls, wrapped } = recordPayload("openai-responses");

    await wrapped.completeSimple(summaryModel, context as never, {
      maxTokens: 4_096,
      onPayload: () => replaced,
    });

    const [call] = calls;
    const sent = (call?.result === undefined ? call?.payload : call?.result) as Record<string, unknown>;
    expect(sent.replaced).toBe(true);
    expect(sent.prompt_cache_key).toBe("session-1");
    expect(replaced).not.toHaveProperty("prompt_cache_key");

    const second = recordPayload("openai-responses");
    await second.wrapped.completeSimple(second.model, context as never, {
      maxTokens: 4_096,
      onPayload: (payload) => {
        (payload as Record<string, unknown>).mutated = true;
        return undefined;
      },
    });

    const [mutated] = second.calls;
    const sentMutation = (mutated?.result === undefined
      ? mutated?.payload
      : mutated?.result) as Record<string, unknown>;
    expect(sentMutation.mutated).toBe(true);
    expect(sentMutation.prompt_cache_key).toBe("session-1");
  });
});

 it("accounts each summary attempt with its account and preserves replay identity", async () => {
  const reports: import("@pi-desktop/shared").MessageUsage[] = [];
  const response = (failed: boolean): AssistantMessage => ({ role: "assistant", content: [], api: model.api,
    provider: model.provider, model: model.id, timestamp: 1, stopReason: failed ? "error" : "stop",
    usage: { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const completeSimple = vi.fn().mockResolvedValueOnce(response(true)).mockResolvedValueOnce(response(false));
  const wrapped = withCompactionRequestHeaders({ completeSimple } as unknown as Models, provider, "summary-session", usage => reports.push(usage));
  const failed = await wrapped.completeSimple(model, context);
  await wrapped.completeSimple(model, context);
  expect(reports).toHaveLength(2);
  expect(new Set(reports.map(usage => usage.operationId)).size).toBe(2);
  expect(reports[0]).toMatchObject({ providerId: provider.id, modelId: model.id, totalTokens: 15, costStatus: "unknown" });
  expect((failed.usage as unknown as { desktopUsage?: { operationId?: string } }).desktopUsage?.operationId).toBe(reports[0]?.operationId);
  expect(completeSimple.mock.calls[0]?.[2]).toMatchObject({ sessionId: "summary-session", headers: { [OPENCODE_SESSION_HEADER]: "summary-session" } });
});

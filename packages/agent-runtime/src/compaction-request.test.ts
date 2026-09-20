import { describe, expect, it, vi } from "vitest";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
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
});

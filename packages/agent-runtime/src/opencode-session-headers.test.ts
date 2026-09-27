import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { APP_VERSION } from "@pi-desktop/shared";
import { completeOneShot } from "./one-shot-complete.js";
import {
  OPENCODE_CLIENT_HEADER,
  OPENCODE_CLIENT_VALUE,
  OPENCODE_SESSION_HEADER,
  OPENCODE_USER_AGENT,
  isOpenCodeEndpoint,
  mergeOpenCodeSessionHeaders,
  withOpenCodeSessionHeaders,
} from "./opencode-session-headers.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

const openaiCompletionsModel = {
  id: "glm-5.3-flash",
  name: "GLM-5.3-Flash",
  api: "openai-completions",
  provider: "row-uuid",
  baseUrl: "https://opencode.ai/zen/go/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as Model<"openai-completions">;

const localModel = {
  ...openaiCompletionsModel,
  provider: "local",
  baseUrl: "http://127.0.0.1:11434/v1",
} as Model<"openai-completions">;

describe("isOpenCodeEndpoint", () => {
  it("matches the OpenCode Go apiStyle even when the row id is a UUID", () => {
    expect(
      isOpenCodeEndpoint({
        apiStyle: "opencode_go",
        baseUrl: "https://opencode.ai/zen/go/v1",
      }),
    ).toBe(true);
  });

  it("matches vendorKey and native pi-ai provider ids", () => {
    expect(isOpenCodeEndpoint({ vendorKey: "opencode-go" })).toBe(true);
    expect(isOpenCodeEndpoint({ vendorKey: "opencode" })).toBe(true);
    expect(
      isOpenCodeEndpoint({
        model: { ...openaiCompletionsModel, provider: "opencode-go" },
      }),
    ).toBe(true);
  });

  it("matches opencode.ai hosts on a generic OpenAI-compatible row", () => {
    expect(
      isOpenCodeEndpoint({
        apiStyle: "chat_completions",
        baseUrl: "https://opencode.ai/zen/go/v1",
      }),
    ).toBe(true);
    expect(
      isOpenCodeEndpoint({
        model: openaiCompletionsModel,
      }),
    ).toBe(true);
  });

  it("does not match other OpenAI-compatible gateways", () => {
    expect(
      isOpenCodeEndpoint({
        apiStyle: "chat_completions",
        baseUrl: "https://openrouter.ai/api/v1",
      }),
    ).toBe(false);
    expect(isOpenCodeEndpoint({ model: localModel })).toBe(false);
  });
});

describe("mergeOpenCodeSessionHeaders", () => {
  it("injects session, client, and user-agent headers", () => {
    expect(
      mergeOpenCodeSessionHeaders({
        apiStyle: "opencode_go",
        sessionId: "session-1",
      }),
    ).toEqual({
      [OPENCODE_SESSION_HEADER]: "session-1",
      [OPENCODE_CLIENT_HEADER]: OPENCODE_CLIENT_VALUE,
      "User-Agent": `pi-desktop/${APP_VERSION}`,
    });
    expect(OPENCODE_USER_AGENT).toBe(`pi-desktop/${APP_VERSION}`);
  });

  it("lets caller headers override client/UA but restores a missing session id", () => {
    expect(
      mergeOpenCodeSessionHeaders({
        apiStyle: "opencode_go",
        sessionId: "session-1",
        headers: {
          [OPENCODE_SESSION_HEADER]: null,
          [OPENCODE_CLIENT_HEADER]: "custom-client",
          "X-Extra": "keep",
        },
      }),
    ).toEqual({
      [OPENCODE_SESSION_HEADER]: "session-1",
      [OPENCODE_CLIENT_HEADER]: "custom-client",
      "User-Agent": OPENCODE_USER_AGENT,
      "X-Extra": "keep",
    });
  });

  it("preserves an explicit session header", () => {
    expect(
      mergeOpenCodeSessionHeaders({
        apiStyle: "opencode_go",
        sessionId: "session-1",
        headers: { [OPENCODE_SESSION_HEADER]: "already-set" },
      })?.[OPENCODE_SESSION_HEADER],
    ).toBe("already-set");
  });

  it("does not add headers for other providers", () => {
    expect(
      mergeOpenCodeSessionHeaders({
        apiStyle: "chat_completions",
        baseUrl: "https://api.openai.com/v1",
        sessionId: "session-1",
        headers: { "X-Existing": "1" },
      }),
    ).toEqual({ "X-Existing": "1" });
  });

  it("does not add headers without a session id", () => {
    expect(
      mergeOpenCodeSessionHeaders({
        apiStyle: "opencode_go",
        sessionId: "  ",
      }),
    ).toBeUndefined();
  });
});

describe("withOpenCodeSessionHeaders", () => {
  it("reuses options.sessionId and leaves retries with the same object fields", () => {
    const options: SimpleStreamOptions = { temperature: 0 };
    const first = withOpenCodeSessionHeaders(options, {
      apiStyle: "opencode_go",
      sessionId: "session-1",
    });
    const second = withOpenCodeSessionHeaders(first, {
      apiStyle: "opencode_go",
    });
    expect(first.sessionId).toBe("session-1");
    expect(second.sessionId).toBe("session-1");
    expect(first.headers?.[OPENCODE_SESSION_HEADER]).toBe("session-1");
    expect(second.headers?.[OPENCODE_SESSION_HEADER]).toBe("session-1");
    expect(first.temperature).toBe(0);
  });

  it("synthesizes a session id for OpenCode one-shot calls that have none", () => {
    const result = withOpenCodeSessionHeaders({}, { apiStyle: "opencode_go" });
    expect(result.sessionId).toEqual(expect.any(String));
    expect(result.sessionId?.length).toBeGreaterThan(8);
    expect(result.headers?.[OPENCODE_SESSION_HEADER]).toBe(result.sessionId);
  });

  it("does not synthesize a session id for other providers", () => {
    const result = withOpenCodeSessionHeaders(
      { temperature: 1 },
      { apiStyle: "chat_completions", baseUrl: "https://api.openai.com/v1" },
    );
    expect(result.sessionId).toBeUndefined();
    expect(result.headers).toBeUndefined();
    expect(result.temperature).toBe(1);
  });
});

describe("completeOneShot OpenCode headers", () => {
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

  function assistantOk(): AssistantMessage {
    return {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      api: "openai-completions",
      provider: provider.id,
      model: provider.modelId,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
  }

  function streamFor(message: AssistantMessage) {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
    });
    return stream;
  }

  it("sends the conversation id on OpenCode Go one-shot completions", async () => {
    let captured: SimpleStreamOptions | undefined;
    const result = await completeOneShot(
      provider,
      { systemPrompt: "s", messages: [] },
      "off",
      {
        sessionId: "session-9",
        stream: (_model, _context, options) => {
          captured = options;
          return streamFor(assistantOk());
        },
      },
    );
    expect(result.text).toBe("ok");
    expect(captured?.sessionId).toBe("session-9");
    expect(captured?.headers).toMatchObject({
      [OPENCODE_SESSION_HEADER]: "session-9",
      [OPENCODE_CLIENT_HEADER]: OPENCODE_CLIENT_VALUE,
      "User-Agent": OPENCODE_USER_AGENT,
    });
  });

  it("does not attach OpenCode headers to a generic Completions provider", async () => {
    let captured: SimpleStreamOptions | undefined;
    await completeOneShot(
      {
        ...provider,
        apiStyle: "chat_completions",
        vendorKey: "openai",
        baseUrl: "https://api.openai.com/v1",
      },
      { systemPrompt: "s", messages: [] },
      "off",
      {
        sessionId: "session-9",
        stream: (_model, _context, options) => {
          captured = options;
          return streamFor(assistantOk());
        },
      },
    );
    expect(captured?.sessionId).toBe("session-9");
    expect(captured?.headers?.[OPENCODE_SESSION_HEADER]).toBeUndefined();
  });
});

describe("OpenCode header call-site wiring", () => {
  it("is applied on session, subagent, and one-shot streams", () => {
    const sources = [
      readFileSync(new URL("./runtime.ts", import.meta.url), "utf8"),
      readFileSync(new URL("./subagent.ts", import.meta.url), "utf8"),
      readFileSync(new URL("./one-shot-complete.ts", import.meta.url), "utf8"),
    ];
    for (const source of sources) {
      expect(source).toContain("withOpenCodeSessionHeaders");
      expect(source).toContain("openCodeEndpointFromProvider");
    }
  });
});

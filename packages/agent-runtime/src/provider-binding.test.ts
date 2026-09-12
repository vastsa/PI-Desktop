import { describe, expect, it, vi } from "vitest";
import type { ModelAuth } from "@earendil-works/pi-ai";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { modelConfigWithBinding } from "./model-capabilities.js";
import type { ModelConfig } from "./thinking-level.js";
import {
  apiBindingForStyle,
  buildProviderModel,
  copilotRequestHeaders,
  createProviderModels,
  runtimeBaseUrlForApi,
  type RuntimeProviderConfig,
} from "./provider-binding.js";

const keyedProvider: RuntimeProviderConfig = {
  id: "acme",
  name: "Acme",
  baseUrl: "https://api.acme.test/v1",
  modelId: "acme-1",
  apiKey: "sk-test",
  authKind: "api_key_and_base_url",
  supportsReasoning: false,
  supportedThinkingLevels: ["off"],
};

describe("apiBindingForStyle", () => {
  it("binds OpenCode Go to its fixed OpenAI-compatible endpoint", () => {
    const opencode = apiBindingForStyle("opencode_go");
    expect(opencode.api).toBe("openai-completions");
    expect(opencode.defaultBaseUrl).toBe("https://opencode.ai/zen/go/v1");
  });

  it("binds the two vendor-account wire APIs", () => {
    const codex = apiBindingForStyle("openai_codex_responses");
    expect(codex.api).toBe("openai-codex-responses");
    expect(codex.defaultBaseUrl).toBe("https://chatgpt.com/backend-api");

    const radius = apiBindingForStyle("pi_messages");
    expect(radius.api).toBe("pi-messages");
    expect(radius.defaultBaseUrl).toBe("https://radius.pi.dev");
  });

  it("keeps unknown styles on chat completions", () => {
    expect(apiBindingForStyle("not-a-style").api).toBe("openai-completions");
    expect(apiBindingForStyle(undefined).api).toBe("openai-completions");
  });
});

describe("Anthropic runtime endpoint", () => {
  it("removes a trailing /v1 before pi-ai appends its version path", () => {
    expect(runtimeBaseUrlForApi("anthropic-messages", "https://gw.example/v1/")).toBe(
      "https://gw.example",
    );
    expect(runtimeBaseUrlForApi("anthropic-messages", "https://gw.example/anthropic/v1")).toBe(
      "https://gw.example/anthropic",
    );
    expect(runtimeBaseUrlForApi("anthropic-messages", "https://api.anthropic.com")).toBe(
      "https://api.anthropic.com",
    );
    expect(runtimeBaseUrlForApi("openai-completions", "https://gw.example/v1/")).toBe(
      "https://gw.example/v1/",
    );
  });

  it("sends a /v1 endpoint to Anthropic gateways without doubling the path", async () => {
    const provider: RuntimeProviderConfig = {
      ...keyedProvider,
      id: "anthropic-gateway",
      name: "Anthropic gateway",
      baseUrl: "https://gw.example/anthropic/v1",
      modelId: "glm-5.3",
      apiStyle: "anthropic_messages",
    };
    const model = buildProviderModel(provider);
    const urls: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return new Response("bad gateway", { status: 502 });
    });

    const result = await createProviderModels(provider, model)
      .streamSimple(
        model,
        {
          systemPrompt: "system",
          messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
          tools: [],
        },
        { fetch },
      )
      .result();

    expect(result.stopReason).toBe("error");
    expect(urls).toEqual(["https://gw.example/anthropic/v1/messages?beta=true"]);
  });
});

describe("buildProviderModel OpenAI-compatible role compatibility", () => {
  const reasoningProvider: RuntimeProviderConfig = {
    ...keyedProvider,
    supportsReasoning: true,
    supportedThinkingLevels: ["off", "high"],
    modelConfig: {
      source: "generic",
      name: "Reasoning model",
      baseUrl: keyedProvider.baseUrl!,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    },
  };

  it("sends the system prompt as system for issue #30's GLM gateway", () => {
    const model = buildProviderModel({
      ...reasoningProvider,
      id: "aimom",
      name: "AIMOM",
      baseUrl: "https://platform.aimom.net/v1",
      modelId: "glm-5.3-flash",
      apiStyle: "chat_completions",
      modelConfig: {
        ...reasoningProvider.modelConfig!,
        name: "GLM-5.3-Flash",
        baseUrl: "https://platform.aimom.net/v1",
      },
    }) as any;

    expect(model.compat).toMatchObject({ supportsDeveloperRole: false });
    const messages = convertMessages(
      model,
      { systemPrompt: "Follow the workspace rules.", messages: [] },
      { supportsDeveloperRole: model.compat.supportsDeveloperRole } as any,
    );

    expect(messages).toEqual([
      { role: "system", content: "Follow the workspace rules." },
    ]);
  });

  it("preserves an explicit model-level developer-role override", () => {
    const model = buildProviderModel({
      ...reasoningProvider,
      apiStyle: "chat_completions",
      modelConfig: {
        ...reasoningProvider.modelConfig!,
        compat: { supportsDeveloperRole: true },
      },
    }) as any;

    expect(model.compat).toMatchObject({ supportsDeveloperRole: true });
    const messages = convertMessages(
      model,
      { systemPrompt: "Use the provider's developer role.", messages: [] },
      { supportsDeveloperRole: model.compat.supportsDeveloperRole } as any,
    );

    expect(messages).toEqual([
      { role: "developer", content: "Use the provider's developer role." },
    ]);
  });

  it("applies Zhipu thinking and tool-stream flags from the endpoint URL", () => {
    const model = buildProviderModel({
      ...reasoningProvider,
      id: "row-uuid",
      vendorKey: "zhipuai-coding-plan",
      baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
      modelId: "glm-5.3",
      apiStyle: "chat_completions",
      modelConfig: {
        ...reasoningProvider.modelConfig!,
        name: "GLM-5.3",
        baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
      },
    }) as any;

    expect(model.compat).toMatchObject({
      thinkingFormat: "zai",
      zaiToolStream: true,
      supportsDeveloperRole: false,
    });
  });

  it("fills missing reasoning_content for DeepSeek models on aggregator URLs", () => {
    const model = buildProviderModel({
      ...reasoningProvider,
      id: "row-uuid",
      vendorKey: "siliconflow-cn",
      baseUrl: "https://api.siliconflow.cn/v1",
      modelId: "deepseek-ai/DeepSeek-V3.2",
      apiStyle: "chat_completions",
      modelConfig: {
        ...reasoningProvider.modelConfig!,
        name: "DeepSeek V3.2",
        family: "deepseek",
        baseUrl: "https://api.siliconflow.cn/v1",
      },
    }) as any;

    expect(model.provider).toBe("row-uuid");
    expect(model.compat).toMatchObject({
      requiresReasoningContentOnAssistantMessages: true,
      supportsDeveloperRole: false,
    });
    expect(model.compat.thinkingFormat).toBeUndefined();

    const messages = convertMessages(
      model,
      {
        systemPrompt: "Follow the workspace rules.",
        messages: [
          { role: "user", content: "hello", timestamp: Date.now() },
          {
            role: "assistant",
            content: [{ type: "text", text: "answer without thinking" }],
            api: "openai-completions",
            provider: model.provider,
            model: model.id,
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
          },
        ],
      },
      {
        supportsDeveloperRole: false,
        requiresReasoningContentOnAssistantMessages: true,
      } as any,
    );

    expect(messages).toEqual([
      { role: "system", content: "Follow the workspace rules." },
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "answer without thinking",
        reasoning_content: "",
      },
    ]);
  });

  it("fills missing reasoning_content from catalog family when the model id is an endpoint", () => {
    const model = buildProviderModel({
      ...reasoningProvider,
      id: "row-uuid",
      vendorKey: "volcengine",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      modelId: "ep-20250101-xyz",
      apiStyle: "chat_completions",
      modelConfig: {
        ...reasoningProvider.modelConfig!,
        name: "DeepSeek V4 Pro",
        family: "deepseek-thinking",
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      },
    }) as any;

    expect(model.compat).toMatchObject({
      requiresReasoningContentOnAssistantMessages: true,
    });
  });

  it("does not mark unrelated OpenAI-compatible models as DeepSeek reasoning replay", () => {
    const model = buildProviderModel({
      ...reasoningProvider,
      id: "row-uuid",
      vendorKey: "custom",
      baseUrl: "https://api.example.com/v1",
      modelId: "gpt-4.1",
      apiStyle: "chat_completions",
    }) as any;

    expect(model.compat.requiresReasoningContentOnAssistantMessages).toBeUndefined();
  });

  it("preserves MiniMax M3 image input on its OpenAI-compatible endpoint", () => {
    const provider: RuntimeProviderConfig = {
      ...keyedProvider,
      id: "minimax-row",
      name: "MiniMax (OpenAI)",
      vendorKey: "minimax-cn",
      baseUrl: "https://api.minimaxi.com/v1",
      modelId: "MiniMax-M3",
      apiStyle: "chat_completions",
      supportsReasoning: true,
      supportedThinkingLevels: ["off", "low", "medium", "high"],
      modelConfig: {
        source: "models.dev",
        name: "MiniMax-M3",
        baseUrl: "https://api.minimaxi.com/v1",
        reasoning: true,
        modalities: { input: ["text", "image", "video"], output: ["text"] },
        input: ["text", "image"],
        contextWindow: 1_048_576,
        maxTokens: 512_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    };
    const model = buildProviderModel(provider) as any;
    expect(model.input).toEqual(["text", "image"]);
    expect(model.compat).toMatchObject({ supportsDeveloperRole: false });

    const messages = convertMessages(
      model,
      {
        systemPrompt: "Read the image.",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is shown?" },
              { type: "image", data: "AQI=", mimeType: "image/png" },
            ],
            timestamp: Date.now(),
          },
        ],
      },
      { supportsDeveloperRole: false } as any,
    );

    expect(messages).toEqual([
      { role: "system", content: "Read the image." },
      {
        role: "user",
        content: [
          { type: "text", text: "What is shown?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AQI=" } },
        ],
      },
    ]);
  });
});

describe("createProviderModels auth resolution", () => {
  it("signs with the stored key when no vendor account is bound", async () => {
    const models = createProviderModels(
      keyedProvider,
      buildProviderModel(keyedProvider),
    );

    const resolved = await models.getAuth(keyedProvider.id);

    expect(resolved?.auth).toEqual({ apiKey: "sk-test" });
  });

  it("asks Electron main for vendor auth on every request", async () => {
    // A vendor access token lives about an hour, so nothing here may be
    // cached: each request must see whatever main hands back now.
    const auths: ModelAuth[] = [
      { apiKey: "first-token", headers: { "x-vendor": "1" } },
      { apiKey: "second-token", baseUrl: "https://per-account.acme.test" },
    ];
    const resolveAuth = vi.fn(async () => auths.shift() as ModelAuth);
    const provider: RuntimeProviderConfig = {
      ...keyedProvider,
      apiKey: "",
      authKind: "oauth",
      resolveAuth,
    };
    const models = createProviderModels(provider, buildProviderModel(provider));

    const first = await models.getAuth(provider.id);
    const second = await models.getAuth(provider.id);

    expect(resolveAuth).toHaveBeenCalledTimes(2);
    // Headers and the per-credential baseUrl ride along with the token: they
    // are how Copilot pins an account to its own endpoint.
    expect(first?.auth).toEqual({ apiKey: "first-token", headers: { "x-vendor": "1" } });
    expect(second?.auth).toEqual({
      apiKey: "second-token",
      baseUrl: "https://per-account.acme.test",
    });
  });
});

describe("explicit extended thinking levels", () => {
  it("sends enabled xhigh and max values instead of clamping them to high", async () => {
    const thinkingLevels = ["off", "low", "medium", "high", "xhigh", "max"] as const;
    const configuredModel = modelConfigWithBinding(
      {
        source: "generic",
        name: "Explicit reasoning model",
        baseUrl: "https://api.acme.test/v1",
        reasoning: true,
        supportedThinkingLevels: ["low", "medium", "high"],
        thinkingLevelMap: { xhigh: null, max: null },
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 8_192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        contextWindow: 128_000,
        maxTokens: 8_192,
        thinkingLevels: [...thinkingLevels],
      },
    );
    const provider: RuntimeProviderConfig = {
      ...keyedProvider,
      supportsReasoning: true,
      supportedThinkingLevels: [...thinkingLevels],
      modelConfig: configuredModel,
    };
    const requests: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const model = buildProviderModel(provider);

    for (const reasoning of ["high", "xhigh", "max"] as const) {
      await createProviderModels(provider, model)
        .streamSimple(
          model,
          {
            systemPrompt: "system",
            messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
            tools: [],
          },
          { reasoning, fetch },
        )
        .result();
    }

    expect(requests.map((request) => request.reasoning_effort)).toEqual([
      "high",
      "xhigh",
      "max",
    ]);
  });
});

describe("buildProviderModel model-level wire API", () => {
  const museCatalog: ModelConfig = {
    source: "models.dev",
    name: "Muse Spark 1.3 Contributor",
    baseUrl: "https://opencode.ai/zen/go/v1",
    api: "openai-responses",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 131072,
    compat: { supportsStrictMode: true },
  };
  const responsesCatalogProvider: RuntimeProviderConfig = {
    ...keyedProvider,
    id: "opencode-go",
    name: "OpenCode Go",
    vendorKey: "opencode-go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    modelId: "muse-spark-1.3-contributor",
    apiStyle: "opencode_go",
    supportsReasoning: true,
    supportedThinkingLevels: ["off", "low", "medium", "high", "xhigh"],
    modelConfig: { ...museCatalog },
  };

  it("routes a responses-only model through the responses API (issue #105)", () => {
    const model = buildProviderModel(responsesCatalogProvider) as any;
    expect(model.api).toBe("openai-responses");
    expect(model.baseUrl).toBe("https://opencode.ai/zen/go/v1");
    expect(model.compat).toMatchObject({ supportsStrictMode: true });
  });

  it("keeps the provider-wide style when the catalog pins no wire API", () => {
    const model = buildProviderModel({
      ...responsesCatalogProvider,
      modelId: "deepseek-v4-flash",
      modelConfig: {
        source: "models.dev",
        name: "DeepSeek V4 Flash",
        baseUrl: "https://opencode.ai/zen/go/v1",
        reasoning: true,
        input: ["text"],
        contextWindow: 1000000,
        maxTokens: 384000,
      },
    }) as any;
    expect(model.api).toBe("openai-completions");
  });

  it("leaves the same model on completions under other providers (issue #105)", () => {
    const model = buildProviderModel({
      ...responsesCatalogProvider,
      id: "llmgateway",
      name: "LLM Gateway",
      vendorKey: "llmgateway",
      baseUrl: "https://llmgateway.example/v1",
      apiStyle: "chat_completions",
      modelConfig: {
        source: "models.dev",
        name: "Muse Spark 1.3 Contributor",
        baseUrl: "https://llmgateway.example/v1",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1048576,
        maxTokens: 131072,
      },
    }) as any;
    expect(model.api).toBe("openai-completions");
  });

  it("posts responses models to the responses endpoint", async () => {
    const provider = responsesCatalogProvider;
    const model = buildProviderModel(provider);
    const urls: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return new Response("bad gateway", { status: 502 });
    });
    const result = await createProviderModels(provider, model)
      .streamSimple(
        model,
        {
          systemPrompt: "system",
          messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
          tools: [],
        },
        { fetch },
      )
      .result();
    expect(result.stopReason).toBe("error");
    expect(urls).toEqual(["https://opencode.ai/zen/go/v1/responses"]);
  });
});

describe("GitHub Copilot transport identity", () => {
  const provider: RuntimeProviderConfig = {
    id: "copilot-account-row",
    name: "GitHub Copilot",
    vendorKey: "github-copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
    modelId: "gpt-4o",
    apiKey: "",
    authKind: "oauth",
    apiStyle: "responses",
    supportsReasoning: true,
    supportedThinkingLevels: ["off", "low", "medium", "high", "max"],
    resolveAuth: async () => ({
      apiKey: "copilot-token",
      baseUrl: "https://api.individual.githubcopilot.com",
    }),
  };

  it("retains pi-ai static headers for a row-scoped OAuth model", () => {
    const model = buildProviderModel(provider);

    expect(model.provider).toBe(provider.id);
    expect(model.headers).toMatchObject({
      "Editor-Version": "vscode/1.107.0",
      "Editor-Plugin-Version": "copilot-chat/0.35.0",
      "Copilot-Integration-Id": "vscode-chat",
    });
  });

  it("derives dynamic headers from the current request context", () => {
    expect(
      copilotRequestHeaders(provider, {
        messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
      }),
    ).toEqual({
      "X-Initiator": "user",
      "Openai-Intent": "conversation-edits",
    });

    expect(
      copilotRequestHeaders(provider, {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hello" },
              { type: "image", data: "AQI=", mimeType: "image/png" },
            ],
            timestamp: Date.now(),
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "working" }],
            api: "openai-responses",
            provider: provider.id,
            model: provider.modelId,
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: "stop",
            timestamp: Date.now(),
          },
        ],
      }),
    ).toEqual({
      "X-Initiator": "agent",
      "Openai-Intent": "conversation-edits",
      "Copilot-Vision-Request": "true",
    });
  });

  it("sends the complete identity on a row-scoped Responses request", async () => {
    const model = buildProviderModel(provider);
    const context = {
      systemPrompt: "system",
      messages: [{ role: "user" as const, content: "hello", timestamp: Date.now() }],
      tools: [],
    };
    let request: Request | undefined;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init);
      return new Response(
        JSON.stringify({ error: "missing Editor-Version header for IDE auth" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    });

    const result = await createProviderModels(provider, model)
      .streamSimple(model, context, {
        fetch,
        headers: copilotRequestHeaders(provider, context),
      })
      .result();

    expect(result.stopReason).toBe("error");
    expect(request?.headers.get("Editor-Version")).toBe("vscode/1.107.0");
    expect(request?.headers.get("Editor-Plugin-Version")).toBe("copilot-chat/0.35.0");
    expect(request?.headers.get("Copilot-Integration-Id")).toBe("vscode-chat");
    expect(request?.headers.get("X-Initiator")).toBe("user");
    expect(request?.headers.get("Openai-Intent")).toBe("conversation-edits");
  });
});

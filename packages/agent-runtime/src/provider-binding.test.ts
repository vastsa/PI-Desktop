import { describe, expect, it, vi } from "vitest";
import type { ModelAuth } from "@earendil-works/pi-ai";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import {
  apiBindingForStyle,
  buildProviderModel,
  createProviderModels,
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

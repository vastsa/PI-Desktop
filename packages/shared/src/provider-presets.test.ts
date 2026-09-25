import { describe, expect, it } from "vitest";
import {
  NAMED_ENDPOINT_PRESETS,
  deepseekRequestCompat,
  DEEPSEEK_REASONING_REPLAY_PLACEHOLDER,
  isDeepSeekReasoningReplay,
  isOfficialDeepSeekEndpoint,
  isZhipuEndpoint,
  matchNamedPreset,
  matchZhipuPreset,
  normalizeEndpointUrl,
  zhipuRequestCompat,
} from "./provider-presets.js";

describe("Zhipu endpoint presets", () => {
  it("distinguishes China API from Coding Plan by path", () => {
    expect(
      matchZhipuPreset({ baseUrl: "https://open.bigmodel.cn/api/paas/v4/" })?.id,
    ).toBe("zhipuai");
    expect(
      matchZhipuPreset({
        baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
      })?.id,
    ).toBe("zhipuai-coding-plan");
  });

  it("distinguishes international API from Coding Plan by path", () => {
    expect(matchZhipuPreset({ baseUrl: "https://api.z.ai/api/paas/v4" })?.id).toBe(
      "zai",
    );
    expect(
      matchZhipuPreset({ baseUrl: "https://api.z.ai/api/coding/paas/v4" })?.id,
    ).toBe("zai-coding-plan");
  });

  it("maps pi-ai's China Coding Plan vendor key without treating it as z.ai", () => {
    expect(matchZhipuPreset({ vendorKey: "zai-coding-cn" })?.id).toBe(
      "zhipuai-coding-plan",
    );
    expect(matchZhipuPreset({ vendorKey: "zai-coding-cn" })?.vendorKey).toBe(
      "zhipuai-coding-plan",
    );
  });

  it("lets a Coding Plan URL win over a mismatched standard-API vendor key", () => {
    expect(
      matchZhipuPreset({
        vendorKey: "zai",
        baseUrl: "https://api.z.ai/api/coding/paas/v4",
      })?.id,
    ).toBe("zai-coding-plan");
  });

  it("does not treat OpenCode Go or a generic gateway as Zhipu", () => {
    expect(
      matchZhipuPreset({
        vendorKey: "custom",
        baseUrl: "https://opencode.ai/zen/go/v1",
      }),
    ).toBeUndefined();
    expect(
      isZhipuEndpoint({
        vendorKey: "custom",
        baseUrl: "https://api.example.com/v1",
      }),
    ).toBe(false);
  });

  it("attaches Zhipu thinking and tool-stream compat only for known endpoints", () => {
    expect(
      zhipuRequestCompat({ baseUrl: "https://open.bigmodel.cn/api/paas/v4" }),
    ).toEqual({ thinkingFormat: "zai", zaiToolStream: true });
    expect(
      zhipuRequestCompat({ baseUrl: "https://api.openai.com/v1" }),
    ).toBeUndefined();
  });

  it("normalizes trailing slashes for preset matching", () => {
    expect(normalizeEndpointUrl("https://API.z.ai/api/paas/v4/")).toBe(
      "https://api.z.ai/api/paas/v4",
    );
  });
});

describe("DeepSeek reasoning replay", () => {
  it("matches official DeepSeek by vendor key or URL", () => {
    expect(isDeepSeekReasoningReplay({ vendorKey: "deepseek" })).toBe(true);
    expect(isOfficialDeepSeekEndpoint({ baseUrl: "https://api.deepseek.com" })).toBe(
      true,
    );
    expect(
      deepseekRequestCompat({ baseUrl: "https://api.deepseek.com" }),
    ).toEqual({ requiresReasoningContentOnAssistantMessages: true });
  });

  it("matches aggregator and custom DeepSeek-family models without a deepseek.com URL", () => {
    expect(
      deepseekRequestCompat({
        vendorKey: "siliconflow-cn",
        baseUrl: "https://api.siliconflow.cn/v1",
        modelId: "deepseek-ai/DeepSeek-V3.2",
      }),
    ).toEqual({
      requiresReasoningContentOnAssistantMessages: true,
      requiresNonEmptyReasoningReplay: true,
    });
    expect(DEEPSEEK_REASONING_REPLAY_PLACEHOLDER.length).toBeGreaterThan(0);
    expect(
      isDeepSeekReasoningReplay({
        vendorKey: "custom",
        baseUrl: "https://llm.corp.example/v1",
        modelId: "deepseek-reasoner",
      }),
    ).toBe(true);
    expect(
      isDeepSeekReasoningReplay({
        vendorKey: "volcengine",
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        modelId: "ep-20250101-xyz",
        family: "deepseek-thinking",
      }),
    ).toBe(true);
  });

  it("does not match unrelated models or change thinkingFormat", () => {
    expect(
      deepseekRequestCompat({
        vendorKey: "custom",
        baseUrl: "https://api.example.com/v1",
        modelId: "gpt-4.1",
      }),
    ).toBeUndefined();
    expect(
      deepseekRequestCompat({
        vendorKey: "zhipuai",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        modelId: "glm-5.3",
      }),
    ).toBeUndefined();
  });
});

describe("named endpoint presets", () => {
  it("lists first-party vendors in one flat catalog, including Xiaomi", () => {
    const ids = NAMED_ENDPOINT_PRESETS.map((item) => item.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "openai",
        "anthropic",
        "google",
        "openrouter",
        "opencode_go",
        "deepseek",
        "alibaba-cn",
        "zhipuai",
        "xiaomi",
      ]),
    );
    expect(NAMED_ENDPOINT_PRESETS.every((item) => !("group" in item))).toBe(true);
    expect(matchNamedPreset({ vendorKey: "xiaomi" })?.baseUrl).toBe(
      "https://api.xiaomimimo.com/v1",
    );
    expect(matchNamedPreset({ vendorKey: "mimo" })?.id).toBe("xiaomi");
  });

  it("binds first-party vendors to their published wire styles", () => {
    expect(matchNamedPreset({ vendorKey: "openai" })?.apiStyle).toBe("responses");
    expect(matchNamedPreset({ vendorKey: "anthropic" })?.apiStyle).toBe(
      "anthropic_messages",
    );
    expect(matchNamedPreset({ vendorKey: "google" })?.apiStyle).toBe(
      "google_generative_ai",
    );
    expect(
      matchNamedPreset({ baseUrl: "https://api.minimaxi.com/anthropic/v1" })?.apiStyle,
    ).toBe("anthropic_messages");
    expect(matchNamedPreset({ baseUrl: "https://api.minimaxi.com/v1" })).toMatchObject({
      id: "minimax-cn-openai",
      vendorKey: "minimax-cn",
      apiStyle: "chat_completions",
    });
  });

  it("maps DashScope and Doubao aliases to China catalog keys", () => {
    expect(matchNamedPreset({ vendorKey: "dashscope" })?.id).toBe("alibaba-cn");
    expect(matchNamedPreset({ vendorKey: "doubao" })?.id).toBe("volcengine");
  });

  it("keeps OpenCode Go as a named service, not a custom URL", () => {
    expect(
      matchNamedPreset({
        apiStyle: "opencode_go",
        baseUrl: "https://opencode.ai/zen/go/v1",
      })?.id,
    ).toBe("opencode_go");
  });
});

describe("pi-ai built-in API-key services", () => {
  it("resolves newly synced international vendors by key and by URL", () => {
    const expected = [
      ["ant-ling", "https://api.ant-ling.com/v1", "chat_completions"],
      ["baseten", "https://inference.baseten.co/v1", "chat_completions"],
      ["cerebras", "https://api.cerebras.ai/v1", "chat_completions"],
      ["huggingface", "https://router.huggingface.co/v1", "chat_completions"],
      ["nvidia", "https://integrate.api.nvidia.com/v1", "chat_completions"],
      ["opencode", "https://opencode.ai/zen/v1", "chat_completions"],
      ["vercel", "https://ai-gateway.vercel.sh/v1", "chat_completions"],
    ] as const;
    for (const [id, baseUrl, apiStyle] of expected) {
      expect(matchNamedPreset({ vendorKey: id })).toMatchObject({
        id,
        vendorKey: id,
        baseUrl,
        apiStyle,
      });
      expect(matchNamedPreset({ baseUrl })).toMatchObject({ id, apiStyle });
    }
  });

  it("keeps international and China hosts apart", () => {
    expect(
      matchNamedPreset({ baseUrl: "https://api.minimax.io/anthropic/v1" }),
    ).toMatchObject({ id: "minimax", apiStyle: "anthropic_messages" });
    expect(
      matchNamedPreset({ baseUrl: "https://api.minimaxi.com/anthropic/v1" })?.id,
    ).toBe("minimax-cn");
    expect(matchNamedPreset({ baseUrl: "https://api.moonshot.ai/v1" })?.id).toBe(
      "moonshotai",
    );
    expect(matchNamedPreset({ baseUrl: "https://api.moonshot.cn/v1" })?.id).toBe(
      "moonshotai-cn",
    );
  });

  it("maps pi-ai gateway and token-plan ids onto catalog keys", () => {
    expect(matchNamedPreset({ vendorKey: "vercel-ai-gateway" })?.id).toBe("vercel");
    expect(matchNamedPreset({ vendorKey: "opencode-zen" })?.id).toBe("opencode");
    expect(matchNamedPreset({ vendorKey: "hf" })?.id).toBe("huggingface");
    expect(matchNamedPreset({ vendorKey: "qwen-token-plan" })?.id).toBe(
      "alibaba-token-plan",
    );
    expect(
      matchNamedPreset({ vendorKey: "qwen-token-plan-individual" })?.vendorKey,
    ).toBe("alibaba-token-plan");
    expect(matchNamedPreset({ vendorKey: "qwen-token-plan-cn" })?.vendorKey).toBe(
      "alibaba-token-plan-cn",
    );
  });

  it("keeps OpenCode Zen and OpenCode Go as separate services", () => {
    expect(matchNamedPreset({ baseUrl: "https://opencode.ai/zen/v1" })?.id).toBe(
      "opencode",
    );
    expect(matchNamedPreset({ baseUrl: "https://opencode.ai/zen/go/v1" })?.id).toBe(
      "opencode_go",
    );
  });

  it("exposes Meta and the Xiaomi token plans as named services", () => {
    expect(matchNamedPreset({ vendorKey: "meta" })).toMatchObject({
      id: "meta",
      apiStyle: "responses",
    });
    for (const id of [
      "xiaomi-token-plan-cn",
      "xiaomi-token-plan-ams",
      "xiaomi-token-plan-sgp",
    ]) {
      expect(matchNamedPreset({ vendorKey: id })?.apiStyle).toBe("chat_completions");
    }
  });
});

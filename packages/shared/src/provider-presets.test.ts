import { describe, expect, it } from "vitest";
import {
  isZhipuEndpoint,
  matchNamedPreset,
  matchZhipuPreset,
  namedPresetsInGroup,
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

describe("named endpoint presets", () => {
  it("groups international and China first-party endpoints", () => {
    const international = namedPresetsInGroup("international").map((item) => item.id);
    const china = namedPresetsInGroup("china").map((item) => item.id);
    expect(international).toEqual(
      expect.arrayContaining(["openai", "anthropic", "google", "openrouter", "opencode_go"]),
    );
    expect(china).toEqual(
      expect.arrayContaining(["deepseek", "alibaba-cn", "zhipuai", "moonshotai-cn"]),
    );
    expect(international).not.toContain("zhipuai");
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

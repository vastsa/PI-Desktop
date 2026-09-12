import { describe, expect, it } from "vitest";
import {
  cleanSummarizedTitle,
  sessionTitleSummarizeContext,
  summarizeSessionTitle,
} from "./session-title-summarize.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

const provider: RuntimeProviderConfig = {
  id: "test-provider",
  name: "Test Provider",
  baseUrl: "http://localhost:8000",
  apiKey: "test-key",
  modelId: "test-model",
  supportsReasoning: false,
  supportedThinkingLevels: [],
};

describe("cleanSummarizedTitle", () => {
  it("strips outer quotes, backticks, and markdown brackets", () => {
    expect(cleanSummarizedTitle('"Debug WebSocket reconnection"')).toBe("Debug WebSocket reconnection");
    expect(cleanSummarizedTitle('“重构用户认证模块”')).toBe("重构用户认证模块");
    expect(cleanSummarizedTitle('`Fix typo in README`')).toBe("Fix typo in README");
    expect(cleanSummarizedTitle('「优化数据库查询」')).toBe("优化数据库查询");
  });

  it("removes redundant Title prefix and trailing punctuation", () => {
    expect(cleanSummarizedTitle("Title: Improve search indexing.")).toBe("Improve search indexing");
    expect(cleanSummarizedTitle("标题：修复登录失败问题！")).toBe("修复登录失败问题");
    expect(cleanSummarizedTitle("Session Title: Add export CSV feature")).toBe("Add export CSV feature");
  });

  it("collapses internal whitespace and limits length", () => {
    expect(cleanSummarizedTitle("  Refactor   theme   switching  ")).toBe("Refactor theme switching");
    const long = "A".repeat(100);
    expect(cleanSummarizedTitle(long).length).toBe(80);
  });
});

describe("sessionTitleSummarizeContext", () => {
  it("formats user prompt and optional reply into context", () => {
    const ctx = sessionTitleSummarizeContext("How to configure Nginx reverse proxy?");
    expect(ctx.messages[0]?.content).toContain("User Prompt:\nHow to configure Nginx reverse proxy?");
    expect(ctx.systemPrompt).toContain("short, concise, descriptive session title");
  });

  it("includes assistant response summary when provided", () => {
    const ctx = sessionTitleSummarizeContext(
      "Deploy Docker container",
      "Created docker-compose.yml and started the services.",
    );
    expect(ctx.messages[0]?.content).toContain("User Prompt:\nDeploy Docker container");
    expect(ctx.messages[0]?.content).toContain("Assistant Response Summary:\nCreated docker-compose.yml");
  });
});

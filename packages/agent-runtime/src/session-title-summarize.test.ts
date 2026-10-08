import { describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  SESSION_TITLE_SUMMARIZE_SYSTEM_PROMPT,
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

describe("configurable session title generation", () => {
  const legacyRule3 = "3. Keep it under 25 characters (or 4-7 words).";

  function assistantMessage(text: string): AssistantMessage {
    return {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-completions",
      provider: "test-provider",
      model: "test-model",
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

  it("keeps the default system prompt identical to the shipped constant", () => {
    expect(SESSION_TITLE_SUMMARIZE_SYSTEM_PROMPT).toContain(legacyRule3);
    expect(sessionTitleSummarizeContext("Fix login").systemPrompt).toBe(
      SESSION_TITLE_SUMMARIZE_SYSTEM_PROMPT,
    );
  });

  it("substitutes the ideal length into the built-in prompt", () => {
    const ctx = sessionTitleSummarizeContext("Fix login", undefined, { idealLength: 15 });
    expect(ctx.systemPrompt).toContain("3. Keep it under 15 characters (or 4-7 words).");
  });

  it("uses a custom prompt only while the gate is on and keeps the user message", () => {
    const builtIn = sessionTitleSummarizeContext("Fix login", "Done.");
    const gatedOff = sessionTitleSummarizeContext("Fix login", "Done.", {
      customPrompt: false,
      prompt: "Custom {{idealLength}}",
    });
    const custom = sessionTitleSummarizeContext("Fix login", "Done.", {
      customPrompt: true,
      prompt: "Custom {{idealLength}}",
      idealLength: 12,
    });
    expect(gatedOff.systemPrompt).toBe(builtIn.systemPrompt);
    expect(custom.systemPrompt).toBe("Custom 12");
    expect(custom.messages[0]?.content).toBe(builtIn.messages[0]?.content);
  });

  it("truncates by code point at the configured length", () => {
    expect(cleanSummarizedTitle("A".repeat(30), 20)).toBe("A".repeat(20));
    expect(cleanSummarizedTitle("😀".repeat(20), 16)).toBe("😀".repeat(16));
  });

  it("forwards the thinking level and applies the truncation length", async () => {
    let seenReasoning: unknown;
    let seenSystemPrompt: string | undefined;
    const title = await summarizeSessionTitle(
      { ...provider, supportsReasoning: true, supportedThinkingLevels: ["off", "low"] },
      "Refactor the authentication module",
      undefined,
      "low",
      {
        maxLength: 16,
        idealLength: 10,
        stream: (_model, context, options) => {
          seenReasoning = options?.reasoning;
          seenSystemPrompt = context.systemPrompt;
          return streamFor(assistantMessage("Refactor authentication module"));
        },
      },
    );
    expect(title).toBe("Refactor authent");
    expect(seenReasoning).toBe("low");
    expect(seenSystemPrompt).toContain("Keep it under 10 characters");
  });
});

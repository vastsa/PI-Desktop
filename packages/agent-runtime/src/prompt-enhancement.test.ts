import { describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  PROMPT_ENHANCEMENT_DEFAULT_SYSTEM_PROMPT,
  PROMPT_ENHANCEMENT_DEFAULT_USER_TEMPLATE,
} from "@pi-desktop/shared";
import {
  enhancePromptDraft,
  promptEnhancementContext,
  stripEnhancementDecorations,
  stripWrappingQuotes,
} from "./prompt-enhancement.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

const provider: RuntimeProviderConfig = {
  id: "provider",
  name: "Provider",
  modelId: "model",
  apiKey: "test-key",
  apiStyle: "chat_completions",
  supportsReasoning: true,
  supportedThinkingLevels: ["off", "high"],
};

function assistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "provider",
    model: "model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function streamFor(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      stream.push({
        type: "error",
        reason: message.stopReason,
        error: message,
      });
    } else {
      stream.push({ type: "start", partial: message });
      stream.push({
        type: "done",
        reason: message.stopReason as "stop" | "length" | "toolUse" | "deferred",
        message,
      });
    }
    stream.end(message);
  });
  return stream;
}

describe("prompt enhancement", () => {
  it("builds a single system-plus-user context without history or tools", () => {
    const context = promptEnhancementContext("  Make this clearer.  ");
    expect(context.systemPrompt).toBe(PROMPT_ENHANCEMENT_DEFAULT_SYSTEM_PROMPT);
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0]).toMatchObject({ role: "user" });
    expect(context.tools).toBeUndefined();
  });

  it("uses the stored user template and the built-in system prompt", () => {
    const context = promptEnhancementContext("draft text", {
      customTemplate: true,
      userTemplate: "custom {{draft}} template",
    });
    expect(context.systemPrompt).toBe(PROMPT_ENHANCEMENT_DEFAULT_SYSTEM_PROMPT);
    expect(context.messages[0]).toMatchObject({
      role: "user",
      content: "custom draft text template",
    });
  });

  it("keeps the default template while the switch is off", () => {
    const context = promptEnhancementContext("draft text", {
      customTemplate: false,
      userTemplate: "custom {{draft}} template",
    });
    expect(String((context.messages[0] as { content: string }).content)).toContain("<draft>");
    expect(String((context.messages[0] as { content: string }).content)).not.toContain(
      "custom",
    );
  });

  it("ignores a stored template that lost the draft variable", () => {
    const context = promptEnhancementContext("draft text", {
      customTemplate: true,
      userTemplate: "no placeholder",
    });
    expect(context.messages[0]).toMatchObject({ role: "user" });
    expect(String((context.messages[0] as { content: string }).content)).toContain(
      "draft text",
    );
  });

  it("uses the mocked provider stream, passes reasoning, and trims text output", async () => {
    let seenContext: ReturnType<typeof promptEnhancementContext> | undefined;
    let seenReasoning: unknown;
    const enhanced = await enhancePromptDraft(
      provider,
      "Rewrite this",
      "high",
      {
        stream: (_model, context, options) => {
          seenContext = context;
          seenReasoning = options?.reasoning;
          return streamFor(
            assistantMessage([{ type: "text", text: "  Rewritten draft  " }]),
          );
        },
      },
    );
    expect(enhanced).toBe("Rewritten draft");
    expect(seenContext?.messages).toHaveLength(1);
    expect(seenReasoning).toBe("high");
  });

  it("strips a wrapping quotation pair from the model answer", async () => {
    const enhanced = await enhancePromptDraft(provider, "Keep this", "off", {
      stream: () =>
        streamFor(
          assistantMessage([
            { type: "text", text: '"请解释这段代码的主要功能与边界情况。"' },
          ]),
        ),
    });
    expect(enhanced).toBe("请解释这段代码的主要功能与边界情况。");
  });

  it("rejects an empty model response without changing the caller's draft", async () => {
    await expect(
      enhancePromptDraft(provider, "Keep this", "off", {
        stream: () => streamFor(assistantMessage([{ type: "text", text: "  " }])),
      }),
    ).rejects.toMatchObject({ errorCode: "PROMPT_ENHANCEMENT_EMPTY" });
  });

  it("classifies provider failures with the existing error code", async () => {
    await expect(
      enhancePromptDraft(provider, "Keep this", "off", {
        stream: () =>
          streamFor(
            Object.assign(assistantMessage([], "error"), {
              errorMessage: "401: invalid api key",
            }),
          ),
      }),
    ).rejects.toMatchObject({ errorCode: "PROVIDER_UNAUTHORIZED" });
  });
});

describe("stripWrappingQuotes", () => {
  it("removes a matching wrapping pair in every supported style", () => {
    expect(stripWrappingQuotes('"clearer"')).toBe("clearer");
    expect(stripWrappingQuotes("'clearer'")).toBe("clearer");
    expect(stripWrappingQuotes("\u201Cclearer\u201D")).toBe("clearer");
    expect(stripWrappingQuotes("\u2018clearer\u2019")).toBe("clearer");
    expect(stripWrappingQuotes('  "clearer"  ')).toBe("clearer");
  });

  it("keeps quotes that are part of the text", () => {
    expect(stripWrappingQuotes('"a" and "b"')).toBe('"a" and "b"');
    expect(stripWrappingQuotes("'it's fine'")).toBe("'it's fine'");
    expect(stripWrappingQuotes('"unmatched')).toBe('"unmatched');
    expect(stripWrappingQuotes("unmatched'")).toBe("unmatched'");
    expect(stripWrappingQuotes("\u201Cunmatched")).toBe("\u201Cunmatched");
  });

  it("keeps a lone quote or an empty pair without crashing", () => {
    expect(stripWrappingQuotes('"')).toBe('"');
    expect(stripWrappingQuotes('""')).toBe('""');
    expect(stripWrappingQuotes("")).toBe("");
    expect(stripWrappingQuotes("   ")).toBe("");
  });

  it("returns unquoted text unchanged", () => {
    expect(stripWrappingQuotes("  plain text  ")).toBe("plain text");
  });
});

describe("stripEnhancementDecorations", () => {
  it("strips a leading rewrite label after unquoting", () => {
    expect(stripEnhancementDecorations('Enhanced: fix the login bug')).toBe(
      "fix the login bug",
    );
    expect(stripEnhancementDecorations('"Output: 请审查这段代码"')).toBe(
      "请审查这段代码",
    );
    expect(stripEnhancementDecorations("增强：请说明要处理的对象")).toBe(
      "请说明要处理的对象",
    );
  });

  it("leaves a prompt that is not a label prefix unchanged", () => {
    expect(stripEnhancementDecorations("Fix the login bug: identify the path.")).toBe(
      "Fix the login bug: identify the path.",
    );
  });
});


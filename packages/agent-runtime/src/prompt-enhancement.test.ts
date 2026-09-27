import { describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  enhancePromptDraft,
  promptEnhancementContext,
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
    expect(context.systemPrompt).toContain("Output only the");
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0]).toMatchObject({
      role: "user",
      content: "Draft:\n  Make this clearer.  ",
    });
    expect(context.tools).toBeUndefined();
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

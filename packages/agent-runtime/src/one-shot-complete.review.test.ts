import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { completeOneShot } from "./one-shot-complete.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

const provider: RuntimeProviderConfig = {
  id: "fixture", name: "Fixture", modelId: "fixture", apiKey: "unused",
  apiStyle: "chat_completions", supportsReasoning: false, supportedThinkingLevels: ["off"],
};

function completion(reason: AssistantMessage["stopReason"], content: AssistantMessage["content"]) {
  const message: AssistantMessage = {
    role: "assistant", content, api: "openai-completions", provider: "fixture", model: "fixture",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: reason, timestamp: 1,
  };
  return () => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: reason as "stop" | "toolUse" | "length", message });
      stream.end(message);
    });
    return stream;
  };
}

describe("strict one-shot review terminal state", () => {
  it("accepts a completed text decision alongside private thinking", async () => {
    const stream = completion("stop", [
      { type: "thinking", thinking: "Internal evidence" },
      { type: "text", text: '{"decision":"allow_once"}' },
    ]);
    await expect(completeOneShot(provider, { messages: [], tools: [] }, "off", {
      stream, requireFinalTextOnly: true, maxRetries: 0, maxOutputChars: 2_000,
    })).resolves.toMatchObject({ text: '{"decision":"allow_once"}' });
  });
  it("rejects truncated text, while normal one-shot consumers retain their behavior", async () => {
    const stream = completion("length", [{ type: "text", text: "partial" }]);
    await expect(completeOneShot(provider, { messages: [], tools: [] }, "off", {
      stream, requireFinalTextOnly: true, maxRetries: 0,
    })).rejects.toMatchObject({ errorCode: "REVIEW_INCOMPLETE" });
    await expect(completeOneShot(provider, { messages: [] }, "off", { stream })).resolves.toMatchObject({ text: "partial" });
  });

  it("rejects text accompanied by a tool call", async () => {
    const stream = completion("toolUse", [
      { type: "text", text: '{"decision":"allow_once"}' },
      { type: "toolCall", id: "call-1", name: "Bash", arguments: { command: "echo no" } },
    ]);
    await expect(completeOneShot(provider, { messages: [], tools: [] }, "off", {
      stream, requireFinalTextOnly: true, maxRetries: 0,
    })).rejects.toMatchObject({ errorCode: "REVIEW_INCOMPLETE" });
  });

  it("aborts oversized streamed reviewer output before a terminal response", async () => {
    let aborted = false;
    const stream = (_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) => {
      options?.signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
      const events = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const partial = { role: "assistant", content: [{ type: "text", text: "" }] } as AssistantMessage;
        events.push({ type: "start", partial });
        events.push({ type: "text_delta", contentIndex: 0, delta: "x".repeat(2_001), partial });
        // Deliberately omit done/end: the cap cannot wait for stream.result().
      });
      return events;
    };
    await expect(completeOneShot(provider, { messages: [], tools: [] }, "off", {
      stream, requireFinalTextOnly: true, maxRetries: 0, maxOutputChars: 2_000,
    })).rejects.toMatchObject({ errorCode: "OUTPUT_TOO_LONG" });
    expect(aborted).toBe(true);
  });
});

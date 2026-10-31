import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, normalizeContext, type AssistantMessage, type Message, type Model } from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { stream as streamCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { dedupeToolCallMessages } from "./tool-call-dedupe.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createToolCallIdentity } from "./tool-call-dedupe.js";

function message(ids: string[]): AssistantMessage {
  return {
    role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture",
    content: ids.map((id) => ({ type: "toolCall", id, name: "Read", arguments: { path: "file.txt" } })),
    timestamp: 1, stopReason: "toolUse",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

describe("tool execution identity", () => {
  it("preserves paired results through the real Responses and Chat Completions converters", async () => {
    const history = [
      message(["reused|fc_old"]),
      { role: "toolResult", toolCallId: "reused|fc_old", toolName: "Read", content: [{ type: "text", text: "first result" }], isError: false, timestamp: 2 },
      message(["reused|fc_new"]),
      { role: "toolResult", toolCallId: "reused|fc_new", toolName: "Read", content: [{ type: "text", text: "second result" }], isError: false, timestamp: 3 },
    ] as AgentMessage[];
    const request = dedupeToolCallMessages(history).messages;
    const context = normalizeContext({ messages: request as Message[] });
    const model: Model<"openai-responses"> = {
      id: "fixture", name: "Fixture", api: "openai-responses", provider: "fixture", baseUrl: "https://fixture.invalid",
      reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const responses = convertResponsesMessages(model, context, new Set(["fixture"]));
    const calls = responses.filter((item) => item.type === "function_call");
    const outputs = responses.filter((item) => item.type === "function_call_output");
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((item) => item.call_id)).size).toBe(2);
    expect(outputs.map((item) => item.call_id)).toEqual(calls.map((item) => item.call_id));
    expect(outputs.map((item) => item.output)).toEqual(["first result", "second result"]);
    expect(calls[1]!.id).toBeUndefined();

    type ChatMessage = { role: string; tool_calls?: Array<{ id: string }>; tool_call_id?: string; content?: unknown };
    let chatMessages: ChatMessage[] = [];
    const chatResult = await streamCompletions({ ...model, api: "openai-completions" }, context, {
      apiKey: "fixture", maxRetries: 0,
      onPayload: (payload) => { chatMessages = (payload as { messages: ChatMessage[] }).messages; },
      fetch: async () => new Response(`data: ${JSON.stringify({
        id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
        choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: "stop" }],
      })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }),
    }).result();
    expect(chatResult.stopReason).toBe("stop");
    const chatCalls = chatMessages.flatMap((item) => item.role === "assistant" ? item.tool_calls ?? [] : []);
    const chatOutputs = chatMessages.filter((item) => item.role === "tool");
    expect(chatCalls).toHaveLength(2);
    expect(new Set(chatCalls.map((item) => item.id)).size).toBe(2);
    expect(chatOutputs.map((item) => item.tool_call_id)).toEqual(chatCalls.map((item) => item.id));
    expect(chatOutputs.map((item) => item.content)).toEqual(["first result", "second result"]);
  });

  it("reserves restored and newly executed ids after their messages leave the request", async () => {
    const wrap = createToolCallIdentity([message(["restored|fc_old", "call_pi_repeat_1"])]);
    async function complete(id: string) {
      const response = message([id]);
      const stream = createAssistantMessageEventStream();
      const wrapped = wrap(stream, []);
      stream.push({ type: "done", reason: "toolUse", message: response });
      stream.end(response);
      for await (const _event of wrapped) { /* consume like Pi */ }
      return (await wrapped.result()).content.flatMap((block) => block.type === "toolCall" ? [block.id] : [])[0]!;
    }

    const first = await complete("restored|fc_old");
    const second = await complete("restored|fc_old");
    const third = await complete(first);
    expect(new Set(["restored|fc_old", "call_pi_repeat_1", first, second, third]).size).toBe(5);
  });

  it("keeps done and result consistent, without mutating the provider's message or metadata", async () => {
    const withUniqueToolCallIds = createToolCallIdentity();
    const original = message(["reused|fc_old", "reused|fc_new", "call_pi_repeat_1"]);
    const snapshot = structuredClone(original);
    const stream = createAssistantMessageEventStream();
    const wrapped = withUniqueToolCallIds(stream, [message(["reused|fc_history"])]);
    stream.push({ type: "start", partial: original });
    stream.push({ type: "done", reason: "toolUse", message: original });
    stream.end(original);

    const events = [];
    for await (const event of wrapped) events.push(event);
    const result = await wrapped.result();

    expect(events[0]).toEqual({ type: "start", partial: original });
    expect(events[1]).toEqual({ type: "done", reason: "toolUse", message: result });
    const ids = result.content.flatMap((block) => block.type === "toolCall" ? [block.id] : []);
    expect(new Set(ids).size).toBe(3);
    expect(ids.at(-1)).toBe("call_pi_repeat_1");
    expect(ids.slice(0, 2).every((id) => !id.includes("|"))).toBe(true);
    expect(result).toMatchObject({ usage: original.usage, stopReason: original.stopReason, timestamp: original.timestamp });
    expect(original).toEqual(snapshot);
    expect(await wrapped.result()).toEqual(result);
  });

  it("preserves unique responses and error events by identity", async () => {
    const withUniqueToolCallIds = createToolCallIdentity();
    const original = message(["unique|fc_1"]);
    const stream = createAssistantMessageEventStream();
    const wrapped = withUniqueToolCallIds(stream, []);
    stream.push({ type: "done", reason: "toolUse", message: original });
    stream.end(original);
    for await (const event of wrapped) {
      if (event.type === "done") expect(event.message).toBe(original);
    }
    expect(await wrapped.result()).toBe(original);

    const failed = { ...original, stopReason: "aborted" as const, errorMessage: "cancelled" };
    const errors = createAssistantMessageEventStream();
    const wrappedErrors = withUniqueToolCallIds(errors, [original]);
    const errorEvent = { type: "error" as const, reason: "aborted" as const, error: failed };
    errors.push(errorEvent);
    errors.end(failed);
    for await (const event of wrappedErrors) expect(event).toBe(errorEvent);
    expect(await wrappedErrors.result()).toBe(failed);
  });

  it("exposes the same rejected batch through the terminal event and result", async () => {
    const original = message(["valid", ""]);
    original.content.unshift({ type: "text", text: "Retain this explanation." });
    const snapshot = structuredClone(original);
    const stream = createAssistantMessageEventStream();
    const wrapped = createToolCallIdentity()(stream, []);
    stream.push({ type: "done", reason: "toolUse", message: original });
    stream.end(original);
    const events = [];
    for await (const event of wrapped) events.push(event);
    const result = await wrapped.result();
    expect(events).toEqual([{ type: "error", reason: "error", error: result }]);
    expect(result).toMatchObject({
      content: [{ type: "text", text: "Retain this explanation." }], stopReason: "error",
      errorDetails: { code: "LOCAL_REQUEST_ERROR", phase: "context-validation" },
    });
    expect(await wrapped.result()).toEqual(result);
    expect(original).toEqual(snapshot);
  });
});

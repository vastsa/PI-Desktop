import { normalizeContext, Type, type Message, type Model } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { describe, expect, it } from "vitest";

const model: Model<"anthropic-messages"> = {
  id: "claude-fixture", name: "Fixture", api: "anthropic-messages", provider: "anthropic",
  baseUrl: "https://fixture.invalid", reasoning: false, input: ["text"],
  contextWindow: 100_000, maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: { supportsStrictTools: true },
  webSearch: true,
};
const messages: Message[] = [
  { role: "system", content: "Fixture", timestamp: 1, toolsAdded: [
    { name: "preferred", description: "Preferred", parameters: Type.Object({ path: Type.String() }), constrainedSampling: { type: "json_schema", strict: "prefer" } },
    { name: "required", description: "Required", parameters: Type.Object({ path: Type.String() }), constrainedSampling: { type: "json_schema", strict: "require" } },
  ] },
  { role: "user", content: "Continue", timestamp: 2 },
];

function completedResponse(): Response {
  const events = [
    { type: "message_start", message: { id: "reply", type: "message", role: "assistant", model: model.id, content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function strictError(message: string): Response {
  return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }), {
    status: 400, headers: { "content-type": "application/json" },
  });
}

describe("Anthropic strict fallback with Desktop patches", () => {
  it.each(["callback", "serialization"])("classifies second-attempt %s failures as local preparation errors", async (failure) => {
    let payloads = 0;
    let fetches = 0;
    const response = await stream(model, normalizeContext({ messages }), {
      apiKey: "fixture", maxRetries: 0,
      onPayload: (payload) => {
        payloads += 1;
        if (payloads === 1) return undefined;
        if (failure === "callback") throw new TypeError("private fixture payload");
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        return circular;
      },
      fetch: async (_url, init) => {
        fetches += 1;
        const body = JSON.parse(String(init?.body)) as { tools: Array<{ name: string; strict?: boolean }> };
        expect(body.tools).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: "preferred", strict: true }),
          expect.objectContaining({ name: "required", strict: true }),
          expect.objectContaining({ name: "web_search" }),
        ]));
        return new Response(JSON.stringify({ type: "error", error: {
          type: "invalid_request_error", message: "The compiled grammar is too large",
        } }), { status: 400, headers: { "content-type": "application/json" } });
      },
    }).result();
    expect(payloads).toBe(2);
    expect(fetches).toBe(1);
    expect(response.stopReason).toBe("error");
    expect(response.errorDetails).toMatchObject({ code: "LOCAL_REQUEST_ERROR", phase: "request-preparation" });
    expect(response.errorMessage).not.toContain("private fixture");
  });

  it.each([
    "The compiled grammar is too large",
    "Too many strict tools (20)",
    "Schemas contains too many parameters with union types (20)",
  ])("downgrades only preferred tools after %s and preserves hosted search", async (message) => {
    const payloads: Array<{ tools: Array<{ name: string; strict?: boolean }> }> = [];
    const response = await stream(model, normalizeContext({ messages }), {
      apiKey: "fixture", maxRetries: 0,
      fetch: async (_url, init) => {
        payloads.push(JSON.parse(String(init?.body)));
        return payloads.length === 1 ? strictError(message) : completedResponse();
      },
    }).result();
    expect(response.stopReason).toBe("stop");
    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.tools.find((tool) => tool.name === "preferred")?.strict).toBe(true);
    expect(payloads[1]?.tools.find((tool) => tool.name === "preferred")).not.toHaveProperty("strict");
    expect(payloads[1]?.tools.find((tool) => tool.name === "required")?.strict).toBe(true);
    expect(payloads[1]?.tools).toContainEqual({ type: "web_search_20250305", name: "web_search" });
  });

  it.each([
    { message: "The compiled grammar is too large", attempts: 2 },
    { message: "Invalid authentication setting", attempts: 1 },
  ])("bounds fallback and does not retry unrelated failures: $message", async ({ message, attempts }) => {
    let fetches = 0;
    const response = await stream(model, normalizeContext({ messages }), {
      apiKey: "fixture", maxRetries: 0,
      fetch: async () => { fetches += 1; return strictError(message); },
    }).result();
    expect(response.stopReason).toBe("error");
    expect(response.errorDetails).toBeUndefined();
    expect(fetches).toBe(attempts);
  });
});

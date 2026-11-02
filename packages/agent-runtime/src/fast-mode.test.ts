import { describe, expect, it } from "vitest";
import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple as completionsStreamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as responsesStreamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { withFastModeOptions } from "./fast-mode.js";

const RELAY = "https://relay.example.com/v1";

const responsesModel = {
  id: "gpt-test",
  name: "GPT Test",
  api: "openai-responses",
  provider: "relay-uuid",
  baseUrl: RELAY,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as Model<"openai-responses">;

function capture() {
  const bodies: Array<Record<string, unknown>> = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ error: { message: "fixture response" } }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  };
  return { bodies, options: { apiKey: "sk-test", fetch } satisfies SimpleStreamOptions };
}

const context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] } as never;

describe("withFastModeOptions", () => {
  it("sends the priority tier through streamSimple on the Responses wire", async () => {
    const { bodies, options } = capture();
    await responsesStreamSimple(
      responsesModel,
      context,
      withFastModeOptions(options, "openai-responses", true),
    ).result();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].service_tier).toBe("priority");
  });

  it("keeps the default tier when Fast mode is off", async () => {
    const { bodies, options } = capture();
    const hooked = withFastModeOptions(options, "openai-responses", false);
    expect(hooked).toBe(options);
    await responsesStreamSimple(responsesModel, context, hooked).result();
    expect(bodies[0].service_tier).toBeUndefined();
  });

  it("leaves a Chat Completions request untouched even when switched on", async () => {
    const { bodies, options } = capture();
    const model = { ...responsesModel, api: "openai-completions" } as Model<"openai-completions">;
    const hooked = withFastModeOptions(options, model.api, true);
    expect(hooked).toBe(options);
    await completionsStreamSimple(model, context, hooked).result();
    expect(bodies[0].service_tier).toBeUndefined();
  });
});

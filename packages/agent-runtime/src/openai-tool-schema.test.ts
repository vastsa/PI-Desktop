import { describe, expect, it } from "vitest";
import { normalizeContext, type ProviderStreams, type StreamOptions } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import * as Value from "typebox/value";
import { buildProviderModel, createProviderModels, type RuntimeProviderConfig } from "./provider-binding.js";
import { scheduledToolParameters } from "./scheduled-tools.js";
import { openAICompatibleToolPayload, withOpenAICompatibleToolSchemas } from "./openai-tool-schema.js";

const provider: RuntimeProviderConfig = {
  id: "fixture", name: "Fixture", modelId: "gpt-5.4", apiKey: "synthetic-key",
  apiStyle: "responses", baseUrl: "https://api.openai.com/v1",
  supportsReasoning: false, supportedThinkingLevels: ["off"],
};

describe("OpenAI scheduled tool schema compatibility", () => {
  it.each(["stream", "streamSimple"] as const)("%s removes uniqueItems from current and replayed declarations", async (method) => {
    for (const replay of ["none", "additions", "changes"] as const) {
      const tools = ["ScheduledTaskCreate", "ScheduledTaskUpdate"].map((name) => ({
        name, description: name, parameters: Type.Object(scheduledToolParameters[name]),
      }));
      const context = normalizeContext({ messages: [
        { role: "system", content: "Synthetic policy", timestamp: 1 },
        { role: "user", content: "Hello", timestamp: 2 },
        { role: "system", content: "", timestamp: 3, toolsAdded: tools },
        { role: "user", content: "Continue", timestamp: 4 },
      ] });
      const before = structuredClone(context);
      const model = buildProviderModel(provider);
      model.compat = { ...model.compat, supportsMidConvoSystemMessages: true, supportsAdditionalTools: replay === "changes", supportsToolSearch: replay === "additions" };
      const requests: Record<string, unknown>[] = [];
      const result = await createProviderModels(provider, model)[method](model, context, {
        maxRetries: 0,
        fetch: async (_input, init) => {
          const body = JSON.parse(String(init?.body));
          requests.push(body);
          if (JSON.stringify(body).includes('"uniqueItems":true')) {
            return new Response(JSON.stringify({ error: { message: 'Invalid schema: Unimplemented keys: ["uniqueItems"]', type: "invalid_request_error", code: "invalid_json_schema" } }), { status: 400, headers: { "content-type": "application/json" } });
          }
          return new Response('data: {"type":"response.completed","response":{"id":"resp_fixture","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":0,"total_tokens":1}}}\n\n', { headers: { "content-type": "text/event-stream" } });
        },
      }).result();
      expect(result.errorMessage).toBeUndefined();
      expect(result.stopReason).toBe("stop");
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(requests[0])).toContain("ScheduledTaskCreate");
      expect(JSON.stringify(requests[0])).not.toContain('"uniqueItems":true');
      if (replay !== "none") expect(requests[0].input).toContainEqual(expect.objectContaining({
        type: replay === "changes" ? "additional_tools" : "tool_search_output",
        tools: expect.arrayContaining([expect.objectContaining({ name: "ScheduledTaskCreate" })]),
      }));
      expect(context).toEqual(before);
      expect(Value.Check(tools[0].parameters, { title: "Test", prompt: "Test", cadence: "weekly", schedule: { hour: 9, minute: 0, weekday: 0, weekdays: [0, 0] } })).toBe(false);
    }
  });

  it("preserves property names, annotations, hosted tools and non-schema input", () => {
    const parameters = { type: "object", properties: {
      uniqueItems: { type: "array", items: { type: "string" }, uniqueItems: true },
      options: { anyOf: [{ type: "array", items: { type: "string" }, uniqueItems: true }, { type: "null" }] },
    }, examples: [{ uniqueItems: true }], required: ["uniqueItems"] };
    const payload = { tools: [{ type: "function", name: "fixture", strict: true, parameters }, { type: "web_search" }], input: [{ role: "user", content: "uniqueItems" }] };
    const result = openAICompatibleToolPayload(payload) as typeof payload;
    expect(result.tools[0]).toMatchObject({ strict: true, parameters: {
      properties: { uniqueItems: { type: "array", items: { type: "string" } } },
      examples: [{ uniqueItems: true }], required: ["uniqueItems"],
    } });
    expect(result.tools[0].parameters?.properties.uniqueItems).not.toHaveProperty("uniqueItems");
    expect(result.tools[0].parameters?.properties.options.anyOf[0]).not.toHaveProperty("uniqueItems");
    expect(result.tools[1]).toEqual({ type: "web_search" });
    expect(result.input).toEqual(payload.input);
    expect(parameters.properties.uniqueItems.uniqueItems).toBe(true);
  });

  it("composes replacement hooks and preserves other transports", async () => {
    let received: StreamOptions | undefined;
    const streams = {
      stream(_model, _context, options) { received = options; return {} as never; },
      streamSimple(_model, _context, options) { received = options; return {} as never; },
    } satisfies ProviderStreams;
    const wrapped = withOpenAICompatibleToolSchemas(streams);
    const model = buildProviderModel(provider);
    const options: StreamOptions = { onPayload: async () => ({ tools: [{ type: "function", name: "replacement", parameters: { type: "array", uniqueItems: true, items: { type: "string" } } }] }) };
    for (const api of ["openai-responses", "openai-codex-responses"] as const) {
      wrapped.streamSimple({ ...model, api }, normalizeContext({ messages: [] }), options);
      const result = await received?.onPayload?.({}, model);
      expect(result).toMatchObject({ tools: [{ name: "replacement", parameters: { type: "array" } }] });
      expect(JSON.stringify(result)).not.toContain("uniqueItems");
    }
    wrapped.stream({ ...model, api: "openai-completions" }, normalizeContext({ messages: [] }), options);
    expect(received).toBe(options);
  });
});

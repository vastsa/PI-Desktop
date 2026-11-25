import { zstdDecompressSync } from "node:zlib";
import { type Context, type Message, type Tool, validateToolArguments } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { genericModelConfig } from "./model-capabilities.js";
import { buildProviderModel, createProviderModels, type RuntimeProviderConfig } from "./provider-binding.js";
import { scheduledToolDescriptions, scheduledToolParameters } from "./scheduled-tools.js";

const provider: RuntimeProviderConfig = {
  id: "custom-fixture", name: "Custom fixture", modelId: "responses-fixture",
  apiStyle: "responses", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture",
  supportsReasoning: false, supportedThinkingLevels: ["off"],
};
const scheduledTools = ["ScheduledTaskCreate", "ScheduledTaskUpdate"].map((name) => ({
  name,
  description: scheduledToolDescriptions[name],
  parameters: Type.Object(scheduledToolParameters[name]),
}));
const userMessage = { role: "user", content: "Schedule this for Monday and Wednesday.", timestamp: 1 } as const;

type WireTool = { type: string; name: string; strict?: boolean | null; parameters?: object };
type Payload = { tools?: WireTool[]; input: Array<{ type?: string; tools?: WireTool[] }> };

async function request(
  config: RuntimeProviderConfig,
  context: Context,
  entry: "stream" | "streamSimple" = "streamSimple",
): Promise<Payload> {
  const model = buildProviderModel(config);
  const models = createProviderModels(config, model);
  let payload: Payload | undefined;
  const result = await models[entry](model, context, {
    transport: "sse",
    maxRetries: 0,
    fetch: async (url, init) => {
      const request = new Request(url, init);
      expect(new URL(request.url).hostname).toBe("fixture.invalid");
      const json = request.headers.get("content-encoding") === "zstd"
        ? zstdDecompressSync(new Uint8Array(await request.arrayBuffer())).toString("utf8")
        : await request.text();
      payload = JSON.parse(json);
      const event = { type: "response.completed", response: { id: "fixture", status: "completed", output: [] } };
      return new Response(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  }).result();
  expect(result.stopReason, result.errorMessage).toBe("stop");
  if (!payload) throw new Error("No Responses request reached the fixture");
  return payload;
}

function withCompat(compat: NonNullable<RuntimeProviderConfig["modelConfig"]>["compat"]): RuntimeProviderConfig {
  const baseUrl = provider.baseUrl ?? "";
  return {
    ...provider,
    modelConfig: {
      ...genericModelConfig(provider.modelId, baseUrl),
      source: "pi",
      transcriptBinding: { modelId: provider.modelId, api: "openai-responses", baseUrl },
      compat,
    },
  };
}

function expectScheduledTools(tools: WireTool[] | undefined, strict: false | null, deferLoading = false) {
  expect(tools).toEqual(scheduledTools.map(({ parameters, ...tool }) => ({
    ...tool,
    type: "function",
    strict,
    parameters: JSON.parse(JSON.stringify(parameters)),
    ...(deferLoading ? { defer_loading: true } : {}),
  })));
}

describe("Responses function tool strictness", () => {
  it.each([
    ["default compatibility", provider, "streamSimple"],
    ["explicit supportsStrictMode=false", withCompat({ supportsStrictMode: false }), "stream"],
  ] as const)("serializes current scheduled tools with strict=false for %s", async (_name, config, entry) => {
    const payload = await request(config, { messages: [userMessage], tools: scheduledTools }, entry);
    expectScheduledTools(payload.tools, false);
  });

  it.each([
    ["additional_tools", { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true }],
    ["tool_search_output", { supportsMidConvoSystemMessages: true, supportsToolSearch: true }],
  ] as const)("serializes replayed scheduled tools in %s after a model switch", async (type, compat) => {
    const messages: Message[] = [
      { ...userMessage, content: "Help with my recurring tasks." },
      {
        role: "assistant", api: "openai-completions", provider: "previous-provider", model: "previous-model",
        content: [{ type: "text", text: "Which days?" }], stopReason: "stop", timestamp: 2,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      },
      { role: "system", content: "Scheduled tools are available.", timestamp: 3, toolsAdded: scheduledTools },
      { ...userMessage, timestamp: 4 },
    ];
    const payload = await request(withCompat({ ...compat, supportsStrictMode: false }), { messages });
    expect(payload.tools).toBeUndefined();
    const index = payload.input.findIndex((item) => item.type === type);
    expect(index).toBeGreaterThan(1);
    expectScheduledTools(payload.input[index]?.tools, false, type === "tool_search_output");
  });

  it("preserves strict sampling for prefer and require on supporting providers", async () => {
    const parameters = Type.Object({ text: Type.String() });
    const tools: Tool[] = (["prefer", "require"] as const).map((strict) => ({
      name: strict, description: strict, parameters, constrainedSampling: { type: "json_schema", strict },
    }));
    const payload = await request(withCompat({ supportsStrictMode: true }), { messages: [userMessage], tools });
    expect(payload.tools).toEqual(tools.map(({ name }) => ({
      type: "function", name, description: name, strict: true,
      parameters: { ...parameters, additionalProperties: false },
    })));
    expect(parameters).not.toHaveProperty("additionalProperties");
  });

  it("preserves Codex's explicit strict=null", async () => {
    const claim = btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } }));
    const payload = await request({
      ...provider, apiStyle: "openai_codex_responses", apiKey: `fixture.${claim}.fixture`,
    }, { messages: [userMessage], tools: scheduledTools });
    expectScheduledTools(payload.tools, null);
  });

  it("preserves custom grammar tools", async () => {
    const tool: Tool = {
      name: "grammar", description: "Grammar fixture", parameters: Type.Object({ input: Type.String() }),
      constrainedSampling: { type: "grammar", variants: { openai_regex: "yes|no" } },
    };
    const payload = await request(withCompat({ supportsStrictMode: false, supportsOpenAIGrammarTools: true }), {
      messages: [userMessage], tools: [tool],
    });
    expect(payload.tools).toEqual([{
      type: "custom", name: tool.name, description: tool.description,
      format: { type: "grammar", syntax: "regex", definition: "yes|no" },
    }]);
  });

  it.each(scheduledTools)("preserves canonical weekday uniqueness and local validation for $name", async (tool) => {
    const canonical = structuredClone(tool.parameters);
    await request(provider, { messages: [userMessage], tools: [tool] });
    expect(tool.parameters).toEqual(canonical);
    expect(tool.parameters).toHaveProperty("properties.schedule.properties.weekdays.uniqueItems", true);
    const call = { type: "toolCall" as const, id: "call_fixture", name: tool.name };
    const args: Record<string, string> = tool.name === "ScheduledTaskCreate"
      ? { title: "Fixture", prompt: "Run fixture", cadence: "weekly" }
      : { id: "fixture" };
    const schedule = { hour: 9, minute: 0, weekday: 0 };
    const valid = { ...args, schedule: { ...schedule, weekdays: [0, 2] } };
    expect(validateToolArguments(tool, { ...call, arguments: valid })).toEqual(valid);
    expect(() => validateToolArguments(tool, {
      ...call, arguments: { ...args, schedule: { ...schedule, weekdays: [0, 0] } },
    })).toThrow(/schedule\.weekdays/);
  });
});

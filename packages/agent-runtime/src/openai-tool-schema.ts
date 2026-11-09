import type { ProviderStreams, StreamOptions } from "@earendil-works/pi-ai";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Only the wire schema changes; local validators retain uniqueness checks. */
function schemaWithoutUniqueItems(schema: unknown): unknown {
  if (!object(schema)) return schema;
  return Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "uniqueItems").map(([key, value]) => {
    if (["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"].includes(key) && object(value)) {
      return [key, Object.fromEntries(Object.entries(value).map(([name, child]) => [name, schemaWithoutUniqueItems(child)]))];
    }
    if (["items", "additionalProperties", "contains", "not", "if", "then", "else", "propertyNames"].includes(key)) {
      return [key, Array.isArray(value) ? value.map(schemaWithoutUniqueItems) : schemaWithoutUniqueItems(value)];
    }
    if (["anyOf", "allOf", "oneOf", "prefixItems"].includes(key) && Array.isArray(value)) {
      return [key, value.map(schemaWithoutUniqueItems)];
    }
    return [key, value];
  }));
}

function toolsWithoutUniqueItems(tools: unknown[]): unknown[] {
  return tools.map((tool) => {
    if (!object(tool)) return tool;
    if (tool.type === "function") return { ...tool, parameters: schemaWithoutUniqueItems(tool.parameters) };
    if (tool.type === "namespace" && Array.isArray(tool.tools)) return { ...tool, tools: toolsWithoutUniqueItems(tool.tools) };
    return tool;
  });
}

/** Historical declarations are compiled too, including additional_tools and tool_search_output. */
export function openAICompatibleToolPayload(payload: unknown): unknown {
  if (!object(payload)) return payload;
  return {
    ...payload,
    ...(Array.isArray(payload.tools) ? { tools: toolsWithoutUniqueItems(payload.tools) } : {}),
    ...(Array.isArray(payload.input) ? { input: payload.input.map((item) =>
      object(item) && ["additional_tools", "tool_search_output"].includes(String(item.type)) && Array.isArray(item.tools)
        ? { ...item, tools: toolsWithoutUniqueItems(item.tools) } : item,
    ) } : {}),
  };
}

export function withOpenAICompatibleToolSchemas(streams: ProviderStreams): ProviderStreams {
  function options<T extends StreamOptions>(api: string, input: T | undefined): T | undefined {
    if (api !== "openai-responses" && api !== "openai-codex-responses") return input;
    return { ...input, onPayload: async (payload, model) =>
      openAICompatibleToolPayload(await input?.onPayload?.(payload, model) ?? payload),
    } as T;
  }
  return {
    ...streams,
    stream: (model, context, input) => streams.stream(model, context, options(model.api, input)),
    streamSimple: (model, context, input) => streams.streamSimple(model, context, options(model.api, input)),
  };
}

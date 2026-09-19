import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Check } from "typebox/value";

export type TrustedExtensionModelRegistry = import("./image-contract.js").ExtensionImageRegistry & ReturnType<typeof import("./model-catalog.js").createExtensionModelCatalog> & {
  complete(model: Pick<Model<Api>, "provider" | "id">, context: Context, options?: ExtensionCompleteOptions): Promise<AssistantMessage>;
};

export const EXTENSION_COMPLETE_TIMEOUT_MS = 90_000;
export type ExtensionCompleteOptions = Pick<SimpleStreamOptions, "signal" | "maxTokens" | "temperature" | "reasoning"> & { timeoutMs?: number };
export type ExtensionCompleteRequest = {
  sessionId: string; extensionId: string; requestId: string;
  providerId: string; modelId: string; context: Context;
  options: Omit<ExtensionCompleteOptions, "signal">;
};

const string = Type.String();
const number = Type.Number();
const text = Type.Object({ type: Type.Literal("text"), text: string });
const image = Type.Object({ type: Type.Literal("image"), data: string, mimeType: string });
const thinking = Type.Object({ type: Type.Literal("thinking"), thinking: string });
const toolCall = Type.Object({ type: Type.Literal("toolCall"), id: string, name: string, arguments: Type.Record(string, Type.Unknown()) });
const cost = Type.Object({ input: number, output: number, cacheRead: number, cacheWrite: number, total: number });
const usage = Type.Object({ input: number, output: number, cacheRead: number, cacheWrite: number, totalTokens: number, cost });
const messages = Type.Array(Type.Union([
  Type.Object({ role: Type.Literal("user"), content: Type.Union([string, Type.Array(Type.Union([text, image]))]), timestamp: number }),
  Type.Object({ role: Type.Literal("assistant"), content: Type.Array(Type.Union([text, thinking, toolCall])), timestamp: number,
    api: string, provider: string, model: string, usage,
    stopReason: Type.Union(["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"].map((value) => Type.Literal(value))) }),
  Type.Object({ role: Type.Literal("toolResult"), toolCallId: string, toolName: string,
    content: Type.Array(Type.Union([text, image])), isError: Type.Boolean(), timestamp: number }),
]), { maxItems: 1000 });
const options = Type.Object({
  maxTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 131072 })),
  temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
  reasoning: Type.Optional(Type.Union(["minimal", "low", "medium", "high", "xhigh", "max"].map((value) => Type.Literal(value)))),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: EXTENSION_COMPLETE_TIMEOUT_MS })),
}, { additionalProperties: false });
const id = Type.String({ minLength: 1, maxLength: 4096 });
const request = Type.Object({ sessionId: id, extensionId: id, requestId: id, providerId: id, modelId: id,
  context: Type.Object({ systemPrompt: Type.Optional(Type.String({ maxLength: 32768 })), messages,
    tools: Type.Optional(Type.Array(Type.Unknown(), { maxItems: 0 })) }, { additionalProperties: false }), options,
}, { additionalProperties: false });

export function extensionModelError(errorCode: string, message: string): Error & { errorCode: string; data: { errorCode: string } } {
  return Object.assign(new Error(message), { errorCode, data: { errorCode } });
}

export function parseExtensionCompleteRequest(value: unknown): ExtensionCompleteRequest {
  if (!Check(request, value) || Buffer.byteLength(JSON.stringify(value), "utf8") > 1_048_576) {
    throw extensionModelError("INVALID_ARGUMENT", "Invalid or oversized extension completion request");
  }
  // The schema checks the pi message union while preserving optional provider
  // continuity fields (signatures, response ids and tool results) verbatim.
  return value as ExtensionCompleteRequest;
}

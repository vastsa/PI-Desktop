/** Versioned, JSON-only inference boundary. Plugins never execute requested Agent tools. */
export type PluginProviderJson = null | boolean | number | string | PluginProviderJson[] | { [key: string]: PluginProviderJson };
export type PluginProviderAdapterDeclarationV1 = { version: 1; chat?: boolean; images?: boolean };
export type PluginProviderImageV1 = { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" };
export type PluginProviderContentV1 =
  | { type: "text"; text: string; textSignature?: string }
  | { type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean }
  | PluginProviderImageV1
  | { type: "toolCall"; id: string; name: string; arguments: { [key: string]: PluginProviderJson }; thoughtSignature?: string; namespace?: string; argumentsError?: string };
export type PluginProviderToolV1 = {
  name: string;
  description: string;
  parameters: { [key: string]: PluginProviderJson };
  constrainedSampling?: PluginProviderJson;
};
/** System messages also carry ordered tool additions/removals and prompt sections. */
export type PluginProviderMessageV1 = {
  role: "system" | "user" | "assistant" | "toolResult";
  content: string | PluginProviderContentV1[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: number;
  sections?: Record<string, string | null>;
  toolsAdded?: PluginProviderToolV1[];
  toolsRemoved?: { name: string }[];
  api?: string;
  provider?: string;
  model?: string;
  responseId?: string;
  stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
  /** Replay metadata, including vendor signatures, is retained verbatim. */
  [field: string]: unknown;
};
export type PluginProviderChatRequestV1 = {
  version: 1;
  providerId: string;
  modelId: string;
  messages: PluginProviderMessageV1[];
  options?: { maxTokens?: number; temperature?: number; reasoning?: string };
};
export type PluginProviderUsageV1 = { input: number; output: number; cacheRead?: number; cacheWrite?: number };
export type PluginProviderChatEventV1 =
  | { type: "text"; delta: string; signature?: string }
  | { type: "thinking"; delta: string; signature?: string; redacted?: boolean }
  | { type: "toolCall"; id: string; name: string; arguments: { [key: string]: PluginProviderJson }; thoughtSignature?: string; namespace?: string; argumentsError?: string }
  | { type: "done"; stopReason: "stop" | "length" | "toolUse"; usage: PluginProviderUsageV1; responseId?: string }
  | { type: "error"; message: string };
export type PluginProviderImageRequestV1 = {
  version: 1;
  providerId: string;
  modelId: string;
  input: ({ type: "text"; text: string } | PluginProviderImageV1)[];
};
export type PluginProviderImageResultV1 = { images: PluginProviderImageV1[]; usage?: PluginProviderUsageV1 };
export type PluginProviderInferenceContextV1 = {
  signal: AbortSignal;
  /** Only this provider's request credential, under an explicit inference grant. Never a refresh token. */
  credential?: { apiKey?: string; headers?: Record<string, string>; requestData?: Record<string, PluginProviderJson> };
};
export type PluginProviderAdapterV1 = {
  version: 1;
  chat?: (request: PluginProviderChatRequestV1, context: PluginProviderInferenceContextV1) => AsyncIterable<PluginProviderChatEventV1> | Promise<AsyncIterable<PluginProviderChatEventV1>>;
  images?: (request: PluginProviderImageRequestV1, context: PluginProviderInferenceContextV1) => Promise<PluginProviderImageResultV1>;
};
/** Module export: providerAdapters[manifest contribution id]. */
export type PluginProviderAdaptersV1 = Record<string, PluginProviderAdapterV1>;
export type PluginProviderInferenceBindingV1 = {
  pluginId: string;
  contributionId: string;
  runtimeId: string;
  /** Host-only account binding for reusable templates; not a plugin authority. */
  accountId?: string;
  templateId?: string;
  version: 1;
  chat: boolean;
  images: boolean;
};
export const PLUGIN_INFERENCE_LIMITS = {
  requestBytes: 16 * 1024 * 1024,
  eventBytes: 256 * 1024,
  totalBytes: 32 * 1024 * 1024,
  events: 32_768,
  imageBytes: 8 * 1024 * 1024,
  images: 4,
  capacity: 16,
  callTimeoutMs: 120_000,
  lifetimeMs: 10 * 60_000,
} as const;

function invalid(): never { throw new Error("Invalid plugin provider inference payload"); }
export function inferenceObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
/** Checks recursively before encoding, so functions, nonfinite numbers and non-JSON prototypes cannot disappear silently. */
export function inferenceJsonBytes(value: unknown, limit: number): number {
  const seen = new Set<object>();
  function visit(v: unknown, depth: number): void {
    if (depth > 64) invalid();
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number" && Number.isFinite(v)) return;
    if (typeof v !== "object" || !v || seen.has(v)) invalid();
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) invalid();
    seen.add(v);
    for (const x of Object.values(v)) visit(x, depth + 1);
    seen.delete(v);
  }
  visit(value, 0);
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > limit) throw new Error("Plugin provider inference size limit exceeded");
  return bytes;
}
/** Secret routing metadata is JSON-only, bounded independently of inference message bodies. */
export function validateProviderRequestData(value: unknown): asserts value is Record<string, PluginProviderJson> {
  inferenceObject(value);
  inferenceJsonBytes(value, 16 * 1024);
}
function string(v: unknown): v is string { return typeof v === "string"; }
function nonempty(v: unknown): v is string { return string(v) && v.length > 0; }
function optionalStrings(o: Record<string, unknown>, fields: string[]): void {
  for (const f of fields) if (o[f] !== undefined && !string(o[f])) invalid();
}
function usage(value: unknown): void {
  const o = inferenceObject(value);
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    if (o[key] === undefined && key.startsWith("cache")) continue;
    if (typeof o[key] !== "number" || !Number.isSafeInteger(o[key]) || o[key] < 0 || o[key] > 1_000_000_000_000) invalid();
  }
}
export function validateProviderAdapterDeclaration(value: unknown): value is PluginProviderAdapterDeclarationV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  return o.version === 1 && (o.chat === true || o.images === true)
    && ["chat", "images"].every(k => o[k] === undefined || typeof o[k] === "boolean")
    && Object.keys(o).every(k => ["version", "chat", "images"].includes(k));
}
export function validateProviderImage(value: unknown): asserts value is PluginProviderImageV1 {
  const o = inferenceObject(value);
  if (o.type !== "image" || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(String(o.mimeType))
    || !nonempty(o.data) || o.data.length > Math.ceil(PLUGIN_INFERENCE_LIMITS.imageBytes / 3) * 4
    || o.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(o.data)) invalid();
  const bytes = o.data.length / 4 * 3 - (o.data.endsWith("==") ? 2 : o.data.endsWith("=") ? 1 : 0);
  if (bytes > PLUGIN_INFERENCE_LIMITS.imageBytes) invalid();
  // Validate the declared MIME against a bounded decoded file signature, never a URL/path.
  const head = atob(o.data.slice(0, Math.min(24, o.data.length)));
  const matches = o.mimeType === "image/png" ? head.startsWith("\x89PNG\r\n\x1a\n")
    : o.mimeType === "image/jpeg" ? head.startsWith("\xff\xd8\xff")
    : o.mimeType === "image/gif" ? /^GIF8[79]a/.test(head)
    : head.startsWith("RIFF") && head.slice(8, 12) === "WEBP";
  if (!matches) invalid();
}
export function validateProviderChatEvent(value: unknown): asserts value is PluginProviderChatEventV1 {
  inferenceJsonBytes(value, PLUGIN_INFERENCE_LIMITS.eventBytes);
  const o = inferenceObject(value);
  switch (o.type) {
    case "text": case "thinking":
      if (!string(o.delta)) invalid();
      optionalStrings(o, ["signature"]);
      if (o.redacted !== undefined && typeof o.redacted !== "boolean") invalid();
      break;
    case "toolCall":
      if (!nonempty(o.id) || !nonempty(o.name)) invalid();
      inferenceObject(o.arguments);
      optionalStrings(o, ["thoughtSignature", "namespace", "argumentsError"]);
      break;
    case "done":
      if (!["stop", "length", "toolUse"].includes(String(o.stopReason))) invalid();
      usage(o.usage);
      optionalStrings(o, ["responseId"]);
      break;
    case "error": if (!nonempty(o.message)) invalid(); break;
    default: invalid();
  }
}
export function validateProviderImageResult(value: unknown): asserts value is PluginProviderImageResultV1 {
  inferenceJsonBytes(value, PLUGIN_INFERENCE_LIMITS.totalBytes);
  const o = inferenceObject(value);
  if (!Array.isArray(o.images) || !o.images.length || o.images.length > PLUGIN_INFERENCE_LIMITS.images) invalid();
  o.images.forEach(validateProviderImage);
  if (o.usage !== undefined) usage(o.usage);
}
export function validateProviderInferenceRequest(value: unknown, operation: "chat" | "images"): void {
  inferenceJsonBytes(value, PLUGIN_INFERENCE_LIMITS.requestBytes);
  const o = inferenceObject(value);
  if (o.version !== 1 || !nonempty(o.providerId) || !nonempty(o.modelId)) invalid();
  if (operation === "images") {
    if (!Array.isArray(o.input) || !o.input.length || o.input.length > 32) invalid();
    for (const block of o.input) {
      const b = inferenceObject(block);
      if (b.type === "image") validateProviderImage(b);
      else if (b.type !== "text" || !string(b.text)) invalid();
    }
  } else {
    if (o.options !== undefined) {
      const options = inferenceObject(o.options);
      if (options.maxTokens !== undefined && (typeof options.maxTokens !== "number" || !Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)) invalid();
      if (options.temperature !== undefined && typeof options.temperature !== "number") invalid();
      optionalStrings(options, ["reasoning"]);
    }
    if (!Array.isArray(o.messages) || o.messages.length > 10_000) invalid();
    for (const message of o.messages) {
      const m = inferenceObject(message);
      if (!["system", "user", "assistant", "toolResult"].includes(String(m.role))) invalid();
      if (!string(m.content) && !Array.isArray(m.content)) invalid();
      for (const field of ["toolsAdded", "toolsRemoved"]) if (m[field] !== undefined) {
        if (!Array.isArray(m[field]) || m[field].length > 4096) invalid();
        for (const entry of m[field]) {
          const tool = inferenceObject(entry);
          if (!nonempty(tool.name)) invalid();
          if (field === "toolsAdded") {
            if (!string(tool.description)) invalid();
            inferenceObject(tool.parameters);
          }
        }
      }
      if (m.sections !== undefined && Object.values(inferenceObject(m.sections)).some(section => section !== null && !string(section))) invalid();
      if (Array.isArray(m.content)) for (const content of m.content) {
        const c = inferenceObject(content);
        if (c.type === "image") validateProviderImage(c);
        else if (c.type === "text" && string(c.text)) optionalStrings(c, ["textSignature"]);
        else if (c.type === "thinking" && string(c.thinking)) optionalStrings(c, ["thinkingSignature"]);
        else if (c.type === "toolCall") validateProviderChatEvent(c);
        // Native hosted-search replay metadata is JSON and must remain opaque.
        else if (c.type !== "hostedSearch") invalid();
      }
      if (m.role === "toolResult" && (!nonempty(m.toolCallId) || !nonempty(m.toolName) || typeof m.isError !== "boolean")) invalid();
    }
  }
}

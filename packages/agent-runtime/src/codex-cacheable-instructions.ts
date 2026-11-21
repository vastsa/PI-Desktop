import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

/**
 * Move the Codex system prompt out of the top-level `instructions` field.
 *
 * GPT-6.2 stopped computing prompt-cache prefixes over the `instructions`
 * field: the adapter puts the whole system prompt there, so every turn of a
 * session re-bills it as uncached input even though it never changes
 * (issue #2419). GPT-6.1 and earlier still cache it, and the plain
 * `openai-responses` path already sends the system prompt as a leading
 * `developer` message inside `input`, so only the codex adapter on a
 * `gpt-6.2` model gets rewritten. The rewrite is idempotent: once the prompt
 * lives in `input`, the top-level field is gone and the hook returns
 * undefined, which keeps upstream's eventual fix a no-op here.
 */
const GPT62_PREFIX = "gpt-6.2";

export function codexCacheableInstructions(payload: unknown, model: Model<any>): unknown | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  if (model.provider !== "openai-codex") return undefined;
  if (!String(model.id).startsWith(GPT62_PREFIX)) return undefined;
  const record = payload as Record<string, unknown>;
  const instructions = record.instructions;
  if (typeof instructions !== "string" || instructions.length === 0) return undefined;
  const input = Array.isArray(record.input) ? record.input : [];
  const rest = { ...record };
  // The field is dropped outright, matching the OpenCode fix: the Codex
  // backend rejects nothing about a missing `instructions`, while an empty
  // string would ask the model to treat the turn as instruction-less.
  delete rest.instructions;
  return {
    ...rest,
    input: [
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: instructions }],
      },
      ...input,
    ],
  };
}

/**
 * Innermost payload hook: the extension chain above it must see the
 * rewritten body, and pi-ai applies `onPayload` before the WebSocket/SSE
 * branch, so both transports ride the same rewrite.
 */
export function withCodexCacheableInstructions(
  options: SimpleStreamOptions,
  model: Model<any>,
): SimpleStreamOptions {
  if (model.provider !== "openai-codex" || !String(model.id).startsWith(GPT62_PREFIX)) {
    return options;
  }
  return {
    ...options,
    onPayload: async (payload, payloadModel) => {
      const rewritten = await options.onPayload?.(payload, payloadModel);
      return codexCacheableInstructions(rewritten ?? payload, payloadModel) ?? rewritten ?? payload;
    },
  };
}

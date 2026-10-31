/**
 * Provider replay metadata for persisted assistant rows (#1972).
 *
 * pi-ai keeps provider signatures on assistant content blocks: Anthropic
 * thinking signatures and redacted payloads, Responses encrypted reasoning
 * items and message ids, Gemini thought signatures, and the reasoning field
 * name for Completions models. A transcript row only stores the concatenated
 * thinking and answer text, so a rebuilt runtime used to replay history
 * without them. pi-ai then sends the thinking as plain text or drops it, which
 * changes the request prefix and invalidates the provider's prompt cache from
 * the first reasoning turn onward.
 *
 * The row keeps block boundaries and signatures only; the texts stay in
 * `thinking` and `content`. Restoring is all-or-nothing: if the stored lengths
 * no longer add up to the row's text, the caller keeps its plain rebuild.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AssistantProviderReplay,
  AssistantProviderReplayBlock,
  AssistantProviderReplayToolCall,
} from "@pi-desktop/shared";

/**
 * Per-row ceiling for the serialized replay data. Signatures are opaque and
 * redacted or encrypted reasoning can be kilobytes per block; a row above the
 * ceiling is stored without replay data and falls back to the plain rebuild
 * instead of growing the transcript without bound.
 */
export const MAX_PROVIDER_REPLAY_BYTES = 64 * 1024;

type ReplayContent = Extract<
  AssistantMessage["content"][number],
  { type: "thinking" } | { type: "text" }
>;

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Record the thinking/text block boundaries and signatures of a finished
 * assistant message. Returns undefined when no block carries anything to
 * replay, so ordinary rows stay unchanged on disk.
 */
export function captureAssistantProviderReplay(
  content: unknown,
): AssistantProviderReplay | undefined {
  if (!Array.isArray(content)) return undefined;
  const blocks: AssistantProviderReplayBlock[] = [];
  const toolCalls: AssistantProviderReplayToolCall[] = [];
  let carriesReplay = false;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const block = part as {
      type?: unknown;
      text?: unknown;
      thinking?: unknown;
      thinkingSignature?: unknown;
      textSignature?: unknown;
      thoughtSignature?: unknown;
      id?: unknown;
      redacted?: unknown;
    };
    if (block.type === "thinking") {
      // Mirrors assistantContent(): adapters may expose thinking as `text`.
      const text = typeof block.thinking === "string"
        ? block.thinking
        : typeof block.text === "string"
          ? block.text
          : "";
      const signature = nonEmpty(block.thinkingSignature);
      const redacted = block.redacted === true;
      if (signature || redacted) carriesReplay = true;
      blocks.push({
        type: "thinking",
        length: text.length,
        ...(signature ? { signature } : {}),
        ...(redacted ? { redacted: true as const } : {}),
      });
    } else if (block.type === "toolCall") {
      // Gemini signs function calls separately from thinking and text. The
      // call is rebuilt from its tool row, so only the id link is kept.
      const id = nonEmpty(block.id);
      const signature = nonEmpty(block.thoughtSignature);
      if (id && signature) {
        carriesReplay = true;
        toolCalls.push({ id, signature });
      }
    } else if (block.type === "text" && typeof block.text === "string") {
      const signature = nonEmpty(block.textSignature);
      if (signature) carriesReplay = true;
      blocks.push({
        type: "text",
        length: block.text.length,
        ...(signature ? { signature } : {}),
      });
    }
  }
  if (!carriesReplay) return undefined;
  const replay: AssistantProviderReplay = {
    version: 1,
    blocks,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
  return Buffer.byteLength(JSON.stringify(replay), "utf8") > MAX_PROVIDER_REPLAY_BYTES
    ? undefined
    : replay;
}

function validBlocks(replay: unknown): AssistantProviderReplayBlock[] | undefined {
  if (!replay || typeof replay !== "object") return undefined;
  const { version, blocks } = replay as { version?: unknown; blocks?: unknown };
  if (version !== 1 || !Array.isArray(blocks)) return undefined;
  for (const block of blocks) {
    if (!block || typeof block !== "object") return undefined;
    const { type, length, signature } = block as {
      type?: unknown;
      length?: unknown;
      signature?: unknown;
    };
    if (type !== "thinking" && type !== "text") return undefined;
    if (typeof length !== "number" || !Number.isInteger(length) || length < 0) {
      return undefined;
    }
    if (signature !== undefined && typeof signature !== "string") return undefined;
  }
  return blocks as AssistantProviderReplayBlock[];
}

/**
 * Signatures of the row's function calls by call id. Independent of the
 * thinking/text lengths, so they survive a row whose text no longer matches.
 */
export function providerReplayToolCallSignatures(replay: unknown): Map<string, string> {
  const signatures = new Map<string, string>();
  if (!replay || typeof replay !== "object") return signatures;
  const { version, toolCalls } = replay as { version?: unknown; toolCalls?: unknown };
  if (version !== 1 || !Array.isArray(toolCalls)) return signatures;
  for (const entry of toolCalls) {
    if (!entry || typeof entry !== "object") continue;
    const { id, signature } = entry as { id?: unknown; signature?: unknown };
    const callId = nonEmpty(id);
    const value = nonEmpty(signature);
    if (callId && value) signatures.set(callId, value);
  }
  return signatures;
}

/**
 * Rebuild the thinking/text blocks of a persisted assistant row with their
 * original boundaries and signatures. Returns undefined when the stored
 * replay is missing, malformed, or no longer matches the row's text.
 */
export function restoreAssistantProviderReplay(
  replay: unknown,
  thinking: string,
  text: string,
): ReplayContent[] | undefined {
  const blocks = validBlocks(replay);
  if (!blocks) return undefined;
  let thinkingLength = 0;
  let textLength = 0;
  for (const block of blocks) {
    if (block.type === "thinking") thinkingLength += block.length;
    else textLength += block.length;
  }
  if (thinkingLength !== thinking.length || textLength !== text.length) {
    return undefined;
  }
  const restored: ReplayContent[] = [];
  let thinkingOffset = 0;
  let textOffset = 0;
  for (const block of blocks) {
    if (block.type === "thinking") {
      const slice = thinking.slice(thinkingOffset, thinkingOffset + block.length);
      thinkingOffset += block.length;
      // An empty unsigned block carries nothing a provider could use.
      if (!slice && !block.signature && !block.redacted) continue;
      restored.push({
        type: "thinking",
        thinking: slice,
        ...(block.signature ? { thinkingSignature: block.signature } : {}),
        ...(block.redacted ? { redacted: true } : {}),
      });
    } else {
      const slice = text.slice(textOffset, textOffset + block.length);
      textOffset += block.length;
      if (!slice && !block.signature) continue;
      restored.push({
        type: "text",
        text: slice,
        ...(block.signature ? { textSignature: block.signature } : {}),
      });
    }
  }
  return restored;
}

/**
 * Replay data for a finished bubble. When the bubble's text is not this
 * response's own (it kept text from an earlier recovery attempt), the block
 * boundaries no longer apply; only the call-id-linked signatures remain.
 */
export function providerReplayForBubble(
  replay: AssistantProviderReplay | undefined,
  textMatchesResponse: boolean,
): AssistantProviderReplay | undefined {
  if (!replay || textMatchesResponse) return replay;
  return replay.toolCalls?.length
    ? { version: 1, blocks: [], toolCalls: replay.toolCalls }
    : undefined;
}

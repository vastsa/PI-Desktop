/**
 * Output-token capping enforced at the pi-desktop stream layer (issue B).
 *
 * pi-ai only clamps `max_tokens` on the `streamSimple` path
 * (`buildBaseOptions` → `clampMaxTokensToContext`). The low-level stream
 * adapter used for `thinkingLevel: "omit"` sends `options.maxTokens`
 * untouched, and the estimate that feeds pi-ai's clamp (`chars / 4`,
 * `CHARS_PER_TOKEN = 4`) systematically under-counts CJK text. Both routes
 * can therefore hand the provider an output budget that pushes
 * `input + output` past the model's real context window, ending in a
 * `maximum context length` 400/413/503.
 *
 * This module re-clamps the effective output budget for *both* routes at the
 * pi-desktop layer, using a CJK-aware input estimate (a CJK character runs
 * ~1 token, not the 0.25 the chars/4 baseline charges) and a safety margin
 * that scales with the window instead of pi-ai's fixed 4096. It is applied
 * in `runtime.ts` and `subagent-model-binding.ts` before either adapter
 * branch runs, so the clamp holds for `streamSimple` and `stream` alike.
 *
 * Hosted search is charged through the adapter's own replay projection for the
 * target model, so a search item the provider discards (a Responses
 * `web_search_call` from another model) no longer inflates the estimate while
 * same-model search history keeps counting. A caller that has no target model
 * passes none and keeps the conservative block-protocol estimate.
 *
 * Instruction history is charged the way the adapter sends it as well: see
 * `requestTranscript`.
 */

import {
  resolveTranscript,
  type Api,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  hostedSearchReplayProjection,
  type HostedSearchReplayOptions,
} from "@earendil-works/pi-ai/utils/hosted-search";

/** Structural view of the request context; assignable from pi-ai's `Context`. */
export type OutputCapContext = {
  systemPrompt?: string;
  messages: OutputCapMessage[];
  tools?: Array<unknown>;
};

/**
 * Structural view of one context message. The replay identity (`api`,
 * `provider`, `model`) is what pi-ai's adapters stamp on assistant messages;
 * it is absent on every other role and on records written before hosted
 * search existed.
 */
export type OutputCapMessage = {
  role: string;
  content: unknown;
  sections?: Record<string, string | null>;
  toolsAdded?: readonly unknown[];
  toolsRemoved?: readonly unknown[];
  api?: Api;
  provider?: string;
  model?: string;
};

/**
 * The target-model facts the hosted-search replay projection needs: `api`
 * selects the projection, `provider`/`id` decide whether a Responses
 * `web_search_call` belongs to the model being asked (the provider discards a
 * cross-model search item). These are exactly the fields the adapter compares,
 * so the estimate charges the items the request really carries.
 */
export type OutputCapReplayTarget = {
  api?: Api;
  provider?: string;
  id?: string;
};

/** Structural view of the active model. */
export type OutputCapModel = OutputCapReplayTarget & {
  contextWindow: number;
  /** Published limit, when a user override may have enlarged contextWindow. */
  catalogContextWindow?: number;
  maxTokens: number;
};

/**
 * Accepted target argument for the estimator. A caller may hold the full
 * model or only its window facts (a catalog entry, a caller test); only the
 * replay identity is read, and a window-only model keeps the conservative
 * estimate instead of being rejected.
 */
export type OutputCapEstimateModel = OutputCapReplayTarget | OutputCapModel;

function positiveWindow(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) return undefined;
  return Math.max(1, Math.round(value!));
}

/** Use the published window as a hard safety ceiling for configured values. */
export function effectiveModelContextWindow(model: OutputCapModel): number {
  const configured = positiveWindow(model.contextWindow);
  const catalog = positiveWindow(model.catalogContextWindow);
  if (configured === undefined) return catalog ?? 0;
  return catalog === undefined ? configured : Math.min(configured, catalog);
}

/** Fallback reserve when the window is too small to afford the ratio. */
const OUTPUT_SAFETY_FLOOR_TOKENS = 4096;
/** Window-proportional reserve; at 262k this is ~4k, at 1M ~10k. */
const OUTPUT_SAFETY_WINDOW_RATIO = 0.01;
/** Wire-format estimate constants, matching pi-ai's internal estimator. */
const CHARS_PER_TOKEN = 4;
const ESTIMATED_CHARS_PER_IMAGE = 4800;

// Han, Japanese kana, and Korean Hangul tokenize at ~1 token per character,
// as do CJK punctuation and full-width forms. The chars/4 baseline charges
// all of these 0.25.
function countCjkChars(text: string): number {
  let count = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      // Hangul Jamo.
      (code >= 0x1100 && code <= 0x11ff) ||
      // CJK punctuation.
      (code >= 0x3000 && code <= 0x303f) ||
      // Hiragana and katakana.
      (code >= 0x3040 && code <= 0x30ff) ||
      // Hangul compatibility Jamo.
      (code >= 0x3130 && code <= 0x318f) ||
      // Katakana phonetic extensions.
      (code >= 0x31f0 && code <= 0x31ff) ||
      // CJK Unified Ideographs + Extension A.
      (code >= 0x3400 && code <= 0x9fff) ||
      // Hangul syllables.
      (code >= 0xac00 && code <= 0xd7af) ||
      // CJK compatibility ideographs.
      (code >= 0xf900 && code <= 0xfaff) ||
      // Full-width and half-width forms.
      (code >= 0xff00 && code <= 0xffef) ||
      // CJK Extension B..F (historical/supplementary plane).
      (code >= 0x20000 && code <= 0x2ebef)
    ) {
      count += 1;
    }
  }
  return count;
}

function stringifyForEstimate(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "" : serialized;
  } catch {
    return "[unserializable]";
  }
}

/** Token estimate for one message's content (text/thinking/tool/image). */
function estimateMessageTokens(
  content: unknown,
  replayOptions: HostedSearchReplayOptions | undefined,
): {
  baseline: number;
  cjkChars: number;
} {
  if (typeof content === "string") {
    return {
      baseline: Math.ceil(content.length / CHARS_PER_TOKEN),
      cjkChars: countCjkChars(content),
    };
  }
  if (!Array.isArray(content)) return { baseline: 0, cjkChars: 0 };
  let chars = 0;
  let cjkChars = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; [key: string]: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      chars += b.text.length;
      cjkChars += countCjkChars(b.text);
    } else if (b.type === "thinking" && typeof b.thinking === "string") {
      chars += b.thinking.length;
      cjkChars += countCjkChars(b.thinking);
    } else if (
      (b.type === "toolCall" || b.type === "functionCall") &&
      typeof b.name === "string"
    ) {
      const payload = stringifyForEstimate(b.arguments ?? b.input);
      chars += b.name.length + payload.length;
      // JSON.stringify leaves Han unescaped, so the payload the chars/4
      // baseline measured is the same string the correction has to see.
      // A \uXXXX form would already be ASCII in that string; decoding it
      // would charge the character twice.
      cjkChars += countCjkChars(b.name) + countCjkChars(payload);
    } else if (b.type === "hostedSearch") {
      // 与适配器共用回放投影；搜索结果不是图片，也不是普通工具参数。
      // 投影会校验结构，失败必须保留为本地错误，不能按零成本继续请求。
      // 只有目标模型不会回放的条目（跨模型的 Responses 搜索）才计零成本，
      // 判据来自适配器本身，不是这里的猜测。
      const replay = hostedSearchReplayProjection(b, replayOptions);
      const payload = JSON.stringify(replay);
      if (payload !== undefined) {
        chars += payload.length;
        cjkChars += countCjkChars(payload);
      }
    } else {
      chars += ESTIMATED_CHARS_PER_IMAGE;
    }
  }
  return { baseline: Math.ceil(chars / CHARS_PER_TOKEN), cjkChars };
}

/**
 * Replay options for one message, mirroring the adapter exactly: with a known
 * target `api` a Responses `web_search_call` is replayed only for the model
 * that produced it, while Anthropic search blocks keep their existing
 * cross-model semantics (the projection ignores `isSameModel` there).
 *
 * Without a target `api` there is no adapter behaviour to mirror, so a caller
 * holding only window facts keeps the conservative block-protocol estimate:
 * every search block is charged instead of silently dropped.
 */
function replayOptionsFor(
  message: OutputCapMessage,
  target: OutputCapReplayTarget | undefined,
): HostedSearchReplayOptions | undefined {
  if (target?.api === undefined) return undefined;
  return {
    api: target.api,
    isSameModel:
      message.api === target.api &&
      message.provider === target.provider &&
      message.model === target.id,
  };
}

/**
 * Estimate the input tokens of a request. Mirrors pi-ai's internal estimator
 * (chars/4, 1200 tokens per image, serialized tool schemas) and adds the
 * missing CJK correction: a CJK char costs ~1 token while the baseline
 * charges 0.25, so the shortfall is added back.
 *
 * `model` is the request's target model; pass it whenever it is known so
 * hosted-search history is charged the way the adapter replays it.
 */
export function estimateOutputCapInputTokens(
  context: OutputCapContext,
  model?: OutputCapEstimateModel,
): number {
  let baseline = 0;
  let cjkChars = 0;
  for (const message of context.messages) {
    const estimated = estimateMessageTokens(
      message.content,
      replayOptionsFor(message, model),
    );
    if (message.role === "system") {
      // Canonical transcript requests carry instruction sections and schema
      // updates on the message, without a separate systemPrompt/tools field.
      const state = [message.sections, message.toolsAdded, message.toolsRemoved]
        .filter((value) => value !== undefined).map(stringifyForEstimate).join("\n");
      baseline += Math.ceil(state.length / CHARS_PER_TOKEN);
      cjkChars += countCjkChars(state);
    }
    baseline += estimated.baseline;
    cjkChars += estimated.cjkChars;
  }
  if (context.systemPrompt) {
    baseline += Math.ceil(context.systemPrompt.length / CHARS_PER_TOKEN);
    cjkChars += countCjkChars(context.systemPrompt);
  }
  if (context.tools?.length) {
    baseline += Math.ceil(
      stringifyForEstimate(context.tools).length / CHARS_PER_TOKEN,
    );
  }
  // CJK chars are ~1 token each; the chars/4 baseline charged them 0.25.
  return baseline + Math.ceil(cjkChars * 0.75);
}

/**
 * The transcript the adapter puts on the wire. Unless the model declares
 * mid-conversation system support, every adapter folds the later system
 * messages into one leading message holding the current instructions and
 * tools. Estimating the unfolded history charges each superseded instruction
 * snapshot again: a long session with a large instruction section then
 * starves the output budget to the provider's floor while the request itself
 * is far from the window.
 */
export function requestTranscript(
  model: Pick<Model<Api>, "compat">,
  context: TranscriptContext,
): TranscriptContext {
  const compat = model.compat;
  const midConversation =
    compat !== undefined &&
    "supportsMidConvoSystemMessages" in compat &&
    compat.supportsMidConvoSystemMessages === true;
  return resolveTranscript(context, midConversation);
}

/**
 * Cap the effective output budget so `estimatedInput + output` stays inside
 * the model's context window, regardless of which adapter branch the caller
 * picks (omit → low-level `stream`, everything else → `streamSimple`).
 *
 * Returns a concrete number so the low-level `stream` path, which never
 * re-derives `max_tokens`, still goes out clamped.
 */
export function clampOutputToContext(
  model: OutputCapModel,
  context: OutputCapContext,
  requestedMaxTokens: number | undefined,
): number {
  const contextWindow = effectiveModelContextWindow(model);
  const desired = Math.max(
    1,
    Math.round(requestedMaxTokens ?? model.maxTokens),
  );
  // Unknown window: there is nothing context-based to clamp against; keep the
  // configured budget (mirrors pi-ai's `contextWindow <= 0` behavior).
  if (contextWindow <= 0) return desired;
  const inputTokens = estimateOutputCapInputTokens(context, model);
  const reserve = Math.max(
    OUTPUT_SAFETY_FLOOR_TOKENS,
    Math.ceil(contextWindow * OUTPUT_SAFETY_WINDOW_RATIO),
  );
  const byContext = Math.max(1, contextWindow - inputTokens - reserve);
  return Math.min(desired, byContext);
}

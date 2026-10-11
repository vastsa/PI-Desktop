import { clipUtf8, fenceReferenceBlock, formatReferenceBlock, utf8Bytes } from "./prompt.js";
import { pairCompletedQaTurns } from "./qa.js";

/** `PLUGIN_MARK_SEND_MAX_BYTES`: the host drops a trigger row whose `send` is larger. */
export const MARK_SEND_MAX_BYTES = 32 * 1024;
/**
 * Complete turns one reference may hold, the first one included: the host's
 * Settings › AI choices (`PluginTriggerQuery.sessionReferences.maxTurns`) and
 * the default when the host does not say (as in PR #447).
 */
export const MAX_TURNS_CHOICES = Object.freeze([3, 5, 10, 20]);
export const DEFAULT_MAX_TURNS = 10;
/** A clipped question keeps at most this much, leaving the rest to its answer. */
const CLIPPED_QUESTION_MAX_BYTES = 2 * 1024;
const CLIP_MARKER = "\n[… clipped to fit the reference size limit]";
const HOST_CLIP_MARKER = "\n[… the host shortened this text]";

/** Model tokens held back for the reply and the user's own text (#447's default output reserve). */
export const CONTEXT_RESERVE_TOKENS = 8192;
/**
 * The reference budget's choices, % of the remaining context: the host's
 * Settings › AI choices (`PluginTriggerQuery.sessionReferences.budgetPercent`)
 * and the default when the host does not say.
 */
export const BUDGET_PERCENTS = Object.freeze([10, 25, 50, 100]);
export const DEFAULT_BUDGET_PERCENT = 25;
/** Context budgets are rounded down to this, so a few tokens of typing do not rebuild every snapshot. */
export const BUDGET_STEP_BYTES = 512;

/** The host's value when it is one of the choices; the default otherwise. */
export function budgetPercent(value) {
  return typeof value === "number" && BUDGET_PERCENTS.includes(value) ? value : DEFAULT_BUDGET_PERCENT;
}

/** The host's value when it is one of the choices; the default otherwise. */
export function maxTurnsOf(value) {
  return typeof value === "number" && MAX_TURNS_CHOICES.includes(value) ? value : DEFAULT_MAX_TURNS;
}

/**
 * The byte budget of one reference: `percent` of what the current session's
 * context can still take, after an 8192-token reply reserve, at #447's UTF-8/3
 * estimate (a heuristic, not a tokenizer), and never more than the mark limit.
 * `context` is the trigger query's `{ usedTokens, contextWindow }`; when the
 * host did not say (no usage yet, an older host) the mark limit is the budget.
 * `contextBound` is true when the context share, not the mark limit, decided.
 */
export function referenceBudget(context, percent = DEFAULT_BUDGET_PERCENT, maxBytes = MARK_SEND_MAX_BYTES) {
  const used = Number(context?.usedTokens);
  const window = Number(context?.contextWindow);
  if (context?.usedTokens == null || context?.contextWindow == null
    || !Number.isFinite(used) || !Number.isFinite(window) || window <= 0 || used < 0) {
    return { bytes: maxBytes, contextBound: false };
  }
  const remaining = Math.max(0, Math.floor(window - used) - CONTEXT_RESERVE_TOKENS);
  const share = Math.floor(remaining * budgetPercent(percent) / 100) * 3;
  const bytes = Math.floor(share / BUDGET_STEP_BYTES) * BUDGET_STEP_BYTES;
  return bytes < maxBytes ? { bytes, contextBound: true } : { bytes: maxBytes, contextBound: false };
}

/**
 * What `buildSessionSnapshot` returns.
 *
 * @typedef {{ status: "ready", send: string, includedTurns: number, firstTurn: boolean,
 *   omittedKnown: number, unread: boolean, clipped: boolean }} SessionSnapshot
 *   `send` is the mark's text: a newline-framed, fenced `<referenced-chat>` block.
 * @typedef {{ status: "context-full", neededBytes: number, contextBytes: number }} SessionSnapshotContextFull
 *   Not even the first (or, unknown, the newest) complete turn fits in the
 *   context budget; `neededBytes` is what that turn needs as a block.
 */

function marked(turn) {
  return turn.truncated ? { question: turn.question, answer: `${turn.answer}${HOST_CLIP_MARKER}` } : turn;
}

const sameTurn = (a, b) => (a.id !== undefined && a.id === b.id)
  || (a.question === b.question && a.answer === b.answer);

/**
 * The referenced session as one mark text within `maxBytes`, at most
 * `maxTurns` complete turns:
 *
 * - its **first** complete turn, always, when known: from the transcript read
 *   when that reaches the start, else `source.firstTurn` (read separately from
 *   the start of the session);
 * - then the most recent turns, selected newest-first while the block fits,
 *   kept in chronological order; a marker line stands for the turns between
 *   (counted when they were read, "not read" when they were not).
 *
 * When the first turn is not known, the most recent turns alone are used and
 * older history is described as not read. A turn that does not fit on its own
 * (the first, or the newest without one) is clipped, question first capped
 * and then the answer, and the block says so: a mark has a hard size limit
 * and no later chance to refuse.
 *
 * `contextBytes` is the context budget. When it is the tighter limit and not
 * even that turn fits, nothing is clipped: the result is `context-full`, so
 * the user can compact (or raise the budget) and pick the session again.
 */
export function buildSessionSnapshot(
  source,
  options = {},
) {
  let maxBytes = options.maxBytes ?? MARK_SEND_MAX_BYTES;
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024) throw new Error("maxBytes must be an integer of at least 1024");
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new Error("maxTurns must be a positive integer");
  const contextBytes = options.contextBytes;
  if (contextBytes !== undefined && (!Number.isFinite(contextBytes) || contextBytes < 0)) {
    throw new Error("contextBytes must be a non-negative number");
  }
  const known = pairCompletedQaTurns(source.messages);
  const fromStart = !source.hasMoreBefore;
  let first = null;
  let rest = known;
  let gapUnread = false;
  const at = source.firstTurn ? known.findIndex((turn) => sameTurn(turn, source.firstTurn)) : -1;
  if (at >= 0 || (fromStart && known.length > 0)) {
    const index = Math.max(0, at);
    first = known[index];
    rest = known.slice(index + 1);
  } else if (source.firstTurn) {
    first = source.firstTurn;
    gapUnread = true;
  }
  const firstMode = first !== null;
  const seed = firstMode ? first : known[known.length - 1];
  const pool = firstMode ? rest : known.slice(0, -1);
  const unread = firstMode ? gapUnread : Boolean(source.hasMoreBefore);

  const compose = (picked, seedTurn = seed, forceClipped = false) => {
    const turns = seedTurn === undefined ? [] : firstMode ? [seedTurn, ...picked] : [...picked, seedTurn];
    const clipped = forceClipped || turns.some((turn) => turn.truncated);
    const omitted = pool.length - picked.length;
    const send = fenceReferenceBlock(formatReferenceBlock({
      sessionId: source.id, title: source.title, turns: turns.map(marked),
      first: firstMode, omitted, unread, clipped,
    }));
    return { status: "ready", send, includedTurns: turns.length, firstTurn: firstMode && turns.length > 0,
      omittedKnown: omitted, unread, clipped };
  };
  const size = (snapshot) => utf8Bytes(snapshot.send);

  if (contextBytes !== undefined && contextBytes < maxBytes) {
    const neededBytes = size(compose([]));
    if (neededBytes > contextBytes) {
      return { status: "context-full", neededBytes, contextBytes: Math.floor(contextBytes) };
    }
    maxBytes = Math.floor(contextBytes);
  }
  if (seed === undefined) {
    const empty = compose([]);
    if (size(empty) > maxBytes) throw new Error("The session title does not fit in a reference");
    return empty;
  }

  if (size(compose([])) > maxBytes) {
    const question = utf8Bytes(seed.question) > CLIPPED_QUESTION_MAX_BYTES
      ? `${clipUtf8(seed.question, CLIPPED_QUESTION_MAX_BYTES)}${CLIP_MARKER}` : seed.question;
    const room = maxBytes - size(compose([], { question, answer: CLIP_MARKER }, true));
    if (room < 0) throw new Error("The session title does not fit in a reference");
    // Escaping can only grow closing tags; trim until the rendered block fits.
    for (let answerBytes = room; ; answerBytes = Math.max(0, answerBytes - 64)) {
      const clipped = compose([], { question, answer: `${clipUtf8(seed.answer, answerBytes)}${CLIP_MARKER}` }, true);
      if (size(clipped) <= maxBytes || answerBytes === 0) return clipped;
    }
  }

  let picked = [];
  for (let index = pool.length - 1; index >= 0 && picked.length + 1 < maxTurns; index--) {
    const candidate = [pool[index], ...picked];
    if (size(compose(candidate)) > maxBytes) break;
    picked = candidate;
  }
  return compose(picked);
}

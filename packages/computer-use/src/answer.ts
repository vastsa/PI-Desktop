/**
 * The strict wire between the bound model and the machine (ADR 0340 §9).
 *
 * Everything in this file treats the model's reply as untrusted text. It is
 * parsed, not interpreted: a reply that is not exactly one well-formed answer
 * is a refusal, never a best-effort guess at what the model meant. The same
 * rule covers content read off the user's screen — a window that asks to be
 * clicked somewhere else is data, and nothing here acts on it.
 */
import {
  COMPUTER_MAX_LABEL_CHARS,
  COMPUTER_MAX_TEXT_CHARS,
  type ComputerAction,
  type ComputerActionKind,
  type ComputerInspection,
  type ComputerNode,
} from "@pi-desktop/shared";

export const COMPUTER_ACTION_KINDS: readonly ComputerActionKind[] = [
  "click",
  "double_click",
  "right_click",
  "set_value",
  "press_keys",
  "scroll",
  "select",
];

export type LoopAnswer =
  | { kind: "action"; action: ComputerAction; note?: string }
  | { kind: "done"; summary: string }
  | { kind: "ask"; question: string };

export type AnswerParse =
  | { ok: true; answer: LoopAnswer }
  | { ok: false; reason: string };

const MAX_NOTE_CHARS = 300;
const MAX_SUMMARY_CHARS = 1_000;
const MAX_QUESTION_CHARS = 300;

function reject(reason: string): AnswerParse {
  return { ok: false, reason };
}

/**
 * Pull the one JSON object out of a model reply.
 *
 * Models wrap JSON in prose and fences often enough that refusing those
 * outright would make the loop unusable, so a single fenced or bare object is
 * accepted. Two objects, or anything else, is still a refusal: picking one of
 * them would be guessing which action the model wanted.
 */
export function extractJsonObject(text: string): AnswerParse | { ok: true; value: unknown } {
  const trimmed = text.trim();
  if (!trimmed) return reject("the model returned nothing");
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return reject("the model returned no JSON object");
  const slice = candidate.slice(start, end + 1);
  try {
    const value = JSON.parse(slice) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return reject("the model returned a non-object");
    }
    return { ok: true, value };
  } catch {
    return reject("the model returned malformed JSON");
  }
}

function boundedString(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > limit) return undefined;
  return trimmed;
}

/** Parse one answer. Unknown keys are refused so the schema cannot grow. */
export function parseLoopAnswer(text: string): AnswerParse {
  const extracted = extractJsonObject(text);
  if ("ok" in extracted && extracted.ok === false) return extracted;
  const value = (extracted as { ok: true; value: unknown }).value as Record<string, unknown>;

  const kind = value.kind;
  if (kind === "done") {
    const summary = boundedString(value.summary, MAX_SUMMARY_CHARS);
    if (!summary) return reject("done without a summary");
    if (Object.keys(value).some((key) => !["kind", "summary"].includes(key))) {
      return reject("done with unexpected fields");
    }
    return { ok: true, answer: { kind: "done", summary } };
  }
  if (kind === "ask") {
    const question = boundedString(value.question, MAX_QUESTION_CHARS);
    if (!question) return reject("ask without a question");
    if (Object.keys(value).some((key) => !["kind", "question"].includes(key))) {
      return reject("ask with unexpected fields");
    }
    return { ok: true, answer: { kind: "ask", question } };
  }
  if (kind !== "action") return reject("unknown answer kind");

  if (Object.keys(value).some((key) => !["kind", "action", "note"].includes(key))) {
    return reject("action with unexpected fields");
  }
  const raw = value.action;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return reject("action without a body");
  const body = raw as Record<string, unknown>;
  const allowed = ["kind", "uid", "point", "text", "keys", "scroll", "option"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    return reject("action body with unexpected fields");
  }
  const actionKind = body.kind;
  if (typeof actionKind !== "string" || !COMPUTER_ACTION_KINDS.includes(actionKind as ComputerActionKind)) {
    return reject("unknown action kind");
  }
  const action: ComputerAction = { kind: actionKind as ComputerActionKind };

  if (body.uid !== undefined) {
    const uid = boundedString(body.uid, 256);
    if (!uid) return reject("malformed element id");
    action.uid = uid;
  }
  if (body.point !== undefined) {
    if (!body.point || typeof body.point !== "object" || Array.isArray(body.point)) {
      return reject("malformed point");
    }
    const point = body.point as Record<string, unknown>;
    if (Object.keys(point).some((key) => !["x", "y"].includes(key))) return reject("malformed point");
    if (typeof point.x !== "number" || typeof point.y !== "number") return reject("malformed point");
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return reject("non-finite point");
    action.point = { x: point.x, y: point.y };
  }
  if (!action.uid && !action.point) return reject("action names neither an element nor a point");

  if (body.text !== undefined) {
    if (typeof body.text !== "string" || body.text.length > COMPUTER_MAX_TEXT_CHARS) {
      return reject("malformed text");
    }
    action.text = body.text;
  }
  if (body.keys !== undefined) {
    if (!Array.isArray(body.keys) || body.keys.length < 1 || body.keys.length > 16) {
      return reject("malformed keys");
    }
    const keys: string[] = [];
    for (const entry of body.keys) {
      const chord = boundedString(entry, 64);
      if (!chord) return reject("malformed key chord");
      keys.push(chord);
    }
    action.keys = keys;
  }
  if (body.scroll !== undefined) {
    if (!body.scroll || typeof body.scroll !== "object" || Array.isArray(body.scroll)) {
      return reject("malformed scroll");
    }
    const scroll = body.scroll as Record<string, unknown>;
    if (Object.keys(scroll).some((key) => !["dx", "dy"].includes(key))) return reject("malformed scroll");
    if (typeof scroll.dx !== "number" || typeof scroll.dy !== "number") return reject("malformed scroll");
    if (!Number.isFinite(scroll.dx) || !Number.isFinite(scroll.dy)) return reject("non-finite scroll");
    action.scroll = { dx: scroll.dx, dy: scroll.dy };
  }
  if (body.option !== undefined) {
    const option = boundedString(body.option, COMPUTER_MAX_LABEL_CHARS);
    if (!option) return reject("malformed select option");
    action.option = option;
  }

  // Per-kind requirements, so a missing field is refused here rather than
  // becoming a host-side rejection one round trip later.
  if (action.kind === "set_value" && action.text === undefined) return reject("set_value without text");
  if (action.kind === "press_keys" && !action.keys) return reject("press_keys without keys");
  if (action.kind === "select" && !action.option) return reject("select without an option");
  if (action.kind === "scroll" && !action.scroll) return reject("scroll without a delta");

  const note = value.note === undefined ? undefined : boundedString(value.note, MAX_NOTE_CHARS);
  if (value.note !== undefined && !note) return reject("malformed note");
  return { ok: true, answer: note ? { kind: "action", action, note } : { kind: "action", action } };
}

export type ValidationResult =
  | { ok: true; action: ComputerAction; node?: ComputerNode }
  | { ok: false; reason: string };

/**
 * Bind an answer to the observation it was produced from.
 *
 * The model may only name elements it was just shown, and may only ask for an
 * action that element actually offers. A coordinate is attached to the basis of
 * the inspection it came from here, rather than being carried by the model, so
 * the model cannot claim a geometry the host never measured.
 */
export function validateAnswerAction(
  action: ComputerAction,
  inspection: ComputerInspection,
): ValidationResult {
  if (inspection.secureInput) return { ok: false, reason: "secure input is active" };
  const next: ComputerAction = { ...action };
  let node: ComputerNode | undefined;
  if (action.uid) {
    node = inspection.nodes.find((candidate) => candidate.uid === action.uid);
    if (!node) return { ok: false, reason: "the element is not in the current observation" };
    if (!node.enabled) return { ok: false, reason: "the element is disabled" };
    if (action.kind === "set_value") {
      if (!node.hasValue) return { ok: false, reason: "the element holds no value" };
    } else if (action.kind !== "press_keys" && !node.actions.includes(action.kind)) {
      return { ok: false, reason: "the element does not offer that action" };
    }
  }
  if (action.point) {
    if (!inspection.bounds) return { ok: false, reason: "the scope has no measured bounds" };
    const { width, height } = inspection.bounds;
    if (action.point.x < 0 || action.point.y < 0 || action.point.x > width || action.point.y > height) {
      return { ok: false, reason: "the point is outside the scope" };
    }
    // The basis is the host's own measurement, never the model's claim.
    next.basis = { revision: inspection.revision, bounds: inspection.bounds };
  }
  return { ok: true, action: next, node };
}

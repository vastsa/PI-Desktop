/**
 * The composer draft as plugins see and write it
 * (`docs/plugin-plan/render/draft/`). Pure, so the bridge and logic tests
 * share it.
 *
 * A plugin's view is the draft's text with every chip replaced by one
 * `PLUGIN_DRAFT_MARK_CHAR`, matched in order by `marks`. A literal mark char
 * the user typed reads as U+FFFD, so the view never has more mark chars than
 * marks. Only the caller's own marks show their `send` text.
 */
import {
  PLUGIN_DRAFT_MARK_CHAR,
  PLUGIN_DRAFT_MAX_MARKS,
  type PluginDraftMark,
} from "@pi-desktop/plugin-sdk";
import type { ComposerFileReference } from "../model";
import { createPluginMark } from "./plugin-marks";

/** The draft of the composer taking input, as its own state holds it. */
export type LiveDraft = {
  /** The composer draft cache key: the session's, or home's. */
  readonly draftKey: string;
  /** The owning session, `""` on home. */
  readonly sessionId: string;
  /** The draft text, chips as their tokens. */
  readonly text: string;
  /** Every reference the composer holds, other sessions' included. */
  readonly references: readonly ComposerFileReference[];
};

/** A new mark or an existing chip, already checked against the mark limits. */
export type DraftMarkInput = { readonly id: string } | { readonly label: string; readonly send: string };

export type DraftReplacement = {
  readonly text: string;
  readonly references: ComposerFileReference[];
};

export type DraftRefusal = {
  readonly code: "PLUGIN_ACTION_INVALID_PAYLOAD" | "PLUGIN_DRAFT_ANCHOR";
  readonly message: string;
};

const REPLACEMENT_CHAR = "\uFFFD";

/** The draft's own references: those of its session. */
export function draftReferences(draft: LiveDraft): ComposerFileReference[] {
  return draft.references.filter((reference) => reference.sessionId === draft.sessionId);
}

/** The draft's chips by token. */
function chipsByToken(draft: LiveDraft): Map<string, ComposerFileReference> {
  const chips = new Map<string, ComposerFileReference>();
  for (const reference of draftReferences(draft)) {
    if (reference.token && draft.text.includes(reference.token)) chips.set(reference.token, reference);
  }
  return chips;
}

/**
 * What changes the draft's generation: the draft switching, its text, and
 * any of its references, detached images and fold counts included.
 */
export function draftSignature(draft: LiveDraft | null): string {
  if (!draft) return "";
  const references = draftReferences(draft).map((reference) => [
    reference.id,
    reference.token ?? "",
    reference.name,
    reference.plugin?.kind === "fold" ? reference.plugin.count : 0,
  ]);
  return JSON.stringify([draft.draftKey, draft.text, references]);
}

function markOf(reference: ComposerFileReference, pluginId: string): PluginDraftMark {
  const part = reference.plugin;
  if (part?.kind === "mark") {
    return {
      id: reference.id,
      kind: "plugin",
      label: reference.name,
      pluginId: part.pluginId,
      ...(part.pluginId === pluginId ? { send: part.send } : {}),
    };
  }
  if (part?.kind === "fold") {
    return { id: reference.id, kind: "fold", label: reference.name, count: part.count };
  }
  return { id: reference.id, kind: "host", label: reference.name };
}

/** `pluginId`'s view of the draft. */
export function pluginDraftView(
  draft: LiveDraft,
  pluginId: string,
): { text: string; marks: PluginDraftMark[] } {
  const chips = chipsByToken(draft);
  const marks: PluginDraftMark[] = [];
  let text = "";
  for (const char of draft.text) {
    const chip = chips.get(char);
    if (chip) {
      chips.delete(char);
      marks.push(markOf(chip, pluginId));
      text += PLUGIN_DRAFT_MARK_CHAR;
    } else {
      text += char === PLUGIN_DRAFT_MARK_CHAR ? REPLACEMENT_CHAR : char;
    }
  }
  return { text, marks };
}

/** Whether `text` holds one of the draft's chip tokens. */
export function holdsDraftChip(draft: LiveDraft, text: string): boolean {
  for (const token of chipsByToken(draft).keys()) if (text.includes(token)) return true;
  return false;
}

/**
 * The draft `pluginId` asks for: `text` with its i-th mark char taken by
 * `marks[i]`, an existing chip by id or a new mark of the caller. Refused
 * when an id is not a chip of the draft or is used twice, when a host chip or
 * the fold is left out (anchor), or when more than `PLUGIN_DRAFT_MAX_MARKS`
 * plugin marks would show. References without a chip (detached images) and
 * other sessions' references are kept as they are.
 */
export function planDraftReplacement(
  draft: LiveDraft,
  pluginId: string,
  text: string,
  marks: readonly DraftMarkInput[],
): DraftReplacement | DraftRefusal {
  const invalid = (message: string): DraftRefusal => ({
    code: "PLUGIN_ACTION_INVALID_PAYLOAD",
    message,
  });
  if (holdsDraftChip(draft, text)) return invalid("the text holds a chip token of the draft");
  const chips = [...chipsByToken(draft).values()];
  const byId = new Map(chips.map((chip) => [chip.id, chip]));
  const placed: ComposerFileReference[] = [];
  for (const input of marks) {
    if ("id" in input) {
      const chip = byId.get(input.id);
      if (!chip) return invalid(`no mark ${JSON.stringify(input.id)} in the draft, or it is used twice`);
      byId.delete(input.id);
      placed.push(chip);
    } else {
      placed.push(createPluginMark({ pluginId, ...input }, draft.sessionId));
    }
  }
  const dropped = [...byId.values()];
  const anchor = dropped.find((chip) => chip.plugin?.kind !== "mark");
  if (anchor) {
    return {
      code: "PLUGIN_DRAFT_ANCHOR",
      message: `the replacement drops the host chip ${JSON.stringify(anchor.name)}`,
    };
  }
  if (placed.filter((chip) => chip.plugin?.kind === "mark").length > PLUGIN_DRAFT_MAX_MARKS) {
    return invalid(`a draft shows at most ${PLUGIN_DRAFT_MAX_MARKS} plugin marks`);
  }
  let index = 0;
  let next = "";
  for (const char of text) {
    next += char === PLUGIN_DRAFT_MARK_CHAR ? (placed[index++]?.token ?? "") : char;
  }
  const replaced = new Set(chips.map((chip) => chip.id));
  const kept = draft.references.filter(
    (reference) => reference.sessionId !== draft.sessionId || !replaced.has(reference.id),
  );
  const created = placed.filter((chip) => !replaced.has(chip.id));
  const reused = placed.filter((chip) => replaced.has(chip.id));
  return { text: next, references: [...kept, ...reused, ...created] };
}

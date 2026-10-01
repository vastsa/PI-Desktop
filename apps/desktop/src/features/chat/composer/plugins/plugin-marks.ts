/**
 * Plugin marks in the composer draft (`docs/plugin-plan/ui/composer/`,
 * `docs/plugin-plan/render/draft/`).
 *
 * A mark is an atomic chip backed by a composer file reference with a
 * `plugin` part: it shows its label and sends its `send` text in its place.
 * One draft shows at most `PLUGIN_DRAFT_MAX_MARKS` of them; every mark past
 * that joins a single fold chip `⧉ +N` at the place of the first one, which
 * sends all of their texts. The fold is the host's, so it survives whatever
 * any single plugin does.
 */
import { PLUGIN_DRAFT_MAX_MARKS } from "@pi-desktop/plugin-sdk";
import { createFileReference, isPluginMark, nextChipToken } from "../editor";
import type { ComposerFileReference } from "../model";

export type PluginMarkInput = {
  readonly pluginId: string;
  readonly label: string;
  readonly send: string;
};

/** The fold chip's label for `count` folded marks. */
export function foldLabel(count: number): string {
  return `\u29C9 +${count}`;
}

/** References whose chip is in `text`, in the order their chips appear. */
export function liveChipReferences<T extends { token?: string }>(
  references: readonly T[],
  text: string,
): T[] {
  const byToken = new Map<string, T>();
  for (const reference of references) if (reference.token) byToken.set(reference.token, reference);
  const live: T[] = [];
  for (const char of Array.from(text)) {
    const reference = byToken.get(char);
    if (reference) {
      live.push(reference);
      byToken.delete(char);
    }
  }
  return live;
}

/** A new mark reference with a fresh chip token. */
export function createPluginMark(mark: PluginMarkInput, sessionId: string): ComposerFileReference {
  return createFileReference("", mark.label, sessionId, {
    kind: "file",
    token: nextChipToken(),
    plugin: { kind: "mark", pluginId: mark.pluginId, send: mark.send },
  });
}

export type PluginMarkPlacement = {
  /** The session's references with the mark in them. */
  readonly references: ComposerFileReference[];
  /**
   * The chip token to put where the mark goes, or `null` when the mark joined
   * the fold already in the draft and nothing new goes into the text.
   */
  readonly token: string | null;
};

/**
 * Add a mark to a draft whose text is `text` and whose references are
 * `references` (one session's). Under the limit the mark is a chip of its
 * own; at the limit it opens the fold, past it it joins the fold.
 */
export function placePluginMark(
  references: readonly ComposerFileReference[],
  text: string,
  mark: PluginMarkInput,
  sessionId: string,
): PluginMarkPlacement {
  const live = liveChipReferences(references, text).filter(isPluginMark);
  const fold = live.find((reference) => reference.plugin?.kind === "fold");
  if (fold?.plugin?.kind === "fold") {
    const count = fold.plugin.count + 1;
    const joined: ComposerFileReference = {
      ...fold,
      name: foldLabel(count),
      plugin: { ...fold.plugin, count, send: `${fold.plugin.send} ${mark.send}` },
    };
    return {
      references: references.map((reference) => (reference === fold ? joined : reference)),
      token: null,
    };
  }
  if (live.length < PLUGIN_DRAFT_MAX_MARKS) {
    const created = createPluginMark(mark, sessionId);
    return { references: [...references, created], token: created.token ?? null };
  }
  const opened = createFileReference("", foldLabel(1), sessionId, {
    kind: "file",
    token: nextChipToken(),
    plugin: { kind: "fold", pluginId: mark.pluginId, send: mark.send, count: 1 },
  });
  return { references: [...references, opened], token: opened.token ?? null };
}

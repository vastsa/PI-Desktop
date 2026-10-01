/**
 * Composer contract of the renderer extension (`docs/plugin-plan/ui/composer/`,
 * `docs/plugin-plan/render/draft/`, `docs/plugin-plan/render/attachments/`).
 *
 * - Triggers: a plugin owns one of the fixed symbols `@ # /` and lists items
 *   for it; the host draws the list and turns a picked item into a mark.
 * - Marks: atomic chips in the draft. A mark shows its `label` and sends its
 *   `send` text in its place.
 * - Draft: `composer.readDraft`, `composer.insertText`, `composer.replaceDraft`
 *   and the `pi.composer.subscribeDraft` push.
 * - Attachments: `attachments.add` / `list` / `remove`, content only, each
 *   plugin seeing and touching only its own.
 */

/** The symbols a plugin can own in the composer; one plugin per symbol. */
export const PLUGIN_COMPOSER_TRIGGERS = ["@", "#", "/"] as const;

export type PluginComposerTrigger = (typeof PLUGIN_COMPOSER_TRIGGERS)[number];

const FULL_WIDTH_TRIGGERS: Readonly<Record<string, PluginComposerTrigger>> = {
  "\uFF20": "@",
  "\uFF03": "#",
  "\uFF0F": "/",
};

/**
 * The trigger a symbol stands for, full-width forms folded to their ASCII
 * one, or `null` when it is not a trigger symbol.
 */
export function composerTriggerKey(value: unknown): PluginComposerTrigger | null {
  if (typeof value !== "string") return null;
  const symbol = FULL_WIDTH_TRIGGERS[value] ?? value;
  return (PLUGIN_COMPOSER_TRIGGERS as readonly string[]).includes(symbol)
    ? (symbol as PluginComposerTrigger)
    : null;
}

/** Items the host keeps from one answer of a trigger; the rest are dropped. */
export const PLUGIN_TRIGGER_MAX_ITEMS = 50;
/** How long a trigger may take to answer before its group collapses. */
export const PLUGIN_TRIGGER_TIMEOUT_MS = 2000;
/** Longest mark label, in characters. */
export const PLUGIN_MARK_LABEL_MAX_CHARS = 64;
/** Longest item detail line, in characters. */
export const PLUGIN_TRIGGER_DETAIL_MAX_CHARS = 256;
/** Largest mark `send` text, in UTF-8 bytes. */
export const PLUGIN_MARK_SEND_MAX_BYTES = 32 * 1024;
/**
 * Plugin marks one draft shows. Past it, every further mark joins one host
 * mark `⧉ +N` that keeps their send text.
 */
export const PLUGIN_DRAFT_MAX_MARKS = 8;
/** Largest `composer.replaceDraft` text, in UTF-8 bytes. */
export const PLUGIN_DRAFT_TEXT_MAX_BYTES = 256 * 1024;
/** Where a mark sits in a draft snapshot's `text`. */
export const PLUGIN_DRAFT_MARK_CHAR = "\uFFFC";
/** Largest `attachments.add` content, in bytes. */
export const PLUGIN_ATTACHMENT_MAX_BYTES = 16 * 1024 * 1024;
/** Attachments one plugin may hold in one draft. */
export const PLUGIN_ATTACHMENTS_MAX = 20;

/** What a trigger is asked for: the text typed after its symbol. */
export type PluginTriggerQuery = {
  readonly trigger: PluginComposerTrigger;
  readonly query: string;
};

/**
 * One row of a trigger's list. Picking it puts a mark in the draft that shows
 * `label` and sends `send` (`label` when omitted). `detail` is a secondary
 * line on the row only. An item breaking a limit is dropped from the list.
 */
export type PluginTriggerItem = {
  readonly label: string;
  readonly send?: string;
  readonly detail?: string;
};

/**
 * `composerTrigger`: own `trigger` (`@`, `#` or `/`, full-width forms
 * accepted). The host calls `items` as the user types after the symbol at
 * the start of a line or after whitespace, never during IME composition and
 * never for text a program wrote. A throw, a rejection or no answer within
 * `PLUGIN_TRIGGER_TIMEOUT_MS` collapses only this plugin's group.
 */
export type PluginComposerTriggerRegistration = {
  readonly slot: "composerTrigger";
  readonly trigger: string;
  readonly items: (
    query: PluginTriggerQuery,
  ) => readonly PluginTriggerItem[] | Promise<readonly PluginTriggerItem[]>;
};

/**
 * A chip in a draft snapshot, in draft order.
 * - `host`: the host's own chip (a file, a pasted file, an attachment chip).
 *   `composer.replaceDraft` must keep every one of them.
 * - `plugin`: a plugin mark. `send` is present only on the caller's own.
 * - `fold`: the `⧉ +N` mark holding the marks past `PLUGIN_DRAFT_MAX_MARKS`.
 *   `composer.replaceDraft` must keep it too, like a host chip.
 */
export type PluginDraftMark =
  | { readonly id: string; readonly kind: "host"; readonly label: string }
  | {
      readonly id: string;
      readonly kind: "plugin";
      readonly label: string;
      readonly pluginId: string;
      readonly send?: string;
    }
  | { readonly id: string; readonly kind: "fold"; readonly label: string; readonly count: number };

/**
 * The draft as plugins see it. Every chip is one `PLUGIN_DRAFT_MARK_CHAR` in
 * `text`, matched in order by `marks`. `generation` changes with every change
 * of the draft, including a switch to another session's draft.
 */
export type PluginDraftSnapshot = {
  readonly text: string;
  readonly marks: readonly PluginDraftMark[];
  readonly generation: number;
};

/** A mark in a replacement: an existing chip by `id`, or a new plugin mark. */
export type PluginDraftMarkInput =
  | { readonly id: string }
  | { readonly label: string; readonly send?: string };

/** `composer.readDraft`: no arguments. */
export type PluginReadDraftPayload = Record<string, never>;

/**
 * `composer.replaceDraft`: the whole draft at once. The i-th
 * `PLUGIN_DRAFT_MARK_CHAR` of `text` takes `marks[i]`, so their counts match.
 * Refused whole unless `expectedGeneration` is current, the composer does not
 * have focus, the call runs inside a user's input event (not a timer, a
 * network answer or a `plugin.call` reply), and every host chip is kept.
 */
export type PluginReplaceDraftPayload = {
  readonly expectedGeneration: number;
  readonly text: string;
  readonly marks?: readonly PluginDraftMarkInput[];
};

/** Draft writes answer with the draft's generation after the write. */
export type PluginDraftWriteResult = { readonly ok: true; readonly generation: number };

/**
 * `attachments.add`: content the host stages for the next message. `name`
 * carries an extension; `content` is the file itself (a string is UTF-8
 * text), never a path or URL for the host to read. The host keeps the file in
 * the draft of the session that was active when the call was made; home, with
 * no session yet, takes none.
 */
export type PluginAttachmentAddPayload = {
  readonly name: string;
  readonly mimeType: string;
  readonly content: string | ArrayBuffer | Uint8Array;
};

export type PluginAttachmentRef = { readonly id: string };

/** One of the caller's own attachments in the active session's draft. */
export type PluginAttachment = {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
};

/** `attachments.list`: no arguments. */
export type PluginAttachmentListPayload = Record<string, never>;

/** Called with the draft snapshot now and after every change; `null` when no composer takes input. */
export type PluginDraftListener = (snapshot: PluginDraftSnapshot | null) => void;

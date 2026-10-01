/**
 * Plugin-owned composer triggers (`docs/plugin-plan/ui/composer/`): where a
 * trigger is active in the draft, and what of a plugin's answer the host
 * keeps. Pure, so the completion hook and logic tests share it.
 */
import {
  PLUGIN_MARK_LABEL_MAX_CHARS,
  PLUGIN_MARK_SEND_MAX_BYTES,
  PLUGIN_TRIGGER_DETAIL_MAX_CHARS,
  PLUGIN_TRIGGER_MAX_ITEMS,
  PLUGIN_TRIGGER_TIMEOUT_MS,
  composerTriggerKey,
  type PluginComposerTrigger,
} from "@pi-desktop/plugin-sdk";

export type PluginTriggerMatch = {
  readonly trigger: PluginComposerTrigger;
  readonly query: string;
  /** Where the symbol sits; accepting replaces `[tokenStart, tokenEnd)`. */
  readonly tokenStart: number;
  readonly tokenEnd: number;
};

/** A row of a trigger's list the host accepted. */
export type PluginTriggerRow = {
  readonly label: string;
  readonly send: string;
  readonly detail?: string;
};

const WHITESPACE = /\s/;
/** Composer chip tokens (private use area) and the snapshot's mark stand-in. */
const RESERVED_CHARS = /[\uE000-\uF8FF\uFFFC]/;
const LINE_BREAK = /[\r\n\u2028\u2029]/;

/**
 * The plugin trigger the caret is in: a word that starts at the beginning of
 * a line or after whitespace with an owned symbol (full-width forms count)
 * and runs to the caret. A chip inside the word ends it.
 */
export function detectPluginTrigger(
  value: string,
  cursor: number,
  owned: ReadonlySet<PluginComposerTrigger>,
): PluginTriggerMatch | null {
  if (owned.size === 0 || cursor <= 0 || cursor > value.length) return null;
  let start = cursor;
  while (start > 0 && !WHITESPACE.test(value[start - 1])) start -= 1;
  if (start === cursor) return null;
  const trigger = composerTriggerKey(value[start]);
  if (!trigger || !owned.has(trigger)) return null;
  const query = value.slice(start + 1, cursor);
  if (RESERVED_CHARS.test(query)) return null;
  return { trigger, query, tokenStart: start, tokenEnd: cursor };
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * One item as the host keeps it (`send` defaulted to `label`), or `null` when
 * it breaks a limit. Marks a plugin writes into the draft pass the same test.
 */
export function sanitizeTriggerItem(item: unknown): PluginTriggerRow | null {
  if (typeof item !== "object" || item === null) return null;
  const { label, send, detail } = item as Record<string, unknown>;
  if (typeof label !== "string" || !label.trim()) return null;
  if (Array.from(label).length > PLUGIN_MARK_LABEL_MAX_CHARS) return null;
  if (RESERVED_CHARS.test(label) || LINE_BREAK.test(label)) return null;
  const sent = send === undefined ? label : send;
  if (typeof sent !== "string" || !sent.trim()) return null;
  if (RESERVED_CHARS.test(sent) || utf8Bytes(sent) > PLUGIN_MARK_SEND_MAX_BYTES) return null;
  if (detail === undefined) return { label, send: sent };
  if (typeof detail !== "string") return null;
  if (Array.from(detail).length > PLUGIN_TRIGGER_DETAIL_MAX_CHARS) return null;
  return { label, send: sent, detail };
}

/**
 * The rows the host keeps of a trigger's answer: items breaking a limit are
 * dropped one by one, the rest cut at `PLUGIN_TRIGGER_MAX_ITEMS`. An answer
 * that is no array is no answer (`null`).
 */
export function sanitizeTriggerItems(answer: unknown): PluginTriggerRow[] | null {
  if (!Array.isArray(answer)) return null;
  const rows: PluginTriggerRow[] = [];
  for (const item of answer) {
    const row = sanitizeTriggerItem(item);
    if (row) rows.push(row);
    if (rows.length === PLUGIN_TRIGGER_MAX_ITEMS) break;
  }
  return rows;
}

/**
 * Ask a trigger for its items. Resolves with the kept rows, or `null` when
 * the provider throws, rejects, answers with no array or not within
 * `timeoutMs`; never rejects. A failure is logged, since the group it
 * collapses is the only trace the user sees.
 */
export function askPluginTrigger(
  provider: (query: { trigger: PluginComposerTrigger; query: string }) => unknown,
  match: Pick<PluginTriggerMatch, "trigger" | "query">,
  label: string,
  timeoutMs = PLUGIN_TRIGGER_TIMEOUT_MS,
): Promise<PluginTriggerRow[] | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (rows: PluginTriggerRow[] | null, why?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (rows === null) console.warn(`[plugin-slot] ${label} composerTrigger failed`, why);
      resolve(rows);
    };
    const timer = setTimeout(
      () => finish(null, new Error(`no answer within ${timeoutMs} ms`)),
      timeoutMs,
    );
    try {
      Promise.resolve(provider({ trigger: match.trigger, query: match.query })).then(
        (answer) => {
          try {
            const rows = sanitizeTriggerItems(answer);
            finish(rows, rows ? undefined : new Error("the answer is not an array"));
          } catch (error) {
            finish(null, error);
          }
        },
        (error: unknown) => finish(null, error),
      );
    } catch (error) {
      finish(null, error);
    }
  });
}

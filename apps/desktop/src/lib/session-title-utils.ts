import i18n from "i18next";
import { splitPluginFences } from "./block-renderer.ts";

/**
 * Every shipped `chat.untitledTask` / `nav.newChat` label plus their historical
 * forms, so a placeholder is recognized regardless of the active locale. Kept in
 * sync with `PLACEHOLDER_TITLES` in `crates/host-core/src/sessions.rs`.
 */
const LEGACY_DEFAULT_TITLES = new Set([
  "new task",
  "new chat",
  "新建任务",
  "新对话",
  "新建任務",
  "新對話",
  "새 작업",
  "새 채팅",
  "tarefa sem título",
  "nova conversa",
  "yeni görev",
  "yeni sohbet",
]);
/** Sidebar/topbar title budget for the local first-prompt fallback. */
const PROMPT_FALLBACK_TITLE_LENGTH = 48;
export function untitledTaskTitle(): string {
  return translatedTitle("chat.untitledTask");
}

/// A missing or not-yet-initialized catalog must never break the composer
/// path that checks whether a session still carries a placeholder title.
function translatedTitle(key: string): string {
  const value = i18n.t(key);
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isDefaultSessionTitle(title?: string | null): boolean {
  const trimmed = (title || "").trim().toLowerCase();
  return (
    !trimmed ||
    LEGACY_DEFAULT_TITLES.has(trimmed) ||
    trimmed === untitledTaskTitle() ||
    trimmed === translatedTitle("nav.newChat")
  );
}

/** A referenced chat block (#446/#447 and `pi.session-mentions`), bare or inside a fence. */
const REFERENCED_CHAT = /<referenced-chat\b[^>]*>[\s\S]*?<\/referenced-chat>/g;
const REFERENCED_CHAT_TITLE = /<referenced-chat\b[^>]*?\stitle="([^"]*)"/g;
/** The #447 envelope's own lines around its blocks. */
const REFERENCE_ENVELOPE_LINE =
  /^(?:# Referenced chats:|## Current request:|The following is historical Q&A from other conversations\b.*)[ \t]*$/gm;

function unescapeAttribute(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/**
 * The words the user typed in a prompt, for naming its session: fences a
 * plugin wrote (tagged `<pluginId>:lang`, the shape a `blockRenderer` claims)
 * and referenced chat blocks (bare, or a #447 envelope) are attached
 * material, not the request. The titles of the chats referenced come along
 * for a prompt that is nothing but references. The prompt itself is unchanged.
 */
export function promptTitleText(userPrompt: string): { text: string; referencedTitles: string[] } {
  const attached: string[] = [];
  let text = splitPluginFences(userPrompt)
    .map((run) => {
      if (run.kind === "text") return run.text;
      attached.push(run.source);
      return "\n";
    })
    .join("");
  text = text.replace(REFERENCED_CHAT, (block) => {
    attached.push(block);
    return "\n";
  });
  if (attached.length > 0) text = text.replace(REFERENCE_ENVELOPE_LINE, "");
  const referencedTitles = attached.flatMap((block) =>
    Array.from(block.matchAll(REFERENCED_CHAT_TITLE), (match) => unescapeAttribute(match[1]).trim()),
  ).filter(Boolean);
  return { text, referencedTitles };
}

/** "Reference: <title>" in the UI language, an untitled session named as the sidebar names it. */
export function referencedSessionTitle(title: string): string {
  const name = isDefaultSessionTitle(title) ? i18n.t("chat.untitledTask") : title;
  const value = i18n.t("chat.referencedSessionTitle", {
    title: name,
    interpolation: { escapeValue: false },
  });
  return typeof value === "string" && value !== "chat.referencedSessionTitle" ? value : name;
}

/**
 * Deterministic title for the first prompt of a still-untitled session.
 * The host keeps the session eligible for an automatic plugin title, so this
 * text is only the immediate, offline-readable fallback. It is made of the
 * user's own words (`promptTitleText`); a prompt that only references other
 * chats is named after the first of them, and an empty one gets `emptyTitle`.
 */
export function promptFallbackSessionTitle(
  userPrompt: string,
  emptyTitle: string,
  referenceTitle: (title: string) => string = referencedSessionTitle,
): string {
  const { text, referencedTitles } = promptTitleText(userPrompt);
  const own = text.trim().replace(/\s+/g, " ").slice(0, PROMPT_FALLBACK_TITLE_LENGTH);
  if (own) return own;
  const referenced = referencedTitles[0];
  return referenced
    ? referenceTitle(referenced).trim().replace(/\s+/g, " ").slice(0, PROMPT_FALLBACK_TITLE_LENGTH) || emptyTitle
    : emptyTitle;
}

import i18n from "i18next";

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

/**
 * Deterministic title for the first prompt of a still-untitled session.
 * The host keeps the session eligible for an automatic plugin title, so this
 * text is only the immediate, offline-readable fallback.
 */
export function promptFallbackSessionTitle(
  userPrompt: string,
  emptyTitle: string,
): string {
  return (
    userPrompt.trim().replace(/\s+/g, " ").slice(0, PROMPT_FALLBACK_TITLE_LENGTH) ||
    emptyTitle
  );
}

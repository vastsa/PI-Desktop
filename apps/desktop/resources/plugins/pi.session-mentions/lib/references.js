const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ID_PATTERN = new RegExp(`^${UUID}$`, "i");

/** Local desktop sessions are UUIDs; other namespaces (e.g. `native-pi:`) are not advertised. */
export function normalizeSessionId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return ID_PATTERN.test(id) ? id.toLowerCase() : null;
}

export const isZh = (lang) => String(lang ?? "").toLowerCase().startsWith("zh");

/** The host's placeholder titles for an untitled session (its `isDefaultSessionTitle`). */
const UNTITLED = new Set(["new task", "new chat", "新建任务", "新对话", "新建任務", "新對話", "새 작업", "새 채팅",
  "tarefa sem título", "nova conversa", "yeni görev", "yeni sohbet"]);

/** A session title as the app shows it: a placeholder reads as the UI language's untitled label. */
export function displayTitle(title, lang) {
  const text = String(title ?? "").trim();
  return text && UNTITLED.has(text.toLowerCase()) ? (isZh(lang) ? "新建任务" : "New task") : text;
}

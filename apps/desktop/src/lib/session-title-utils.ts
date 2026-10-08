import i18n from "i18next";

const LEGACY_DEFAULT_TITLES = new Set(["new task", "new chat", "新建任务", "新对话"]);
export function untitledTaskTitle(): string {
  return i18n.t("chat.untitledTask");
}

export function isDefaultSessionTitle(title?: string | null): boolean {
  const trimmed = (title || "").trim().toLowerCase();
  return (
    !trimmed ||
    LEGACY_DEFAULT_TITLES.has(trimmed) ||
    trimmed === untitledTaskTitle().toLowerCase() ||
    trimmed === i18n.t("nav.newChat").toLowerCase()
  );
}

import i18n from "i18next";
import type { AppState } from "../app-state";
import type { SessionRuntime } from "./session-runtime";
import type { StoreAccess } from "../slices/types";
import { api } from "../../lib/api";

const LEGACY_DEFAULT_TITLES = new Set(["new task", "new chat", "新建任务", "新对话"]);
const SESSION_TITLE_FALLBACK_LENGTH = 48;

export function untitledTaskTitle(): string {
  return i18n.t("chat.untitledTask");
}

export function promptFallbackSessionTitle(
  userPrompt: string,
  emptyTitle: string,
): string {
  return (
    userPrompt.trim().replace(/\s+/g, " ").slice(0, SESSION_TITLE_FALLBACK_LENGTH) ||
    emptyTitle
  );
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

export type SessionTitleRuntime = {
  manualSessionTitles: Set<string>;
  triggerAutoTitleSummarization: (sessionId: string) => Promise<void>;
};

export function createSessionTitleRuntime({
  get,
  sessionRuntime,
  initialSessionMeta,
}: StoreAccess & {
  sessionRuntime: SessionRuntime;
  initialSessionMeta: AppState["sessionMeta"];
}): SessionTitleRuntime {
  const manualSessionTitles = new Set<string>();
  const summarizedSessionIds = new Set<string>();
  for (const [sessionId, meta] of Object.entries(initialSessionMeta)) {
    if (meta.manualTitle) manualSessionTitles.add(sessionId);
  }

  async function triggerAutoTitleSummarization(sessionId: string): Promise<void> {
    if (!sessionId) return;
    if (manualSessionTitles.has(sessionId)) return;
    if (summarizedSessionIds.has(sessionId)) return;

    const state = get();
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!session) return;
    const messages =
      sessionId === state.activeSessionId
        ? state.messages
        : sessionRuntime.sessionTranscriptCache.get(sessionId) ?? [];
    const firstUser = messages.find((message) => message.role === "user");
    if (!firstUser?.content) return;
    if (
      state.sessionMeta[sessionId]?.manualTitle ||
      (!isDefaultSessionTitle(session.title) &&
        session.title.trim() !== promptFallbackSessionTitle(firstUser.content, ""))
    ) {
      return;
    }
    const firstAssistant = messages.find(
      (message) =>
        message.role === "assistant" &&
        typeof message.content === "string" &&
        message.content.trim(),
    );

    summarizedSessionIds.add(sessionId);
    try {
      const result = await api.summarizeSessionTitle({
        sessionId,
        userPrompt: firstUser.content,
        assistantReply:
          typeof firstAssistant?.content === "string"
            ? firstAssistant.content
            : undefined,
      });
      const nextTitle = result?.title?.trim();
      if (nextTitle && !manualSessionTitles.has(sessionId)) {
        await api.renameSession(sessionId, nextTitle);
        await get().refreshSessions();
      }
    } catch {
      // Non-fatal: keep the current truncated prompt title as fallback.
    }
  }

  return { manualSessionTitles, triggerAutoTitleSummarization };
}

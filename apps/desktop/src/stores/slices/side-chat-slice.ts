import i18n from "i18next";
import type { AppState } from "../app-state";
import type { StoreAccess } from "./types";
import { api } from "../../lib/api";
import { forkedSessionMessages } from "../../lib/session-fork";
import { registerSideChat, removeSideChat, sideChatEntry, sideChatWorkPanelTab, sideChatsForParent } from "../../lib/side-chat";
import type { SessionSliceDependencies } from "./session-slice";

export function createSideChatSlice({ get, set, commitForkedSession, withoutRecordKey }: StoreAccess &
  Pick<SessionSliceDependencies, "commitForkedSession" | "withoutRecordKey">): Pick<AppState,
  "openSideChat" | "closeSideChat" | "addSideChatReplyToMain" | "abortSession"> {
  const sideChatOpens = new Map<string, Promise<string | null>>();
  return {
    openSideChat: async (messageId) => {
      const state = get();
      const parentSessionId = state.activeSessionId;
      if (!parentSessionId) return null;
      // One fork per anchored message: two clicks before the host answers must
      // share one round trip, not create two children for the same anchor (D-LOCAL-message-quotes).
      const openKey = `${parentSessionId}:${messageId}`;
      const inFlight = sideChatOpens.get(openKey);
      if (inFlight) return inFlight;
      const request = (async () => {
        const message = state.messages.find(
          (candidate) => candidate.id === messageId,
        );
        const parent = state.sessions.find(
          (session) => session.id === parentSessionId,
        );
        if (!message || !parent) return null;
        // Re-opening an existing side chat brings its panel back instead of
        // forking a second child from the same answer.
        const existing = sideChatsForParent(state.sideChats, parentSessionId).find(
          (chat) => chat.anchorMessageId === messageId,
        );
        if (existing) {
          // Dock into the parent's own context: the fork may resolve after the
          // user switched conversations, and the panel must not follow them.
          get().openWorkPanelTabForSession(
            parentSessionId,
            sideChatWorkPanelTab(existing.sessionId),
          );
          return existing.sessionId;
        }
        // The host refuses a fork while the source turn is still running.
        if (state.runningSessions[parentSessionId]) return null;
        const sourceTitle = parent.title.trim() || i18n.t("chat.untitledTask");
        try {
          const result = await api.forkSession(
            parentSessionId,
            i18n.t("sideChat.sessionTitle", { title: sourceTitle }),
            messageId,
          );
          const child = result.session;
          const messages = forkedSessionMessages(child);
          // The child is durable on the host now. Recording it is what puts it in
          // the session list; activation is what is deliberately skipped, so the
          // main conversation keeps its transcript, its draft, and its run state.
          commitForkedSession(child, { activate: false, clearError: true });
          set((current) => ({
            sideChats: registerSideChat(
              current.sideChats,
              sideChatEntry({
                sessionId: child.id,
                parentSessionId,
                title: child.title,
                anchorMessageId: messageId,
              }),
            ),
            sideChatTranscripts: {
              ...current.sideChatTranscripts,
              [child.id]: messages,
            },
          }));
          get().openWorkPanelTabForSession(
            parentSessionId,
            sideChatWorkPanelTab(child.id),
          );
          return child.id;
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : String(error),
            errorCode: (error as { code?: string })?.code ?? null,
          });
          return null;
        }
      })();
      sideChatOpens.set(openKey, request);
      try {
        return await request;
      } finally {
        if (sideChatOpens.get(openKey) === request) sideChatOpens.delete(openKey);
      }
    },
    closeSideChat: (sessionId) => {
      if (!sessionId) return;
      const tabId = sideChatWorkPanelTab(sessionId).id;
      if (get().workPanelTabs.some((tab) => tab.id === tabId)) {
        get().closeWorkPanelTab(tabId);
      }
      set((state) => {
        const sideChats = removeSideChat(state.sideChats, sessionId);
        if (sideChats === state.sideChats) return {};
        // The durable child session stays in the sidebar and in search; only the
        // renderer's panel projection and its tab go away.
        const workPanelContexts = Object.fromEntries(
          Object.entries(state.workPanelContexts).map(([id, context]) => {
            if (!context.tabs.some((tab) => tab.id === tabId)) return [id, context];
            const tabs = context.tabs.filter((tab) => tab.id !== tabId);
            return [
              id,
              {
                ...context,
                tabs,
                activeTabId:
                  context.activeTabId === tabId
                    ? tabs.at(-1)?.id ?? null
                    : context.activeTabId,
              },
            ];
          }),
        );
        return {
          sideChats,
          sideChatTranscripts: withoutRecordKey(
            state.sideChatTranscripts,
            sessionId,
          ),
          workPanelContexts,
        };
      });
    },

    addSideChatReplyToMain: (sessionId) => {
      const entry = get().sideChats[sessionId];
      if (!entry) return;
      const messages = get().sideChatTranscripts[sessionId] ?? [];
      const answer = [...messages]
        .reverse()
        .find(
          (message) =>
            message.role === "assistant" && Boolean((message.content || "").trim()),
        );
      if (!answer) return;
      get().quoteMessageIntoComposer({ title: entry.title, text: answer.content });
    },

    abortSession: async (sessionId) => {
      if (!sessionId) return;
      try {
        await api.abort(sessionId);
      } finally {
        set((state) => ({
          isRunning:
            state.activeSessionId === sessionId ? false : state.isRunning,
          runningSessions: { ...state.runningSessions, [sessionId]: false },
        }));
      }
    },

  };
}

import i18n from "i18next";
import { create } from "zustand";
import { type SessionSummary } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { chatContextPlainText } from "../../lib/chat-context-format";
import { optimisticUserMessage, upsertLiveSessionMessage } from "../../lib/session-transcript";
import { promptAttachmentsFromDraft } from "../../stores/helpers/store-helpers";
import { useAppStore, type AppState } from "../../stores/app-store";

const EMPTY_MESSAGES: AppState["messages"] = [];

export function updateSideQuestionSummary(summary: SessionSummary): void {
  useAppStore.setState(state => {
    const parentId = summary.sideQuestion?.parentSessionId;
    const rename = (tabs: typeof state.workPanelTabs) => tabs.map(tab =>
      tab.kind === "sideQuestion" && tab.resource === summary.id ? { ...tab, label: summary.title } : tab);
    const context = parentId ? state.workPanelContexts[parentId] : undefined;
    return {
      sideQuestionSessions: { ...state.sideQuestionSessions, [summary.id]: summary },
      ...(state.activeSessionId === parentId ? { workPanelTabs: rename(state.workPanelTabs) } : {}),
      ...(context && parentId ? { workPanelContexts: { ...state.workPanelContexts, [parentId]: { ...context, tabs: rename(context.tabs) } } } : {}),
    };
  });
}

/** A composer-local projection; its actions never change the global active session. */
export function createSideQuestionComposerStore(id: string) {
  let mounted = true;
  const current = () => mounted &&
    Boolean(useAppStore.getState().sideQuestionSessions[id]);
  let sending = false;
  let configuring = false;
  const send: AppState["sendPrompt"] = async (content, draft) => {
    const state = useAppStore.getState();
    if (!current() || sending || configuring || state.runningSessions[id]) return false;
    sending = true;
    refresh();
    const optimistic = optimisticUserMessage(crypto.randomUUID(), content);
    const install = (messages: AppState["messages"]) => {
      const source = useAppStore.getState();
      const session = source.sideQuestionSessions[id];
      if (session && current()) source.retainSideQuestion({ ...session, messages, ...source.sessionHistory[id] });
    };
    install(upsertLiveSessionMessage(state.sideQuestionTranscripts[id] ?? [], optimistic));
    try {
      const session = useAppStore.getState().sideQuestionSessions[id];
      if (session.messageCount === (session.sideQuestion?.inheritedMessageCount ?? 0)) {
        const title = Array.from(chatContextPlainText(content).replace(/\s+/g, " ").trim()).slice(0, 80).join("");
        if (title) {
          const renamed = await api.renameSession(id, title);
          if (!current()) return false;
          if (!renamed.ok) throw new Error(i18n.t("sideQuestions.unavailable"));
          updateSideQuestionSummary({ ...session, title });
        }
      }
      if (!current()) return false;
      const result = await api.promptSideQuestion({ sessionId: id, content,
        attachments: promptAttachmentsFromDraft(draft?.fileReferences ?? []),
        messageId: optimistic.id, viewingSessionId: null });
      if (!result.accepted) throw new Error(i18n.t("sideQuestions.sendFailed"));
      return true;
    } catch (error) {
      if (current()) {
        install((useAppStore.getState().sideQuestionTranscripts[id] ?? []).filter(message => message.id !== optimistic.id));
        useAppStore.getState().showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
      }
      return false;
    } finally { sending = false; refresh(); }
  };
  const configure: AppState["configureActiveSession"] = async config => {
    if (!current()) return;
    if (config.mode !== "agent") throw new Error(i18n.t("sideQuestions.readOnly"));
    if (sending || configuring || useAppStore.getState().runningSessions[id]) throw new Error(i18n.t("sideQuestions.working"));
    configuring = true;
    refresh();
    try {
      const result = await api.configureSession(id, config);
      if (current()) updateSideQuestionSummary(result.session);
    } finally { configuring = false; refresh(); }
  };
  const abort: AppState["abort"] = async () => {
    if (!current()) return;
    try { await api.abort(id); }
    catch (error) { if (current()) useAppStore.getState().showToast(String(error), { variant: "error" }); }
  };
  const project = (): AppState => {
    const state = useAppStore.getState();
    const session = state.sideQuestionSessions[id];
    return { ...state,
      activeSessionId: id,
      sessions: session ? [...state.sessions, session] : state.sessions,
      messages: state.sideQuestionTranscripts[id] ?? EMPTY_MESSAGES,
      isRunning: sending || configuring || state.runningSessions[id] === true,
      composerPrefill: null,
      clearComposerPrefill: () => {},
      draftConfiguration: null,
      sendPrompt: send,
      steerPrompt: async () => false,
      configureActiveSession: configure,
      abort,
    };
  };
  const store = create<AppState>(() => project());
  const refresh = () => store.setState(project(), true);
  return { store, subscribe: () => {
    mounted = true;
    refresh();
    const unsubscribe = useAppStore.subscribe(refresh);
    return () => { mounted = false; unsubscribe(); };
  } };
}

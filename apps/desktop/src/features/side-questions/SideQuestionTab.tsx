import { useCallback, useEffect, useLayoutEffect, useRef, useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { type SessionDetail } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { useTranscriptView } from "../../hooks/use-transcript-view";
import { ChatFileSessionContext } from "../../hooks/use-verified-chat-text";
import { useFollowScroll } from "../../hooks/use-follow-scroll";
import { mergeLiveSessionMessages } from "../../lib/session-transcript";
import { sideQuestionHistoryWorkPanelTab } from "../../lib/work-panel-tabs";
import { Markdown } from "../../components/Markdown";
import { PermissionCard } from "../../components/PermissionCard";
import { IconArrowDown } from "../../components/icons";
import { Button, TooltipButton } from "../../components/ui";
import { ToolRow } from "../chat/transcript/ToolRow";
import { AssistantErrorMessage, ThinkingRow } from "../chat/transcript/shared";
import { TranscriptDisclosureProvider } from "../chat/transcript/disclosure";
import { Composer } from "../../components/Composer";
import { SideQuestionUserText } from "./SideQuestionUserText";
import { createSideQuestionComposerStore } from "./composer-store";
import { sideQuestionMessages } from "./model";
import { DeleteSideQuestionButton } from "./DeleteSideQuestionButton";
import "./side-questions.css";

export function SideQuestionTab({ id, parentId }: { id: string; parentId: string }) {
  return <TranscriptDisclosureProvider key={id}>
    <SideQuestionConversation id={id} parentId={parentId} />
  </TranscriptDisclosureProvider>;
}

function SideQuestionConversation({ id, parentId }: { id: string; parentId: string }) {
  const { t } = useTranslation();
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const running = useAppStore(state => state.runningSessions[id] === true);
  const history = useAppStore(state => state.sessionHistory[id]);
  const permissions = useAppStore(state => state.pendingPermissions[id]);
  const transcript = useTranscriptView(id);
  const inheritedCount = session?.sideQuestion?.inheritedMessageCount ?? 0;
  const messages = sideQuestionMessages(transcript.messages, inheritedCount, history?.messageStart ?? 0);
  const composer = useRef<HTMLElement>(null);
  const target = useMemo(() => createSideQuestionComposerStore(id), [id]);
  useEffect(target.subscribe, [target]);
  const composerBusy = target.store(state => state.isRunning);
  const mounted = useRef(true);
  const loadTicket = useRef(0);
  const follow = useFollowScroll();
  const current = () => mounted.current;
  const fail = (failure: unknown) => { if (current()) setError(failure instanceof Error ? failure.message : String(failure)); };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      useAppStore.setState(state => {
        const { [id]: _released, ...rest } = state.sideQuestionTranscripts;
        return { sideQuestionTranscripts: rest };
      });
    };
  }, [id]);
  const ready = Boolean(session);
  useEffect(() => {
    if (ready && current() && useAppStore.getState().activeWorkPanelTabId === `side-question:${id}`) composer.current?.querySelector<HTMLElement>('[role="textbox"]')?.focus();
  }, [ready, id]);

  const load = useCallback(async () => {
    const ticket = ++loadTicket.current;
    const known = useAppStore.getState().sideQuestionSessions[id];
    try {
      const result = await api.getSession(id, { messageLimit: 100, contentLimit: 64 * 1024 });
      if (!current() || ticket !== loadTicket.current) return;
      if (!result.session?.sideQuestion || result.session.id !== id || result.session.sideQuestion.parentSessionId !== parentId) throw new Error(t("sideQuestions.unavailable"));
      const state = useAppStore.getState();
      const latest = state.sideQuestionSessions[id];
      const loaded = latest && latest !== known
        ? { ...result.session, ...latest, messages: result.session.messages } : result.session;
      setSession(loaded);
      // An in-flight metadata read must never replace the live side transcript.
      if (!state.runningSessions[id] || !state.sideQuestionTranscripts[id]) state.retainSideQuestion(loaded);
      await state.restorePendingInteractive(id);
    } catch (failure) { fail(failure); }
  }, [id, parentId, t]);
  useEffect(() => { void load(); }, [load, running]);
  useLayoutEffect(() => { follow.scheduleFollowScroll(); }, [transcript.messages, follow.scheduleFollowScroll]);

  const older = async () => {
    if (!session || loadingOlder || !history || history.messageStart <= inheritedCount) return;
    const top = follow.scrollRef.current?.scrollTop ?? 0;
    const height = follow.scrollRef.current?.scrollHeight ?? 0;
    setLoadingOlder(true);
    try {
      const result = await api.getSession(id, { messageBefore: history.messageStart, messageLimit: 100, contentLimit: 64 * 1024 });
      if (!current() || !result.session) return;
      useAppStore.getState().retainSideQuestion({ ...result.session,
        messages: mergeLiveSessionMessages(result.session.messages, useAppStore.getState().sideQuestionTranscripts[id] ?? []) });
      requestAnimationFrame(() => { if (current() && follow.scrollRef.current) follow.scrollRef.current.scrollTop = top + follow.scrollRef.current.scrollHeight - height; });
    } catch (failure) { fail(failure); }
    finally { if (current()) setLoadingOlder(false); }
  };
  return <section className="side-question-conversation" aria-label={t("sideQuestions.title")}>
    <div className="side-question-toolbar">
      <span title={session?.sideQuestion?.parentTitle}>{t("sideQuestions.source", { title: session?.sideQuestion?.parentTitle ?? "" })}</span>
      <div className="side-question-toolbar-actions"><Button variant="ghost" onClick={() => useAppStore.getState().openWorkPanelTabForSession(parentId, sideQuestionHistoryWorkPanelTab(parentId))}>{t("sideQuestions.history")}</Button>
      <DeleteSideQuestionButton id={id} disabled={!session || composerBusy} /></div>
    </div>
    {error ? <div className="side-question-error" role="alert">{error}{!session ? <Button variant="ghost" onClick={() => void load()}>{t("common.retry")}</Button> : null}</div> : null}
    <div className="side-question-scroll" ref={follow.scrollRef} onScroll={follow.handleScroll} role="log" aria-live="polite" tabIndex={0}>
      <ChatFileSessionContext.Provider value={{ id, projectPath: session?.projectPath }}>
      <div ref={follow.contentRef}>
        {history && history.messageStart > inheritedCount ? <Button variant="ghost" disabled={loadingOlder} onClick={() => void older()}>{t("sideQuestions.loadMore")}</Button> : null}
        {session ? messages.map(message => message.role === "tool" ? <ToolRow key={message.id} message={message} /> :
          <div key={message.id} className={`message-row ${message.role}`} data-message-id={message.id}>
            <div className="message-col"><div className="message-bubble">
              {message.thinking ? <ThinkingRow message={message} streaming={running && message.status === "streaming"} /> : null}
              {message.role === "user" ? <div className="message-user-text selectable"><SideQuestionUserText content={message.content} /></div> : <div className="prose-chat selectable"><Markdown source={message.content} /></div>}
              {message.error ? <AssistantErrorMessage message={message} /> : null}
            </div></div>
          </div>) : null}
        {running ? <div className="side-question-working" role="status">{t("sideQuestions.working")}</div> : null}
      </div>
      </ChatFileSessionContext.Provider>
    </div>
    {follow.showJump ? <TooltipButton className="side-question-jump" tooltip={t("chat.scrollToBottom")} ariaLabel={t("chat.scrollToBottom")} onClick={follow.jumpToLatest}><IconArrowDown size={14} /></TooltipButton> : null}
    {permissions?.[0] ? <PermissionCard permission={permissions[0]} queued={permissions.length - 1} restoreFocus={false} /> : null}
    <footer ref={composer} className="side-question-composer">
      {session ? <Composer store={target.store} /> : null}
    </footer>
  </section>;
}

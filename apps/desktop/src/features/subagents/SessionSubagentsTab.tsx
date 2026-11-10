import type { UiMessage } from "@pi-desktop/shared";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconBot, IconChevronLeft, IconCopy, IconRefresh } from "../../components/icons";
import { Badge, Button, Input, SegmentedControl, TooltipButton } from "../../components/ui";
import { SubagentTranscriptTab } from "../../components/workpanel/SubagentTranscriptTab";
import { SubagentStopButton } from "../chat/transcript/SubagentStopButton";
import { useAppStore } from "../../stores/app-store";
import { buildSessionSubagents, filterSessionSubagents, mergeSubagentMessages,
  canControlSubagents, type SessionSubagent, type SubagentFilter } from "./model";
import { useSubagentIndex, useSubagentTranscriptHistory } from "./use-subagent-history";
import { SubagentCreateForm } from "./SubagentCreateForm";

function Outcome({ agent }: { agent: SessionSubagent }) {
  const { t } = useTranslation();
  const tone = agent.status === "completed" ? "success"
    : agent.status === "failed" || agent.status === "denied" ? "error"
      : agent.status === "running" ? "neutral" : "warning";
  return <Badge tone={tone}>{t(agent.creating ? "chat.subagentCreating" : `chat.subagentStatus.${agent.status}`)}</Badge>;
}

function HistoryError({ error, retry }: { error: Error | null; retry: () => void }) {
  const { t } = useTranslation();
  if (!error) return null;
  return <div className="session-subagents-error" role="alert">
    <span>{t("panel.sessionSubagents.loadFailed")}</span>
    <details><summary>{t("panel.sessionSubagents.errorDetails")}</summary><p>{error.message}</p></details>
    <Button size="sm" onClick={retry}>{t("panel.sessionSubagents.retry")}</Button>
  </div>;
}

function SubagentDetail({ sessionId, agent, live, onBack }: {
  sessionId: string; agent: SessionSubagent; live: readonly UiMessage[]; onBack: () => void;
}) {
  const { t } = useTranslation();
  const history = useSubagentTranscriptHistory(sessionId, agent.calls);
  const messages = useMemo(() => {
    const own = new Set(agent.calls.map((call) => call.toolCallId ?? call.id));
    const liveRows = live.filter((message) => message.parentToolCallId
      ? own.has(message.parentToolCallId) : own.has(message.toolCallId ?? message.id));
    return mergeSubagentMessages(mergeSubagentMessages(agent.calls, history.messages), liveRows);
  }, [agent.calls, history.messages, live]);
  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(agent.delegationId);
      if (useAppStore.getState().activeSessionId === sessionId) {
        useAppStore.getState().showToast(t("chat.copied"));
      }
    } catch (error) {
      if (useAppStore.getState().activeSessionId === sessionId) {
        useAppStore.getState().showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
      }
    }
  };
  return <section className="session-subagents session-subagents-detail" aria-label={t("panel.sessionSubagents.title")}>
    <header className="session-subagents-header">
      <TooltipButton type="button" tooltip={t("panel.sessionSubagents.back")}
        ariaLabel={t("panel.sessionSubagents.back")} onClick={onBack}><IconChevronLeft size={16} /></TooltipButton>
      <div className="session-subagents-heading"><h2>{agent.agentName || t("chat.subagentUnnamed")}</h2>
        <p className="selectable">{agent.modelId || agent.description}</p></div>
      <Outcome agent={agent} />
      <TooltipButton type="button" tooltip={t("panel.sessionSubagents.copyId")}
        ariaLabel={t("panel.sessionSubagents.copyId")} disabled={agent.creating}
        onClick={() => void copyId()}><IconCopy size={15} /></TooltipButton>
    </header>
    <HistoryError error={history.error} retry={history.reload} />
    {history.loading && <p className="session-subagents-notice" role="status">{t("common.loading")}</p>}
    {history.hasMore && <Button className="session-subagents-more" size="sm" disabled={history.loading}
      onClick={history.loadMore}>{t("panel.sessionSubagents.moreActivity")}</Button>}
    <SubagentTranscriptTab delegationId={agent.delegationId} messages={messages}
      draftKey={agent.key} ready={!agent.creating} onDelivered={history.reload}
      running={agent.status === "running" && !agent.creating} />
  </section>;
}

/** A discoverable, session-scoped directory, separate from global agent definitions. */
export function SessionSubagentsTab() {
  const { t } = useTranslation();
  const sessionId = useAppStore((state) => state.activeSessionId);
  const session = useAppStore((state) => state.sessions.find((entry) => entry.id === sessionId));
  const allowed = canControlSubagents(session);
  const live = useAppStore((state) => state.messages);
  const running = useAppStore((state) => sessionId ? state.runningSessions[sessionId] ?? false : false);
  const index = useSubagentIndex(sessionId);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SubagentFilter>("all");
  const [selection, setSelection] = useState<{ sessionId: string; callId: string } | null>(null);
  const [creationSession, setCreationSession] = useState<string | null>(null);
  const agents = useMemo(() => sessionId
    ? buildSessionSubagents(mergeSubagentMessages(index.messages, live), running) : [],
    [index.messages, live, running, sessionId]);
  const visible = useMemo(() => filterSessionSubagents(agents, query, filter), [agents, query, filter]);
  const selectedId = selection?.sessionId === sessionId ? selection?.callId : undefined;
  const selected = selectedId ? agents.find((agent) =>
    agent.calls.some((call) => (call.toolCallId ?? call.id) === selectedId)) : undefined;
  if (selected && sessionId) return <SubagentDetail key={`${sessionId}:${selected.key}`}
    sessionId={sessionId} agent={selected} live={live} onBack={() => setSelection(null)} />;
  const runningCount = agents.filter((agent) => agent.status === "running").length;
  return <section className="session-subagents" data-testid="session-subagents" aria-label={t("panel.sessionSubagents.title")}>
    <header className="session-subagents-header">
      <IconBot size={20} />
      <div className="session-subagents-heading"><h2>{t("panel.sessionSubagents.title")}</h2>
        <p>{t("panel.sessionSubagents.summary", { count: agents.length, running: runningCount })}</p></div>
      {allowed && sessionId && <Button type="button" size="sm" data-testid="subagent-create"
        aria-expanded={creationSession === sessionId} onClick={() => setCreationSession(
          creationSession === sessionId ? null : sessionId)}>{t("panel.sessionSubagents.control.new")}</Button>}
      <TooltipButton type="button" tooltip={t("panel.sessionSubagents.refresh")} ariaLabel={t("panel.sessionSubagents.refresh")}
        disabled={index.loading || !sessionId} onClick={index.reload}><IconRefresh size={15} /></TooltipButton>
    </header>
    <div className="session-subagents-toolbar">
      <Input value={query} onChange={(event) => setQuery(event.target.value)}
        placeholder={t("panel.sessionSubagents.search")} aria-label={t("panel.sessionSubagents.search")} />
      <div className="session-subagents-filters"><SegmentedControl value={filter} onChange={setFilter}
        label={t("panel.sessionSubagents.filter")} options={[
          { value: "all", label: t("panel.sessionSubagents.all") },
          { value: "running", label: t("chat.subagentStatus.running") },
          { value: "completed", label: t("chat.subagentStatus.completed") },
          { value: "failed", label: t("panel.sessionSubagents.issues") },
        ]} />
        <SubagentStopButton running={agents.some((agent) => agent.status === "running" && !agent.creating)} />
      </div>
    </div>
    <HistoryError error={index.error} retry={index.reload} />
    <div className="session-subagents-scroll" tabIndex={0} aria-busy={index.loading}>
      {allowed && sessionId && creationSession === sessionId && <SubagentCreateForm key={sessionId} sessionId={sessionId}
        onStarted={(response) => {
          setCreationSession(null);
          setSelection({ sessionId, callId: response.messageId });
          index.reload();
        }} />}
      <ul className="session-subagents-list">
        {visible.map((agent) => <li key={agent.key} className="session-subagent-entry" data-delegation-id={agent.delegationId}>
          <div className="session-subagent-identity"><strong>{agent.agentName || t("chat.subagentUnnamed")}</strong>
            <Outcome agent={agent} /><SubagentStopButton delegationId={agent.delegationId}
              name={agent.agentName} running={agent.status === "running" && !agent.creating} compact /></div>
          {agent.modelId && <p className="session-subagent-model selectable">{agent.modelId}</p>}
          <Button variant="ghost" className="session-subagent-open"
            aria-label={t("panel.sessionSubagents.view", { name: agent.description || agent.agentName })}
            onClick={() => sessionId && setSelection({ sessionId,
              callId: agent.calls[agent.calls.length - 1].toolCallId ?? agent.calls[agent.calls.length - 1].id })}>
            <span>{agent.description || t("panel.subagentTaskEmpty")}</span>
            <span className="session-subagent-view-label">{t("panel.sessionSubagents.activity")}</span>
          </Button>
        </li>)}
      </ul>
      {index.loading && <p className="session-subagents-notice" role="status">{t("common.loading")}</p>}
      {!index.loading && !index.error && visible.length === 0 && <p className="session-subagents-notice" role="status">
        {t(!sessionId ? "panel.sessionSubagents.noSession" : query || filter !== "all"
          ? "panel.sessionSubagents.noMatches" : index.hasMore ? "panel.sessionSubagents.olderHint" : "panel.sessionSubagents.empty")}
      </p>}
      {index.hasMore && <Button className="session-subagents-more" size="sm" disabled={index.loading}
        onClick={index.loadMore}>{t("panel.sessionSubagents.moreAgents")}</Button>}
    </div>
    <p className="session-subagents-hint">{t("panel.sessionSubagents.mainAgentHint")}</p>
  </section>;
}

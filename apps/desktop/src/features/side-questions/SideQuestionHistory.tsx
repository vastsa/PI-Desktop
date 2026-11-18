import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type SessionSummary, type SideQuestionList } from "@pi-desktop/shared";
import { isRemoteSession } from "../../lib/remote-session-safety";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { sideQuestionHistoryWorkPanelTab, sideQuestionWorkPanelTab } from "../../lib/work-panel-tabs";
import { IconChat } from "../../components/icons";
import { Button, Checkbox, Input } from "../../components/ui";
import { sideQuestionGroups } from "./model";
import { openSideQuestion } from "./actions";
import { DeleteSideQuestionButton } from "./DeleteSideQuestionButton";
import "./side-questions.css";

function useHistory(parentId: string | undefined, query = "", archived = false, limit = 5) {
  const [page, setPage] = useState<SideQuestionList>({ sessions: [], total: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const request = async (offset: number, ticket: number) => {
    if (!parentId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.listSideQuestions(parentId, { query, archived, limit, offset });
      if (ticket !== generation.current) return;
      setPage(previous => ({ total: result.total, sessions: offset ? [...new Map([...previous.sessions, ...result.sessions].map(item => [item.id, item])).values()] : result.sessions }));
    } catch (failure) {
      if (ticket === generation.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally { if (ticket === generation.current) setLoading(false); }
  };
  useEffect(() => {
    const ticket = ++generation.current;
    setPage({ sessions: [], total: 0 });
    const timer = setTimeout(() => void request(0, ticket), query ? 200 : 0);
    return () => { clearTimeout(timer); ++generation.current; };
  }, [parentId, query, archived, limit, revision]);
  return { ...page, loading, error, refresh: () => setRevision(value => value + 1), more: () => request(page.sessions.length, generation.current) };
}

export function SideQuestionLauncher({ parentId }: { parentId: string | undefined }) {
  const { t } = useTranslation();
  const source = useAppStore(state => state.sessions.find(session => session.id === parentId));
  const eligible = source && !source.scheduledRun && !isRemoteSession(source) && source.source !== "pi-native";
  const history = useHistory(eligible ? parentId : undefined);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const create = async () => {
    if (!parentId || pending.current) return;
    pending.current = true;
    setCreating(true);
    setError(null);
    try {
      await openSideQuestion(parentId, t("sideQuestions.untitled"));
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { pending.current = false; setCreating(false); }
  };
  return <>
    <button type="button" className="work-panel-launcher-row" disabled={!eligible || creating} onClick={() => void create()}>
      <span className="work-panel-launcher-icon" aria-hidden><IconChat size={15} /></span>
      <span className="work-panel-launcher-label">{t("sideQuestions.title")}</span>
    </button>
    {error || history.error ? <div className="side-question-error" role="alert">{error || history.error}</div> : null}
    {parentId && eligible && history.total > 0 ? <section className="side-question-recent" aria-label={t("sideQuestions.history")}>
      <div className="side-question-history-heading">{t("sideQuestions.title")} <span>{history.total}</span></div>
      {history.sessions.map(session => <button type="button" className="work-panel-launcher-row" key={session.id}
        onClick={() => useAppStore.getState().openWorkPanelTabForSession(parentId, sideQuestionWorkPanelTab(session.id, session.title))}>
        <IconChat size={14} /><span className="work-panel-launcher-label">{session.title}</span><span>{t("sideQuestions.open")}</span>
      </button>)}
      <Button variant="ghost" onClick={() => useAppStore.getState().openWorkPanelTabForSession(parentId, sideQuestionHistoryWorkPanelTab(parentId))}>{t("sideQuestions.viewAll", { count: history.total })}</Button>
    </section> : null}
  </>;
}

export function SideQuestionHistory({ parentId }: { parentId: string }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [tree, setTree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const history = useHistory(parentId, query, archived, 20);
  const running = useAppStore(state => state.runningSessions);
  const mutate = async (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try { await operation(); history.refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const row = (session: SessionSummary) => <div className="side-question-history-row" key={session.id}>
    <Button type="button" variant="ghost" className="side-question-history-open" onClick={() => useAppStore.getState().openWorkPanelTabForSession(parentId, sideQuestionWorkPanelTab(session.id, session.title))}>
      <IconChat size={14} /><span>{session.title}</span>{running[session.id] ? <span role="status">{t("sideQuestions.working")}</span> : <time dateTime={session.updatedAt}>{new Date(session.updatedAt).toLocaleDateString()}</time>}
    </Button>
    <Button variant="ghost" disabled={busy} onClick={() => void mutate(() => api.archiveSideQuestion(session.id, !archived))}>{t(archived ? "sideQuestions.restore" : "sideQuestions.archive")}</Button>
    <DeleteSideQuestionButton id={session.id} disabled={busy} onDeleted={history.refresh} />
  </div>;
  return <section className="side-question-history" aria-label={t("sideQuestions.history")}>
    <div className="side-question-history-controls">
      <Input type="search" aria-label={t("sideQuestions.search")} placeholder={t("sideQuestions.search")} value={query} onChange={event => setQuery(event.target.value)} />
      <div className="side-question-toolbar">
        <Checkbox checked={archived} onChange={event => setArchived(event.target.checked)} label={t("sideQuestions.archived")} />
        <Button variant="ghost" aria-pressed={tree} onClick={() => setTree(value => !value)}>{t(tree ? "sideQuestions.list" : "sideQuestions.tree")}</Button>
      </div>
    </div>
    {error || history.error ? <div className="side-question-error" role="alert">{error || history.error}</div> : null}
    <div className="side-question-history-scroll">
      {tree ? sideQuestionGroups(history.sessions).map(group => <details open key={group.id} className="side-question-tree-group">
        <summary>{group.label || t("sideQuestions.start")}</summary>{group.sessions.map(row)}
      </details>) : history.sessions.map(row)}
      {!history.loading && !history.sessions.length ? <div className="side-question-empty">{t("sideQuestions.empty")}</div> : null}
      {history.sessions.length < history.total ? <Button variant="ghost" disabled={history.loading} onClick={() => void history.more()}>{t("sideQuestions.loadMore")}</Button> : null}
      {history.loading ? <div role="status">{t("common.loading")}</div> : null}
    </div>
  </section>;
}

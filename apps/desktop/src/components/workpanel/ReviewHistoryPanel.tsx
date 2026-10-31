import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReviewChangesPage, ReviewContextLines, ReviewTurnsPage } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { groupReviewFiles, readReviewPages } from "../../lib/review-history";
import { useReviewFocusRequest } from "../../lib/review-focus-request";
import { readReviewContextLines, rememberReviewContextLines } from "../../lib/review-preferences";
import { useAppStore } from "../../stores/app-store";
import { Button, Select } from "../ui";
import { ReviewHistoryFile } from "./ReviewHistoryFile";
import { ReviewHistoryToolbar } from "./ReviewHistoryToolbar";

type Selection = { turnId?: string; snapshotId?: string; focusSeq?: number };

/** Browsing review history never replaces the chat's bounded message window. */
export function ReviewHistoryPanel({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const messages = useAppStore(state => state.messages);
  const running = useAppStore(state => state.isRunning);
  const focus = useReviewFocusRequest();
  const [selection, setSelection] = useState<Selection>({});
  const [catalog, setCatalog] = useState<ReviewTurnsPage>({ turns: [] });
  const [result, setResult] = useState<ReviewChangesPage>({ turnId: null, changes: [] });
  const [context, setContext] = useState<ReviewContextLines>(readReviewContextLines);
  const [history, setHistory] = useState(false), [wrap, setWrap] = useState(true);
  const [loading, setLoading] = useState(true), [error, setError] = useState(false);
  const [reload, setReload] = useState(0), [paging, setPaging] = useState(false);
  const generation = useRef(0), handledFocus = useRef(0), scroller = useRef<HTMLDivElement>(null);
  // Review facts refresh independently of streamed text, including late delegates.
  const revision = useMemo(() => messages.filter(message => message.role === "tool")
    .map(message => `${message.id}:${message.toolStatus}:${JSON.stringify((message.toolResult as { details?: { review?: unknown } } | undefined)?.details?.review ?? null)}`).join("|"), [messages]);
  useEffect(() => {
    if (!focus || focus.seq === handledFocus.current || (focus.sessionId && focus.sessionId !== sessionId)) return;
    handledFocus.current = focus.seq;
    setHistory(true);
    setSelection({ snapshotId: focus.snapshotIds[0], focusSeq: focus.seq });
  }, [focus, sessionId]);
  useEffect(() => {
    let active = true;
    const version = ++generation.current;
    setLoading(true); setError(false); setPaging(false);
    Promise.all([
      api.workspaceReviewTurns({ sessionId, limit: 50 }),
      readReviewPages(api.workspaceReviewChanges, { sessionId, turnId: selection.turnId, snapshotId: selection.snapshotId, limit: 50 }, () => active),
    ]).then(([turns, changes]) => {
      if (!active) return;
      setCatalog(turns); setResult(changes); setLoading(false);
    }).catch(() => { if (active) { setError(true); setLoading(false); } });
    return () => { active = false; if (generation.current === version) generation.current++; };
  }, [sessionId, selection, revision, running, reload]);
  const files = useMemo(() => groupReviewFiles(result.changes), [result]);
  useEffect(() => {
    if (loading || !selection.snapshotId) return;
    scroller.current?.querySelector<HTMLElement>(`[data-review-snapshots~="${CSS.escape(selection.snapshotId)}"]`)
      ?.scrollIntoView({ block: "start" });
  }, [files, loading, selection]);
  const older = async () => {
    if (catalog.nextBefore === undefined || paging) return;
    const version = generation.current;
    setPaging(true);
    try {
      const page = await api.workspaceReviewTurns({ sessionId, before: catalog.nextBefore, limit: 50 });
      if (generation.current === version) setCatalog(current => ({
        turns: [...current.turns, ...page.turns.filter(turn => !current.turns.some(old => old.id === turn.id))], nextBefore: page.nextBefore,
      }));
    } catch { if (generation.current === version) setError(true); }
    finally { if (generation.current === version) setPaging(false); }
  };
  const selectedId = selection.turnId ?? (selection.snapshotId ? result.turnId ?? "" : "");
  const count = files.reduce((sum, file) => sum + file.entries.length, 0);
  return <div className={`review-tab review-history${wrap ? "" : " is-nowrap"}`} aria-busy={loading}>
    <ReviewHistoryToolbar history={history} onHistory={value => {
      setHistory(value); setSelection(value && result.turnId ? { turnId: result.turnId } : {});
    }} count={count} additions={files.reduce((sum, file) => sum + file.additions, 0)}
      deletions={files.reduce((sum, file) => sum + file.deletions, 0)} context={context} onContext={value => {
        rememberReviewContextLines(value); setContext(value);
      }} wrap={wrap} onWrap={() => setWrap(value => !value)} />
    {history && <div className="review-history-selector">
      <span className="review-history-label">{t("panel.review.historyTitle")}</span>
      <Select className="review-select review-history-round-select" value={selectedId || result.turnId || ""} aria-label={t("panel.review.historyTitle")}
        onChange={event => { setSelection({ turnId: event.target.value }); scroller.current?.scrollTo({ top: 0 }); }}>
        {selectedId && !catalog.turns.some(turn => turn.id === selectedId) && <option value={selectedId}>{selectedId}</option>}
        {catalog.turns.map(turn => <option key={turn.id} value={turn.id}>{new Date(turn.createdAt).toLocaleString()}</option>)}
      </Select>
      {catalog.nextBefore !== undefined && <Button size="sm" disabled={paging} onClick={() => void older()}>{t("panel.review.moreHistory")}</Button>}
    </div>}
    <div className="review-scroll" ref={scroller}>
      {loading && <div className="review-change-note" role="status">{t("panel.review.loadingHistory")}</div>}
      {error && <div className="review-change-note" role="alert">{t("panel.review.historyError")} <Button size="sm" onClick={() => setReload(value => value + 1)}>{t("panel.review.retryHistory")}</Button></div>}
      {!loading && !error && !files.length && <div className="review-change-note">{t("panel.review.noChanges")}</div>}
      {!error && files.map(file => <ReviewHistoryFile key={`${result.turnId}:${file.id}`} file={file} sessionId={sessionId} context={context}
        focusSeq={selection.focusSeq} focusSnapshots={focus?.snapshotIds} expandFocus={focus?.expand}
        disabled={loading} onChanged={() => setReload(value => value + 1)} />)}
    </div>
  </div>;
}

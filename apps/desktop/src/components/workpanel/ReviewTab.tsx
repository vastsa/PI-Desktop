import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { reviewChangesFromMessages, summarizeReviewChanges } from "../../lib/workspace-review";
import { transcriptViewMessages } from "../../lib/transcript-reading";
import { useAppStore } from "../../stores/app-store";
import { IconDiff } from "../icons";
import { ReviewChangeCard } from "../ReviewChangeCard";
import { WorkTabEmpty } from "./WorkTabEmpty";

export function ReviewTab() {
  const { t } = useTranslation();
  const liveMessages = useAppStore((state) => state.messages);
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const selection = useAppStore((state) =>
    state.activeSessionId
      ? state.workPanelContexts[state.activeSessionId]?.reviewSelection
      : undefined,
  );
  const view = useAppStore((state) =>
    state.activeSessionId ? state.transcriptViews[state.activeSessionId] : undefined,
  );
  const messages = useMemo(
    () => selection ? transcriptViewMessages(liveMessages, view) : liveMessages,
    [liveMessages, selection, view],
  );
  const allEntries = useMemo(
    () => reviewChangesFromMessages(messages),
    [messages],
  );
  const entries = useMemo(() => {
    if (!selection || selection.sessionId !== activeSessionId) return allEntries;
    const snapshotIds = new Set(selection.snapshotIds);
    return allEntries.filter(
      ({ change }) =>
        change.path === selection.selectedPath &&
        snapshotIds.has(change.snapshotId),
    );
  }, [activeSessionId, allEntries, selection]);
  const summary = useMemo(() => summarizeReviewChanges(entries), [entries]);

  if (entries.length === 0) {
    return (
      <WorkTabEmpty
        icon={IconDiff}
        title={t("panel.review.noChanges")}
      />
    );
  }

  return (
    <div className="review-tab">
      <div className="review-toolbar">
        <span className="review-summary">
          {t("panel.review.changes", { count: summary.changeCount })}
        </span>
        <span className="review-toolbar-counts diff-counts">
          <span className="diff-count-add">+{summary.additions}</span>
          <span className="diff-count-del">−{summary.deletions}</span>
        </span>
      </div>
      <div className="review-scroll">
        {entries.map((entry) => (
          <ReviewChangeCard
            key={entry.change.snapshotId}
            message={entry.message}
            snapshotId={entry.change.snapshotId}
            compact
            revealToken={selection?.revision}
          />
        ))}
      </div>
    </div>
  );
}

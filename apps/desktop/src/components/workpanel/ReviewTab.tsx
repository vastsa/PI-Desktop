import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  reviewChangesFromMessages,
  summarizeReviewChanges,
} from "../../lib/workspace-review";
import { useAppStore } from "../../stores/app-store";
import { IconDiff } from "../icons";
import { ReviewChangeCard } from "../ReviewChangeCard";
import { useReviewFeedbackDrafts } from "../../features/chat/composer/review-feedback-drafts";
import { useReviewNavigation } from "../../lib/review-navigation";
import { WorkTabEmpty } from "./WorkTabEmpty";

export function ReviewTab() {
  const { t } = useTranslation();
  const messages = useAppStore((state) => state.messages);
  const sessionId = useAppStore((state) => state.activeSessionId);
  const workspacePath = useAppStore((state) => state.workspace?.path);
  const feedback = useReviewFeedbackDrafts((state) => {
    const draft = sessionId ? state.drafts.get(sessionId) : undefined;
    return draft?.workspacePath === workspacePath ? draft : undefined;
  });
  const focus = useReviewNavigation((state) => state.focus);
  const entries = useMemo(
    () => reviewChangesFromMessages(messages),
    [messages],
  );
  const summary = useMemo(() => summarizeReviewChanges(entries), [entries]);

  if (entries.length === 0 && !feedback) {
    return <WorkTabEmpty icon={IconDiff} title={t("panel.review.noChanges")} />;
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
            compact
            enableFeedback
            feedback={
              feedback?.snapshotId === entry.change.snapshotId &&
              feedback.messageId === entry.change.messageId
                ? feedback
                : undefined
            }
            revealRequest={
              focus && focus.sessionId === sessionId &&
              focus.workspacePath === workspacePath &&
              focus.snapshotId === entry.change.snapshotId
                ? focus.sequence
                : undefined
            }
          />
        ))}
      </div>
    </div>
  );
}

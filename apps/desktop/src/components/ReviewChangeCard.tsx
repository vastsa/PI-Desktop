import { memo, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ReviewChangeStatus,
  ReviewRollbackStatus,
  UiMessage,
} from "@pi-desktop/shared";
import { reviewChangeFromMessage } from "../lib/workspace-review";
import { useAppStore } from "../stores/app-store";
import { cx } from "./ui";
import type { ReviewFeedback } from "../lib/review-feedback";
import { ReviewChangeActions } from "./ReviewChangeActions";
import { ReviewFeedbackDiff } from "./ReviewFeedbackDiff";
import { IconCheck, IconChevronRight, IconSnapshot } from "./icons";

/* Git-status letters carry the status without relying on color alone; the
   localized word stays in the row's accessible name. */
const STATUS_MARKS: Record<ReviewChangeStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
};

function DiffBody({
  message,
  compact,
  enableFeedback,
  feedback,
}: {
  message: UiMessage;
  compact: boolean;
  enableFeedback: boolean;
  feedback?: ReviewFeedback;
}) {
  const { t } = useTranslation();
  const change = reviewChangeFromMessage(message);
  const rollback = useAppStore((state) => state.rollbackWorkspaceChange);
  const [rollingBack, setRollingBack] = useState(false);
  const [rollbackStatus, setRollbackStatus] =
    useState<ReviewRollbackStatus | null>(null);

  if (!change) return null;

  const runRollback = async () => {
    if (!change.reversible || change.state === "rolledBack" || rollingBack)
      return;
    setRollingBack(true);
    setRollbackStatus(null);
    const result = await rollback(message.id, change.snapshotId);
    setRollingBack(false);
    if (result) setRollbackStatus(result.status);
  };

  const actions = (
    <div className={cx("review-change-card-actions", compact && "is-compact")}>
      {rollbackStatus === "conflict" ? (
        <div className="review-change-rollback-note is-warning">
          {t("panel.review.rollbackConflict")}
        </div>
      ) : rollbackStatus === "unavailable" ? (
        <div className="review-change-rollback-note">
          {t("panel.review.rollbackUnavailable")}
        </div>
      ) : null}
      {!compact ? <ReviewChangeActions change={change} /> : null}
      {change.state === "rolledBack" ? (
        <span className="review-change-state is-rolled-back">
          <IconCheck size={13} />
          {t("panel.review.rolledBack")}
        </span>
      ) : change.reversible ? (
        <button
          type="button"
          className="review-change-rollback"
          onClick={() => void runRollback()}
          disabled={rollingBack}
        >
          <IconSnapshot size={13} />
          {rollingBack
            ? t("panel.review.rollingBack")
            : t("panel.review.rollback")}
        </button>
      ) : (
        <span className="review-change-rollback-note">
          {t("panel.review.rollbackUnavailable")}
        </span>
      )}
    </div>
  );
  return (
    <div className="review-change-card-body-content">
      {change.binary ? (
        <div className="review-change-note">{t("panel.review.binary")}</div>
      ) : change.truncated ? (
        <div className="review-change-note">{t("panel.review.tooLarge")}</div>
      ) : change.hunks.length > 0 ? (
        <ReviewFeedbackDiff
          change={change}
          message={message}
          enabled={enableFeedback}
          feedback={feedback}
        />
      ) : (
        <div className="review-change-note">
          {t("panel.review.noLineDetails")}
        </div>
      )}

      {actions}
    </div>
  );
}

export const ReviewChangeCard = memo(function ReviewChangeCard({
  message,
  compact = false,
  enableFeedback = false,
  feedback,
  revealRequest,
}: {
  message: UiMessage;
  compact?: boolean;
  enableFeedback?: boolean;
  feedback?: ReviewFeedback;
  revealRequest?: number;
}) {
  const { t } = useTranslation();
  const change = reviewChangeFromMessage(message);
  const detailsId = useId();
  const [open, setOpen] = useState(Boolean(feedback || revealRequest));
  const cardRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (revealRequest) setOpen(true);
  }, [revealRequest]);
  useEffect(() => {
    if (!revealRequest || !open) return;
    const frame = requestAnimationFrame(() =>
      cardRef.current?.scrollIntoView({ block: "nearest" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [revealRequest, open]);

  if (!change) return null;

  const statusLabel = t(`panel.review.status.${change.status}`);
  const baseLabel = t(
    open ? "chat.reviewChangeHide" : "chat.reviewChangeShow",
    {
      status: statusLabel,
      path: change.path,
      additions: change.additions,
      deletions: change.deletions,
    },
  );
  // The collapsed row shows a rolled-back change struck through, so the state
  // has to reach the accessible name too.
  const accessibleLabel =
    change.state === "rolledBack"
      ? `${baseLabel} · ${t("panel.review.rolledBack")}`
      : baseLabel;

  return (
    <section
      ref={cardRef}
      className={cx(
        "review-change-card",
        compact && "is-compact",
        open && "open",
      )}
      data-state={change.state}
      data-status={change.status}
    >
      <div className="review-change-heading">
        <button
          type="button"
          className="review-change-card-header"
          aria-expanded={open}
          aria-controls={detailsId}
          aria-label={accessibleLabel}
          title={accessibleLabel}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="review-change-card-caret" aria-hidden>
            <IconChevronRight size={11} />
          </span>
          <span
            className={cx("review-change-card-mark", `is-${change.status}`)}
            aria-hidden
          >
            {STATUS_MARKS[change.status]}
          </span>
          <span className="review-change-card-path" title={change.path}>
            {change.path}
          </span>
          <span
            className="review-change-card-counts diff-counts"
            aria-label={t("chat.reviewChangeCounts", change)}
          >
            {change.additions > 0 && (
              <span className="diff-count-add">+{change.additions}</span>
            )}
            {change.deletions > 0 && (
              <span className="diff-count-del">−{change.deletions}</span>
            )}
          </span>
          {feedback ? (
            <span className="review-comment-marker">
              {t("panel.review.feedback.attachment")}
            </span>
          ) : null}
        </button>
      </div>
      {open ? (
        <div className="review-change-card-body" id={detailsId}>
          <DiffBody
            message={message}
            compact={compact}
            enableFeedback={enableFeedback}
            feedback={feedback}
          />
        </div>
      ) : null}
    </section>
  );
});

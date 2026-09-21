import { useTranslation } from "react-i18next";
import {
  reviewFeedbackRange,
  type ReviewFeedback,
} from "../../lib/review-feedback";
import { clearReviewFeedback } from "../../features/chat/composer/review-feedback-drafts";
import { IconTrash } from "../icons";

export function ReviewPendingFeedback({
  feedback,
}: {
  feedback: ReviewFeedback;
}) {
  const { t } = useTranslation();
  const range = reviewFeedbackRange(feedback.lines);
  return (
    <section
      className="review-pending-feedback"
      aria-label={t("panel.review.feedback.attachment")}
    >
      <span
        className="review-comment-heading"
        title={t("panel.review.feedback.range", range)}
      >
        {t("panel.review.feedback.location", {
          lines: range.new === "–" ? range.old : range.new,
        })}
      </span>
      <p>{feedback.comment}</p>
      <div className="review-comment-footer">
        <span className="review-feedback-status" role="status">
          {t("panel.review.feedback.added")}
        </span>
        <button
          type="button"
          className="review-change-rollback"
          onClick={() => clearReviewFeedback(feedback.sessionId)}
        >
          <IconTrash size={13} />
          {t("panel.review.feedback.remove")}
        </button>
      </div>
    </section>
  );
}

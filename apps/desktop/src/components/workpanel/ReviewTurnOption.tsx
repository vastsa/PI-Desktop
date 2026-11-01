import type { ReviewTurn } from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";

/** Only Host-recorded totals are displayed; missing/unsafe values stay unknown. */
export function ReviewTurnOption({ turn }: { turn: Pick<ReviewTurn, "id" | "createdAt" | "additions" | "deletions"> }) {
  const { t } = useTranslation();
  const { additions, deletions } = turn;
  const known = typeof additions === "number" && Number.isSafeInteger(additions) && additions >= 0
    && typeof deletions === "number" && Number.isSafeInteger(deletions) && deletions >= 0;
  const date = turn.createdAt ? new Date(turn.createdAt).toLocaleString() : turn.id;
  return <option value={turn.id} title={t("panel.review.recordedTotals")}>
    <span className="review-turn-time">{date}</span>{" "}
    {known ? <span className="review-turn-counts" aria-label={t("chat.reviewChangeCounts", { additions, deletions })}>
      <span className="diff-count-add">+{additions}</span>{" "}<span className="diff-count-del">−{deletions}</span>
    </span> : <span className="review-turn-counts is-unknown">{t("panel.review.unknownTotals")}</span>}
  </option>;
}

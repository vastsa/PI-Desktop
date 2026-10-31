import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useReviewFocusRequest } from "../../lib/review-focus-request";
import { reviewChangesFromMessages, summarizeReviewChanges } from "../../lib/workspace-review";
import { useAppStore } from "../../stores/app-store";
import { IconDiff } from "../icons";
import { ReviewChangeCard } from "../ReviewChangeCard";
import { WorkTabEmpty } from "./WorkTabEmpty";

/* Module-level like the Files tab's request dedup: a remounted tab must not
   re-apply a focus request it already honored. */
let handledFocusSeq = 0;

type AppliedFocus = {
  snapshotIds: ReadonlySet<string>;
  /** The earliest focused change in the list, scrolled to the top. */
  anchor: string;
  expand: boolean;
  seq: number;
};

export function ReviewTab() {
  const { t } = useTranslation();
  const messages = useAppStore((state) => state.messages);
  const entries = useMemo(() => reviewChangesFromMessages(messages), [messages]);
  const summary = useMemo(() => summarizeReviewChanges(entries), [entries]);
  const focusRequest = useReviewFocusRequest();
  const [focus, setFocus] = useState<AppliedFocus | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // A request names snapshots of one session; it waits until this tab shows
  // that session's changes, then applies once.
  useEffect(() => {
    if (!focusRequest || focusRequest.seq === handledFocusSeq) return;
    const wanted = new Set(focusRequest.snapshotIds);
    const anchor = entries.find((entry) => wanted.has(entry.change.snapshotId));
    if (!anchor) return;
    handledFocusSeq = focusRequest.seq;
    setFocus({
      snapshotIds: wanted,
      anchor: anchor.change.snapshotId,
      expand: focusRequest.expand,
      seq: focusRequest.seq,
    });
  }, [focusRequest, entries]);

  useEffect(() => {
    if (!focus) return;
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-snapshot-id="${CSS.escape(focus.anchor)}"]`)
      ?.scrollIntoView({ block: "start" });
  }, [focus]);

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
      <div className="review-scroll" ref={scrollRef}>
        {entries.map((entry) => (
          <ReviewChangeCard
            key={entry.change.snapshotId}
            message={entry.message}
            compact
            openRequest={
              focus?.expand && focus.snapshotIds.has(entry.change.snapshotId)
                ? focus.seq
                : undefined
            }
          />
        ))}
      </div>
    </div>
  );
}

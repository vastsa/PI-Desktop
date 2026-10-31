import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ReviewChangeStatus, UiMessage } from "@pi-desktop/shared";
import { cx } from "../../../components/ui";
import { requestReviewFocus } from "../../../lib/review-focus-request";
import {
  summarizeTurnChanges,
  TURN_CHANGES_RELAXED_LIMIT,
  TURN_CHANGES_VISIBLE_LIMIT,
  type TurnChangedFile,
} from "../../../lib/turn-changed-files";
import { toolWorkPanelTab } from "../../../lib/work-panel-tabs";
import { useSlotSessionId } from "../../../plugins/renderer-slots/use-slots";
import { useAppStore } from "../../../stores/app-store";
import "../../../styles/turn-changes.css";

/* Same Git-style letters as the per-call review row, so status never relies
   on color alone. */
const STATUS_MARKS: Record<ReviewChangeStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
};

function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="turn-changes-counts diff-counts" aria-hidden>
      {additions > 0 && <span className="diff-count-add">+{additions}</span>}
      {deletions > 0 && <span className="diff-count-del">−{deletions}</span>}
    </span>
  );
}

/**
 * The read-only "what did this turn change" summary under a completed reply.
 * Each row opens the existing Review tab on that file's recorded changes; the
 * card has no diff body and no rollback of its own.
 */
export const TurnChangesCard = memo(function TurnChangesCard({
  tools,
}: {
  tools: readonly UiMessage[];
}) {
  const { t } = useTranslation();
  const sessionId = useSlotSessionId();
  const openTabForSession = useAppStore((state) => state.openWorkPanelTabForSession);
  const openTab = useAppStore((state) => state.openWorkPanelTab);
  const summary = useMemo(() => summarizeTurnChanges(tools), [tools]);
  const { files } = summary;
  if (files.length === 0) return null;

  const dense = files.length > TURN_CHANGES_RELAXED_LIMIT;
  const visible = files.slice(0, TURN_CHANGES_VISIBLE_LIMIT);
  const hidden = files.length - visible.length;

  const openReview = (snapshotIds: readonly string[], expand: boolean) => {
    requestReviewFocus(snapshotIds, { expand });
    const tab = toolWorkPanelTab("review");
    if (sessionId) openTabForSession(sessionId, tab);
    else openTab(tab);
  };

  const rowLabel = (file: TurnChangedFile) => {
    const label = t("chat.turnChangesOpen", {
      status: t(`panel.review.status.${file.status}`),
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
    });
    return file.rolledBack ? `${label} · ${t("panel.review.rolledBack")}` : label;
  };

  return (
    <section className="turn-changes-card" aria-label={t("chat.turnChangesLabel")}>
      <div className="turn-changes-head">
        <span className="turn-changes-title">{t("chat.turnChangesTitle")}</span>
        <span className="turn-changes-meta">
          {t("chat.toolChipFiles", { count: files.length })}
          {dense ? ` · ${t("chat.turnChangesDirs", { count: summary.directoryCount })}` : null}
        </span>
        <span
          className="turn-changes-total"
          aria-label={t("chat.reviewChangeCounts", summary)}
        >
          <Counts additions={summary.additions} deletions={summary.deletions} />
        </span>
      </div>
      <ul className={cx("turn-changes-body", dense && "is-dense")}>
        {visible.map((file) => {
          const label = rowLabel(file);
          return (
            <li key={file.path}>
              <button
                type="button"
                className="turn-changes-row"
                data-status={file.status}
                data-rolled-back={file.rolledBack || undefined}
                aria-label={label}
                title={label}
                onClick={() => openReview(file.snapshotIds, true)}
              >
                <span className="turn-changes-mark" aria-hidden>
                  {STATUS_MARKS[file.status]}
                </span>
                <span className="turn-changes-path">{file.path}</span>
                <Counts additions={file.additions} deletions={file.deletions} />
              </button>
            </li>
          );
        })}
        {hidden > 0 ? (
          <li className="turn-changes-more">
            <span aria-hidden>···</span>
            {t("chat.turnChangesMore", { count: hidden })}
          </li>
        ) : null}
      </ul>
      {hidden > 0 ? (
        <div className="turn-changes-foot">
          <button
            type="button"
            className="turn-changes-view-all"
            onClick={() => openReview(files.flatMap((file) => file.snapshotIds), false)}
          >
            {t("chat.turnChangesViewAll", { count: files.length })}
          </button>
        </div>
      ) : null}
    </section>
  );
});

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconDiff } from "../../../components/icons";
import type { AssistantTurnEntry } from "../../../lib/assistant-turns";
import { summarizeTurnFileChanges } from "../../../lib/turn-file-summary";
import { useAppStore } from "../../../stores/app-store";
import "./TurnFileSummary.css";

const DEFAULT_VISIBLE_FILES = 3;
const COLLAPSE_THRESHOLD = 5;

export function TurnFileSummary({
  entry,
  sessionId,
}: {
  entry: AssistantTurnEntry;
  sessionId: string | undefined;
}) {
  const { t } = useTranslation();
  const summary = useMemo(() => summarizeTurnFileChanges(entry), [entry]);
  const [showAll, setShowAll] = useState(false);
  const openTurnFileReview = useAppStore((state) => state.openTurnFileReview);

  if (summary.fileCount === 0) return null;

  const collapsible = summary.fileCount > COLLAPSE_THRESHOLD;
  const visibleFiles = showAll || !collapsible
    ? summary.files
    : summary.files.slice(0, DEFAULT_VISIBLE_FILES);
  const hiddenCount = summary.fileCount - visibleFiles.length;

  return (
    <section
      className="turn-file-summary"
      aria-label={t("chat.turnFilesEdited", { count: summary.fileCount })}
    >
      <div className="turn-file-summary-header">
        <span className="turn-file-summary-icon" aria-hidden>
          <IconDiff size={16} />
        </span>
        <div className="turn-file-summary-heading">
          <strong>{t("chat.turnFilesEdited", { count: summary.fileCount })}</strong>
          <div
            className="turn-file-summary-totals"
            aria-label={t("chat.turnFilesEditTotalsLabel", {
              additions: summary.additions,
              deletions: summary.deletions,
            })}
          >
            <span className="diff-count-add">+{summary.additions}</span>
            <span className="diff-count-del">−{summary.deletions}</span>
          </div>
        </div>
      </div>

      <div className="turn-file-summary-list">
        {visibleFiles.map((file) => {
          const fileLabel = [
            file.path,
            t("chat.reviewChangeCounts", file),
            file.rolledBackOperationCount > 0
              ? `${t("panel.review.rolledBack")}: ${file.rolledBackOperationCount}`
              : "",
          ].filter(Boolean).join(" · ");
          return (
            <button
              type="button"
              className="turn-file-summary-file-header"
              aria-label={fileLabel}
              key={file.path}
              onClick={() => {
                if (!sessionId) return;
                openTurnFileReview({
                  sessionId,
                  turnId: entry.id,
                  selectedPath: file.path,
                  snapshotIds: file.entries.map(
                    (record) => record.change.snapshotId,
                  ),
                });
              }}
            >
              <span className="turn-file-summary-path" title={file.path}>
                {file.path}
              </span>
              <span className="turn-file-summary-file-totals" aria-hidden>
                <span className="diff-count-add">+{file.additions}</span>
                <span className="diff-count-del">−{file.deletions}</span>
              </span>
            </button>
          );
        })}
      </div>

      {collapsible ? (
        <button
          type="button"
          className="turn-file-summary-more"
          aria-expanded={showAll}
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll
            ? t("chat.turnFilesShowLess")
            : t("chat.turnFilesShowMore", { count: hiddenCount })}
        </button>
      ) : null}
    </section>
  );
}

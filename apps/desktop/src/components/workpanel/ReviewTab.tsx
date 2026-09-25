import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DiffFile, WorkspaceDiff } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { isRemoteSession } from "../../lib/session-capabilities";
import { reviewChangesFromMessages, summarizeReviewChanges } from "../../lib/workspace-review";
import { useAppStore } from "../../stores/app-store";
import { Button, cx } from "../ui";
import { IconDiff, IconChevronRight } from "../icons";
import { ReviewChangeCard } from "../ReviewChangeCard";
import { WorkTabEmpty } from "./WorkTabEmpty";

type RemoteDiffState =
  | { requestKey: string; status: "loading" }
  | { requestKey: string; status: "error" }
  | { requestKey: string; status: "ready"; diff: WorkspaceDiff };

const STATUS_MARKS: Record<DiffFile["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "?",
};

function WorkspaceDiffFileCard({ file }: { file: DiffFile }) {
  const { t } = useTranslation();
  const detailsId = useId();
  const [open, setOpen] = useState(false);
  const statusLabel = t(`panel.review.status.${file.status}`);
  const path = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  const accessibleLabel = t(
    open ? "chat.reviewChangeHide" : "chat.reviewChangeShow",
    {
      status: statusLabel,
      path,
      additions: file.additions,
      deletions: file.deletions,
    },
  );

  return (
    <section
      className={cx("review-change-card is-compact", open && "open")}
      data-status={file.status}
    >
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
          className={cx("review-change-card-mark", `is-${file.status}`)}
          aria-hidden
        >
          {STATUS_MARKS[file.status]}
        </span>
        <span className="review-change-card-path" title={path}>
          {path}
        </span>
        <span className="review-change-card-counts diff-counts">
          {file.additions > 0 && (
            <span className="diff-count-add">+{file.additions}</span>
          )}
          {file.deletions > 0 && (
            <span className="diff-count-del">−{file.deletions}</span>
          )}
        </span>
      </button>
      {open ? (
        <div className="review-change-card-body" id={detailsId}>
          <div className="review-change-card-body-content">
            {file.binary ? (
              <div className="review-change-note">{t("panel.review.binary")}</div>
            ) : file.tooLarge ? (
              <div className="review-change-note">{t("panel.review.tooLarge")}</div>
            ) : file.hunks.length > 0 ? (
              <div className="review-change-diff">
                {file.hunks.map((hunk, hunkIndex) => (
                  <div className="diff-hunk" key={`${hunk.header}-${hunkIndex}`}>
                    <div className="diff-line hunk">
                      <span className="diff-line-text">{hunk.header}</span>
                    </div>
                    {hunk.lines.map((line, lineIndex) => (
                      <div className={cx("diff-line", line.type)} key={lineIndex}>
                        <span className="diff-line-sign" aria-hidden>
                          {line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
                        </span>
                        <span className="diff-line-text">{line.text}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ) : (
              <div className="review-change-note">
                {t("panel.review.noLineDetails")}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function ReviewTab() {
  const { t } = useTranslation();
  const messages = useAppStore((state) => state.messages);
  const remoteSessionId = useAppStore((state) => {
    const active = state.sessions.find((session) => session.id === state.activeSessionId);
    return active && isRemoteSession(active) ? active.id : null;
  });
  const entries = useMemo(() => reviewChangesFromMessages(messages), [messages]);
  const summary = useMemo(() => summarizeReviewChanges(entries), [entries]);
  const latestReviewSnapshotId = entries.at(-1)?.change.snapshotId;
  const [remoteDiff, setRemoteDiff] = useState<RemoteDiffState | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const requestKey = remoteSessionId
    ? `${remoteSessionId}\0${latestReviewSnapshotId ?? ""}\0${refreshVersion}`
    : null;

  useEffect(() => {
    if (!remoteSessionId || !requestKey) return;
    let current = true;
    setRemoteDiff({ requestKey, status: "loading" });
    void api
      .workspaceDiff(remoteSessionId)
      .then((diff) => {
        if (current) setRemoteDiff({ requestKey, status: "ready", diff });
      })
      .catch(() => {
        if (current) setRemoteDiff({ requestKey, status: "error" });
      });
    return () => {
      current = false;
    };
  }, [latestReviewSnapshotId, remoteSessionId, refreshVersion, requestKey]);

  if (!remoteSessionId) {
    if (entries.length === 0) {
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
            />
          ))}
        </div>
      </div>
    );
  }

  const currentDiff =
    remoteDiff?.requestKey === requestKey
      ? remoteDiff
      : { requestKey, status: "loading" as const };
  const loading = currentDiff.status === "loading";
  const workspaceSummary =
    currentDiff.status === "ready"
      ? currentDiff.diff.files.reduce(
          (counts, file) => ({
            additions: counts.additions + file.additions,
            deletions: counts.deletions + file.deletions,
          }),
          { additions: 0, deletions: 0 },
        )
      : null;

  return (
    <div className="review-tab">
      <div className="review-toolbar">
        <span className="review-summary">{t("panel.review.workspaceDiff")}</span>
        {currentDiff.status === "ready" && currentDiff.diff.repo && (
          <>
            <span className="review-summary">
              {t("panel.review.filesChanged", {
                count: currentDiff.diff.files.length,
              })}
            </span>
            <span className="review-toolbar-counts diff-counts">
              <span className="diff-count-add">+{workspaceSummary?.additions ?? 0}</span>
              <span className="diff-count-del">−{workspaceSummary?.deletions ?? 0}</span>
            </span>
          </>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={loading}
          onClick={() => setRefreshVersion((version) => version + 1)}
        >
          {t("panel.review.refresh")}
        </Button>
      </div>
      <div className="review-scroll" aria-busy={loading || undefined}>
        {currentDiff.status === "loading" ? (
          <div className="file-tree-note" role="status">
            {t("panel.files.loading")}
          </div>
        ) : currentDiff.status === "error" ? (
          <div className="file-tree-note review-workspace-error" role="status">
            {t("panel.review.workspaceError")}
          </div>
        ) : !currentDiff.diff.repo ? (
          <WorkTabEmpty
            icon={IconDiff}
            title={t("panel.review.workspaceNoRepo")}
          />
        ) : currentDiff.diff.files.length === 0 ? (
          <div className="file-tree-note" role="status">
            {t("panel.review.workspaceNoChanges")}
          </div>
        ) : (
          <>
            {currentDiff.diff.truncated && (
              <div className="file-tree-note" role="status">
                {t("panel.review.workspaceTruncated")}
              </div>
            )}
            {currentDiff.diff.files.map((file) => (
              <WorkspaceDiffFileCard key={`${file.status}:${file.path}`} file={file} />
            ))}
          </>
        )}
        {entries.length > 0 && (
          <div className="review-remote-history">
            <div className="review-toolbar">
              <span className="review-summary">
                {t("panel.review.changes", { count: summary.changeCount })}
              </span>
              <span className="review-toolbar-counts diff-counts">
                <span className="diff-count-add">+{summary.additions}</span>
                <span className="diff-count-del">−{summary.deletions}</span>
              </span>
            </div>
            {entries.map((entry) => (
              <ReviewChangeCard
                key={entry.change.snapshotId}
                message={entry.message}
                compact
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

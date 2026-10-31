import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReviewContextLines } from "@pi-desktop/shared";
import { reviewFilePathLabel, type ReviewFileGroup } from "../../lib/review-history";
import { ReviewChangeDetails } from "../ReviewChangeCard";
import { Button, TooltipButton, cx } from "../ui";
import { ContextMenu, useContextMenu } from "../ContextMenu";
import { useReviewFileOpen } from "../../hooks/use-review-file-open";
import { IconChevronRight, IconMore } from "../icons";
import { ReviewFileActions } from "./ReviewFileActions";

export function ReviewHistoryFile({ file, sessionId, context, focusSeq, focusSnapshots, expandFocus, disabled, onChanged }: {
  file: ReviewFileGroup; sessionId: string; context: ReviewContextLines;
  focusSeq?: number; focusSnapshots?: readonly string[]; expandFocus?: boolean;
  disabled: boolean; onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const menu = useContextMenu();
  const { canOpenInternal, canOpenFile, openFile, outside } = useReviewFileOpen(file, sessionId);
  useEffect(() => {
    if (focusSeq && expandFocus && file.entries.some(entry => focusSnapshots?.includes(entry.change.snapshotId))) setOpen(true);
  }, [focusSeq, expandFocus, file, focusSnapshots]);
  return <section className={cx("review-history-file", open && "open")} data-review-snapshots={file.entries.map(entry => entry.change.snapshotId).join(" ")}>
    <div className="review-history-file-heading">
    <Button variant="ghost" className="review-history-file-header" aria-expanded={open} aria-controls={detailsId} disabled={disabled} title={/^(?:[a-z]:[\\/]|[\\/])/i.test(file.path) || !file.root ? file.path : `${file.root}/${file.path}`} onClick={() => setOpen(value => !value)}>
      <IconChevronRight size={11} /><span className="review-change-card-path" data-outside-path={reviewFilePathLabel(file.path) !== file.path || undefined}>{reviewFilePathLabel(file.path)}</span>
      <span className="diff-counts"><span className="diff-count-add">+{file.additions}</span><span className="diff-count-del">−{file.deletions}</span></span>
    </Button>
    <TooltipButton className="icon-btn review-file-menu-button" tooltip={t("panel.review.fileActions")} disabled={disabled} aria-haspopup="menu" aria-expanded={!!menu.contextMenu} onClick={event => menu.openContextMenu(event, { label: t("panel.review.fileActions"), density: "compact", items: [
      ...(!outside ? [{ id: "review-open-internal", label: t("panel.review.openInternal"), disabled: !canOpenInternal, onSelect: () => void openFile("internal") }] : []),
      { id: "review-open-external", label: t("panel.review.openExternal"), disabled: !canOpenFile, onSelect: () => void openFile("external") },
      { id: "review-open-folder", label: t("panel.review.openFolder"), disabled: !canOpenFile, onSelect: () => void openFile("folder") },
    ] })}><IconMore size={14} /></TooltipButton>
    </div>
    <ContextMenu state={menu.contextMenu} onClose={menu.closeContextMenu} />
    {open && <div className="review-history-file-body" id={detailsId}>
      {file.entries.map(entry => <div className="review-history-record" key={entry.change.snapshotId} data-snapshot-id={entry.change.snapshotId}>
        <ReviewChangeDetails message={entry.message} compact numbered actions={false} sessionId={sessionId} contextLines={context} />
      </div>)}
      <ReviewFileActions file={file} sessionId={sessionId} context={context} disabled={disabled} onChanged={onChanged} />
    </div>}
  </section>;
}

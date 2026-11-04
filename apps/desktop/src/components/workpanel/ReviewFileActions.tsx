import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReviewContextLines } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import type { ReviewFileGroup } from "../../lib/review-history";
import { withReviewChangeState } from "../../lib/workspace-review";
import { useAppStore } from "../../stores/app-store";
import { useChatSessionCapability } from "../../hooks/use-chat-session-capability";
import { useCopy } from "../Markdown";
import { reviewDiffText } from "../ReviewChangeCard";
import { Button, cx } from "../ui";
import { IconCheck, IconCopy, IconSnapshot } from "../icons";

export function ReviewFileActions({ file, sessionId, context, disabled, onChanged }: {
  file: ReviewFileGroup; sessionId: string; context: ReviewContextLines; disabled: boolean; onChanged: () => void;
}) {
  const { t } = useTranslation();
  const { copied, copy } = useCopy();
  const localToolsAllowed = useChatSessionCapability("canUseLocalTools");
  const running = useAppStore(state => state.isRunning);
  const workspace = useAppStore(state => state.workspace);
  const [rollingBack, setRollingBack] = useState(false);
  const latest = useRef({ file, context }); latest.current = { file, context };
  const active = file.entries.filter(entry => entry.change.state !== "rolledBack");
  const canRollback = active.length > 0 && active.every(entry => entry.change.reversible) && localToolsAllowed;
  const current = () => useAppStore.getState().activeSessionId === sessionId && useAppStore.getState().workspace === workspace;
  const rollback = async () => {
    if (!current() || disabled || !canRollback || rollingBack || useAppStore.getState().isRunning) return;
    setRollingBack(true);
    try {
      const result = await api.workspaceReviewRollbackFile({ sessionId, snapshotId: file.entries[0].change.snapshotId });
      if (!current()) return;
      if (result.status === "rolledBack" || result.status === "alreadyRolledBack") {
        const ids = new Set(file.entries.map(entry => entry.change.snapshotId));
        useAppStore.setState(state => ({ messages: state.messages.map(message => {
          const row = file.entries.find(entry => entry.message.id === message.id);
          return row && ids.has(row.change.snapshotId) ? withReviewChangeState(message, "rolledBack") : message;
        }) }));
        onChanged();
      } else {
        useAppStore.getState().showToast(t(result.status === "conflict" ? "panel.review.rollbackConflict" : "panel.review.rollbackUnavailable"), { variant: "warning" });
      }
    } catch {
      if (current()) useAppStore.getState().showToast(t("panel.review.rollbackError"), { variant: "error" });
    } finally { setRollingBack(false); }
  };
  const copyFile = async () => {
    try {
      const hunks = await Promise.all(file.entries.map(async ({ change }) => {
        try {
          const saved = await api.workspaceReviewContext({ sessionId, snapshotId: change.snapshotId, context });
          return saved.unavailable ? change.hunks : saved.hunks;
        } catch { return change.hunks; }
      }));
      if (!current() || latest.current.file !== file || latest.current.context !== context) return;
      const text = reviewDiffText({ hunks: hunks.flat() });
      await copy(text);
    } catch {
      if (current()) useAppStore.getState().showToast(t("panel.review.contextError"), { variant: "error" });
    }
  };
  return <div className="review-change-card-actions is-compact">
    {!active.length ? <span className="review-change-state is-rolled-back"><IconCheck size={13} />{t("panel.review.rolledBack")}</span>
      : canRollback ? <Button variant="ghost" size="sm" className="review-change-rollback" disabled={disabled || rollingBack || running} onClick={() => void rollback()}><IconSnapshot size={13} />{t(rollingBack ? "panel.review.rollingBack" : "panel.review.rollback")}</Button>
        : <span className="review-change-rollback-note">{t("panel.review.rollbackUnavailable")}</span>}
    <Button variant="ghost" size="sm" className={cx("review-change-copy", copied && "copied")} disabled={disabled || !file.entries.some(entry => entry.change.hunks.length)} title={t("chat.copy")} onClick={() => void copyFile()}>{copied ? <IconCheck size={13} /> : <IconCopy size={13} />}{t(copied ? "chat.copied" : "chat.copy")}</Button>
  </div>;
}

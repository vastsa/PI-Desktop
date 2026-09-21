import { Fragment, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReviewChange, UiMessage } from "@pi-desktop/shared";
import { useAppStore } from "../stores/app-store";
import {
  createReviewFeedback,
  reviewFeedbackAnchor,
  type ReviewFeedback,
  MAX_REVIEW_COMMENT,
  MAX_REVIEW_SELECTION,
  reviewFeedbackLines,
} from "../lib/review-feedback";
import { ReviewPendingFeedback } from "./workpanel/ReviewPendingFeedback";
import { stageReviewFeedback } from "../features/chat/composer/review-feedback-drafts";

import { useReviewLineSelection } from "../hooks/useReviewLineSelection";
import { IconPlus } from "./icons";

/** Selection and comment editing stay local; only an explicit Add stages a draft. */
export function ReviewFeedbackDiff({
  change,
  message,
  enabled,
  feedback,
}: {
  change: ReviewChange;
  message: UiMessage;
  enabled: boolean;
  feedback?: ReviewFeedback;
}) {
  const { t } = useTranslation();
  const sessionId = useAppStore((state) => state.activeSessionId);
  const workspacePath = useAppStore((state) => state.workspace?.path ?? "");
  // Remount the editor on ownership changes, even when a tool id is reused.
  return (
    <FeedbackEditor
      key={`${sessionId}:${workspacePath}:${change.snapshotId}`}
      change={change}
      enabled={enabled}
      feedback={feedback}
      message={message}
      sessionId={sessionId}
      workspacePath={workspacePath}
      t={t}
    />
  );
}

function FeedbackEditor({
  change,
  message,
  sessionId,
  workspacePath,
  t,
  enabled,
  feedback,
}: {
  change: ReviewChange;
  message: UiMessage;
  sessionId: string | null | undefined;
  workspacePath: string;
  enabled: boolean;
  feedback?: ReviewFeedback;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const lineSelection = useReviewLineSelection();
  const { selection, dragging } = lineSelection;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (selection && !dragging)
      textareaRef.current?.focus({ preventScroll: true });
  }, [selection, dragging]);
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const inputId = useId();
  const anchor = enabled ? reviewFeedbackAnchor(change, feedback) : null;
  const selectedLines = selection
    ? reviewFeedbackLines(change.hunks[selection.hunk]).slice(
        Math.min(selection.anchor, selection.end),
        Math.max(selection.anchor, selection.end) + 1,
      )
    : [];
  const oversized =
    selectedLines.map((line) => line.text).join("\n").length >
    MAX_REVIEW_SELECTION;
  const add = () => {
    const state = useAppStore.getState();
    if (
      !selection ||
      state.activeSessionId !== sessionId ||
      state.workspace?.path !== workspacePath ||
      !state.messages.some((row) => row.id === message.id)
    )
      return;
    const feedback = createReviewFeedback(
      change,
      sessionId ?? "",
      workspacePath,
      selection.hunk,
      selection.anchor,
      selection.end,
      comment,
    );
    if (!feedback) return;
    if (!stageReviewFeedback(feedback)) {
      setError(t("panel.review.feedback.pending"));
      return;
    }
    lineSelection.clear();
    setComment("");
    state.showToast(t("panel.review.feedback.added"), { variant: "info" });
  };
  const form =
    selection && !dragging ? (
      <div className="review-feedback-form">
        <label htmlFor={inputId}>{t("panel.review.feedback.comment")}</label>
        <textarea
          ref={textareaRef}
          id={inputId}
          value={comment}
          maxLength={MAX_REVIEW_COMMENT}
          onChange={(event) => setComment(event.target.value)}
        />
        {oversized ? (
          <p role="alert">{t("panel.review.feedback.tooLarge")}</p>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        <div>
          <button
            type="button"
            disabled={
              !comment.trim() || oversized || !sessionId || !workspacePath
            }
            onClick={add}
          >
            {t("panel.review.feedback.add")}
          </button>
          <button
            type="button"
            onClick={() => {
              lineSelection.clear();
              setComment("");
              setError("");
            }}
          >
            {t("common.cancel")}
          </button>
        </div>
      </div>
    ) : null;
  return (
    <div className="review-feedback-editor" ref={lineSelection.rootRef}>
      <div className="review-change-diff">
        {change.hunks.map((hunk, hunkIndex) => {
          const rows = reviewFeedbackLines(hunk);
          return (
            <div className="diff-hunk" key={`${hunk.header}-${hunkIndex}`}>
              <div className="diff-line hunk">
                <span className="diff-line-text">{hunk.header}</span>
              </div>
              {hunk.lines.map((line, lineIndex) => {
                const row = rows[lineIndex];
                const selected =
                  selection?.hunk === hunkIndex &&
                  lineIndex >= Math.min(selection.anchor, selection.end) &&
                  lineIndex <= Math.max(selection.anchor, selection.end);
                return (
                  <Fragment key={lineIndex}>
                    <div
                      data-review-hunk={hunkIndex}
                      data-review-line={lineIndex}
                      className={`diff-line ${line.type}${selected ? " is-feedback-selected" : ""}`}
                    >
                      {row && enabled ? (
                        <span className="review-line-gutter">
                          <button
                            type="button"
                            className="review-line-select"
                            aria-pressed={selected}
                            aria-label={t("panel.review.feedback.line", {
                              old: row.oldLine ?? "–",
                              new: row.newLine ?? "–",
                            })}
                            title={t("panel.review.feedback.selectHint")}
                            onPointerDown={(event) => {
                              setError("");
                              lineSelection.start(event, hunkIndex, lineIndex);
                            }}
                            onPointerMove={lineSelection.move}
                            onPointerUp={lineSelection.finish}
                            onPointerCancel={lineSelection.cancel}
                            onLostPointerCapture={lineSelection.cancel}
                            onClick={(event) => {
                              if (event.detail === 0) {
                                setError("");
                                lineSelection.keyboardSelect(
                                  hunkIndex,
                                  lineIndex,
                                  event.shiftKey,
                                );
                              }
                            }}
                          >
                            <IconPlus size={12} />
                          </button>
                          <span className="review-line-number" aria-hidden>
                            {row.oldLine ?? "–"}/{row.newLine ?? "–"}
                          </span>
                        </span>
                      ) : null}
                      <span className="diff-line-sign" aria-hidden>
                        {line.type === "add"
                          ? "+"
                          : line.type === "del"
                            ? "−"
                            : " "}
                      </span>
                      <span className="diff-line-text">{line.text}</span>
                    </div>
                    {anchor?.hunk === hunkIndex &&
                    anchor.line === lineIndex &&
                    feedback ? (
                      <ReviewPendingFeedback feedback={feedback} />
                    ) : null}
                    {selection?.hunk === hunkIndex &&
                    lineIndex === Math.max(selection.anchor, selection.end)
                      ? form
                      : null}
                  </Fragment>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

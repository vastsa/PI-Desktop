import { useEffect, useRef } from "react";
import type { TFunction } from "i18next";
import { TooltipButton } from "../../../components/ui";
import {
  IconArrowDown,
  IconArrowUp,
  IconFolder,
  IconPencil,
  IconX,
} from "../../../components/icons";
import type { ComposerDropItem } from "../../../lib/composer-drop";
import {
  isPendingQueuedPrompt,
  isPromotedQueuedPrompt,
  type QueuedPrompt,
  type QueuedPromptDirection,
} from "../../../lib/queued-prompts";
import { useAppStore } from "../../../stores/app-store";

export type ComposerStatusProps = {
  t: TFunction;
  queuedPrompts: readonly QueuedPrompt[];
  removeQueuedPrompt: (id: string) => void;
  moveQueuedPrompt: (id: string, direction: QueuedPromptDirection) => Promise<void>;
  editQueuedPrompt: (id: string) => void;
  sendQueuedNow: (id: string) => Promise<void>;
  approvalPending: boolean;
  enhancementError: { message: string; code: string } | null;
  clearEnhancementError: () => void;
  droppedDirectories: ComposerDropItem[];
  openDroppedFolderAsProject: () => Promise<void>;
  insertDroppedDirectoryPaths: () => void;
  dismissDroppedDirectories: () => void;
};

/** Non-editor composer status rows: queue, folder drops, and the one-shot
 *  enhancement failure, which is reported through the global toast. */
export function ComposerStatus({
  t,
  queuedPrompts,
  removeQueuedPrompt,
  moveQueuedPrompt,
  editQueuedPrompt,
  sendQueuedNow,
  approvalPending,
  enhancementError,
  clearEnhancementError,
  droppedDirectories,
  openDroppedFolderAsProject,
  insertDroppedDirectoryPaths,
  dismissDroppedDirectories,
}: ComposerStatusProps) {
  const showToast = useAppStore((state) => state.showToast);
  // A failed enhancement is a one-shot result of the Enhance action: it goes to
  // the toast stack and the pending error is cleared, so a remount can neither
  // re-report it nor render the old inline row again.
  const reportedEnhancementError = useRef<string | null>(null);
  useEffect(() => {
    if (!enhancementError) {
      reportedEnhancementError.current = null;
      return;
    }
    const key = `${enhancementError.code}\u0000${enhancementError.message}`;
    if (reportedEnhancementError.current === key) return;
    reportedEnhancementError.current = key;
    // The store already reads the provider's own answer as either a specific
    // reason or the generic failure, so the sentence is not prefixed again; the
    // inline row carried the verbatim code, so the toast keeps it.
    showToast(
      `${enhancementError.message} (${enhancementError.code})`,
      { variant: "error" },
    );
    clearEnhancementError();
  }, [enhancementError, clearEnhancementError, showToast, t]);

  return (
    <>
      {queuedPrompts.length ? (
        <div
          className="composer-queued-prompts"
          role="list"
          aria-label={t("chat.queuedPrompts")}
        >
          {queuedPrompts.map((item) => {
            const label =
              item.content.trim() ||
              item.draft.fileReferences.map((reference) => reference.name).join(", ") ||
              t("chat.queuedPromptEmpty");
            const promoted = isPromotedQueuedPrompt(item);
            const pending = isPendingQueuedPrompt(item);
            const actionsLocked = promoted || pending;
            const sendNowLocked = approvalPending || actionsLocked;
            // Pending rows have no Host id. Promoted rows keep their order,
            // but remain cancellable until the Host starts delivery.
            const actionLabel = (action: string) =>
              promoted
                ? `${action} · ${t("chat.sendNowPending")}`
                : pending
                  ? `${action} · ${t("common.saving")}`
                  : action;
            return (
              <div
                key={item.id}
                className="composer-queued-prompt"
                role="listitem"
                data-testid="queued-prompt"
                data-priority={promoted ? "true" : "false"}
              >
                <span className="composer-queued-prompt-text" title={label}>
                  {label}
                </span>
                <TooltipButton
                  type="button"
                  className="composer-queued-prompt-action composer-queued-prompt-move-up"
                  tooltip={actionLabel(t("chat.moveQueuedPromptUp"))}
                  ariaLabel={actionLabel(t("chat.moveQueuedPromptUp"))}
                  disabled={actionsLocked}
                  aria-disabled={actionsLocked}
                  onClick={() => void moveQueuedPrompt(item.id, "up")}
                >
                  <IconArrowUp size={13} aria-hidden />
                </TooltipButton>
                <TooltipButton
                  type="button"
                  className="composer-queued-prompt-action composer-queued-prompt-move-down"
                  tooltip={actionLabel(t("chat.moveQueuedPromptDown"))}
                  ariaLabel={actionLabel(t("chat.moveQueuedPromptDown"))}
                  disabled={actionsLocked}
                  aria-disabled={actionsLocked}
                  onClick={() => void moveQueuedPrompt(item.id, "down")}
                >
                  <IconArrowDown size={13} aria-hidden />
                </TooltipButton>
                <TooltipButton
                  type="button"
                  className="composer-queued-prompt-send-now"
                  tooltip={actionLabel(t("chat.sendNow"))}
                  ariaLabel={actionLabel(t("chat.sendNow"))}
                  disabled={sendNowLocked}
                  aria-disabled={sendNowLocked}
                  onClick={() => void sendQueuedNow(item.id)}
                >
                  {promoted
                    ? t("chat.sendNowPending")
                    : pending
                      ? t("common.saving")
                      : t("chat.sendNow")}
                </TooltipButton>
                <TooltipButton
                  type="button"
                  className="composer-queued-prompt-action composer-queued-prompt-edit"
                  tooltip={actionLabel(t("chat.editQueuedPrompt"))}
                  ariaLabel={actionLabel(t("chat.editQueuedPrompt"))}
                  disabled={actionsLocked}
                  aria-disabled={actionsLocked}
                  onClick={() => editQueuedPrompt(item.id)}
                >
                  <IconPencil size={13} aria-hidden />
                </TooltipButton>
                <TooltipButton
                  type="button"
                  className="composer-queued-prompt-action composer-queued-prompt-remove"
                  tooltip={pending ? actionLabel(t("chat.removeQueuedPrompt")) : t("chat.removeQueuedPrompt")}
                  ariaLabel={pending ? actionLabel(t("chat.removeQueuedPrompt")) : t("chat.removeQueuedPrompt")}
                  disabled={pending}
                  aria-disabled={pending}
                  onClick={() => removeQueuedPrompt(item.id)}
                >
                  <IconX size={13} aria-hidden />
                </TooltipButton>
              </div>
            );
          })}
        </div>
      ) : null}
      {droppedDirectories.length ? (
        <div className="composer-directory-drop" role="status">
          <IconFolder size={13} aria-hidden />
          <span className="composer-directory-drop-name">
            {t("project.droppedFolder", {
              count: droppedDirectories.length,
              defaultValue: "Folder dropped",
            })}
          </span>
          <button
            type="button"
            className="composer-directory-drop-action"
            data-action="open-dropped-folder-project"
            onClick={() => void openDroppedFolderAsProject()}
          >
            {t("project.openAsProject", { defaultValue: "Open as project" })}
          </button>
          <button
            type="button"
            className="composer-directory-drop-action"
            data-action="reference-dropped-folder"
            onClick={insertDroppedDirectoryPaths}
          >
            {t("project.referenceFolder", { defaultValue: "Reference folder" })}
          </button>
          <TooltipButton
            type="button"
            className="composer-directory-drop-dismiss"
            tooltip={t("nav.dismissFolderDrop")}
            ariaLabel={t("nav.dismissFolderDrop")}
            onClick={dismissDroppedDirectories}
          >
            <IconX size={13} aria-hidden />
          </TooltipButton>
        </div>
      ) : null}
    </>
  );
}

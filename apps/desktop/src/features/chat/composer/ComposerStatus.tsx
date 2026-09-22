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

/** Non-editor composer status rows: queue, enhancement errors, and folder drops. */
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
            // Pending rows have no actionable Host id; promoted rows already
            // belong to the next turn. Explain both locked states.
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
                  tooltip={actionLabel(t("chat.removeQueuedPrompt"))}
                  ariaLabel={actionLabel(t("chat.removeQueuedPrompt"))}
                  disabled={actionsLocked}
                  aria-disabled={actionsLocked}
                  onClick={() => removeQueuedPrompt(item.id)}
                >
                  <IconX size={13} aria-hidden />
                </TooltipButton>
              </div>
            );
          })}
        </div>
      ) : null}
      {enhancementError ? (
        <div className="composer-enhancement-error" role="alert">
          <span className="composer-enhancement-error-message">
            {t("chat.enhancementFailed")}: {enhancementError.message}
          </span>
          <code>{enhancementError.code}</code>
          <TooltipButton
            type="button"
            className="composer-enhancement-error-dismiss"
            tooltip={t("chat.dismissEnhancementError")}
            ariaLabel={t("chat.dismissEnhancementError")}
            onClick={clearEnhancementError}
          >
            <IconX size={13} aria-hidden="true" />
          </TooltipButton>
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

import type { TFunction } from "i18next";
import { TooltipButton } from "../../../components/ui";
import { IconFolder, IconX } from "../../../components/icons";
import type { ComposerDropItem } from "../../../lib/composer-drop";
import type { QueuedPrompt } from "../../../lib/queued-prompts";

export type ComposerStatusProps = {
  t: TFunction;
  queuedPrompts: readonly QueuedPrompt[];
  removeQueuedPrompt: (id: string) => void;
  sendQueuedNow: (id: string) => Promise<void>;
  approvalPending: boolean;
  runActive: boolean;
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
  sendQueuedNow,
  approvalPending,
  runActive,
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
            return (
              <div
                key={item.id}
                className="composer-queued-prompt"
                role="listitem"
                data-testid="queued-prompt"
              >
                <span className="composer-queued-prompt-text" title={label}>
                  {label}
                </span>
                <TooltipButton
                  type="button"
                  className="composer-queued-prompt-action"
                  tooltip={t("chat.removeQueuedPrompt")}
                  ariaLabel={t("chat.removeQueuedPrompt")}
                  onClick={() => removeQueuedPrompt(item.id)}
                >
                  <IconX size={13} aria-hidden />
                </TooltipButton>
                <button
                  type="button"
                  className="composer-queued-prompt-send-now"
                  disabled={approvalPending || (runActive && item.sendNowRequested === true)}
                  onClick={() => void sendQueuedNow(item.id)}
                >
                  {item.sendNowRequested ? t("chat.sendNowPending") : t("chat.sendNow")}
                </button>
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

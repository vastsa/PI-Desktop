import { ComposerReferenceText } from "./ComposerReferenceText";
import { parseComposerPromptDisplay } from "@pi-desktop/shared";
import {
  memo,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { UiMessage } from "@pi-desktop/shared";
import { useOpenChatFileRef } from "../../../hooks/use-preview-target";
import { splitChatText } from "../../../lib/chat-links";
import { useAppStore } from "../../../stores/app-store";
import { Markdown } from "../../../components/Markdown";
import {
  IconChevronLeft,
  IconChevronRight,
  IconPencil,
  IconTrash,
} from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";
import { userMessageMenuItems } from "./menu-items";
import { SessionMessageOrigin } from "./SessionMessageOrigin";
import {
  CopyButton,
  FileRefChip,
  LinkifiedText,
  MessageAttachmentImage,
} from "./shared";
import {
  useChatTextActions,
  useTranscriptMenu,
} from "./TranscriptMenu";

export const MessageRow = memo(function MessageRow({
  message,
  isRunning,
}: {
  message: UiMessage;
  isRunning: boolean;
}) {
  const { t } = useTranslation();
  const openTranscriptMenu = useTranscriptMenu();
  const { copyText, selectText } = useChatTextActions();
  const editUserMessage = useAppStore((s) => s.editUserMessage);
  const activateMessageRevision = useAppStore((s) => s.activateMessageRevision);
  const deleteMessage = useAppStore((s) => s.deleteMessage);
  const isUser = message.role === "user";
  const isSessionMessage = Boolean(message.sessionMessage);
  const editableUserMessage = isUser && !isSessionMessage;
  const workspaceRoot = useAppStore((s) => s.workspace?.path);
  const openFileRef = useOpenChatFileRef();
  // Slash prompts are stored expanded; editing works on the typed form so the
  // resent turn re-expands the template (D123).
  const referenceDisplay = isUser ? parseComposerPromptDisplay(message.composerDisplay) : undefined;
  const editSeed =
    referenceDisplay?.content ?? ((editableUserMessage && message.command) || (message.content || ""));
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(editSeed);
  const [retryingEdit, setRetryingEdit] = useState(false);
  const copyLabel = t("chat.copy");
  const editLabel = t("chat.editMessage");
  const deleteLabel = t("chat.deleteMessage");
  // Runtime chunks are already progressive. Rendering that source directly
  // avoids a second per-frame state loop while Markdown memoizes stable blocks.
  const displayed = referenceDisplay?.content ?? message.content ?? "";
  const hasAnswer = Boolean((message.content || "").trim());
  const revisionCount = message.revisionCount ?? 0;
  const activeRevision = message.activeRevision ?? revisionCount;
  const showRevisionPager = editableUserMessage && revisionCount > 1;
  const extraAttachments = useMemo(() => {
    const attachments = message.attachments;
    if (!attachments?.length) return [];
    const inline = new Set(
      splitChatText(displayed, workspaceRoot)
        .filter((segment): segment is { kind: "target"; text: string; label: string; target: { kind: "file"; path: string } } => segment.kind === "target" && segment.target.kind === "file")
        .map((segment) => segment.target.path),
    );
    return attachments.filter((attachment) => !inline.has(attachment.ref));
  }, [message.attachments, displayed, workspaceRoot]);
  const cancelEdit = () => {
    setEditValue(editSeed);
    setEditing(false);
  };
  const retryEdit = async () => {
    const next = editValue.trim();
    if (!editableUserMessage || retryingEdit || (!next && !message.attachments?.length)) return;
    setRetryingEdit(true);
    const saved = await editUserMessage(message.id, next, message.attachments);
    setRetryingEdit(false);
    if (saved) setEditing(false);
  };
  /*
    The pointer path to the actions the hover row already offers. Only a human
    turn is owned here: an assistant answer belongs to its turn, so this row
    must not answer for one — it would offer Copy without the Regenerate and
    Branch items that live on the turn.
  */
  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!isUser) return;
    openTranscriptMenu(event, {
      label: t("chat.messageMenu"),
      items: userMessageMenuItems({
        t,
        text: editing ? editValue : displayed,
        selectTarget: event.currentTarget.querySelector<HTMLElement>(
          editing ? ".message-edit-input" : ".message-bubble",
        ),
        editable: editableUserMessage && !editing,
        running: isRunning,
        revision: !editing && showRevisionPager
          ? { count: revisionCount, active: activeRevision }
          : null,
        actions: { copyText, selectText },
        onEdit: () => {
          setEditValue(editSeed);
          setEditing(true);
        },
        onDelete: () => void deleteMessage(message.id),
        onActivateRevision: (index) =>
          void activateMessageRevision(message.id, index),
      }),
    });
  };
  return (
    <div
      className={`message-row ${isSessionMessage ? "session-message" : isUser ? "user" : message.role}`}
      data-minimap-id={message.id}
      data-message-id={message.id}
      data-row-role={isSessionMessage ? undefined : "user"}
      onContextMenu={onContextMenu}
      role="article"
      aria-label={isSessionMessage ? t("sessionCollaboration.agentMessage") : isUser ? t("chat.userMessage") : t("chat.assistantMessage")}
    >
      <div className="message-col">
        {message.sessionMessage ? <SessionMessageOrigin origin={message.sessionMessage} /> : null}
        {isUser || displayed ? (
          <div className="message-bubble">
            {editing && editableUserMessage ? (
              <form
                className="message-edit"
                aria-busy={retryingEdit || undefined}
                onSubmit={(event) => {
                  event.preventDefault();
                  void retryEdit();
                }}
              >
                <textarea
                  className="message-edit-input selectable"
                  value={editValue}
                  rows={Math.min(12, Math.max(3, editValue.split("\n").length))}
                  aria-label={editLabel}
                  autoFocus
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  disabled={retryingEdit}
                  onChange={(event) => setEditValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      cancelEdit();
                    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      void retryEdit();
                    }
                  }}
                />
                <div className="message-edit-actions">
                  <button
                    type="button"
                    className="icon-btn message-edit-cancel"
                    disabled={retryingEdit}
                    onClick={cancelEdit}
                  >
                    {t("chat.cancelEdit")}
                  </button>
                  <button
                    type="submit"
                    className="send-btn message-edit-submit"
                    disabled={retryingEdit || (!editValue.trim() && !message.attachments?.length)}
                  >
                    {retryingEdit ? t("chat.retryingEdit") : t("chat.retryEdit")}
                  </button>
                </div>
              </form>
            ) : isUser ? (
              <>
                {extraAttachments.length ? (
                  <div
                    className="message-attachments"
                    role="list"
                    aria-label={t("chat.messageAttachments")}
                  >
                    {extraAttachments.map((attachment) =>
                      attachment.kind === "image" ? (
                        <MessageAttachmentImage
                          key={`${attachment.ref}:${attachment.name}`}
                          attachment={attachment}
                          onOpenFile={openFileRef}
                        />
                      ) : (
                        <span
                          key={`${attachment.ref}:${attachment.name}`}
                          role="listitem"
                        >
                          <FileRefChip
                            name={attachment.name}
                            path={attachment.ref}
                            kind={attachment.kind}
                            onOpen={openFileRef}
                          />
                        </span>
                      ),
                    )}
                  </div>
                ) : null}
                {message.content ? (
                  <div className="message-user-text selectable">
                    {referenceDisplay ? (
                      <ComposerReferenceText display={referenceDisplay} fallback={message.content} />
                    ) : editableUserMessage && message.command ? (
                      // Slash invocations show the typed form as a chip; the
                      // expanded template body lives in `content` (hover reveals
                      // it) and is what regenerate/reseed replay (D123).
                      <code
                        className="chat-command-chip"
                        data-source-start={0}
                        data-source-end={message.content.length}
                        title={String(message.content || "")}
                      >
                        {message.command}
                      </code>
                    ) : (
                      <LinkifiedText text={String(message.content || "")} attachments={message.attachments} />
                    )}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="prose-chat">
                <Markdown source={displayed} />
              </div>
            )}
          </div>
        ) : null}
        {!editing && (hasAnswer || showRevisionPager) ? (
          <div className="message-actions">
            {showRevisionPager ? (
              <div className="message-revision-pager" role="group" aria-label={t("chat.revisions")}>
                <TooltipButton
                  className="copy-btn icon revision-nav"
                  tooltip={t("chat.revisionPrev")}
                  ariaLabel={t("chat.revisionPrev")}
                  disabled={isRunning || activeRevision <= 1}
                  onClick={() =>
                    void activateMessageRevision(message.id, Math.max(1, activeRevision - 1))
                  }
                >
                  <IconChevronLeft size={13} />
                </TooltipButton>
                <span className="message-revision-label">
                  {t("chat.revisionPager", {
                    current: activeRevision,
                    total: revisionCount,
                  })}
                </span>
                <TooltipButton
                  className="copy-btn icon revision-nav"
                  tooltip={t("chat.revisionNext")}
                  ariaLabel={t("chat.revisionNext")}
                  disabled={isRunning || activeRevision >= revisionCount}
                  onClick={() =>
                    void activateMessageRevision(
                      message.id,
                      Math.min(revisionCount, activeRevision + 1),
                    )
                  }
                >
                  <IconChevronRight size={13} />
                </TooltipButton>
              </div>
            ) : null}
            {hasAnswer ? <CopyButton text={displayed} label={copyLabel} /> : null}
            {editableUserMessage ? (
              <TooltipButton
                className="copy-btn icon"
                tooltip={editLabel}
                ariaLabel={editLabel}
                disabled={isRunning}
                onClick={() => {
                  setEditValue(editSeed);
                  setEditing(true);
                }}
              >
                <IconPencil size={13} />
              </TooltipButton>
            ) : null}
            {editableUserMessage ? (
              <TooltipButton
                className="copy-btn icon danger"
                tooltip={deleteLabel}
                ariaLabel={deleteLabel}
                disabled={isRunning}
                onClick={() => void deleteMessage(message.id)}
              >
                <IconTrash size={13} />
              </TooltipButton>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
});

import {
  memo,
  useMemo,
  useState,
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
import {
  CopyButton,
  FileRefChip,
  LinkifiedText,
  MessageAttachmentImage,
} from "./shared";

export const MessageRow = memo(function MessageRow({
  message,
  isRunning,
}: {
  message: UiMessage;
  isRunning: boolean;
}) {
  const { t } = useTranslation();
  const editUserMessage = useAppStore((s) => s.editUserMessage);
  const activateMessageRevision = useAppStore((s) => s.activateMessageRevision);
  const deleteMessage = useAppStore((s) => s.deleteMessage);
  const isUser = message.role === "user";
  const workspaceRoot = useAppStore((s) => s.workspace?.path);
  const openFileRef = useOpenChatFileRef();
  // Slash prompts are stored expanded; editing works on the typed form so the
  // resent turn re-expands the template (D123).
  const editSeed = (isUser && message.command) || message.content || "";
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(editSeed);
  const [retryingEdit, setRetryingEdit] = useState(false);
  const copyLabel = t("chat.copy");
  const editLabel = t("chat.editMessage");
  const deleteLabel = t("chat.deleteMessage");
  // Runtime chunks are already progressive. Rendering that source directly
  // avoids a second per-frame state loop while Markdown memoizes stable blocks.
  const displayed = message.content || "";
  const hasAnswer = Boolean((message.content || "").trim());
  const revisionCount = message.revisionCount ?? 0;
  const activeRevision = message.activeRevision ?? revisionCount;
  const showRevisionPager = isUser && revisionCount > 1;
  const extraAttachments = useMemo(() => {
    const attachments = message.attachments;
    if (!attachments?.length) return [];
    const inline = new Set(
      splitChatText(String(message.content || ""), workspaceRoot)
        .filter((segment): segment is { kind: "target"; text: string; label: string; target: { kind: "file"; path: string } } => segment.kind === "target" && segment.target.kind === "file")
        .map((segment) => segment.target.path),
    );
    return attachments.filter((attachment) => !inline.has(attachment.ref));
  }, [message.attachments, message.content, workspaceRoot]);
  const cancelEdit = () => {
    setEditValue(editSeed);
    setEditing(false);
  };
  const retryEdit = async () => {
    const next = editValue.trim();
    if (retryingEdit || (!next && !message.attachments?.length)) return;
    setRetryingEdit(true);
    const saved = await editUserMessage(message.id, next, message.attachments);
    setRetryingEdit(false);
    if (saved) setEditing(false);
  };
  return (
    <div
      className={`message-row ${isUser ? "user" : message.role}`}
      data-minimap-id={message.id}
      role="article"
      aria-label={isUser ? t("chat.userMessage") : t("chat.assistantMessage")}
    >
      <div className="message-col">
        {isUser || displayed ? (
          <div className="message-bubble">
            {editing ? (
              <div className="message-edit">
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
                    className="copy-btn"
                    disabled={retryingEdit}
                    onClick={cancelEdit}
                  >
                    {t("chat.cancelEdit")}
                  </button>
                  <button
                    type="button"
                    className="copy-btn primary"
                    disabled={retryingEdit || (!editValue.trim() && !message.attachments?.length)}
                    onClick={() => void retryEdit()}
                  >
                    {retryingEdit ? t("chat.retryingEdit") : t("chat.retryEdit")}
                  </button>
                </div>
              </div>
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
                    {message.command ? (
                      // Slash invocations show the typed form as a chip; the
                      // expanded template body lives in `content` (hover reveals
                      // it) and is what regenerate/reseed replay (D123).
                      <code
                        className="chat-command-chip"
                        title={String(message.content || "")}
                      >
                        {message.command}
                      </code>
                    ) : (
                      <LinkifiedText text={String(message.content || "")} />
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
            {hasAnswer ? <CopyButton text={message.content} label={copyLabel} /> : null}
            {isUser ? (
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
            {isUser ? (
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

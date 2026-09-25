/**
 * The transcript's context-menu vocabulary, as pure functions of the state a
 * row already knows.
 *
 * Three surfaces build menus over the same actions — a user row, an assistant
 * turn, the conversation background — and they must not each decide for
 * themselves which item is available when. Keeping the decision here means the
 * item set for a state is a plain value that a test can assert, while the
 * components stay wiring.
 *
 * Each builder mirrors the hover action row it belongs to. `separatorBefore`
 * marks the transition from "read this" to "act on this", so a menu with only
 * one group never paints a leading rule.
 */
import type { TFunction } from "i18next";
import {
  IconArrowDown,
  IconArrowUp,
  IconBranch,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconPencil,
  IconReview,
  IconTextSelect,
  IconTrash,
} from "../../../components/icons";
import type { ContextMenuItem } from "../../../components/ContextMenu";

/** Actions the builders call; the components own their real implementations. */
export type MenuItemActions = {
  copyText: (text: string, selection?: string) => void;
  selectText: (element: HTMLElement | null) => void;
};

/**
 * A human turn: read it, or change it.
 *
 * Delete is separated from Edit rather than placed beside it: it is the only
 * item that destroys durable history, and Edit's undo is a revision the user can
 * walk back to.
 */
export function userMessageMenuItems({
  t,
  text,
  selectTarget,
  editable,
  running,
  revision,
  actions,
  onEdit,
  onDelete,
  onActivateRevision,
}: {
  t: TFunction;
  text: string;
  selectTarget: HTMLElement | null;
  /** Session-relayed turns are not human input, so they cannot be edited. */
  editable: boolean;
  running: boolean;
  /** Present only while a regenerate left more than one version behind. */
  revision: { count: number; active: number } | null;
  actions: MenuItemActions;
  onEdit: () => void;
  onDelete: () => void;
  onActivateRevision: (index: number) => void;
}): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (text.trim()) {
    items.push({
      id: "copy",
      label: t("chat.copy"),
      icon: copyIcon(),
      onSelect: (selection) => actions.copyText(text, selection),
    });
    items.push({
      id: "select-text",
      label: t("chat.selectMessageText"),
      icon: selectIcon(),
      onSelect: () => actions.selectText(selectTarget),
    });
  }
  if (editable) {
    items.push({
      id: "edit",
      label: t("chat.editMessage"),
      icon: pencilIcon(),
      disabled: running,
      separatorBefore: items.length > 0,
      onSelect: onEdit,
    });
  }
  if (revision) {
    items.push({
      id: "revision-previous",
      label: t("chat.revisionPrev"),
      icon: previousIcon(),
      disabled: running || revision.active <= 1,
      separatorBefore: items.length > 0,
      onSelect: () => onActivateRevision(Math.max(1, revision.active - 1)),
    });
    items.push({
      id: "revision-next",
      label: t("chat.revisionNext"),
      icon: nextIcon(),
      disabled: running || revision.active >= revision.count,
      onSelect: () =>
        onActivateRevision(Math.min(revision.count, revision.active + 1)),
    });
  }
  if (editable) {
    items.push({
      id: "delete",
      label: t("chat.deleteMessage"),
      icon: trashIcon(),
      danger: true,
      disabled: running,
      separatorBefore: true,
      onSelect: onDelete,
    });
  }
  return items;
}

/**
 * An assistant turn: read the answer, or re-run it.
 *
 * Copy/Select need answer text, and Regenerate/Branch need a settled turn, so a
 * streaming or failed turn legitimately yields an empty list — the caller then
 * opens no menu at all rather than an empty one.
 */
export function assistantTurnMenuItems({
  t,
  answer,
  selectTarget,
  complete,
  canRegenerate = true,
  actions,
  onRegenerate,
  onBranch,
}: {
  t: TFunction;
  answer: string;
  selectTarget: HTMLElement | null;
  /** Idle, error-free, and backed by an answer message. */
  complete: boolean;
  /** The session's host can regenerate; a remote host cannot. */
  canRegenerate?: boolean;
  actions: MenuItemActions;
  onRegenerate: () => void;
  onBranch: () => void;
}): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (answer.trim()) {
    items.push({
      id: "copy",
      label: t("chat.copy"),
      icon: copyIcon(),
      onSelect: (selection) => actions.copyText(answer, selection),
    });
    items.push({
      id: "select-text",
      label: t("chat.selectMessageText"),
      icon: selectIcon(),
      onSelect: () => actions.selectText(selectTarget),
    });
  }
  if (complete) {
    const separatorBefore = items.length > 0;
    if (canRegenerate) {
      items.push({
        id: "regenerate",
        label: t("chat.retry"),
        icon: regenerateIcon(),
        separatorBefore,
        onSelect: onRegenerate,
      });
    }
    items.push({
      id: "branch",
      label: t("chat.forkResponse"),
      icon: branchIcon(),
      ...(canRegenerate ? {} : { separatorBefore }),
      onSelect: onBranch,
    });
  }
  return items;
}

/**
 * The conversation background: the actions that need the whole thread, which no
 * single row can offer.
 */
export function conversationMenuItems({
  t,
  canCopy,
  onCopyConversation,
  scrollRef,
  contentRef,
  actions,
  onReturnToLatest,
}: {
  t: TFunction;
  /** The loaded window or older/newer history contains dialogue to copy. */
  canCopy: boolean;
  onCopyConversation: () => void;
  scrollRef: { current: HTMLElement | null };
  contentRef: { current: HTMLElement | null };
  actions: MenuItemActions;
  onReturnToLatest: () => void;
}): ContextMenuItem[] {
  const scrollTo = (top: number) => () => scrollRef.current?.scrollTo({ top });
  return [
    {
      id: "copy-conversation",
      label: t("chat.copyConversation"),
      icon: copyIcon(),
      disabled: !canCopy,
      // The labelled thread is the action; a live selection belongs to Copy on a turn.
      onSelect: () => onCopyConversation(),
    },
    {
      id: "select-conversation",
      label: t("chat.selectConversationText"),
      icon: selectIcon(),
      separatorBefore: true,
      onSelect: () => actions.selectText(contentRef.current),
    },
    {
      id: "scroll-top",
      label: t("chat.scrollToTop"),
      icon: upIcon(),
      separatorBefore: true,
      onSelect: scrollTo(0),
    },
    {
      id: "scroll-bottom",
      label: t("chat.scrollToBottom"),
      icon: downIcon(),
      // Re-entering follow mode is part of jumping to the end: without it the
      // scroller would scroll once and then stay pinned where it landed.
      onSelect: onReturnToLatest,
    },
  ];
}

/*
  Icons arrive as elements rather than components so a builder stays a plain
  function of data. They are created per call, which React reconciles by
  position inside the menu — the same shape the hover toolbar already uses.
*/
function copyIcon() {
  return <IconCopy size={14} />;
}

function selectIcon() {
  return <IconTextSelect size={14} />;
}

function pencilIcon() {
  return <IconPencil size={14} />;
}

function trashIcon() {
  return <IconTrash size={14} />;
}

function previousIcon() {
  return <IconChevronLeft size={14} />;
}

function nextIcon() {
  return <IconChevronRight size={14} />;
}

function regenerateIcon() {
  return <IconReview size={14} />;
}

function branchIcon() {
  return <IconBranch size={14} />;
}

function upIcon() {
  return <IconArrowUp size={14} />;
}

function downIcon() {
  return <IconArrowDown size={14} />;
}

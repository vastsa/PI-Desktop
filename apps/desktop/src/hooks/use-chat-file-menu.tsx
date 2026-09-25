/**
 * The right-click action every file reference in the conversation shares.
 *
 * A reference the transcript already recognises as a file — a chip on a turn, an
 * inline code span, a link, a local image — is a file the user can open with one
 * click, so its menu offers the destination a click has no room for: the file's
 * own folder in the system file manager. The reference travels through the same
 * completion a click uses (`useRevealChatFileRef`, ADR 0262/0263), so a
 * reference that resolved to nothing says so instead of revealing a lookalike
 * somewhere else.
 *
 * Items are data, exactly as `ContextMenu` takes them: every surface keeps the
 * menu instance it already owns and shares only this vocabulary, so a row that
 * already has items of its own (a markdown link) adds this one instead of
 * opening a second surface.
 */
import { useCallback, type MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useContextMenu, type ContextMenuItem } from "../components/ContextMenu";
import { IconCopy, IconFolderOpen } from "../components/icons";
import { useCopyChatFileRef, useRevealChatFileRef } from "./use-preview-target";

export type ChatFileMenuTarget = {
  /** The reference as the surface spelled it, before completion. */
  path: string;
  /** Markdown file the reference was read from, for `./` and `../`. */
  baseDir?: string;
};

export function useChatFileMenuItems() {
  const { t } = useTranslation();
  const revealFileRef = useRevealChatFileRef();
  const copyFileRef = useCopyChatFileRef();
  return useCallback(
    ({ path, baseDir }: ChatFileMenuTarget): ContextMenuItem[] => [
      {
        id: "reveal-in-folder",
        label: t("chat.revealFileInFolder"),
        icon: <IconFolderOpen size={14} />,
        onSelect: () => revealFileRef(path, baseDir),
      },
      {
        id: "copy-full-path",
        label: t("chat.copyFullPath"),
        icon: <IconCopy size={14} />,
        separatorBefore: true,
        onSelect: () => copyFileRef(path, baseDir, "absolute"),
      },
      {
        id: "copy-relative-path",
        label: t("chat.copyRelativePath"),
        icon: <IconCopy size={14} />,
        onSelect: () => copyFileRef(path, baseDir, "relative"),
      },
    ],
    [copyFileRef, revealFileRef, t],
  );
}

/**
 * The item plus the open request, for a surface that owns its own menu.
 *
 * A row-level menu is a different surface from this one, so a reference inside
 * a row cannot hand its item to that menu's opener and still say which file it
 * means. Callers therefore take the pair and render one `<ContextMenu>` where
 * the reference lives — a tool row, a tool result list, an attachment
 * thumbnail — while `Markdown` shares a single pair across its whole tree.
 */
export function useChatFileMenu() {
  const fileMenuItems = useChatFileMenuItems();
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu();
  const openFileMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>, target: ChatFileMenuTarget) =>
      openContextMenu(event, { items: fileMenuItems(target) }),
    [fileMenuItems, openContextMenu],
  );
  return { fileMenu: contextMenu, openFileMenu, closeFileMenu: closeContextMenu };
}

/**
 * The right-click action every file reference in the conversation shares.
 *
 * HTML references expose explicit open destinations in the context menu: the
 * bundled File Manager, built-in browser, and default browser. Every local
 * reference can also be shown in its folder in the system file manager. Each
 * action goes through the same resolver as a normal click, so a reference that
 * resolves to nothing cannot open or reveal a lookalike somewhere else.
 *
 * Items are data, exactly as `ContextMenu` takes them: every surface keeps the
 * menu instance it already owns and shares only this vocabulary, so a row that
 * already has items of its own (a markdown link) adds this one instead of
 * opening a second surface.
 */
import { useCallback, type MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useContextMenu, type ContextMenuItem } from "../components/ContextMenu";
import {
  IconBrowser,
  IconCopy,
  IconExternal,
  IconFolderOpen,
  IconGlobe,
} from "../components/icons";
import { isHtmlFilePath } from "../lib/chat-links";
import { useChatNativeFilesAllowed } from "./use-chat-session-capability";
import {
  useCopyChatFileRef,
  useOpenChatFileRef,
  useRevealChatFileRef,
} from "./use-preview-target";

export type ChatFileMenuTarget = {
  /** The reference as the surface spelled it, before completion. */
  path: string;
  /** Markdown file the reference was read from, for `./` and `../`. */
  baseDir?: string;
};

export function useChatFileMenuItems() {
  const { t } = useTranslation();
  const nativeFilesAllowed = useChatNativeFilesAllowed();
  const openFileRef = useOpenChatFileRef();
  const revealFileRef = useRevealChatFileRef();
  const copyFileRef = useCopyChatFileRef();
  return useCallback(
    ({ path, baseDir }: ChatFileMenuTarget): ContextMenuItem[] => [
      ...(nativeFilesAllowed && isHtmlFilePath(path)
        ? [{
            id: "open-with",
            label: t("chat.openWith"),
            icon: <IconExternal size={14} />,
            submenu: [
              {
                id: "open-with-file-manager",
                label: t("chat.openWithFileManager"),
                icon: <IconFolderOpen size={14} />,
                onSelect: () =>
                  openFileRef(path, baseDir, undefined, {
                    destination: "file-manager",
                  }),
              },
              {
                id: "open-with-built-in-browser",
                label: t("chat.openWithBuiltInBrowser"),
                icon: <IconBrowser size={14} />,
                onSelect: () =>
                  openFileRef(path, baseDir, undefined, {
                    destination: "built-in-browser",
                  }),
              },
              {
                id: "open-with-default-browser",
                label: t("chat.openWithDefaultBrowser"),
                icon: <IconGlobe size={14} />,
                onSelect: () =>
                  openFileRef(path, baseDir, undefined, {
                    destination: "default-browser",
                  }),
              },
            ],
          }]
        : []),
      ...(nativeFilesAllowed
        ? [{
            id: "reveal-in-folder",
            label: t("chat.revealFileInFolder"),
            icon: <IconFolderOpen size={14} />,
            onSelect: () => revealFileRef(path, baseDir),
          }]
        : []),
      {
        id: "copy-full-path",
        label: t("chat.copyFullPath"),
        icon: <IconCopy size={14} />,
        separatorBefore: nativeFilesAllowed,
        onSelect: () => copyFileRef(path, baseDir, "absolute"),
      },
      {
        id: "copy-relative-path",
        label: t("chat.copyRelativePath"),
        icon: <IconCopy size={14} />,
        onSelect: () => copyFileRef(path, baseDir, "relative"),
      },
    ],
    [copyFileRef, nativeFilesAllowed, openFileRef, revealFileRef, t],
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

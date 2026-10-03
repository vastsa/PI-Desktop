/**
 * The transcript's right-click menu: one surface per conversation, fed by
 * whichever row the pointer asked from.
 *
 * The menu lives at the transcript level because a row cannot own a floating
 * layer that has to outlive it — deleting a message removes its row, and the
 * transcript scroller measures every row for the minimap. Rows therefore
 * publish a request through context (the same shape `TranscriptSearchContext`
 * and `DisclosureAnchorContext` use) and the provider renders exactly one
 * `<ContextMenu>`.
 *
 * The item vocabulary is the one the hover action rows already ship — Copy,
 * Edit, Delete, Regenerate, Branch, versions — now also reachable from the
 * keyboard-visible pointer path instead of hover only.
 */
import {
  createContext,
  useCallback,
  useContext,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  ContextMenu,
  useContextMenu,
  type ContextMenuRequest,
} from "../../../components/ContextMenu";
import { useAppStore } from "../../../stores/app-store";
import {
  copySelectionOrFallback,
} from "../../../lib/chat-transcript-text";

export type OpenTranscriptMenu = (
  event: ReactMouseEvent<HTMLElement>,
  request: ContextMenuRequest,
) => void;

/**
 * A row rendered outside the provider (tests, a focused single-row view) keeps
 * a working handler that opens nothing rather than throwing mid-render.
 */
export const TranscriptMenuContext = createContext<OpenTranscriptMenu>(() => {});

export function useTranscriptMenu(): OpenTranscriptMenu {
  return useContext(TranscriptMenuContext);
}

export function TranscriptMenuProvider({ children }: { children: ReactNode }) {
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu();
  return (
    <TranscriptMenuContext.Provider value={openContextMenu}>
      {children}
      <ContextMenu state={contextMenu} onClose={closeContextMenu} />
    </TranscriptMenuContext.Provider>
  );
}

/**
 * The clipboard and selection half of a menu item.
 *
 * A menu disappears the moment an item runs, so an item cannot report its
 * outcome through its own state the way the hover copy chips do (see `useCopy`);
 * the toast host carries the outcome instead.
 */
export function useChatTextActions() {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const addComposerExcerpt = useAppStore((state) => state.addComposerExcerpt);

  const copyText = useCallback(
    async (text: string, selection?: string) => {
      const payload = copySelectionOrFallback(selection, text);
      if (!payload) return;
      try {
        await navigator.clipboard.writeText(payload);
        showToast(t("chat.copied"), { variant: "success" });
      } catch {
        showToast(t("chat.copyFailed"), { variant: "error" });
      }
    },
    [showToast, t],
  );

  /*
    Selecting the row's rendered text hands a partial copy back to the platform:
    dragging across a long answer is the only way to take a sentence out of it,
    and the row is already on screen, so nothing needs measuring.
  */
  const selectText = useCallback((element: HTMLElement | null) => {
    if (element instanceof HTMLTextAreaElement) {
      element.focus();
      element.select();
      return;
    }
    const selection = window.getSelection();
    if (!element || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  }, []);

  const addToConversation = useCallback(
    (text: string, selection?: string) => {
      if (!activeSessionId) return;
      if (addComposerExcerpt(activeSessionId, copySelectionOrFallback(selection, text))) {
        showToast(t("chat.addedToConversation"), { variant: "success" });
      }
    },
    [activeSessionId, addComposerExcerpt, showToast, t],
  );

  return { copyText, selectText, addToConversation };
}

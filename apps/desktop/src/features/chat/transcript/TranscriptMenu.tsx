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
import { IconPlug } from "../../../components/icons";
import { api } from "../../../lib/api";
import { pluginViewIcon } from "../../../lib/plugin-view-icons";
import { pluginWorkPanelTab } from "../../../lib/work-panel-tabs";
import { useAppStore } from "../../../stores/app-store";
import { copySelectionOrFallback } from "../../../lib/chat-transcript-text";

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

export function TranscriptMenuProvider({ children, sessionId }: {
  children: ReactNode;
  sessionId?: string;
}) {
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu();
  const openTranscriptMenu: OpenTranscriptMenu = useCallback((event, request) => {
    const state = useAppStore.getState();
    const views = state.pluginViews.filter((view) => view.acceptsTranscriptSelection);
    if (views.length === 0) {
      openContextMenu(event, request);
      return;
    }
    const target = event.target instanceof Element ? event.target.closest(".message-bubble") : null;
    const selection = target && window.getSelection();
    if (!sessionId || sessionId !== state.activeSessionId || state.selectingSessionId || sessionId.startsWith("remote:") ||
        !target || !event.currentTarget.contains(target) || !selection || selection.isCollapsed ||
        !target.contains(selection.anchorNode) || !target.contains(selection.focusNode)) {
      openContextMenu(event, request);
      return;
    }
    openContextMenu(event, request, (text) => {
      if (!text.trim() || new TextEncoder().encode(text).length >= 64 * 1024) return [];
      return views.map((view, index) => {
        const Icon = pluginViewIcon(view.icon) ?? IconPlug;
        return {
          id: `plugin-selection:${view.ref}`,
          label: view.title,
          icon: <Icon size={14} />,
          separatorBefore: index === 0,
          onSelect: () => {
            const selected = useAppStore.getState();
            if (selected.activeSessionId !== sessionId || selected.selectingSessionId) return;
            void api.pluginViewOpen(view.pluginId, view.viewId, { sessionId, selection: text }).then(
              () => {
                const current = useAppStore.getState();
                if (current.activeSessionId === sessionId && !current.selectingSessionId) {
                  current.openWorkPanelTabForSession(sessionId, pluginWorkPanelTab(view.pluginId, view.viewId));
                }
              },
              (error: unknown) => {
                useAppStore.getState().showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
              },
            );
          },
        };
      });
    });
  }, [openContextMenu, sessionId]);

  return (
    <TranscriptMenuContext.Provider value={openTranscriptMenu}>
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

  return { copyText, selectText };
}

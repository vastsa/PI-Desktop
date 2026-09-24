import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { portalToBody } from "../../../lib/portal-visibility";
import { texClipboardPayload } from "../../../lib/selection-tex";
import { useAppStore } from "../../../stores/app-store";
import { useChatTextActions } from "./TranscriptMenu";

type SelectionAction = {
  text: string;
  rect: { left: number; right: number; top: number; bottom: number };
};

function elementForNode(node: Node | null): Element | null {
  return node instanceof Element ? node : node?.parentElement ?? null;
}

/** Only a selection inside one speaking turn's visible text is actionable. */
function transcriptSelection(root: HTMLElement): SelectionAction | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const anchor = elementForNode(selection.anchorNode);
  const focus = elementForNode(selection.focusNode);
  const row = anchor?.closest<HTMLElement>("[data-row-role]");
  if (!row || row !== focus?.closest("[data-row-role]") || !root.contains(row)) {
    return null;
  }
  const surface =
    row.dataset.rowRole === "user"
      ? ".message-bubble"
      : row.dataset.rowRole === "assistant"
        ? ".assistant-turn-fragment .prose-chat"
        : null;
  const anchorSurface = surface && anchor?.closest(surface);
  if (!anchorSurface || anchorSurface !== focus?.closest(surface)) return null;
  const text = texClipboardPayload(selection) ?? selection.toString();
  if (!text.trim()) return null;
  const viewport = root.getBoundingClientRect();
  const visibleTop = Math.max(0, viewport.top);
  const visibleBottom = Math.min(window.innerHeight, viewport.bottom);
  const rects = [...selection.getRangeAt(0).getClientRects()].filter(
    (rect) =>
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > visibleTop &&
      rect.top < visibleBottom,
  );
  const rect = rects.at(-1);
  if (!rect) return null;
  return {
    text,
    rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
  };
}

export function TranscriptSelectionAction({
  scrollRef,
  sessionId,
  visible,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  sessionId: string | undefined;
  visible: boolean;
}) {
  const { t } = useTranslation();
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const { addToConversation } = useChatTextActions();
  const [action, setAction] = useState<SelectionAction | null>(null);
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !sessionId || !visible) return;
    let pointerSelecting = false;
    let lastSelection: {
      anchorNode: Node | null;
      focusNode: Node | null;
      anchorOffset: number;
      focusOffset: number;
    } | null = null;
    const update = () => {
      if (pointerSelecting || toolbarRef.current?.contains(document.activeElement)) return;
      setAction(transcriptSelection(root));
    };
    const onPointerDown = () => { pointerSelecting = true; setAction(null); };
    const onPointerUp = () => { pointerSelecting = false; update(); };
    const onSelectionChange = () => {
      const selection = window.getSelection();
      if (
        lastSelection &&
        lastSelection.anchorNode === selection?.anchorNode &&
        lastSelection.focusNode === selection?.focusNode &&
        lastSelection.anchorOffset === selection?.anchorOffset &&
        lastSelection.focusOffset === selection?.focusOffset
      ) return;
      lastSelection = selection
        ? {
            anchorNode: selection.anchorNode,
            focusNode: selection.focusNode,
            anchorOffset: selection.anchorOffset,
            focusOffset: selection.focusOffset,
          }
        : null;
      update();
    };
    const onDismiss = () => setAction(null);
    const onOutsidePointerDown = (event: PointerEvent) => {
      if (root.contains(event.target as Node) || toolbarRef.current?.contains(event.target as Node)) return;
      onDismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    root.addEventListener("pointerdown", onPointerDown);
    root.addEventListener("pointerup", onPointerUp);
    root.addEventListener("contextmenu", onDismiss);
    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("pointerdown", onOutsidePointerDown, true);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("scroll", onDismiss, true);
    window.addEventListener("resize", onDismiss);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      root.removeEventListener("pointerdown", onPointerDown);
      root.removeEventListener("pointerup", onPointerUp);
      root.removeEventListener("contextmenu", onDismiss);
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("pointerdown", onOutsidePointerDown, true);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("scroll", onDismiss, true);
      window.removeEventListener("resize", onDismiss);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [scrollRef, sessionId, visible]);

  useEffect(() => { setAction(null); }, [sessionId, visible]);

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!action || !toolbar) { setPlacement(null); return; }
    const { width, height } = toolbar.getBoundingClientRect();
    const scroller = scrollRef.current?.getBoundingClientRect();
    const visibleTop = Math.max(8, scroller?.top ?? 8);
    const visibleBottom = Math.min(window.innerHeight - 8, scroller?.bottom ?? window.innerHeight - 8);
    const center = (action.rect.left + action.rect.right) / 2;
    const left = Math.max(8, Math.min(center - width / 2, window.innerWidth - width - 8));
    const below = action.rect.bottom + 8;
    const top = below + height <= visibleBottom
      ? below
      : Math.max(visibleTop, action.rect.top - height - 8);
    setPlacement({ left, top });
  }, [action, scrollRef]);

  if (!action || !sessionId || !visible) return null;
  return portalToBody(
    <div
      ref={toolbarRef}
      className={`transcript-selection-action${placement ? " is-open" : ""}`}
      role="toolbar"
      aria-label={t("chat.selectionActions")}
      style={placement ?? undefined}
    >
      <button
        type="button"
        data-selection-action="add-to-conversation"
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => {
          if (activeSessionId !== sessionId) return;
          addToConversation(action.text, action.text);
          setAction(null);
        }}
      >
        {t("chat.addToConversation")}
      </button>
    </div>,
  );
}

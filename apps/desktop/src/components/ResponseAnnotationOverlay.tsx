import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { ResponseAnnotation } from "../lib/response-annotations";
import { annotationRange, annotationRow, placeAnnotationBadges } from "../lib/response-annotation-anchor";
import { COMPOSER_DOCK_SELECTOR, intersectSelectionQuoteRect, selectionQuoteBounds, type SelectionQuoteRect } from "../lib/selection-quote";
import { useAppStore } from "../stores/app-store";
import { IconChevronDown, IconChevronRight, IconPencil, IconX } from "./icons";
import { TooltipButton } from "./ui";

const EMPTY: ResponseAnnotation[] = [];

/** One session's floating index and out-of-flow source badges; never edits Markdown. */
export function ResponseAnnotationOverlay({ sessionId, scrollRef, onNavigate }: {
  sessionId: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  onNavigate: (annotation: ResponseAnnotation) => void;
}) {
  const { t } = useTranslation();
  const annotations = useAppStore((state) => state.responseAnnotations[sessionId] ?? EMPTY);
  const edit = useAppStore((state) => state.openResponseAnnotationEditor);
  const remove = useAppStore((state) => state.removeResponseAnnotation);
  const clear = useAppStore((state) => state.clearResponseAnnotations);
  const [expanded, setExpanded] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [geometry, setGeometry] = useState<{
    badges: { id: string; index: number; left: number; top: number; exact: boolean }[];
    highlights: SelectionQuoteRect[];
  }>({ badges: [], highlights: [] });

  useEffect(() => {
    if (!annotations.some((annotation) => annotation.id === activeId)) setActiveId(null);
  }, [annotations, activeId]);

  useLayoutEffect(() => {
    const root = scrollRef.current;
    if (!root || !annotations.length) {
      setGeometry({ badges: [], highlights: [] });
      return;
    }
    let frame = 0;
    const measure = () => {
      frame = 0;
      const dock = document.querySelector(COMPOSER_DOCK_SELECTOR);
      const bounds = selectionQuoteBounds({ element: root,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        bottomBoundaryTop: dock?.getBoundingClientRect().top,
      });
      if (!bounds) { setGeometry({ badges: [], highlights: [] }); return; }
      const badges: typeof geometry.badges = [];
      const highlights: SelectionQuoteRect[] = [];
      annotations.forEach((annotation, index) => {
        const row = annotationRow(root, annotation.messageId);
        if (!row) return;
        const range = annotationRange(row, annotation.anchor);
        const rects = range ? Array.from(range.getClientRects()) : [row.getBoundingClientRect()];
        const visible = rects.map((rect) => intersectSelectionQuoteRect(rect, bounds))
          .filter((rect): rect is SelectionQuoteRect => rect !== null);
        if (!visible.length) return;
        const rowRect = row.getBoundingClientRect();
        badges.push({ id: annotation.id, index: index + 1,
          left: Math.max(bounds.left, Math.min(rowRect.right + 4, bounds.right - 24)),
          top: visible[0].top, exact: range !== null,
        });
        if (range) highlights.push(...visible);
      });
      setGeometry({ badges: placeAnnotationBadges(badges, bounds.top, bounds.bottom), highlights });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    root.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    const resize = new ResizeObserver(schedule);
    resize.observe(root);
    if (root.firstElementChild) resize.observe(root.firstElementChild);
    const dock = document.querySelector(COMPOSER_DOCK_SELECTOR);
    if (dock) resize.observe(dock);
    const mutation = new MutationObserver(schedule);
    mutation.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      cancelAnimationFrame(frame);
      root.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      resize.disconnect();
      mutation.disconnect();
    };
  }, [annotations, scrollRef]);

  if (!annotations.length) return null;
  const choose = (annotation: ResponseAnnotation) => {
    setActiveId(annotation.id);
    setExpanded(true);
    onNavigate(annotation);
  };

  return <>
    <aside className="response-annotation-float" data-annotation-layer
      aria-label={t("chat.annotationReview")} data-testid="annotation-float">
      <div className="response-annotation-float-head">
        <button type="button" ref={toggleRef} className="response-annotation-float-toggle"
          aria-expanded={expanded} aria-controls={`annotation-list-${sessionId}`}
          onClick={() => setExpanded((value) => !value)}>
          {expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
          {t("chat.annotationChip", { count: annotations.length })}
        </button>
        {expanded ? <TooltipButton type="button" className="composer-annotation-clear"
          tooltip={t("chat.clearAnnotations")} ariaLabel={t("chat.clearAnnotations")} onClick={clear}>
          <IconX size={12} />
        </TooltipButton> : null}
      </div>
      {expanded ? <ol id={`annotation-list-${sessionId}`} className="response-annotation-float-list"
        data-testid="composer-annotation-menu">
        {annotations.map((annotation, index) => <li key={annotation.id}
          className={`composer-annotation-item${activeId === annotation.id ? " active" : ""}`}
          data-testid="composer-annotation-item">
          <div className="composer-annotation-item-head">
            <button type="button" className="response-annotation-locate"
              aria-label={`${t("chat.annotationLocate")} ${index + 1}`}
              onClick={() => choose(annotation)}>
              <span className="response-annotation-number">{index + 1}</span>
              <span className="composer-annotation-item-text" title={annotation.text}>{annotation.text}</span>
            </button>
            <TooltipButton type="button" className="composer-annotation-item-action"
              tooltip={t("chat.annotationEdit")} ariaLabel={`${t("chat.annotationEdit")} ${index + 1}`}
              onClick={() => edit({ messageId: annotation.messageId, text: annotation.text, annotationId: annotation.id })}>
              <IconPencil size={13} />
            </TooltipButton>
            <TooltipButton type="button" className="composer-annotation-item-action"
              tooltip={t("chat.annotationRemove")} ariaLabel={`${t("chat.annotationRemove")} ${index + 1}`}
              onClick={() => { remove(annotation.id); toggleRef.current?.focus(); }}>
              <IconX size={13} />
            </TooltipButton>
          </div>
          {annotation.annotation ? <p className="composer-annotation-item-comment">{annotation.annotation}</p> : null}
        </li>)}
      </ol> : null}
    </aside>
    {createPortal(<div className="response-annotation-source-layer" data-annotation-layer>
      {geometry.highlights.map((rect, index) => <span key={index} aria-hidden="true"
        className="response-annotation-highlight" style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }} />)}
      {geometry.badges.map((badge) => {
        // A removal changes the list before its layout measurement runs.
        const index = annotations.findIndex((annotation) => annotation.id === badge.id);
        if (index < 0) return null;
        const annotation = annotations[index];
        return <button key={badge.id} type="button"
          className={`response-annotation-source-badge${activeId === badge.id ? " active" : ""}`}
          style={{ top: badge.top, left: badge.left }}
          aria-label={`${t("chat.annotationLocate")} ${index + 1}`}
          title={badge.exact ? annotation.text : t("chat.annotationRowLocation")}
          onClick={() => choose(annotation)}>{index + 1}</button>;
      })}
    </div>, document.body)}
  </>;
}

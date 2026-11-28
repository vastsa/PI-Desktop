import { type ReactNode, type UIEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/** One matching line from the project content search (Files tab). */
export type ProjectFileRow = {
  path: string;
  line: number;
  column: number;
  text: string;
};

/** Row height in CSS pixels; `--search-file-row-height` in overlays.css matches. */
const ROW_HEIGHT = 56;
/** Rows rendered beyond the viewport so a fast scroll does not flash blanks. */
const OVERSCAN = 8;

/**
 * Rows for the global search dialog's Files tab.
 *
 * A project-wide query can match hundreds of thousands of lines, so the list is
 * virtualized: only the visible window is mounted and the dialog loads the page
 * a row belongs to on demand. `rows` is therefore a flat array of hit count
 * slots, where unfetched slots are `null` until their page arrives. The dialog
 * owns the query, the debounce, and the paging.
 */
export function ProjectFileSearchResults({
  rows,
  fileCount,
  query,
  active,
  caseSensitive,
  onToggleCase,
  onActivate,
  onSelect,
  onEnsureRange,
}: {
  rows: (ProjectFileRow | null)[];
  fileCount: number;
  query: string;
  active: number;
  caseSensitive: boolean;
  onToggleCase: () => void;
  onActivate: (index: number) => void;
  onSelect: (row: ProjectFileRow) => void;
  /** Ask the dialog for every page overlapping `[start, end)`. */
  onEnsureRange: (start: number, end: number) => void;
}) {
  const { t } = useTranslation();
  const total = rows.length;
  const bodyRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const scrollRef = useRef(0);
  const frameRef = useRef(0);

  useEffect(() => {
    const element = bodyRef.current;
    if (!element) return;
    const sync = () => setViewport(element.clientHeight);
    sync();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(
    () => () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewport / ROW_HEIGHT) + OVERSCAN * 2;
  const end = Math.min(total, start + visibleCount);

  // Fetch whatever the window shows but does not hold yet.
  useEffect(() => {
    if (total > 0) onEnsureRange(start, Math.max(end, start + 1));
  }, [start, end, total, onEnsureRange]);

  // Keyboard navigation must pull the active row into view, including rows the
  // window has not loaded yet, so the list never hides the current selection.
  useEffect(() => {
    const element = bodyRef.current;
    if (!element || active >= total) return;
    const top = active * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + element.clientHeight) {
      element.scrollTop = bottom - element.clientHeight;
    }
  }, [active, total]);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    scrollRef.current = event.currentTarget.scrollTop;
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      setScrollTop(scrollRef.current);
    });
  };

  const summary = total > 0 ? t("search.filesSummary", { count: total, files: fileCount }) : null;

  return (
    <div className="search-group" data-search-group="files">
      {/* The header stays mounted with no hits so the toggle is always reachable. */}
      <div className="search-group-label" role="presentation">
        <span>{t("search.tabFiles")}</span>
        <span className="search-group-actions">
          {summary ? <span className="search-group-summary">{summary}</span> : null}
          <button
            type="button"
            className={`search-case-toggle ${caseSensitive ? "active" : ""}`}
            aria-pressed={caseSensitive}
            aria-label={t("search.caseSensitive")}
            title={t("search.caseSensitive")}
            onClick={onToggleCase}
          >
            Aa
          </button>
        </span>
      </div>
      <div className="search-files-body" ref={bodyRef} onScroll={handleScroll}>
        <div className="search-files-track" style={{ height: total * ROW_HEIGHT }}>
          <div
            className="search-files-window"
            style={{ transform: `translateY(${start * ROW_HEIGHT}px)` }}
          >
            {Array.from({ length: end - start }, (_, offset) => {
              const index = start + offset;
              const row = rows[index];
              if (!row) {
                return <div key={index} className="search-file-placeholder" aria-hidden />;
              }
              return (
                <button
                  key={`${row.path}:${row.line}`}
                  id={`global-search-option-${index}`}
                  type="button"
                  role="option"
                  aria-selected={active === index}
                  aria-posinset={index + 1}
                  aria-setsize={total}
                  className={`search-item search-item-file ${active === index ? "active" : ""}`}
                  onMouseEnter={() => onActivate(index)}
                  onClick={() => onSelect(row)}
                >
                  <span className="search-item-title">
                    {row.path}
                    <span className="search-item-path">:{row.line}</span>
                  </span>
                  <span className="search-item-snippet">{highlight(row.text, query)}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Marks the matched substring so a long preview stays readable. */
function highlight(text: string, query: string): ReactNode {
  const needle = query.trim().toLowerCase();
  if (!needle) return text;
  const index = text.toLowerCase().indexOf(needle);
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark className="search-hit">{text.slice(index, index + needle.length)}</mark>
      {text.slice(index + needle.length)}
    </>
  );
}

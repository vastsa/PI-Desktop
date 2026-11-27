import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

/** One matching line from the project content search (Files tab). */
export type ProjectFileRow = {
  path: string;
  line: number;
  column: number;
  text: string;
};

/**
 * Rows for the global search dialog's Files tab. Kept presentational: the
 * dialog owns the query, the debounce, and the tab state.
 */
export function ProjectFileSearchResults({
  rows,
  query,
  active,
  baseIndex,
  caseSensitive,
  onToggleCase,
  onActivate,
  onSelect,
}: {
  rows: ProjectFileRow[];
  query: string;
  active: number;
  /** The dialog's listbox index for the first file row. */
  baseIndex: number;
  caseSensitive: boolean;
  onToggleCase: () => void;
  onActivate: (index: number) => void;
  onSelect: (row: ProjectFileRow) => void;
}) {
  const { t } = useTranslation();
  const fileCount = new Set(rows.map((row) => row.path)).size;
  const summary = rows.length > 0 ? t("search.filesSummary", { count: rows.length, files: fileCount }) : null;
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
      {rows.map((row, offset) => {
        const index = baseIndex + offset;
        return (
          <button
            key={`${row.path}:${row.line}`}
            id={`global-search-option-${index}`}
            type="button"
            role="option"
            aria-selected={active === index}
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

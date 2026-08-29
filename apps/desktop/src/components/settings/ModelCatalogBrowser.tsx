/**
 * Catalog-first model picker (two panes) backed by the models.dev snapshot.
 *
 * The left pane searches the published catalog; the right pane shows the
 * published record for the active row as a definition list. Token limits are
 * never typed here: bindingFromModelInfo adopts the published values, so
 * choosing a model is a single click.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  MODEL_FILTERS,
  formatModelPrice,
  formatTokenCount,
  sortThinkingLevels,
  type ModelFilter,
  type ModelInfo,
  type ModelSearchInput,
  type ModelSearchOutput,
  type ModelSearchResult,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Button, cx } from "../ui";
import { IconCheck, IconSearch } from "../icons";

/** Keystroke settling window before a catalog search is issued. */
const SEARCH_DEBOUNCE_MS = 150;
/** Upper bound on requested rows; the host clamps this as well. */
const RESULT_LIMIT = 200;

type ProviderGroup = {
  key: string;
  name: string;
  rows: ModelSearchResult[];
};

export type ModelCatalogBrowserProps = {
  /** Restrict results to one models.dev provider key. */
  providerKey?: string;
  /** Restrict results to the catalog provider behind a configured row. */
  providerId?: string;
  /** Currently selected model ids; the caller owns this list. */
  selectedIds: string[];
  onToggle: (model: ModelInfo) => void;
  onConfirm: () => void;
  onCancel: () => void;
  /** Overrides the primary action label. */
  confirmLabel?: string;
  /**
   * False when the surrounding surface owns the confirm/cancel buttons; the
   * footer then keeps only the selected-count line.
   */
  footerActions?: boolean;
  /** Injectable search so tests can stub the catalog. */
  search?: (input: ModelSearchInput) => Promise<ModelSearchOutput>;
};

function modalityLine(list: readonly string[] | undefined): string {
  return list && list.length > 0 ? list.join(", ") : "—";
}

export function ModelCatalogBrowser({
  providerKey,
  providerId,
  selectedIds,
  onToggle,
  onConfirm,
  onCancel,
  confirmLabel,
  footerActions = true,
  search = api.searchCatalogModels,
}: ModelCatalogBrowserProps) {
  const { t } = useTranslation();
  const listId = useId();
  const rowIdPrefix = `${listId}-row`;
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<ModelFilter[]>([]);
  const [results, setResults] = useState<ModelSearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [degraded, setDegraded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [activeIndex, setActiveIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);
  // Only the newest request may commit; a stale reply must not overwrite it.
  const requestSeq = useRef(0);

  useEffect(() => {
    const requestId = ++requestSeq.current;
    setLoading(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const output = await search({
            query: query.trim() || undefined,
            providerKey,
            providerId,
            filters,
            limit: RESULT_LIMIT,
          });
          if (requestSeq.current !== requestId) return;
          setResults(output.results);
          setTotal(output.total);
          setDegraded(output.degraded);
        } catch {
          if (requestSeq.current !== requestId) return;
          setResults([]);
          setTotal(0);
          setDegraded(true);
        } finally {
          if (requestSeq.current === requestId) setLoading(false);
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [filters, providerId, providerKey, query, search]);

  const { groups, rows } = useMemo(() => {
    // A provider-scoped search is already one provider, so headings would only
    // repeat the dialog title.
    if (providerKey || providerId) {
      return { groups: [] as ProviderGroup[], rows: results };
    }
    const byProvider = new Map<string, ProviderGroup>();
    for (const result of results) {
      const group = byProvider.get(result.providerKey);
      if (group) group.rows.push(result);
      else {
        byProvider.set(result.providerKey, {
          key: result.providerKey,
          name: result.providerName,
          rows: [result],
        });
      }
    }
    const grouped = [...byProvider.values()];
    return { groups: grouped, rows: grouped.flatMap((group) => group.rows) };
  }, [providerId, providerKey, results]);

  useEffect(() => {
    setActiveIndex((current) => (current < rows.length ? current : 0));
  }, [rows.length]);

  // Model ids are matched case-insensitively: a hand-typed id and the
  // published record differ only in case often enough that an exact compare
  // would show the same model as both selected and selectable.
  const selected = useMemo(
    () => new Set(selectedIds.map((id) => id.toLowerCase())),
    [selectedIds],
  );
  const active = rows[activeIndex];
  const filterLabels: Record<ModelFilter, string> = {
    reasoning: t("settings.modelFilterReasoning"),
    vision: t("settings.modelFilterVision"),
    tools: t("settings.modelFilterTools"),
    attachments: t("settings.modelFilterAttachments"),
  };

  const moveActive = useCallback(
    (delta: number) => {
      if (rows.length === 0) return;
      setActiveIndex((current) => {
        const next = Math.min(Math.max(current + delta, 0), rows.length - 1);
        rowRefs.current[next]?.scrollIntoView({ block: "nearest" });
        return next;
      });
    },
    [rows.length],
  );

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
      return;
    }
    if (event.key === "Enter") {
      if (!active) return;
      event.preventDefault();
      onToggle(active.model);
      return;
    }
    if (event.key === "Escape") {
      // Escape returns to the search box first; from there the surrounding
      // dialog owns the next press and can close.
      if (document.activeElement !== searchRef.current) {
        event.preventDefault();
        event.stopPropagation();
        searchRef.current?.focus();
      }
    }
  };

  const toggleFilter = (filter: ModelFilter) =>
    setFilters((current) =>
      current.includes(filter)
        ? current.filter((entry) => entry !== filter)
        : [...current, filter],
    );

  const renderRow = (result: ModelSearchResult, index: number) => {
    const { model } = result;
    const isSelected = selected.has(model.modelId.toLowerCase());
    const isActive = index === activeIndex;
    return (
      <div
        key={`${result.providerKey}/${model.modelId}`}
        ref={(node) => {
          rowRefs.current[index] = node;
        }}
        id={`${rowIdPrefix}-${index}`}
        role="option"
        aria-selected={isSelected}
        title={model.modelId}
        className={cx(
          "model-catalog-row",
          isSelected && "is-selected",
          isActive && "is-active",
        )}
        onMouseEnter={() => setActiveIndex(index)}
        onClick={() => onToggle(model)}
      >
        <span className={cx("model-catalog-check", isSelected && "is-checked")} aria-hidden>
          {isSelected ? <IconCheck size={12} /> : null}
        </span>
        <span className="model-catalog-row-copy">
          <span className="model-catalog-row-name">{model.displayName}</span>
          <span className="model-catalog-row-id font-mono">{model.modelId}</span>
        </span>
        <span className="model-catalog-row-meta">
          <span>{result.providerName}</span>
          <span className="model-catalog-meta-dot" aria-hidden>
            ·
          </span>
          <span>{formatTokenCount(model.contextWindow || model.limit?.context)}</span>
          <span className="model-catalog-meta-dot" aria-hidden>
            ·
          </span>
          <span>{formatModelPrice(model.cost)}</span>
        </span>
      </div>
    );
  };

  let cursor = 0;
  const body =
    loading && results.length === 0 ? (
      <div className="model-catalog-placeholder">{t("settings.modelCatalogLoading")}</div>
    ) : degraded ? (
      <div className="model-catalog-placeholder">{t("settings.modelCatalogDegraded")}</div>
    ) : rows.length === 0 ? (
      <div className="model-catalog-placeholder">{t("settings.modelCatalogEmpty")}</div>
    ) : groups.length > 0 ? (
      groups.map((group) => {
        const start = cursor;
        cursor += group.rows.length;
        return (
          <div className="model-catalog-group" key={group.key}>
            <div className="model-catalog-group-head" role="presentation">
              <span className="model-catalog-group-name">{group.name}</span>
              <span className="model-catalog-group-count">{group.rows.length}</span>
            </div>
            {group.rows.map((result, offset) => renderRow(result, start + offset))}
          </div>
        );
      })
    ) : (
      rows.map((result, index) => renderRow(result, index))
    );

  return (
    <div className="model-catalog" onKeyDown={onKeyDown}>
      <div className="model-catalog-panes">
        <div className="model-catalog-search-pane">
          <div className="model-catalog-search-wrap">
            <IconSearch size={14} aria-hidden />
            <input
              ref={searchRef}
              className="model-catalog-search"
              value={query}
              placeholder={t("settings.modelCatalogSearch")}
              aria-label={t("settings.modelCatalogSearch")}
              aria-controls={listId}
              aria-autocomplete="list"
              autoFocus
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          <div
            className="model-catalog-filters"
            role="group"
            aria-label={t("settings.modelCatalogFilters")}
          >
            {MODEL_FILTERS.map((filter) => {
              const on = filters.includes(filter);
              return (
                <button
                  key={filter}
                  type="button"
                  className={cx("model-catalog-filter", on && "is-on")}
                  aria-pressed={on}
                  onClick={() => toggleFilter(filter)}
                >
                  {filterLabels[filter]}
                </button>
              );
            })}
          </div>

          <div
            className="model-catalog-list"
            id={listId}
            role="listbox"
            aria-multiselectable="true"
            aria-label={t("settings.modelCatalogResults")}
            aria-activedescendant={active ? `${rowIdPrefix}-${activeIndex}` : undefined}
          >
            {body}
          </div>

          <div className="model-catalog-count">
            {t("settings.modelCatalogResultCount", { shown: rows.length, total })}
          </div>
        </div>

        <div className="model-catalog-detail-pane" aria-live="polite">
          {active ? (
            <ModelDetail model={active.model} providerName={active.providerName} />
          ) : (
            <div className="model-catalog-placeholder">
              {t("settings.modelCatalogNoSelection")}
            </div>
          )}
        </div>
      </div>

      <div className="model-catalog-footer">
        <span className="model-catalog-selected-count">
          {t("settings.nModelsSelected", { n: selectedIds.length })}
        </span>
        {footerActions ? (
          <div className="model-catalog-footer-actions">
            <Button variant="ghost" onClick={onCancel}>
              {t("settings.cancel")}
            </Button>
            <Button variant="primary" disabled={selectedIds.length === 0} onClick={onConfirm}>
              {confirmLabel ?? t("settings.modelCatalogUseSelected")}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Read-only published record for the active row, rendered as a definition
 * list. Deliberately not a JSON dump: every field is labelled and localized.
 */
function ModelDetail({
  model,
  providerName,
}: {
  model: ModelInfo;
  providerName: string;
}) {
  const { t } = useTranslation();
  const yes = t("settings.modelEnabled");
  const no = t("settings.modelDisabled");
  const flag = (value?: boolean) => (value ? yes : no);
  const thinkingLevels = sortThinkingLevels(model.supportedThinkingLevels ?? []);
  const reasoningOptions = (model.reasoningOptions ?? [])
    .map((option) => {
      const values = option.values?.filter((entry): entry is string => !!entry);
      if (values && values.length > 0) return `${option.type}: ${values.join(", ")}`;
      if (option.min !== undefined || option.max !== undefined) {
        return `${option.type}: ${option.min ?? "—"}–${option.max ?? "—"}`;
      }
      return option.type;
    })
    .join(" · ");

  const rows: Array<[string, string]> = [
    [t("settings.modelFamily"), model.family || "—"],
    [t("settings.modelInput"), modalityLine(model.modalities?.input)],
    [t("settings.modelOutput"), modalityLine(model.modalities?.output)],
    [
      t("settings.modelLimits"),
      `${t("settings.contextWindowShort")} ${formatTokenCount(
        model.contextWindow || model.limit?.context,
      )} · ${t("settings.maxOutputShort")} ${formatTokenCount(
        model.maxTokens || model.limit?.output,
      )}`,
    ],
    [t("settings.modelPricing"), formatModelPrice(model.cost)],
    [t("settings.modelKnowledge"), model.knowledge || "—"],
    [t("settings.modelReleased"), model.releaseDate || "—"],
    [t("settings.modelUpdated"), model.lastUpdated || "—"],
    [
      t("settings.supportedThinkingLevels"),
      thinkingLevels.length > 0
        ? thinkingLevels.map((level) => t(`thinkingLevel.${level}`)).join(" · ")
        : t("settings.notSupported"),
    ],
    [t("settings.modelReasoningOptions"), reasoningOptions || "—"],
    [t("settings.modelTools"), flag(model.toolCall)],
    [t("settings.modelStructuredOutput"), flag(model.structuredOutput)],
    [t("settings.modelTemperature"), flag(model.temperature)],
    [t("settings.modelAttachments"), flag(model.attachment)],
    [t("settings.modelOpenWeights"), flag(model.openWeights)],
  ];

  return (
    <div className="model-catalog-detail">
      <div className="model-catalog-detail-head">
        <div className="model-catalog-detail-name">{model.displayName}</div>
        <div className="model-catalog-detail-id font-mono">{model.modelId}</div>
        <div className="model-catalog-detail-provider">{providerName}</div>
      </div>
      {model.description ? (
        <p className="model-catalog-detail-desc">{model.description}</p>
      ) : null}
      <dl className="model-catalog-detail-grid">
        {rows.map(([label, value]) => (
          <div className="model-catalog-detail-row" key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

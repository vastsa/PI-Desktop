/**
 * The one model picker both credential kinds render.
 *
 * An AI service and a vendor account differ in how they authenticate, not in
 * what choosing a model means: the same discovered list, the same binding
 * shape, the same per-model limits and thinking levels. While each dialog kept
 * its own copy the account editor silently lost the advanced controls, so the
 * guarantee lives here once instead of in a convention two files had to
 * remember.
 */
import { useEffect, useMemo, useState, type Ref } from "react";
import { useTranslation } from "react-i18next";
import {
  bindingForCustomModel,
  bindingForCustomModelInfo,
  bindingFromModelInfo,
  fastModeBillingOn,
  formatTokenCount,
  nativeWebSearchSupportedOn,
  publishedThinkingLevels,
  resolveBindingDefaultThinkingLevel,
  sortThinkingLevels,
  type ModelBinding,
  type ModelInfo,
  type ThinkingLevel,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Badge, Button, Field, HelpIcon, Input, TooltipButton, cx } from "../ui";
import { IconClose, IconGripVertical, IconPlus, IconRefresh, IconSearch } from "../icons";
import { ModelAdvancedSettings } from "./ModelAdvancedSettings";
import { filterChosenModels, hidesAddedBinding } from "./model-chosen-filter";
import {
  applyCustomModelLookup,
  customModelLookupInput,
  customModelSeedBinding,
  type CustomModelLookupContext,
} from "./model-custom-lookup";
import type { ProviderModelsState } from "./useProviderModels";
import { useModelReorder } from "./useModelReorder";

/** One row of the model list: what the service returned, plus its binding. */
export type ModelRow = {
  id: string;
  displayName: string;
  contextWindow?: number;
  maxTokens?: number;
  /** Published record when the service (or models.dev) described the model. */
  info?: ModelInfo;
  binding?: ModelBinding;
};

export type ModelSelection = {
  rows: ModelRow[];
  models: ModelBinding[];
  publishedLevelsById: Map<string, ThinkingLevel[]>;
  /**
   * What the caller must save: the chosen bindings with explicit thinking
   * selections preserved, including manual overrides not listed by the catalog.
   */
  bindingsToPersist: ModelBinding[];
  setModels: (update: (current: ModelBinding[]) => ModelBinding[]) => void;
};

type ModelTokenLimit = "contextWindow" | "maxTokens";

function publishedModelLimit(
  info: ModelInfo | undefined,
  field: ModelTokenLimit,
): number | undefined {
  if (!info) return undefined;
  const published = field === "contextWindow" ? info.limit?.context : info.limit?.output;
  if (published !== undefined) return published;
  // models.dev rows keep the raw record in `limit`; other discovered rows may
  // carry only the runtime's generic safety budget, which is not a published
  // model limit and should not look like one in Settings.
  if (info.catalogSource === "models.dev" || info.source === "discovered") {
    return undefined;
  }
  return field === "contextWindow" ? info.contextWindow : info.maxTokens;
}

/**
 * Row merging and published-level metadata for one binding list.
 *
 * Rows are the models the credential offered, plus any configured binding the
 * current answer does not mention (a hand-typed id, or an endpoint that went
 * quiet), so nothing already saved can silently disappear.
 */
export function useModelSelection(
  discovery: ProviderModelsState,
  models: ModelBinding[],
  setModels: (update: (current: ModelBinding[]) => ModelBinding[]) => void,
): ModelSelection {
  const rows = useMemo<ModelRow[]>(() => {
    const byId = new Map<string, ModelRow>();
    for (const model of discovery.models) {
      byId.set(model.modelId.toLowerCase(), {
        id: model.modelId,
        displayName: model.displayName,
        contextWindow: model.contextWindow ?? model.limit?.context,
        maxTokens: model.maxTokens ?? model.limit?.output,
        info: model,
      });
    }
    for (const binding of models) {
      const key = binding.id.toLowerCase();
      const existing = byId.get(key);
      if (existing) byId.set(key, { ...existing, binding });
      else {
        byId.set(key, {
          id: binding.id,
          displayName: binding.id,
          contextWindow: binding.contextWindow,
          maxTokens: binding.maxTokens,
          binding,
        });
      }
    }
    return [...byId.values()];
  }, [discovery.models, models]);

  /**
   * Published thinking levels are kept separately from the editable binding.
   * They seed newly added known models and explain the catalog baseline, but a
   * user may explicitly configure any canonical level for a proxy or new model.
   */
  const publishedLevelsById = useMemo(() => {
    const byId = new Map<string, ThinkingLevel[]>();
    for (const row of rows) {
      // A row with no published record is a hand-typed id, a vendor account
      // model the catalog does not list, or an endpoint that went quiet. Those
      // stay out of the map entirely: an absent entry means "unknown", which
      // preserves the stored levels, while an empty entry would erase them.
      if (!row.info) continue;
      byId.set(row.id.toLowerCase(), publishedThinkingLevels(row.info));
    }
    return byId;
  }, [rows]);

  /**
   * Persist the user's explicit level set. The catalog is metadata and a
   * provider endpoint may support a level that its published record omits.
   */
  const bindingsToPersist = useMemo(
    () =>
      models.map((binding) => {
        // Canonical order, because this is the same order the panel offers the
        // default in: picking the first entry of an insertion-ordered list here
        // would save a different default than the one the user was shown.
        const thinkingLevels = sortThinkingLevels(binding.thinkingLevels);
        const enabled = thinkingLevels;
        const defaultThinkingLevel = resolveBindingDefaultThinkingLevel(
          binding.defaultThinkingLevel,
          enabled,
        );
        if (
          thinkingLevels.length === binding.thinkingLevels.length &&
          defaultThinkingLevel === binding.defaultThinkingLevel
        ) {
          return binding;
        }
        return { ...binding, thinkingLevels, defaultThinkingLevel };
      }),
    [models],
  );

  return { rows, models, publishedLevelsById, bindingsToPersist, setModels };
}

/**
 * Add or drop every currently visible row in one step.
 *
 * The search box is a view over the live list, so "all" means the rows on
 * screen: a filtered select-all does not touch hidden matches, and a filtered
 * clear does not drop models that are still chosen off-screen. Already-chosen
 * bindings keep their advanced overrides.
 */
export function applyVisibleModelSelection(
  current: ModelBinding[],
  visibleRows: ModelRow[],
  select: boolean,
): ModelBinding[] {
  const visibleIds = new Set(visibleRows.map((row) => row.id.toLowerCase()));
  if (!select) {
    return current.filter((binding) => !visibleIds.has(binding.id.toLowerCase()));
  }
  const selected = new Set(current.map((binding) => binding.id.toLowerCase()));
  const additions: ModelBinding[] = [];
  for (const row of visibleRows) {
    if (selected.has(row.id.toLowerCase())) continue;
    additions.push(
      row.info ? { ...bindingFromModelInfo(row.info), id: row.id } : bindingForCustomModel(row.id),
    );
  }
  return additions.length === 0 ? current : [...current, ...additions];
}

export type ModelSelectionPanesProps = {
  imageModelIds?: string[];
  onImageModelChange?: (id: string, selected: boolean) => void;
  discovery: ProviderModelsState & { canReload?: boolean };
  selection: ModelSelection;
  /** Heading of the discovered list: a service's models, or an account's. */
  listTitle: string;
  /** True while the caller saves, so the picker stops accepting input. */
  busy?: boolean;
  /** Probe the service's model list now, skipping the edit debounce. */
  onReload?: () => void;
  /**
   * Effective API style of the provider being configured. Gates the native
   * web search opt-in: only wires that can carry a provider-hosted search
   * tool offer the checkbox at all.
   */
  apiStyle?: string;
  /**
   * What this entry knows about where a hand-typed id belongs. The picker
   * passes it to the model-library lookup that seeds a custom row's published
   * limits; absent fields only widen the catalog search.
   */
  lookupContext?: CustomModelLookupContext;
  /** Attached to the hand-typed id field, so a caller can focus it. */
  customModelInputRef?: Ref<HTMLInputElement>;
  /** The chosen list is exactly what the recommendation picked. */
  autoPicked?: boolean;
};

/**
 * Two panes, because picking a model and reviewing what was picked are one
 * task: the credential's list on the left, the chosen bindings on the right.
 * Stacking them made the dialog scroll for no reason.
 */
export function ModelSelectionPanes({
  discovery,
  selection,
  listTitle,
  busy = false,
  onReload,
  apiStyle,
  imageModelIds,
  lookupContext,
  onImageModelChange,
  customModelInputRef,
  autoPicked = false,
}: ModelSelectionPanesProps) {
  const { t } = useTranslation();
  const { rows, models, publishedLevelsById, setModels } = selection;
  const [modelQuery, setModelQuery] = useState("");
  const [chosenQuery, setChosenQuery] = useState("");
  const [customModelId, setCustomModelId] = useState("");
  const [customModelError, setCustomModelError] = useState("");
  // Keep selections scannable; advanced settings stay folded until requested.
  const [expandedModelId, setExpandedModelId] = useState<string | null>(null);

  // The returned list is short and already local, so filtering is client-side:
  // no host search and no debounced IPC round trip.
  const visibleRows = useMemo(() => {
    // The service pane follows a live answer. Configured-only rows remain in
    // the chosen pane, including hand-typed IDs absent from discovery.
    const listedRows = rows.filter((row) => row.info?.discoveryState !== "unlisted");
    const availableRows = discovery.source === "remote"
      ? listedRows.filter((row) => row.info && row.info.source !== "user")
      : listedRows;
    const needle = modelQuery.trim().toLowerCase();
    if (!needle) return availableRows;
    return availableRows.filter(
      (row) =>
        row.id.toLowerCase().includes(needle) ||
        row.displayName.toLowerCase().includes(needle),
    );
  }, [modelQuery, rows, discovery.source]);

  const selected = useMemo(
    () => new Set(models.map((binding) => binding.id.toLowerCase())),
    [models],
  );
  const visibleSelectedCount = useMemo(
    () => visibleRows.filter((row) => selected.has(row.id.toLowerCase())).length,
    [selected, visibleRows],
  );
  const allVisibleSelected =
    visibleRows.length > 0 && visibleSelectedCount === visibleRows.length;
  const someVisibleSelected =
    visibleSelectedCount > 0 && visibleSelectedCount < visibleRows.length;

  // Published records for the chosen rows, so the capability switches can show
  // what models.dev says before the user overrides it.
  const infoById = useMemo(() => {
    const byId = new Map<string, ModelInfo>();
    for (const row of rows) if (row.info) byId.set(row.id.toLowerCase(), row.info);
    return byId;
  }, [rows]);

  // An emptied list disables the field, so a filter still sitting in it could
  // no longer be cleared by the user. Drop it with the last configured model.
  useEffect(() => {
    if (models.length === 0) setChosenQuery("");
  }, [models.length]);

  // Use the same published endpoint routing as the runtime. A disabled control
  // means this connection is not integrated, not that the vendor cannot search.
  const nativeWebSearchWireCapable = nativeWebSearchSupportedOn(apiStyle, lookupContext?.baseUrl);
  // Fast mode rides the Responses `service_tier` field; the hint names what
  // the priority tier costs on this wire (ADR 0334).
  const fastModeBilling = fastModeBillingOn(apiStyle);
  const fastModeHint = fastModeBilling === "subscription"
    ? "settings.fastModeAllowedSubscriptionHint"
    : fastModeBilling === "usage"
      ? "settings.fastModeAllowedUsageHint"
      : "settings.fastModeAllowedUnsupported";

  /**
   * The chosen list narrows with the discovered list's rule plus the binding's
   * alias: a case-insensitive substring match over the id, the alias, and the
   * catalog display name, so a friendly name finds the id it stands for. The
   * rule lives in `model-chosen-filter`, so the pane, the add paths below, and
   * the tests execute one implementation instead of three copies of it.
   */
  const visibleChosen = useMemo(
    () => filterChosenModels(models, chosenQuery, rows),
    [chosenQuery, models, rows],
  );
  const reorder = useModelReorder(visibleChosen, setModels, busy);

  /** Keep the wire id of the selected row, even if catalog spelling differs. */
  const bindingForRow = (row: ModelRow): ModelBinding =>
    row.info ? bindingForCustomModelInfo(row.id, row.info) : bindingForCustomModel(row.id);

  /**
   * The rule for a model that is being added: a filter is kept while it still
   * shows the new row and dropped when the row would land out of view, so
   * nothing the user just added hides behind a search typed earlier.
   */
  const keepAddedModelVisible = (added: ModelBinding[]) => {
    if (hidesAddedBinding(added, chosenQuery, rows)) setChosenQuery("");
  };

  const toggleModel = (row: ModelRow) => {
    const wanted = row.id.toLowerCase();
    const alreadyChosen = models.some(
      (binding) => binding.id.toLowerCase() === wanted,
    );
    if (!alreadyChosen) {
      keepAddedModelVisible([bindingForRow(row)]);
    }
    setModels((current) => {
      if (current.some((binding) => binding.id.toLowerCase() === wanted)) {
        return current.filter((binding) => binding.id.toLowerCase() !== wanted);
      }
      return [...current, bindingForRow(row)];
    });
  };

  const toggleVisibleModels = (select: boolean) => {
    if (select) {
      const added = visibleRows
        .filter((row) => !selected.has(row.id.toLowerCase()))
        .map((row) => bindingForRow(row));
      keepAddedModelVisible(added);
    }
    setModels((current) => applyVisibleModelSelection(current, visibleRows, select));
  };

  const updateBinding = (id: string, update: Partial<ModelBinding>) =>
    setModels((current) =>
      current.map((binding) => (binding.id === id ? { ...binding, ...update } : binding)),
    );

  /**
   * Ask the host for the model library's record of a just-added hand-typed id
   * and upgrade the row in place.
   *
   * The lookup is asynchronous, so the row may have been edited, removed, or
   * replaced by the time it answers; `applyCustomModelLookup` only replaces the
   * untouched seed. A miss or a failed call is the generic seed it already is.
   */
  const enrichCustomModel = async (seed: ModelBinding) => {
    let info: ModelInfo | null = null;
    try {
      const result = await api.lookupProviderModel(
        customModelLookupInput(seed.id, lookupContext),
      );
      info = result?.info ?? null;
    } catch {
      return;
    }
    /*
      The host answered for the id this row was added with, so the record is this
      row's — including when the same model is published under another spelling
      of it (a route prefix, a date, a marker the deployment appends). That is the
      resolution the runtime reads for the row too, so checking the spelling again
      here would only drop an answer the rest of the app uses. The stored wire id
      stays exactly what the user typed.
    */
    setModels((current) => applyCustomModelLookup(current, seed, info));
  };

  /**
   * A hand-typed id is matched against the discovered rows first, then against
   * the model library through the host. The row lands immediately with the
   * generic seed, so a slow or failed lookup still leaves exactly one usable
   * row; a published record upgrades that same row when it arrives.
   */
  const addCustomModel = () => {
    const id = customModelId.trim();
    if (!id) {
      setCustomModelError(t("settings.customModelRequired"));
      return;
    }
    if (models.some((binding) => binding.id.toLowerCase() === id.toLowerCase())) {
      setCustomModelError(t("settings.modelAlreadyAdded"));
      return;
    }
    const discovered = rows.find((row) => row.id.toLowerCase() === id.toLowerCase());
    const binding = discovered?.info
      ? bindingForCustomModelInfo(id, discovered.info)
      : customModelSeedBinding(id);
    setModels((current) => [...current, binding]);
    // Expand the stored wire id, not a catalog spelling that may differ.
    setExpandedModelId(binding.id);
    setCustomModelId("");
    setCustomModelError("");
    keepAddedModelVisible([binding]);
    // A discovered row already carries the published record, so only the
    // not-yet-known id needs the extra lookup.
    if (!discovered?.info) void enrichCustomModel(binding);
  };

  // A failed probe leaves an empty pane: the pane says the list is missing and
  // the toast says why, so the list no longer hosts a classified error box.
  const emptyFetchError = discovery.status === "error" && rows.length === 0;

  const modelListBody =
    discovery.status === "idle" ? (
      <div className="provider-models-placeholder">{t("settings.modelsEmptyHint")}</div>
    ) : emptyFetchError ? (
      <div className="provider-models-placeholder is-error">
        {t("settings.modelsFetchFailed")}
      </div>
    ) : rows.length === 0 ? (
      <div className="provider-models-placeholder">
        {discovery.status === "loading"
          ? t("settings.modelsLoading")
          : t("settings.modelsNoneFromService")}
      </div>
    ) : visibleRows.length === 0 ? (
      <div className="provider-models-placeholder">{t("settings.noModelMatches")}</div>
    ) : (
      <ul className="provider-models-list">
        {visibleRows.map((row) => (
          <li className="provider-models-row" key={row.id}>
            <label
              className="provider-models-row-label"
              onClick={(event) => {
                // Keyboard activation reports detail 0 and is not a click that
                // carries a text selection, so it must keep toggling.
                if (event.detail === 0) return;
                // A copied selection can remain active when the user clicks the
                // checkbox next. The checkbox is an explicit toggle target, so
                // an old selection must not cancel its native activation.
                if (event.target instanceof HTMLInputElement) return;
                // A drag-selection inside this row is a copy gesture, not a toggle.
                const selection = window.getSelection();
                const row = event.currentTarget;
                if (
                  selection &&
                  !selection.isCollapsed &&
                  row.contains(selection.anchorNode) &&
                  row.contains(selection.focusNode)
                ) {
                  event.preventDefault();
                }
              }}
            >
              <input
                type="checkbox"
                className="provider-models-check"
                checked={selected.has(row.id.toLowerCase())}
                disabled={busy}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                onChange={() => toggleModel(row)}
              />
              <span className="provider-models-row-copy selectable">
                <span className="provider-models-row-id font-mono">{row.id}</span>
                {row.displayName && row.displayName !== row.id ? (
                  <span className="provider-models-row-name">{row.displayName}</span>
                ) : null}
              </span>
              <span className="provider-models-row-limits">
                {formatTokenCount(publishedModelLimit(row.info, "contextWindow"))} ·{" "}
                {formatTokenCount(publishedModelLimit(row.info, "maxTokens"))}
              </span>
            </label>
          </li>
        ))}
      </ul>
    );

  return (
    <div className="provider-setup-panes">
      <div className="provider-models">
        <div className="provider-models-head">
          <div className="provider-models-heading">
            {visibleRows.length > 0 ? (
              <input
                type="checkbox"
                className="provider-models-check provider-models-select-all"
                checked={allVisibleSelected}
                disabled={busy}
                ref={(el) => {
                  if (el) el.indeterminate = someVisibleSelected;
                }}
                aria-label={
                  allVisibleSelected
                    ? t("settings.deselectAllVisibleModels")
                    : t("settings.selectAllVisibleModels")
                }
                title={
                  allVisibleSelected
                    ? t("settings.deselectAllVisibleModels")
                    : t("settings.selectAllVisibleModels")
                }
                onChange={(event) => toggleVisibleModels(event.target.checked)}
              />
            ) : null}
            <h4 className="provider-models-title">
              {listTitle}
              {/* Where this batch came from is the heading's answer now, so the
                  list keeps its height whether the source is the catalog or
                  the fallback. */}
              {discovery.source === "catalog" ? (
                <HelpIcon label={t("settings.modelsFromCatalogNote")} />
              ) : discovery.source === "fallback" ? (
                <HelpIcon label={t("settings.modelsFallbackNote")} />
              ) : null}
            </h4>
            {onReload ? (
              <button
                type="button"
                className={cx(
                  "provider-models-reload",
                  discovery.status === "loading" && "is-loading",
                )}
                disabled={busy || !discovery.canReload}
                onClick={onReload}
              >
                <IconRefresh size={13} aria-hidden />
                {discovery.status === "loading"
                  ? t("settings.modelsLoading")
                  : t("settings.fetchModelList")}
              </button>
            ) : null}
          </div>
          <div className="provider-models-search-wrap">
            <IconSearch size={13} aria-hidden />
            <input
              className="provider-models-search"
              value={modelQuery}
              placeholder={t("settings.searchModelId")}
              aria-label={t("settings.searchModelId")}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              onChange={(event) => setModelQuery(event.target.value)}
            />
          </div>
        </div>

        {modelListBody}
      </div>

      <div className="provider-chosen">
        <div className="provider-chosen-head">
          <h4 className="provider-chosen-title">{t("settings.modelConfigurations")}</h4>
          <span className="provider-chosen-count">{models.length}</span>
          <div className="provider-chosen-search-wrap">
            <IconSearch size={13} aria-hidden />
            <input
              className="provider-chosen-search"
              value={chosenQuery}
              placeholder={t("settings.searchChosenModels")}
              aria-label={t("settings.searchChosenModels")}
              disabled={busy || models.length === 0}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              onChange={(event) => setChosenQuery(event.target.value)}
            />
          </div>
        </div>
        {autoPicked && models.length > 0 ? (
          <div className="provider-models-summary-hint">{t("settings.modelsAutoPicked")}</div>
        ) : null}
        {models.length === 0 ? (
          <div className="provider-chosen-empty">{t("settings.noModelsChosen")}</div>
        ) : visibleChosen.length === 0 ? (
          <div className="provider-chosen-empty">{t("settings.noChosenModelMatches")}</div>
        ) : (
          <ul className="provider-chosen-list">
            {visibleChosen.map((binding) => {
              const publishedLevels =
                publishedLevelsById.get(binding.id.toLowerCase()) ?? [];
              const info = infoById.get(binding.id.toLowerCase());
              // The row's published window, so the hint below the field can say
              // the number still follows it.
              const publishedContextWindow = publishedModelLimit(info, "contextWindow");
              const publishedMaxTokens = publishedModelLimit(info, "maxTokens");
              const followsCatalog =
                binding.contextWindowSource !== "user" &&
                publishedContextWindow !== undefined;
              const displayedContextWindow =
                binding.contextWindowSource === "catalog" &&
                publishedContextWindow === undefined
                  ? undefined
                  : binding.contextWindow;
              const displayedMaxTokens =
                binding.maxTokensSource === "catalog" &&
                publishedMaxTokens === undefined
                  ? undefined
                  : binding.maxTokens;
              const expanded = expandedModelId === binding.id;
              const imageModelSelected = imageModelIds?.some((modelId) =>
                modelId.toLowerCase() === binding.id.toLowerCase(),
              ) ?? false;
              const advancedId = `model-advanced-${binding.id}`;
              return (
                <li
                  className={cx(
                    "provider-chosen-row",
                    reorder.draggingId === binding.id && "is-dragging",
                  )}
                  key={binding.id}
                  data-drop-placement={
                    reorder.dropTarget?.id === binding.id ? reorder.dropTarget.placement : undefined
                  }
                  {...reorder.rowEvents(binding.id)}
                >
                  <div className="provider-chosen-row-head">
                    <button
                      type="button"
                      className="provider-chosen-reorder"
                      aria-label={t("settings.reorderModel", { name: binding.id })}
                      title={t("settings.reorderModel", { name: binding.id })}
                      {...reorder.handleEvents(binding.id)}
                    >
                      <IconGripVertical size={14} aria-hidden />
                    </button>
                    <span className="provider-chosen-row-id font-mono selectable">
                      {binding.id}
                    </span>
                    {binding.alias?.trim() ? (
                      <span className="provider-chosen-row-alias">{binding.alias.trim()}</span>
                    ) : null}
                    {imageModelSelected ? <Badge>{t("settings.imageModelSelected")}</Badge> : null}
                    <span className="provider-chosen-row-limits">
                      {formatTokenCount(displayedContextWindow)} ·{" "}
                      {formatTokenCount(displayedMaxTokens)}
                    </span>
                    <button
                      type="button"
                      className="provider-chosen-advanced-toggle"
                      aria-expanded={expanded}
                      aria-controls={advancedId}
                      onClick={() =>
                        setExpandedModelId((current) =>
                          current === binding.id ? null : binding.id,
                        )
                      }
                    >
                      {t("settings.advanced")}
                    </button>
                    <TooltipButton
                      type="button"
                      className="provider-chosen-remove"
                      ariaLabel={t("settings.removeModel")}
                      tooltip={t("settings.removeModel")}
                      disabled={busy}
                      onClick={() =>
                        setModels((current) =>
                          current.filter((entry) => entry.id !== binding.id),
                        )
                      }
                    >
                      <IconClose size={12} />
                    </TooltipButton>
                  </div>
                  <ModelAdvancedSettings
                    id={advancedId}
                    hidden={!expanded}
                    binding={binding}
                    info={info}
                    publishedLevels={publishedLevels}
                    followsCatalog={followsCatalog}
                    apiStyle={apiStyle}
                    busy={busy}
                    imageModelSelected={imageModelSelected}
                    onImageModelChange={onImageModelChange}
                    nativeWebSearchWireCapable={nativeWebSearchWireCapable}
                    fastModeBilling={fastModeBilling}
                    fastModeHint={fastModeHint}
                    updateBinding={updateBinding}
                  />
                </li>
              );
            })}
          </ul>
        )}

        <div className="provider-custom-model">
          <Field
            label={t("settings.customModel")}
            hint={customModelError || t("settings.customModelHint")}
          >
            <div className="provider-custom-model-row">
              <Input
                ref={customModelInputRef}
                value={customModelId}
                placeholder={t("settings.customModelPlaceholder")}
                className="font-mono text-sm"
                onChange={(event) => {
                  setCustomModelId(event.target.value);
                  if (customModelError) setCustomModelError("");
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  addCustomModel();
                }}
              />
              <Button variant="secondary" disabled={busy} onClick={addCustomModel}>
                <IconPlus size={14} />
                {t("settings.addCustomModel")}
              </Button>
            </div>
          </Field>
        </div>
      </div>
    </div>
  );
}

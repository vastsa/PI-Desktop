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
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  THINKING_LEVELS,
  bindingForCustomModel,
  bindingFromModelInfo,
  formatTokenCount,
  modelMatchesFilter,
  publishedThinkingLevels,
  sortThinkingLevels,
  type ModelBinding,
  type ModelInfo,
  type ThinkingLevel,
} from "@pi-desktop/shared";
import { Button, Field, Input, Tooltip, TooltipButton, cx } from "../ui";
import { IconClose, IconHelp, IconPlus, IconRefresh, IconSearch } from "../icons";
import { describeModelsFetchError } from "./model-fetch-error";
import type { ProviderModelsState } from "./useProviderModels";

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
        const defaultThinkingLevel =
          binding.defaultThinkingLevel && enabled.includes(binding.defaultThinkingLevel)
            ? binding.defaultThinkingLevel
            : (enabled[0] ?? null);
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
      row.info ? bindingFromModelInfo(row.info) : bindingForCustomModel(row.id),
    );
  }
  return additions.length === 0 ? current : [...current, ...additions];
}

export type ModelSelectionPanesProps = {
  discovery: ProviderModelsState & { canReload?: boolean };
  selection: ModelSelection;
  /** Heading of the discovered list: a service's models, or an account's. */
  listTitle: string;
  /** True while the caller saves, so the picker stops accepting input. */
  busy?: boolean;
  /** Probe the service's model list now, skipping the edit debounce. */
  onReload?: () => void;
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
}: ModelSelectionPanesProps) {
  const { t } = useTranslation();
  const { rows, models, publishedLevelsById, setModels } = selection;
  const [modelQuery, setModelQuery] = useState("");
  const [customModelId, setCustomModelId] = useState("");
  const [customModelError, setCustomModelError] = useState("");
  const [expandedModelId, setExpandedModelId] = useState<string | null>(
    () => models[0]?.id ?? null,
  );

  // The returned list is short and already local, so filtering is client-side:
  // no host search and no debounced IPC round trip.
  const visibleRows = useMemo(() => {
    const needle = modelQuery.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (row) =>
        row.id.toLowerCase().includes(needle) ||
        row.displayName.toLowerCase().includes(needle),
    );
  }, [modelQuery, rows]);

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

  const toggleModel = (row: ModelRow) => {
    const wanted = row.id.toLowerCase();
    const alreadyChosen = models.some(
      (binding) => binding.id.toLowerCase() === wanted,
    );
    if (!alreadyChosen) setExpandedModelId((open) => open ?? row.id);
    setModels((current) => {
      if (current.some((binding) => binding.id.toLowerCase() === wanted)) {
        return current.filter((binding) => binding.id.toLowerCase() !== wanted);
      }
      // A discovered row arrives already enriched, so its published limits and
      // thinking levels are adopted as-is.
      return [
        ...current,
        row.info ? bindingFromModelInfo(row.info) : bindingForCustomModel(row.id),
      ];
    });
  };

  const toggleVisibleModels = (select: boolean) => {
    if (select) setExpandedModelId((open) => open ?? visibleRows[0]?.id ?? null);
    setModels((current) => applyVisibleModelSelection(current, visibleRows, select));
  };

  const updateBinding = (id: string, update: Partial<ModelBinding>) =>
    setModels((current) =>
      current.map((binding) => (binding.id === id ? { ...binding, ...update } : binding)),
    );

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
    setModels((current) => [...current, bindingForCustomModel(id)]);
    setExpandedModelId(id);
    setCustomModelId("");
    setCustomModelError("");
  };

  const fetchFailed = discovery.status === "error";
  const emptyFetchError = fetchFailed && rows.length === 0;

  const modelListBody =
    discovery.status === "idle" ? (
      <div className="provider-models-placeholder">{t("settings.modelsEmptyHint")}</div>
    ) : emptyFetchError ? (
      <ModelsFetchErrorMessage error={discovery.error} variant="placeholder" />
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
                {formatTokenCount(row.contextWindow)} · {formatTokenCount(row.maxTokens)}
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
            <h4 className="provider-models-title">{listTitle}</h4>
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

        {discovery.source === "catalog" ? (
          <div className="provider-models-note">{t("settings.modelsFromCatalogNote")}</div>
        ) : null}
        {discovery.source === "fallback" ? (
          <div className="provider-models-note">{t("settings.modelsFallbackNote")}</div>
        ) : null}
        {fetchFailed && !emptyFetchError ? (
          <ModelsFetchErrorMessage error={discovery.error} variant="banner" />
        ) : null}

        {modelListBody}
      </div>

      <div className="provider-chosen">
        <div className="provider-chosen-head">
          <h4 className="provider-chosen-title">{t("settings.modelConfigurations")}</h4>
          <span className="provider-chosen-count">{models.length}</span>
        </div>
        {models.length === 0 ? (
          <div className="provider-chosen-empty">{t("settings.noModelsChosen")}</div>
        ) : (
          <ul className="provider-chosen-list">
            {models.map((binding) => {
              // The catalog is a baseline, not a capability gate. Always show
              // the canonical ladder so a proxy or newly released model can be
              // configured before models.dev catches up.
              const levelChoices = THINKING_LEVELS;
              const publishedLevels =
                publishedLevelsById.get(binding.id.toLowerCase()) ?? [];
              const enabledLevels = sortThinkingLevels(binding.thinkingLevels);
              const info = infoById.get(binding.id.toLowerCase());
              const publishedImages = info ? modelMatchesFilter(info, "vision") : false;
              const publishedDocuments = info ? modelMatchesFilter(info, "pdf") : false;
              const expanded = expandedModelId === binding.id;
              const advancedId = `model-advanced-${binding.id}`;
              return (
                <li className="provider-chosen-row" key={binding.id}>
                  <div className="provider-chosen-row-head">
                    <span className="provider-chosen-row-id font-mono selectable">
                      {binding.id}
                    </span>
                    {binding.alias?.trim() ? (
                      <span className="provider-chosen-row-alias">{binding.alias.trim()}</span>
                    ) : null}
                    <span className="provider-chosen-row-limits">
                      {formatTokenCount(binding.contextWindow)} ·{" "}
                      {formatTokenCount(binding.maxTokens)}
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
                  {/* Dense sheet: 2xs labels, alias hint as a title tooltip. */}
                  <div
                    className="provider-chosen-row-body"
                    id={advancedId}
                    hidden={!expanded}
                  >
                    <label className="provider-chosen-field">
                      <span className="provider-chosen-field-label">
                        {t("settings.modelAlias")}
                      </span>
                      <Input
                        value={binding.alias ?? ""}
                        placeholder={t("settings.modelAliasPlaceholder")}
                        title={t("settings.modelAliasHint")}
                        spellCheck={false}
                        autoCorrect="off"
                        autoCapitalize="off"
                        onChange={(event) =>
                          updateBinding(binding.id, {
                            // Host-core caps the alias at 60 Unicode scalars, so
                            // clamp by code point rather than UTF-16 unit.
                            alias: [...event.target.value].slice(0, 60).join(""),
                          })
                        }
                      />
                    </label>
                    <div className="provider-chosen-limits">
                      <label className="provider-chosen-field">
                        <span className="provider-chosen-field-label">
                          {t("settings.contextWindow")}
                        </span>
                        <Input
                          type="number"
                          min={1}
                          inputMode="numeric"
                          value={binding.contextWindow}
                          onChange={(event) =>
                            updateBinding(binding.id, {
                              contextWindow: Number(event.target.value) || 0,
                            })
                          }
                        />
                      </label>
                      <label className="provider-chosen-field">
                        <span className="provider-chosen-field-label">
                          {t("settings.maxOutput")}
                        </span>
                        <Input
                          type="number"
                          min={1}
                          inputMode="numeric"
                          value={binding.maxTokens}
                          onChange={(event) =>
                            updateBinding(binding.id, {
                              maxTokens: Number(event.target.value) || 0,
                            })
                          }
                        />
                      </label>
                    </div>
                    <div className="provider-chosen-thinking">
                      <div className="provider-chosen-thinking-head">
                        <span className="provider-chosen-thinking-label">
                          {t("settings.supportedThinkingLevels")}
                        </span>
                        {publishedLevels.length === 0 ? (
                          <span className="provider-chosen-thinking-hint">
                            {t("settings.thinkingManualOverrideHint")}
                          </span>
                        ) : null}
                        {enabledLevels.length > 1 ? (
                          <label className="provider-chosen-thinking-default">
                            <span className="provider-chosen-thinking-label">
                              {t("settings.defaultThinkingLevel")}
                            </span>
                            <select
                              className="provider-chosen-thinking-select"
                              value={
                                binding.defaultThinkingLevel &&
                                enabledLevels.includes(binding.defaultThinkingLevel)
                                  ? binding.defaultThinkingLevel
                                  : (enabledLevels[0] ?? "")
                              }
                              onChange={(event) =>
                                updateBinding(binding.id, {
                                  defaultThinkingLevel: event.target
                                    .value as ThinkingLevel,
                                })
                              }
                            >
                              {enabledLevels.map((level) => (
                                <option key={level} value={level}>
                                  {level}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : null}
                      </div>
                      <div
                        className="provider-chosen-thinking-chips"
                        role="group"
                        aria-label={t("settings.supportedThinkingLevels")}
                      >
                        {levelChoices.map((level) => {
                          const on = binding.thinkingLevels.includes(level);
                          return (
                            <TooltipButton
                              key={level}
                              type="button"
                              className={cx("provider-thinking-chip", on && "selected")}
                              ariaLabel={level}
                              tooltip={level}
                              aria-pressed={on}
                              onClick={() => {
                                const next: ThinkingLevel[] = on
                                  ? binding.thinkingLevels.filter(
                                      (entry) => entry !== level,
                                    )
                                  : [...binding.thinkingLevels, level];
                                updateBinding(binding.id, {
                                  thinkingLevels: next,
                                  defaultThinkingLevel: next.includes(
                                    binding.defaultThinkingLevel as ThinkingLevel,
                                  )
                                    ? binding.defaultThinkingLevel
                                    : (sortThinkingLevels(next)[0] ?? null),
                                });
                              }}
                            >
                              {level}
                            </TooltipButton>
                          );
                        })}
                      </div>
                    </div>
                    <div className="provider-chosen-capabilities">
                      <span className="provider-chosen-thinking-label">
                        {t("settings.modelCapabilities")}
                      </span>
                      <div className="provider-chosen-capability-rows">
                        <CapabilityToggle
                          label={t("settings.imageInput")}
                          published={publishedImages}
                          value={binding.supportsImages}
                          onChange={(next) =>
                            updateBinding(binding.id, { supportsImages: next })
                          }
                        />
                        <CapabilityToggle
                          label={t("settings.documentInput")}
                          published={publishedDocuments}
                          value={binding.supportsDocuments}
                          onChange={(next) =>
                            updateBinding(binding.id, { supportsDocuments: next })
                          }
                        />
                        <span className="provider-chosen-delegation">
                          <label className="provider-chosen-capability">
                            <input
                              type="checkbox"
                              checked={binding.availableForSubagents ?? false}
                              onChange={(event) =>
                                updateBinding(binding.id, {
                                  availableForSubagents:
                                    event.target.checked || undefined,
                                })
                              }
                            />
                            <span>{t("settings.availableForSubagents")}</span>
                          </label>
                          <Tooltip
                            className="provider-chosen-delegation-help"
                            label={t("settings.availableForSubagentsHint")}
                            ariaLabel={t("settings.availableForSubagentsHint")}
                          >
                            <IconHelp size={13} />
                          </Tooltip>
                        </span>
                      </div>
                    </div>
                  </div>
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

function ModelsFetchErrorMessage({
  error,
  variant,
}: {
  error?: string;
  variant: "banner" | "placeholder";
}) {
  const { t } = useTranslation();
  const view = describeModelsFetchError(error);
  let summary = t("settings.modelsFetchFailed");
  switch (view.kind) {
    case "unauthorized":
      summary = t("errors.PROVIDER_UNAUTHORIZED");
      break;
    case "notFound":
      summary = t("settings.modelsFetchNotFound");
      break;
    case "rateLimited":
      summary = t("errors.PROVIDER_RATE_LIMITED");
      break;
    case "timeout":
      summary = t("errors.TIMEOUT");
      break;
    case "network":
      summary = t("errors.NETWORK_ERROR");
      break;
    case "invalidResponse":
      summary = t("settings.modelsFetchInvalidResponse");
      break;
    case "http":
      summary = t("settings.modelsFetchFailedStatus", {
        status: view.summaryParams?.status ?? 0,
      });
      break;
  }
  const className =
    variant === "placeholder"
      ? "provider-models-placeholder is-error"
      : "provider-models-note is-error";
  return (
    <div className={className} role="alert">
      <span className="provider-models-error-summary">{summary}</span>
      {view.detail ? (
        <span className="provider-models-error-detail">{view.detail}</span>
      ) : null}
      {variant === "placeholder" ? (
        <span className="provider-models-error-hint">{t("settings.modelsFetchHint")}</span>
      ) : null}
    </div>
  );
}

type CapabilityToggleProps = {
  label: string;
  /** What models.dev publishes for this model. */
  published: boolean;
  /** Stored override: `true`/`false` explicit, `null`/undefined follows. */
  value: boolean | null | undefined;
  onChange: (next: boolean | null) => void;
};

/**
 * One attachment capability as a plain checkbox showing the effective answer.
 *
 * The three stored states stay, but they need no third control: ticking the box
 * back to what models.dev publishes stores "follow the catalog" rather than an
 * equal-valued override, so agreeing with the catalog is the reset. That keeps a
 * later catalog correction flowing through without asking the user to
 * understand the distinction.
 */
function CapabilityToggle({ label, published, value, onChange }: CapabilityToggleProps) {
  const effective = typeof value === "boolean" ? value : published;
  return (
    <label className="provider-chosen-capability">
      <input
        type="checkbox"
        checked={effective}
        onChange={(event) =>
          onChange(event.target.checked === published ? null : event.target.checked)
        }
      />
      <span>{label}</span>
    </label>
  );
}

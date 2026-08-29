/**
 * One form to add or edit an AI service.
 *
 * Name, base URL and key are entered together, and the model list comes from
 * the service's own endpoint (`useProviderModels`) rather than from a browsable
 * catalog. models.dev only enriches the rows the service returned, which is why
 * context/output limits need no manual entry on the common path.
 */
import { useMemo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  API_STYLES,
  bindingForCustomModel,
  bindingFromModelInfo,
  formatTokenCount,
  publishedThinkingLevels,
  type CatalogApiStyle,
  type ModelBinding,
  type ModelInfo,
  type ProviderPublic,
  type ThinkingLevel,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Button, Field, Input, Select, cx } from "../ui";
import { IconClose, IconPlus, IconSearch } from "../icons";
import { useProviderModels } from "./useProviderModels";

const API_STYLE_LABEL_KEYS: Record<CatalogApiStyle, string> = {
  chat_completions: "settings.apiStyleChatCompletions",
  responses: "settings.apiStyleResponses",
  anthropic_messages: "settings.apiStyleAnthropic",
  google_generative_ai: "settings.apiStyleGoogle",
  openai_codex_responses: "settings.apiStyleCodexResponses",
  pi_messages: "settings.apiStylePiMessages",
  opencode_go: "settings.apiStyleOpenCodeGo",
};

export type ProviderSetupDialogProps = {
  /** Existing row being edited; absent creates a new service. */
  provider?: ProviderPublic | null;
  onClose: () => void;
  /** Called after a successful create/update so the caller can refresh. */
  onSaved: (provider: ProviderPublic, models: ModelBinding[]) => void;
};

/** One row of the model list: what the service returned, plus its binding. */
type ModelRow = {
  id: string;
  displayName: string;
  contextWindow?: number;
  maxTokens?: number;
  /** Published record when the service (or models.dev) described the model. */
  info?: ModelInfo;
  binding?: ModelBinding;
};

export function ProviderSetupDialog({
  provider,
  onClose,
  onSaved,
}: ProviderSetupDialogProps) {
  const { t } = useTranslation();
  const editing = !!provider;
  const [name, setName] = useState(provider?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [apiStyle, setApiStyle] = useState<CatalogApiStyle>(
    (provider?.apiStyle as CatalogApiStyle) ?? "chat_completions",
  );
  const [models, setModels] = useState<ModelBinding[]>(provider?.models ?? []);
  const [modelQuery, setModelQuery] = useState("");
  const [customModelId, setCustomModelId] = useState("");
  const [customModelError, setCustomModelError] = useState("");
  const [expandedModelId, setExpandedModelId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [testResult, setTestResult] = useState("");

  const discovery = useProviderModels(true, { baseUrl, apiKey, apiStyle }, provider);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || saving) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  /**
   * Rows are the models the service returned, plus any configured binding the
   * current answer does not mention (a hand-typed id, or an endpoint that went
   * quiet), so nothing already saved can silently disappear.
   */
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

  /**
   * Thinking levels a configured model may actually be given. The runtime
   * intersects a binding with the published levels before it builds a request,
   * so enabling anything outside this list would be discarded there and the
   * Composer reasoning menu would offer fewer entries than this dialog did.
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

  const toggleModel = (row: ModelRow) =>
    setModels((current) => {
      const wanted = row.id.toLowerCase();
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
    setCustomModelId("");
    setCustomModelError("");
  };

  const testConnection = async () => {
    if (!provider) return;
    setTesting(true);
    setTestResult("");
    try {
      const result = (await api.testProvider(provider.id)) as {
        ok?: boolean;
        message?: string;
        status?: number;
      };
      setTestResult(
        result?.ok
          ? t("settings.testOk")
          : result?.message ||
              (result?.status
                ? t("settings.testFailedStatus", { status: result.status })
                : t("settings.testFailed")),
      );
    } catch (cause) {
      setTestResult(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setTesting(false);
    }
  };

  /**
   * Persist only levels the model publishes. A binding stored before the model
   * was known — or before its published levels changed — can still carry an
   * unsupported level, which the runtime would drop while this dialog kept
   * counting it as enabled.
   */
  const bindingsToPersist = useMemo(
    () =>
      models.map((binding) => {
        const choices = publishedLevelsById.get(binding.id.toLowerCase());
        // An unknown row (discovery is offline) must not erase stored levels.
        if (!choices) return binding;
        const thinkingLevels = binding.thinkingLevels.filter((level) =>
          choices.includes(level),
        );
        if (thinkingLevels.length === binding.thinkingLevels.length) return binding;
        return {
          ...binding,
          thinkingLevels,
          defaultThinkingLevel:
            binding.defaultThinkingLevel &&
            thinkingLevels.includes(binding.defaultThinkingLevel)
              ? binding.defaultThinkingLevel
              : (thinkingLevels[0] ?? null),
        };
      }),
    [models, publishedLevelsById],
  );

  const save = async () => {
    const providerName = name.trim();
    const providerBaseUrl = baseUrl.trim();
    if (!providerName || !providerBaseUrl || models.length === 0) return;
    const persisted = bindingsToPersist;
    setSaving(true);
    setError("");
    try {
      if (provider) {
        const result = await api.updateProvider({
          id: provider.id,
          name: providerName,
          baseUrl: providerBaseUrl,
          defaultModelId: persisted[0]?.id,
          models: persisted,
          apiStyle,
          // An empty key on edit means "keep the stored one", so the secret is
          // only sent when the user actually typed a new value.
          ...(apiKey ? { secretValue: apiKey } : {}),
        });
        onSaved(result.provider ?? provider, persisted);
      } else {
        const result = await api.createProvider({
          name: providerName,
          // Only the main process knows how a base URL maps onto a models.dev
          // provider key, and no renderer-safe mapping is exported; the host
          // resolves the catalog identity from baseUrl when it enriches models.
          vendorKey: "custom",
          type: "openai_compatible",
          protocol: "openai_compatible",
          baseUrl: providerBaseUrl,
          authKind: "api_key_and_base_url",
          defaultModelId: persisted[0]?.id,
          models: persisted,
          secretValue: apiKey || undefined,
          apiStyle,
        });
        onSaved(result.provider, persisted);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const canSave = !saving && !!name.trim() && !!baseUrl.trim() && models.length > 0;

  const modelListBody =
    discovery.status === "idle" ? (
      <div className="provider-models-placeholder">{t("settings.modelsEmptyHint")}</div>
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
        {visibleRows.map((row) => {
          const checked = selected.has(row.id.toLowerCase());
          return (
            <li className="provider-models-row" key={row.id}>
              <label className="provider-models-row-label">
                <input
                  type="checkbox"
                  className="provider-models-check"
                  checked={checked}
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  onChange={() => toggleModel(row)}
                />
                <span className="provider-models-row-copy">
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
          );
        })}
      </ul>
    );

  return (
    <div
      className="overlay provider-setup-overlay"
      role="presentation"
      onClick={() => {
        if (saving) return;
        onClose();
      }}
    >
      <div
        className="dialog provider-setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-setup-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="provider-setup-head">
          <h3 id="provider-setup-title" className="provider-setup-title">
            {editing ? t("settings.editProviderTitle") : t("settings.addProviderTitle")}
          </h3>
          {/*
            The dialog's actions live here instead of a footer bar, so Save sits
            where the close affordance used to be. Cancel keeps the leftmost slot
            of the group so a stray click near the corner discards rather than
            saves, and Escape still closes the dialog.
          */}
          <div className="provider-setup-head-actions">
            {provider ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={testing || saving}
                onClick={() => void testConnection()}
              >
                {testing ? t("settings.testing") : t("settings.testConnection")}
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>
              {t("settings.cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!canSave}
              onClick={() => void save()}
            >
              {saving ? t("settings.saving") : t("settings.saveProvider")}
            </Button>
          </div>
        </div>

        <div className="provider-setup-body">
          {/* A save failure belongs next to the fields, not under the panes. */}
          {error ? <div className="provider-setup-error">{error}</div> : null}

          <div className="provider-setup-credentials">
            <div className="provider-setup-fields">
              <Field label={t("settings.name")}>
                <Input
                  value={name}
                  autoFocus
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>

              <Field label={t("settings.baseUrl")}>
                <Input
                  value={baseUrl}
                  className="font-mono text-sm-plus"
                  placeholder="https://api.example.com/v1"
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
              </Field>

              <Field
                label={t("settings.apiKey")}
                hint={editing ? t("settings.apiKeyKeepHint") : t("settings.apiKeyHint")}
              >
                <Input
                  type="password"
                  value={apiKey}
                  placeholder="sk-…"
                  className="font-mono text-sm-plus"
                  autoComplete="off"
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </Field>

              {/*
                Derived from the endpoint, but a plain fourth field: a whole
                disclosure for one select was more chrome than the setting.
              */}
              <Field label={t("settings.apiStyle")} hint={t("settings.apiStyleDerived")}>
                <Select
                  value={apiStyle}
                  onChange={(event) => setApiStyle(event.target.value as CatalogApiStyle)}
                >
                  {API_STYLES.map((style) => (
                    <option key={style} value={style}>
                      {t(API_STYLE_LABEL_KEYS[style])}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            {testResult ? (
              <div className="provider-credential-test">
                <span className="provider-credential-test-result">{testResult}</span>
              </div>
            ) : null}
          </div>

          {/*
            Two panes, because picking a model and reviewing what was picked
            are one task: the service's list on the left, the chosen bindings
            on the right. Stacking them made the dialog scroll for no reason.
          */}
          <div className="provider-setup-panes">
            <div className="provider-models">
              <div className="provider-models-head">
                <h4 className="provider-models-title">{t("settings.serviceModels")}</h4>
                {discovery.status === "loading" ? (
                  <span className="provider-models-state">{t("settings.modelsLoading")}</span>
                ) : null}
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
              {discovery.status === "error" ? (
                <div className="provider-models-note is-error">
                  {discovery.error || t("settings.modelsFetchHint")}
                </div>
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
                    // An unknown row has no published list to offer, so it shows
                    // what is already enabled rather than claiming the model has
                    // no thinking support.
                    const levelChoices =
                      publishedLevelsById.get(binding.id.toLowerCase()) ??
                      binding.thinkingLevels;
                    return (
                    <li className="provider-chosen-row" key={binding.id}>
                      <div className="provider-chosen-row-head">
                        <span className="provider-chosen-row-id font-mono">{binding.id}</span>
                        <span className="provider-chosen-row-limits">
                          {formatTokenCount(binding.contextWindow)} ·{" "}
                          {formatTokenCount(binding.maxTokens)}
                        </span>
                        <button
                          type="button"
                          className="provider-chosen-advanced-toggle"
                          aria-expanded={expandedModelId === binding.id}
                          onClick={() =>
                            setExpandedModelId((current) =>
                              current === binding.id ? null : binding.id,
                            )
                          }
                        >
                          {t("settings.advanced")}
                        </button>
                        <button
                          type="button"
                          className="provider-chosen-remove"
                          aria-label={t("settings.removeModel")}
                          title={t("settings.removeModel")}
                          onClick={() =>
                            setModels((current) =>
                              current.filter((entry) => entry.id !== binding.id),
                            )
                          }
                        >
                          <IconClose size={12} />
                        </button>
                      </div>
                      <div
                        className="provider-chosen-row-body"
                        hidden={expandedModelId !== binding.id}
                      >
                        <div className="provider-chosen-limits">
                          <Field label={t("settings.contextWindow")}>
                            <Input
                              type="number"
                              min={1}
                              value={binding.contextWindow}
                              onChange={(event) =>
                                updateBinding(binding.id, {
                                  contextWindow: Number(event.target.value) || 0,
                                })
                              }
                            />
                          </Field>
                          <Field label={t("settings.maxOutput")}>
                            <Input
                              type="number"
                              min={1}
                              value={binding.maxTokens}
                              onChange={(event) =>
                                updateBinding(binding.id, {
                                  maxTokens: Number(event.target.value) || 0,
                                })
                              }
                            />
                          </Field>
                        </div>
                        <div className="provider-chosen-thinking">
                          <span className="provider-chosen-thinking-label">
                            {t("settings.supportedThinkingLevels")}
                          </span>
                          <div className="provider-chosen-thinking-chips">
                            {levelChoices.length === 0 ? (
                              <span className="provider-chosen-thinking-empty">
                                {t("settings.thinkingDisabledHint")}
                              </span>
                            ) : null}
                            {levelChoices.map((level) => {
                              const on = binding.thinkingLevels.includes(level);
                              return (
                                <button
                                  key={level}
                                  type="button"
                                  className={cx("provider-thinking-chip", on && "selected")}
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
                                        : (next[0] ?? null),
                                    });
                                  }}
                                >
                                  {t(`thinkingLevel.${level}`)}
                                </button>
                              );
                            })}
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
                      className="font-mono text-sm-plus"
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
                    <Button variant="secondary" onClick={addCustomModel}>
                      <IconPlus size={14} />
                      {t("settings.addCustomModel")}
                    </Button>
                  </div>
                </Field>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

/**
 * Staged provider setup: pick a models.dev preset, enter the credential, then
 * choose models from the catalog. Replaces the old single dense form.
 *
 * The API format is derived from the preset's published adapter and only
 * surfaces under "Advanced" for custom endpoints. Token limits come from
 * bindingFromModelInfo, so the common path needs no numeric entry at all.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  API_STYLES,
  THINKING_LEVELS,
  bindingForCustomModel,
  bindingFromModelInfo,
  formatTokenCount,
  type CatalogApiStyle,
  type CatalogProviderPreset,
  type ModelBinding,
  type ModelInfo,
  type ProviderPublic,
  type ThinkingLevel,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Badge, Button, Field, Input, Select, cx } from "../ui";
import { IconCheck, IconClose, IconExternal, IconPlus, IconSearch } from "../icons";
import { ModelCatalogBrowser } from "./ModelCatalogBrowser";

/** Ordered stages of the flow; the stepper renders them in this order. */
const STAGES = ["provider", "credential", "models"] as const;
export type ProviderSetupStage = (typeof STAGES)[number];

const API_STYLE_LABEL_KEYS: Record<CatalogApiStyle, string> = {
  chat_completions: "settings.apiStyleChatCompletions",
  responses: "settings.apiStyleResponses",
  anthropic_messages: "settings.apiStyleAnthropic",
  google_generative_ai: "settings.apiStyleGoogle",
  openai_codex_responses: "settings.apiStyleCodexResponses",
  pi_messages: "settings.apiStylePiMessages",
  opencode_go: "settings.apiStyleOpenCodeGo",
};

/** Sentinel preset for a hand-typed OpenAI-compatible endpoint. */
const CUSTOM_PRESET_KEY = "__custom__";

export type ProviderSetupDialogProps = {
  /** Existing row being edited; absent starts at the preset grid. */
  provider?: ProviderPublic | null;
  onClose: () => void;
  /** Called after a successful create/update so the caller can refresh. */
  onSaved: (provider: ProviderPublic, models: ModelBinding[]) => void;
  /** Injectable preset loader so tests can stub the catalog. */
  loadPresets?: typeof api.catalogPresets;
};

export function ProviderSetupDialog({
  provider,
  onClose,
  onSaved,
  loadPresets = api.catalogPresets,
}: ProviderSetupDialogProps) {
  const { t } = useTranslation();
  const editing = !!provider;
  const [stage, setStage] = useState<ProviderSetupStage>(
    editing ? "credential" : "provider",
  );
  const [presets, setPresets] = useState<CatalogProviderPreset[]>([]);
  const [presetQuery, setPresetQuery] = useState("");
  const [preset, setPreset] = useState<CatalogProviderPreset | null>(null);
  const [custom, setCustom] = useState(false);
  const [name, setName] = useState(provider?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [apiStyle, setApiStyle] = useState<CatalogApiStyle>(
    (provider?.apiStyle as CatalogApiStyle) ?? "chat_completions",
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [models, setModels] = useState<ModelBinding[]>(provider?.models ?? []);
  const [customModelId, setCustomModelId] = useState("");
  const [customModelError, setCustomModelError] = useState("");
  const [expandedModelId, setExpandedModelId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [testResult, setTestResult] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const result = await loadPresets();
        setPresets(result.presets);
        if (provider) {
          // Editing keeps the provider's own identity, but the preset supplies
          // the catalog scope the model browser searches within.
          const match = result.presets.find(
            (entry) => entry.configuredProviderId === provider.id,
          );
          if (match) setPreset(match);
          else setCustom(true);
        }
      } catch {
        // A missing catalog only costs the preset grid; the custom endpoint
        // path still works.
        setPresets([]);
        if (provider) setCustom(true);
      }
    })();
  }, [loadPresets, provider]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || saving) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  const visiblePresets = useMemo(() => {
    const needle = presetQuery.trim().toLowerCase();
    if (!needle) return presets;
    return presets.filter(
      (entry) =>
        entry.name.toLowerCase().includes(needle) ||
        entry.providerKey.toLowerCase().includes(needle),
    );
  }, [presetQuery, presets]);

  /** A preset that publishes a base URL locks the field unless custom is chosen. */
  const baseUrlLocked = !custom && !!preset?.baseUrl;
  const selectedIds = models.map((binding) => binding.id);

  const pickPreset = (entry: CatalogProviderPreset) => {
    setPreset(entry);
    setCustom(false);
    setName(entry.name);
    setBaseUrl(entry.baseUrl ?? "");
    setApiStyle(entry.apiStyle);
    setError("");
    setStage("credential");
  };

  const pickCustom = () => {
    setPreset(null);
    setCustom(true);
    setName("");
    setBaseUrl("");
    setApiStyle("chat_completions");
    setAdvancedOpen(true);
    setError("");
    setStage("credential");
  };

  const toggleModel = (model: ModelInfo) =>
    setModels((current) => {
      const wanted = model.modelId.toLowerCase();
      return current.some((binding) => binding.id.toLowerCase() === wanted)
        ? current.filter((binding) => binding.id.toLowerCase() !== wanted)
        : [...current, bindingFromModelInfo(model)];
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

  const save = async () => {
    const providerName = name.trim();
    const providerBaseUrl = baseUrl.trim();
    if (!providerName || !providerBaseUrl || models.length === 0) return;
    setSaving(true);
    setError("");
    try {
      if (provider) {
        const result = await api.updateProvider({
          id: provider.id,
          name: providerName,
          baseUrl: providerBaseUrl,
          defaultModelId: models[0]?.id,
          models,
          apiStyle,
          ...(apiKey ? { secretValue: apiKey } : {}),
        });
        onSaved(result.provider ?? provider, models);
      } else {
        const result = await api.createProvider({
          name: providerName,
          vendorKey: preset?.providerKey ?? "custom",
          type: "openai_compatible",
          protocol: "openai_compatible",
          baseUrl: providerBaseUrl,
          authKind: "api_key_and_base_url",
          defaultModelId: models[0]?.id,
          models,
          secretValue: apiKey || undefined,
          apiStyle,
        });
        onSaved(result.provider, models);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const stageLabels: Record<ProviderSetupStage, string> = {
    provider: t("settings.setupStageProvider"),
    credential: t("settings.setupStageCredential"),
    models: t("settings.setupStageModels"),
  };
  const stageIndex = STAGES.indexOf(stage);
  const credentialReady = !!name.trim() && !!baseUrl.trim();
  const canGoNext =
    stage === "provider"
      ? !!preset || custom
      : stage === "credential"
        ? credentialReady
        : models.length > 0;

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
          <button
            type="button"
            className="provider-setup-close"
            aria-label={t("settings.cancel")}
            disabled={saving}
            onClick={onClose}
          >
            <IconClose size={16} />
          </button>
        </div>

        <ol className="provider-setup-stepper">
          {STAGES.map((entry, index) => (
            <li
              key={entry}
              className={cx(
                "provider-setup-step",
                entry === stage && "is-current",
                index < stageIndex && "is-done",
              )}
              aria-current={entry === stage ? "step" : undefined}
            >
              <span className="provider-setup-step-marker" aria-hidden>
                {index < stageIndex ? <IconCheck size={11} /> : index + 1}
              </span>
              <span className="provider-setup-step-label">{stageLabels[entry]}</span>
            </li>
          ))}
        </ol>

        <div className="provider-setup-body">
          {stage === "provider" ? (
            <div className="provider-preset-stage">
              <div className="provider-preset-search-wrap">
                <IconSearch size={14} aria-hidden />
                <input
                  className="provider-preset-search"
                  value={presetQuery}
                  placeholder={t("settings.presetSearch")}
                  aria-label={t("settings.presetSearch")}
                  autoFocus
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  autoComplete="off"
                  onChange={(event) => setPresetQuery(event.target.value)}
                />
              </div>
              <div className="provider-preset-grid">
                {visiblePresets.map((entry) => (
                  <button
                    key={entry.providerKey}
                    type="button"
                    className={cx(
                      "provider-preset-card",
                      preset?.providerKey === entry.providerKey && "is-selected",
                    )}
                    onClick={() => pickPreset(entry)}
                  >
                    <span className="provider-preset-card-name">{entry.name}</span>
                    <span className="provider-preset-card-meta">
                      {t("settings.presetModelCount", { count: entry.modelCount })}
                    </span>
                    {entry.configuredProviderId ? (
                      <Badge tone="success">{t("settings.configured")}</Badge>
                    ) : null}
                  </button>
                ))}
                <button
                  key={CUSTOM_PRESET_KEY}
                  type="button"
                  className={cx("provider-preset-card", "is-custom", custom && "is-selected")}
                  onClick={pickCustom}
                >
                  <span className="provider-preset-card-name">
                    {t("settings.presetCustomEndpoint")}
                  </span>
                  <span className="provider-preset-card-meta">
                    {t("settings.presetCustomEndpointDesc")}
                  </span>
                </button>
              </div>
            </div>
          ) : null}

          {stage === "credential" ? (
            <div className="provider-credential-stage">
              <Field label={t("settings.name")}>
                <Input
                  value={name}
                  autoFocus
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>

              {baseUrlLocked ? (
                <Field label={t("settings.baseUrl")} hint={t("settings.baseUrlPublished")}>
                  <div className="provider-credential-fixed font-mono">{baseUrl}</div>
                </Field>
              ) : (
                <Field label={t("settings.baseUrl")}>
                  <Input
                    value={baseUrl}
                    className="font-mono text-sm-plus"
                    placeholder="https://api.example.com/v1"
                    onChange={(event) => setBaseUrl(event.target.value)}
                  />
                </Field>
              )}

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

              {preset?.envVars?.length ? (
                <div className="provider-credential-hint">
                  {t("settings.presetEnvHint", { vars: preset.envVars.join(", ") })}
                </div>
              ) : null}

              {preset?.doc ? (
                <a
                  className="provider-credential-doc"
                  href={preset.doc}
                  target="_blank"
                  rel="noreferrer"
                >
                  <IconExternal size={12} aria-hidden />
                  <span>{t("settings.presetOpenDocs")}</span>
                </a>
              ) : null}

              {provider ? (
                <div className="provider-credential-test">
                  <Button variant="secondary" disabled={testing} onClick={() => void testConnection()}>
                    {testing ? t("settings.testing") : t("settings.testConnection")}
                  </Button>
                  {testResult ? (
                    <span className="provider-credential-test-result">{testResult}</span>
                  ) : null}
                </div>
              ) : null}

              <details
                className="provider-advanced"
                open={advancedOpen}
                onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
              >
                <summary className="provider-advanced-summary">
                  {t("settings.advanced")}
                </summary>
                <div className="provider-advanced-body">
                  <Field label={t("settings.apiStyle")} hint={t("settings.apiStyleDerived")}>
                    <Select
                      value={apiStyle}
                      onChange={(event) =>
                        setApiStyle(event.target.value as CatalogApiStyle)
                      }
                    >
                      {API_STYLES.map((style) => (
                        <option key={style} value={style}>
                          {t(API_STYLE_LABEL_KEYS[style])}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
              </details>
            </div>
          ) : null}

          {stage === "models" ? (
            <div className="provider-models-stage">
              <ModelCatalogBrowser
                providerKey={custom ? undefined : preset?.providerKey}
                providerId={custom ? undefined : provider?.id}
                selectedIds={selectedIds}
                footerActions={false}
                onToggle={toggleModel}
                onConfirm={() => void save()}
                onCancel={onClose}
              />

              <div className="provider-chosen">
                <div className="provider-chosen-head">
                  <h4 className="provider-chosen-title">{t("settings.modelConfigurations")}</h4>
                  <span className="provider-chosen-count">{models.length}</span>
                </div>
                {models.length === 0 ? (
                  <div className="provider-chosen-empty">{t("settings.noModelsChosen")}</div>
                ) : (
                  <ul className="provider-chosen-list">
                    {models.map((binding) => (
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
                              {THINKING_LEVELS.map((level) => {
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
                    ))}
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
          ) : null}
        </div>

        {error ? <div className="provider-setup-error">{error}</div> : null}

        <div className="provider-setup-actions">
          <Button
            variant="ghost"
            disabled={saving || stageIndex === 0 || editing}
            onClick={() => setStage(STAGES[Math.max(stageIndex - 1, 0)])}
          >
            {t("settings.back")}
          </Button>
          <div className="provider-setup-actions-right">
            <Button variant="ghost" disabled={saving} onClick={onClose}>
              {t("settings.cancel")}
            </Button>
            {stage === "models" ? (
              <Button variant="primary" disabled={saving || !canGoNext} onClick={() => void save()}>
                {saving ? t("settings.saving") : t("settings.saveProvider")}
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={saving || !canGoNext}
                onClick={() => setStage(STAGES[Math.min(stageIndex + 1, STAGES.length - 1)])}
              >
                {t("settings.next")}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

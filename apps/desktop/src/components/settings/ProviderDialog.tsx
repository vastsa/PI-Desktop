import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  OPENCODE_GO_API_STYLE,
  THINKING_LEVELS,
  type ModelInfo,
  type ProviderPublic,
  type ThinkingLevel,
} from "@pi-desktop/shared";
import { Button, Field, Input, Select } from "../ui";
import { IconClose, IconPlus } from "../icons";
import { ModelConfigCard } from "./ModelConfigCard";
import { ModelMultiSelect } from "./ModelMultiSelect";
import {
  CUSTOM_API_STYLE_OPTIONS,
  fallbackModelDraft,
  fixedProviderFieldsForApiStyle,
  isCatalogModel,
  modelDraftFromInfo,
  type ApiStyle,
  type ProviderForm,
  type ProviderModelDraft,
} from "./provider-form";
import { useProviderModels } from "./useProviderModels";

function modelInfoForDraft(draft: ProviderModelDraft, discovered: ModelInfo[]): ModelInfo {
  return (
    discovered.find((model) => model.modelId === draft.id) ?? {
      modelId: draft.id,
      displayName: draft.id,
      providerId: "",
      contextWindow: draft.contextWindow,
      maxTokens: draft.maxTokens,
      reasoning: draft.thinkingLevels.length > 0,
      supportedThinkingLevels: draft.thinkingLevels,
      source: draft.source === "catalog" ? "bundled" : "user",
      capabilities: draft.thinkingLevels.length > 0 ? ["text", "reasoning"] : ["text"],
    }
  );
}

export function ProviderDialog({
  editingProvider,
  form,
  setField,
  saving,
  onClose,
  onSave,
}: {
  editingProvider: ProviderPublic | null;
  form: ProviderForm;
  setField: <K extends keyof ProviderForm>(key: K, value: ProviderForm[K]) => void;
  saving: boolean;
  onClose: () => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  const models = useProviderModels(true, form, editingProvider);
  const discovered = "models" in models ? models.models : [];
  const [customModelId, setCustomModelId] = useState("");
  const [customModelError, setCustomModelError] = useState("");
  const [customModelIds, setCustomModelIds] = useState<string[]>(() =>
    form.models
      .filter((model) => model.source !== "catalog")
      .map((model) => model.id),
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || saving) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saving, onClose]);

  const selectedIds = form.models.map((model) => model.id);
  const discoveredById = useMemo(
    () => new Map(discovered.map((model) => [model.modelId, model])),
    [discovered],
  );
  const customIds = useMemo(
    () =>
      Array.from(
        new Set([
          ...customModelIds.filter(
            (id) => !isCatalogModel(discoveredById.get(id)),
          ),
          ...form.models
            .filter(
              (model) =>
                model.source !== "catalog" &&
                !isCatalogModel(discoveredById.get(model.id)),
            )
            .map((model) => model.id),
        ]),
      ),
    [customModelIds, discoveredById, form.models],
  );
  const optionModels = useMemo(() => {
    const byId = new Map<string, ModelInfo>();
    for (const id of customIds) {
      byId.set(
        id,
        discoveredById.get(id) ?? modelInfoForDraft(fallbackModelDraft(id), []),
      );
    }
    for (const model of discovered) {
      if (!byId.has(model.modelId)) byId.set(model.modelId, model);
    }
    for (const draft of form.models) {
      if (!byId.has(draft.id)) byId.set(draft.id, modelInfoForDraft(draft, []));
    }
    return [...byId.values()];
  }, [customIds, discovered, form.models]);

  const updateModels = (next: ProviderModelDraft[]) => setField("models", next);

  const toggleModel = (model: ModelInfo) => {
    const selected = form.models.some((item) => item.id === model.modelId);
    updateModels(
      selected
        ? form.models.filter((item) => item.id !== model.modelId)
        : [...form.models, modelDraftFromInfo(model)],
    );
  };

  const updateModel = (id: string, update: Partial<ProviderModelDraft>) => {
    updateModels(
      form.models.map((model) => (model.id === id ? { ...model, ...update } : model)),
    );
  };

  const addCustomModel = () => {
    const id = customModelId.trim();
    if (!id) {
      setCustomModelError(t("settings.customModelRequired"));
      return;
    }
    if (optionModels.some((model) => model.modelId.toLowerCase() === id.toLowerCase())) {
      setCustomModelError(t("settings.modelAlreadyAdded"));
      return;
    }
    setCustomModelIds((current) => [...current, id]);
    updateModels([...form.models, fallbackModelDraft(id)]);
    setCustomModelId("");
    setCustomModelError("");
  };

  const levelLabels = THINKING_LEVELS.reduce(
    (labels, level) => {
      labels[level] = t(`thinkingLevel.${level}`);
      return labels;
    },
    {} as Record<ThinkingLevel, string>,
  );

  const modelsStatusHint =
    models.status === "error" ? t("settings.modelsFetchHint") : undefined;
  const isOpenCodeGo = form.apiStyle === OPENCODE_GO_API_STYLE;

  const changeApiStyle = (apiStyle: ApiStyle) => {
    setField("apiStyle", apiStyle);
    const fixedFields = fixedProviderFieldsForApiStyle(apiStyle);
    if (fixedFields) {
      setField("name", fixedFields.name);
      setField("baseUrl", fixedFields.baseUrl);
    }
  };

  return (
    <div
      className="overlay provider-dialog-overlay"
      role="presentation"
      onClick={() => {
        if (saving) return;
        onClose();
      }}
    >
      <div
        className="dialog provider-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="provider-dialog-head">
          <h3 id="provider-dialog-title" className="provider-dialog-title">
            {editingProvider ? t("settings.editProviderTitle") : t("settings.addProviderTitle")}
          </h3>
          <button
            type="button"
            className="provider-dialog-close"
            aria-label={t("settings.cancel")}
            disabled={saving}
            onClick={onClose}
          >
            <IconClose size={16} />
          </button>
        </div>

        <div className="provider-form-grid">
          <Field label={t("settings.name")}>
            <Input
              value={form.name}
              onChange={(event) => setField("name", event.target.value)}
              readOnly={isOpenCodeGo}
              aria-readonly={isOpenCodeGo}
              autoFocus={!isOpenCodeGo}
            />
          </Field>
          <Field
            label={t("settings.apiStyle")}
            hint={isOpenCodeGo ? t("settings.apiStyleOpenCodeGoFixed") : undefined}
          >
            <Select
              value={form.apiStyle}
              onChange={(event) => changeApiStyle(event.target.value as ApiStyle)}
            >
              {CUSTOM_API_STYLE_OPTIONS.map(([value, labelKey]) => (
                <option key={value} value={value}>
                  {t(labelKey)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("settings.baseUrl")}>
            <Input
              value={form.baseUrl}
              onChange={(event) => setField("baseUrl", event.target.value)}
              readOnly={isOpenCodeGo}
              aria-readonly={isOpenCodeGo}
              className="font-mono text-sm-plus"
              placeholder="https://api.example.com/v1"
            />
          </Field>
          <Field label={t("settings.apiKey")}>
            <Input
              type="password"
              value={form.apiKey}
              onChange={(event) => setField("apiKey", event.target.value)}
              placeholder="sk-…"
              className="font-mono text-sm-plus"
              autoComplete="off"
              autoFocus={isOpenCodeGo}
            />
          </Field>
          <Field label={t("settings.selectModels")} hint={modelsStatusHint}>
            <ModelMultiSelect
              models={optionModels}
              selectedIds={selectedIds}
              customModelIds={customIds}
              loading={models.status === "loading"}
              placeholder={t("settings.selectModelsPlaceholder")}
              selectedLabel={(count) => t("settings.nModelsSelected", { n: count })}
              searchPlaceholder={t("settings.searchModelId")}
              noMatchesHint={t("settings.noModelMatches")}
              emptyHint={t("settings.modelsEmptyHint")}
              fetchingLabel={t("settings.modelsFetching")}
              customLabel={t("settings.customModel")}
              reasoningLabel={t("settings.reasoning")}
              visionLabel={t("settings.vision")}
              onToggle={toggleModel}
            />
          </Field>
          <Field label={t("settings.customModel")} hint={customModelError || undefined}>
            <div className="provider-custom-model-row">
              <Input
                value={customModelId}
                onChange={(event) => {
                  setCustomModelId(event.target.value);
                  if (customModelError) setCustomModelError("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addCustomModel();
                  }
                }}
                placeholder={t("settings.customModelPlaceholder")}
                className="font-mono text-sm-plus"
                spellCheck={false}
              />
              <Button variant="secondary" onClick={addCustomModel}>
                <IconPlus size={14} />
                {t("settings.addCustomModel")}
              </Button>
            </div>
          </Field>
        </div>

        {form.models.length > 0 ? (
          <section className="provider-model-config-section" aria-labelledby="provider-model-config-title">
            <div className="provider-model-config-heading">
              <div>
                <h4 id="provider-model-config-title">{t("settings.modelConfigurations")}</h4>
              </div>
              <span className="provider-model-config-count">{form.models.length}</span>
            </div>
            <div className="provider-model-card-list">
              {form.models.map((binding, index) => {
                const metadata = discoveredById.get(binding.id);
                const source = isCatalogModel(metadata) || binding.source === "catalog" ? "catalog" : "custom";
                const sourceLabel = metadata?.catalogSource === "models.dev"
                  ? t("settings.modelsDevCatalog")
                  : t("settings.builtInCatalog");
                return (
                  <ModelConfigCard
                    key={binding.id}
                    binding={binding}
                    metadata={metadata}
                    initiallyExpanded={index === 0}
                    source={source}
                    sourceLabel={sourceLabel}
                    customSourceLabel={t("settings.customModel")}
                    visionLabel={t("settings.vision")}
                    textOnlyLabel={t("settings.textOnly")}
                    reasoningLabel={t("settings.reasoning")}
                    contextWindowLabel={t("settings.contextWindow")}
                    contextWindowShortLabel={t("settings.contextWindowShort")}
                    maxOutputLabel={t("settings.maxOutput")}
                    maxOutputShortLabel={t("settings.maxOutputShort")}
                    supportedThinkingLabel={t("settings.supportedThinkingLevels")}
                    defaultThinkingLabel={t("settings.defaultThinkingLevel")}
                    disabledThinkingLabel={t("settings.notSupported")}
                    disabledThinkingHint={t("settings.thinkingDisabledHint")}
                    levelLabels={levelLabels}
                    removeLabel={t("settings.removeModel")}
                    onChange={(update) => updateModel(binding.id, update)}
                    onRemove={() => toggleModel(modelInfoForDraft(binding, discovered))}
                  />
                );
              })}
            </div>
          </section>
        ) : null}

        <div className="provider-dialog-actions">
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            {t("settings.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={saving || !form.name.trim() || !form.baseUrl.trim() || form.models.length === 0}
            onClick={onSave}
          >
            {saving ? t("settings.saving") : t("settings.saveProvider")}
          </Button>
        </div>
      </div>
    </div>
  );
}

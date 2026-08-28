import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ModelInfo, ProviderPublic, ThinkingLevel } from "@pi-desktop/shared";
import { THINKING_LEVELS } from "@pi-desktop/shared";
import { Button, Field, Input } from "../ui";
import { IconClose, IconPlus } from "../icons";
import { ModelCombobox } from "./ModelCombobox";
import { ModelConfigCard } from "./ModelConfigCard";
import { ModelMultiSelect } from "./ModelMultiSelect";
import {
  fallbackModelDraft,
  isCatalogModel,
  modelDraftFromInfo,
  normalizeApiStyle,
  type ProviderModelDraft,
} from "./provider-form";
import { useProviderModels } from "./useProviderModels";

export type VendorAccountForm = {
  name: string;
  modelId: string;
  models: ProviderModelDraft[];
};

function modelInfoForDraft(draft: ProviderModelDraft, discovered: ModelInfo[]): ModelInfo {
  return discovered.find((model) => model.modelId === draft.id) ?? {
    modelId: draft.id,
    displayName: draft.id,
    providerId: "",
    contextWindow: draft.contextWindow,
    maxTokens: draft.maxTokens,
    reasoning: draft.thinkingLevels.length > 0,
    supportedThinkingLevels: draft.thinkingLevels,
    source: draft.source === "catalog" ? "bundled" : "user",
    capabilities: draft.thinkingLevels.length > 0 ? ["text", "reasoning"] : ["text"],
  };
}

export function VendorAccountDialog({
  provider,
  initialName,
  onClose,
  onSave,
  saving,
}: {
  provider: ProviderPublic;
  initialName: string;
  onClose: () => void;
  onSave: (form: VendorAccountForm) => void;
  saving: boolean;
}) {
  const { t } = useTranslation();
  const initialModels = provider.models.length > 0
    ? provider.models.map((model) => ({ ...model, source: "unknown" as const }))
    : provider.defaultModelId
      ? [fallbackModelDraft(provider.defaultModelId)]
      : [];
  const [form, setForm] = useState<VendorAccountForm>({
    name: initialName,
    modelId: provider.defaultModelId ?? initialModels[0]?.id ?? "",
    models: initialModels,
  });
  const [customModelId, setCustomModelId] = useState("");
  const [customModelError, setCustomModelError] = useState("");
  const [customModelIds, setCustomModelIds] = useState<string[]>(() =>
    initialModels.filter((model) => model.source !== "catalog").map((model) => model.id),
  );
  const models = useProviderModels(
    true,
    {
      baseUrl: provider.baseUrl ?? "",
      apiKey: "",
      apiStyle: normalizeApiStyle(provider.apiStyle),
    },
    provider,
  );
  const discovered = models.status !== "idle" ? models.models : [];
  const discoveredById = useMemo(
    () => new Map(discovered.map((model) => [model.modelId, model])),
    [discovered],
  );
  const customIds = useMemo(
    () => Array.from(new Set([
      ...customModelIds.filter((id) => !isCatalogModel(discoveredById.get(id))),
      ...form.models
        .filter((model) => model.source !== "catalog" && !isCatalogModel(discoveredById.get(model.id)))
        .map((model) => model.id),
    ])),
    [customModelIds, discoveredById, form.models],
  );
  const optionModels = useMemo(() => {
    const byId = new Map<string, ModelInfo>();
    for (const id of customIds) byId.set(id, discoveredById.get(id) ?? modelInfoForDraft(fallbackModelDraft(id), []));
    for (const model of discovered) if (!byId.has(model.modelId)) byId.set(model.modelId, model);
    for (const model of form.models) if (!byId.has(model.id)) byId.set(model.id, modelInfoForDraft(model, []));
    return [...byId.values()];
  }, [customIds, discovered, discoveredById, form.models]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  const updateModels = (next: ProviderModelDraft[]) => {
    setForm((current) => ({
      ...current,
      models: next,
      modelId: next.some((model) => model.id === current.modelId) ? current.modelId : next[0]?.id ?? "",
    }));
  };
  const toggleModel = (model: ModelInfo) => {
    const selected = form.models.some((item) => item.id === model.modelId);
    updateModels(selected
      ? form.models.filter((item) => item.id !== model.modelId)
      : [...form.models, modelDraftFromInfo(model)]);
  };
  const updateModel = (id: string, update: Partial<ProviderModelDraft>) =>
    updateModels(form.models.map((model) => model.id === id ? { ...model, ...update } : model));
  const addCustomModel = () => {
    const id = customModelId.trim();
    if (!id) { setCustomModelError(t("settings.customModelRequired")); return; }
    if (optionModels.some((model) => model.modelId.toLowerCase() === id.toLowerCase())) {
      setCustomModelError(t("settings.modelAlreadyAdded"));
      return;
    }
    setCustomModelIds((current) => [...current, id]);
    updateModels([...form.models, fallbackModelDraft(id)]);
    setCustomModelId("");
    setCustomModelError("");
  };
  const levelLabels = THINKING_LEVELS.reduce((labels, level) => {
    labels[level] = t(`thinkingLevel.${level}`);
    return labels;
  }, {} as Record<ThinkingLevel, string>);

  return (
    <div className="overlay provider-dialog-overlay" role="presentation" onClick={() => !saving && onClose()}>
      <div className="dialog provider-dialog vendor-account-dialog" role="dialog" aria-modal="true" aria-labelledby="vendor-account-dialog-title" onClick={(event) => event.stopPropagation()}>
        <div className="provider-dialog-head">
          <h3 id="vendor-account-dialog-title" className="provider-dialog-title">{t("settings.editVendorAccountTitle")}</h3>
          <button type="button" className="provider-dialog-close" aria-label={t("settings.cancel")} disabled={saving} onClick={onClose}><IconClose size={16} /></button>
        </div>
        <div className="provider-form-grid vendor-account-form-grid">
          <Field label={t("settings.name")}><Input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} autoFocus /></Field>
          <Field label={t("settings.selectModels")} hint={models.status === "error" ? t("settings.modelsFetchHint") : undefined}>
            <ModelMultiSelect models={optionModels} selectedIds={form.models.map((model) => model.id)} customModelIds={customIds} loading={models.status === "loading"} placeholder={t("settings.selectModelsPlaceholder")} selectedLabel={(count) => t("settings.nModelsSelected", { n: count })} searchPlaceholder={t("settings.searchModelId")} noMatchesHint={t("settings.noModelMatches")} emptyHint={t("settings.modelsEmptyHint")} fetchingLabel={t("settings.modelsFetching")} customLabel={t("settings.customModel")} reasoningLabel={t("settings.reasoning")} visionLabel={t("settings.vision")} onToggle={toggleModel} />
          </Field>
          <Field label={t("settings.defaultModel")}>
            <ModelCombobox value={form.modelId} models={optionModels} loading={models.status === "loading"} loadingLabel={t("settings.modelsLoading")} placeholder={t("settings.searchOrEnterModel")} onChange={(modelId) => setForm((current) => ({ ...current, modelId }))} />
          </Field>
          <Field label={t("settings.customModel")} hint={customModelError || undefined}>
            <div className="provider-custom-model-row"><Input value={customModelId} onChange={(event) => { setCustomModelId(event.target.value); if (customModelError) setCustomModelError(""); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addCustomModel(); } }} placeholder={t("settings.customModelPlaceholder")} className="font-mono text-sm-plus" spellCheck={false} /><Button variant="secondary" onClick={addCustomModel}><IconPlus size={14} />{t("settings.addCustomModel")}</Button></div>
          </Field>
        </div>
        {form.models.length > 0 ? <section className="provider-model-config-section" aria-labelledby="vendor-model-config-title">
          <div className="provider-model-config-heading"><h4 id="vendor-model-config-title">{t("settings.modelConfigurations")}</h4><span className="provider-model-config-count">{form.models.length}</span></div>
          <div className="provider-model-card-list">{form.models.map((binding, index) => {
            const metadata = discoveredById.get(binding.id);
            const source = isCatalogModel(metadata) || binding.source === "catalog" ? "catalog" : "custom";
            const sourceLabel = metadata?.catalogSource === "models.dev"
              ? t("settings.modelsDevCatalog")
              : t("settings.builtInCatalog");
            return <ModelConfigCard key={binding.id} binding={binding} metadata={metadata} initiallyExpanded={index === 0} source={source} sourceLabel={sourceLabel} customSourceLabel={t("settings.customModel")} visionLabel={t("settings.vision")} textOnlyLabel={t("settings.textOnly")} reasoningLabel={t("settings.reasoning")} contextWindowLabel={t("settings.contextWindow")} contextWindowShortLabel={t("settings.contextWindowShort")} maxOutputLabel={t("settings.maxOutput")} maxOutputShortLabel={t("settings.maxOutputShort")} supportedThinkingLabel={t("settings.supportedThinkingLevels")} defaultThinkingLabel={t("settings.defaultThinkingLevel")} disabledThinkingLabel={t("settings.notSupported")} disabledThinkingHint={t("settings.thinkingDisabledHint")} levelLabels={levelLabels} removeLabel={t("settings.removeModel")} onChange={(update) => updateModel(binding.id, update)} onRemove={() => toggleModel(modelInfoForDraft(binding, discovered))} />;
          })}</div>
        </section> : null}
        <div className="provider-dialog-actions"><Button variant="ghost" disabled={saving} onClick={onClose}>{t("settings.cancel")}</Button><Button variant="primary" disabled={saving || !form.name.trim() || !form.modelId.trim() || form.models.length === 0} onClick={() => onSave(form)}>{saving ? t("settings.saving") : t("settings.saveVendorAccount")}</Button></div>
      </div>
    </div>
  );
}

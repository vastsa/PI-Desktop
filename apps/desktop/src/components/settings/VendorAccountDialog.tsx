/**
 * Edit one vendor (OAuth) account: its label and the models it may use.
 *
 * The list comes from the account itself: the host answers
 * `api.listProviderModels({ providerId })` from the signed-in account's
 * entitlements, so this dialog shows what the account can actually run rather
 * than every model the vendor publishes.
 */
import { useEffect, useMemo, useState } from "react";
import {
  bindingForCustomModel,
  bindingFromModelInfo,
  formatTokenCount,
  type ModelBinding,
  type ProviderPublic,
} from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";
import { Button, Field, Input } from "../ui";
import { IconClose, IconPlus, IconSearch } from "../icons";
import { useProviderModels } from "./useProviderModels";

export type VendorAccountForm = {
  name: string;
  /** The account's default model; always `models[0]`. */
  modelId: string;
  models: ModelBinding[];
};

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
  const [name, setName] = useState(initialName);
  const [models, setModels] = useState<ModelBinding[]>(
    provider.models.length > 0
      ? provider.models
      : provider.defaultModelId
        ? [bindingForCustomModel(provider.defaultModelId)]
        : [],
  );
  const [modelQuery, setModelQuery] = useState("");
  const [customModelId, setCustomModelId] = useState("");
  const [customModelError, setCustomModelError] = useState("");

  // A vendor account has no typed key: the host resolves the stored login.
  const discovery = useProviderModels(
    true,
    { baseUrl: provider.baseUrl ?? "", apiKey: "", apiStyle: provider.apiStyle ?? "" },
    provider,
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  /** Entitled models from the account, plus any id already configured here. */
  const rows = useMemo(() => {
    const byId = new Map<
      string,
      { id: string; displayName: string; contextWindow?: number; maxTokens?: number; binding?: ModelBinding }
    >();
    for (const model of discovery.models) {
      byId.set(model.modelId.toLowerCase(), {
        id: model.modelId,
        displayName: model.displayName,
        contextWindow: model.contextWindow ?? model.limit?.context,
        maxTokens: model.maxTokens ?? model.limit?.output,
      });
    }
    for (const binding of models) {
      const key = binding.id.toLowerCase();
      const existing = byId.get(key);
      byId.set(key, {
        id: existing?.id ?? binding.id,
        displayName: existing?.displayName ?? binding.id,
        contextWindow: existing?.contextWindow ?? binding.contextWindow,
        maxTokens: existing?.maxTokens ?? binding.maxTokens,
        binding,
      });
    }
    return [...byId.values()];
  }, [discovery.models, models]);

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

  const toggleModel = (modelId: string) =>
    setModels((current) => {
      const wanted = modelId.toLowerCase();
      if (current.some((binding) => binding.id.toLowerCase() === wanted)) {
        return current.filter((binding) => binding.id.toLowerCase() !== wanted);
      }
      const info = discovery.models.find(
        (model) => model.modelId.toLowerCase() === wanted,
      );
      return [
        ...current,
        info ? bindingFromModelInfo(info) : bindingForCustomModel(modelId),
      ];
    });

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

  const canSave = !saving && !!name.trim() && models.length > 0;

  const submit = () => {
    if (!canSave) return;
    // The account's default model is always the first binding, so reordering or
    // removing the head is the only way to change it.
    onSave({ name: name.trim(), modelId: models[0].id, models });
  };

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
        {visibleRows.map((row) => (
          <li className="provider-models-row" key={row.id}>
            <label className="provider-models-row-label">
              <input
                type="checkbox"
                className="provider-models-check"
                checked={selected.has(row.id.toLowerCase())}
                disabled={saving}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                onChange={() => toggleModel(row.id)}
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
        ))}
      </ul>
    );

  return (
    <div
      className="overlay vendor-account-overlay"
      role="presentation"
      onClick={() => {
        if (saving) return;
        onClose();
      }}
    >
      <div
        className="dialog vendor-account-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vendor-account-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="vendor-account-head">
          <h3 id="vendor-account-title" className="vendor-account-title">
            {t("settings.editVendorAccount")}
          </h3>
        </div>

        <div className="vendor-account-body">
          <Field label={t("settings.name")}>
            <Input
              value={name}
              autoFocus
              onChange={(event) => setName(event.target.value)}
            />
          </Field>

          <div className="provider-models">
            <div className="provider-models-head">
              <h4 className="provider-models-title">{t("settings.accountModels")}</h4>
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

          <div className="vendor-account-chosen">
            <div className="vendor-account-chosen-head">
              <h4 className="vendor-account-chosen-title">
                {t("settings.modelConfigurations")}
              </h4>
              <span className="vendor-account-chosen-count">{models.length}</span>
            </div>
            {models.length === 0 ? (
              <div className="vendor-account-chosen-empty">
                {t("settings.noModelsChosen")}
              </div>
            ) : (
              <ul className="vendor-account-chosen-list">
                {models.map((binding) => (
                  <li className="vendor-account-chosen-row" key={binding.id}>
                    <span className="vendor-account-chosen-row-id font-mono">
                      {binding.id}
                    </span>
                    <span className="vendor-account-chosen-row-limits">
                      {formatTokenCount(binding.contextWindow)} ·{" "}
                      {formatTokenCount(binding.maxTokens)}
                    </span>
                    <button
                      type="button"
                      className="vendor-account-chosen-remove"
                      aria-label={t("settings.removeModel")}
                      title={t("settings.removeModel")}
                      disabled={saving}
                      onClick={() =>
                        setModels((current) =>
                          current.filter((entry) => entry.id !== binding.id),
                        )
                      }
                    >
                      <IconClose size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="vendor-account-custom-model">
              <Field
                label={t("settings.customModel")}
                hint={customModelError || t("settings.customModelHint")}
              >
                <div className="vendor-account-custom-model-row">
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
                  <Button variant="secondary" disabled={saving} onClick={addCustomModel}>
                    <IconPlus size={14} />
                    {t("settings.addCustomModel")}
                  </Button>
                </div>
              </Field>
            </div>
          </div>
        </div>

        <div className="vendor-account-actions">
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            {t("settings.cancel")}
          </Button>
          <Button variant="primary" disabled={!canSave} onClick={submit}>
            {t("settings.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}

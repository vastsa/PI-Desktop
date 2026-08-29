/**
 * Edit one vendor (OAuth) account: its label and the models it may use.
 *
 * The model section is the same catalog browser the API-key path uses, so both
 * credential kinds share one model-picking UI and one binding shape.
 */
import { useEffect, useState } from "react";
import {
  bindingForCustomModel,
  bindingFromModelInfo,
  formatTokenCount,
  type ModelBinding,
  type ModelInfo,
  type ProviderPublic,
} from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";
import { Button, Field, Input } from "../ui";
import { IconClose, IconPlus } from "../icons";
import { ModelCatalogBrowser } from "./ModelCatalogBrowser";

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
  const [customModelId, setCustomModelId] = useState("");
  const [customModelError, setCustomModelError] = useState("");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  const toggleModel = (model: ModelInfo) =>
    setModels((current) => {
      const wanted = model.modelId.toLowerCase();
      return current.some((binding) => binding.id.toLowerCase() === wanted)
        ? current.filter((binding) => binding.id.toLowerCase() !== wanted)
        : [...current, bindingFromModelInfo(model)];
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

          <ModelCatalogBrowser
            providerId={provider.id}
            selectedIds={models.map((binding) => binding.id)}
            footerActions={false}
            onToggle={toggleModel}
            onConfirm={submit}
            onCancel={onClose}
          />

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

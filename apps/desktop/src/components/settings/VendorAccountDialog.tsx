/**
 * Edit one vendor (OAuth) account: its label and the models it may use.
 *
 * The list comes from the account itself: the host answers
 * `api.listProviderModels({ providerId })` from the signed-in account's
 * entitlements, so this dialog shows what the account can actually run rather
 * than every model the vendor publishes. Choosing among those rows is
 * `ModelSelectionPanes`, the same picker the AI service dialog renders, so an
 * account is not a reduced version of a service.
 */
import { useEffect, useState } from "react";
import {
  bindingForCustomModel,
  type ModelBinding,
  type ProviderPublic,
} from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";
import { Button, Field, Input } from "../ui";
import { useProviderModels } from "./useProviderModels";
import { ModelSelectionPanes, useModelSelection } from "./ModelSelectionPanes";

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

  // A vendor account has no typed key: the host resolves the stored login.
  const discovery = useProviderModels(
    true,
    { baseUrl: provider.baseUrl ?? "", apiKey: "", apiStyle: provider.apiStyle ?? "" },
    provider,
  );
  const selection = useModelSelection(discovery, models, setModels);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  const canSave = !saving && !!name.trim() && models.length > 0;

  const submit = () => {
    if (!canSave) return;
    // Narrowed like a service's bindings, so an account cannot persist a
    // thinking level the runtime would discard. The account's default model is
    // always the first binding, so reordering or removing the head is the only
    // way to change it.
    const persisted = selection.bindingsToPersist;
    onSave({ name: name.trim(), modelId: persisted[0].id, models: persisted });
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

          <ModelSelectionPanes
            discovery={discovery}
            selection={selection}
            listTitle={t("settings.accountModels")}
            busy={saving}
          />
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

/** Host-owned API-key setup for a provider selected from a plugin catalog. */
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { bindingFromModelInfo, normalizeApiStyle, type ProviderPublic } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button } from "../ui";
import { ProviderConnectionFields } from "./ProviderConnectionFields";

export type PluginProviderKeySetupFormProps = {
  provider: ProviderPublic;
  pluginName: string;
  onClose: () => void;
  onSaved: (provider: ProviderPublic) => void | Promise<void>;
};

export function PluginProviderKeySetupForm({
  provider,
  pluginName,
  onClose,
  onSaved,
}: PluginProviderKeySetupFormProps) {
  const { t } = useTranslation();
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const showToast = useAppStore((state) => state.showToast);
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const save = async () => {
    if (!apiKey.trim() || saving) return;
    setSaving(true);
    try {
      const result = await api.setProviderSecret({ id: provider.id, secretValue: apiKey });
      if (!result.provider) {
        showToast(t("settings.providerUnavailable"), { variant: "error" });
        return;
      }
      let savedProvider = result.provider;
      let modelDiscoveryMessage: string | null = null;
      try {
        const discovery = await api.listProviderModels({
          providerId: provider.id,
          source: "refresh",
        });
        if (discovery.source === "remote" && discovery.models.length > 0) {
          savedProvider = {
            ...savedProvider,
            models: discovery.models.map(bindingFromModelInfo),
          };
        } else {
          modelDiscoveryMessage = t("settings.modelsFetchNotFound");
        }
      } catch {
        modelDiscoveryMessage = t("settings.modelsFetchFailed");
      }
      await onSaved(savedProvider);
      if (modelDiscoveryMessage) {
        showToast(modelDiscoveryMessage, { variant: "warning" });
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="provider-setup-head">
        <h3 id="provider-setup-title" className="provider-setup-title">
          {t("settings.addProviderTitle")}
        </h3>
        <div className="provider-setup-head-actions">
          <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>
            {t("settings.cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={saving || !apiKey.trim()}
            onClick={() => void save()}
          >
            {saving ? t("settings.saving") : t("settings.saveProvider")}
          </Button>
        </div>
      </div>

      <div className="provider-setup-body">
        <div className="text-sm text-text-secondary">
          {t("settings.pluginProviderBy", { plugin: pluginName })}
        </div>
        <ProviderConnectionFields
          named
          custom={false}
          editing={false}
          saving={saving}
          serviceLabel={provider.name}
          serviceBaseUrl={provider.baseUrl ?? ""}
          apiKeyHint={t("settings.pluginProviderKeyHint")}
          lockedService
          onChangeService={() => {}}
          apiKeyRef={apiKeyRef}
          nameRef={nameRef}
          apiKey={apiKey}
          onApiKeyChange={setApiKey}
          name={provider.name}
          onNameChange={() => {}}
          baseUrl={provider.baseUrl ?? ""}
          onBaseUrlChange={() => {}}
          commitBaseUrl={() => {}}
          apiStyle={normalizeApiStyle(provider.apiStyle)}
          onApiStyleChange={() => {}}
          accountOnlyApiStyle={false}
          requiresApiStyleChoice={false}
        />
      </div>
    </>
  );
}

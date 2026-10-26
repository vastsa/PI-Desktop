/** Credentials create a native account first; model discovery belongs to its existing editor. */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { normalizeApiStyle, type PluginProviderCatalogMeta, type ProviderPublic } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button, Field, Input } from "../ui";
import { ProviderConnectionFields } from "./ProviderConnectionFields";

export function ProviderTemplateSetupForm({ template, onClose, onCreated, onBusyChange }: {
  template: PluginProviderCatalogMeta;
  onClose: () => void;
  onCreated: (provider: ProviderPublic) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(template.name ?? "");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const mounted = useRef(false);
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const needsKey = template.authKind === "api_key";
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !savingRef.current) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const save = async () => {
    if (savingRef.current || !template.templateId || !name.trim() || (needsKey && !apiKey.trim())) return;
    savingRef.current = true;
    setSaving(true);
    onBusyChange(true);
    try {
      const { provider } = await api.createTemplateProvider({
        pluginId: template.pluginId,
        templateId: template.templateId,
        name: name.trim(),
        ...(needsKey ? { secretValue: apiKey } : {}),
      });
      // Even if the page went away, the completed Host write remains a real account.
      useAppStore.setState((state) => ({
        providers: [...state.providers.filter((row) => row.id !== provider.id), provider],
      }));
      if (mounted.current) {
        setApiKey("");
        onBusyChange(false);
        onCreated(provider);
      }
    } catch (error) {
      if (mounted.current) {
        useAppStore.getState().showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
        savingRef.current = false;
        setSaving(false);
        onBusyChange(false);
      }
    }
  };

  return <>
    <div className="provider-setup-head">
      <h3 id="provider-setup-title" className="provider-setup-title">{t("settings.addProviderTitle")}</h3>
      <div className="provider-setup-head-actions">
        <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>{t("settings.cancel")}</Button>
        <Button variant="primary" size="sm" disabled={saving || !name.trim() || (needsKey && !apiKey.trim())} onClick={() => void save()}>
          {saving ? t("settings.saving") : t("settings.saveProvider")}
        </Button>
      </div>
    </div>
    <div className="provider-setup-body">
      <p className="settings-hint">{t("settings.pluginProviderBy", { plugin: template.pluginName })}</p>
      <Field label={t("settings.name")}>
        <Input ref={nameRef} value={name} disabled={saving} onChange={(event) => setName(event.target.value)} />
      </Field>
      <ProviderConnectionFields
        named={needsKey} custom={false} editing={false} saving={saving}
        serviceLabel={template.name ?? template.templateId ?? ""} serviceBaseUrl={template.baseUrl ?? ""}
        lockedService onChangeService={() => {}} apiKeyRef={apiKeyRef} nameRef={nameRef}
        apiKey={apiKey} onApiKeyChange={setApiKey} apiKeyHint={t("settings.pluginProviderKeyHint")}
        name={name} onNameChange={setName} baseUrl={template.baseUrl ?? ""}
        onBaseUrlChange={() => {}} commitBaseUrl={() => {}}
        apiStyle={normalizeApiStyle(template.apiStyle)} onApiStyleChange={() => {}}
        accountOnlyApiStyle={false} requiresApiStyleChoice={false}
      />
    </div>
  </>;
}

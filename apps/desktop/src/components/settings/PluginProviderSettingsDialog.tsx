/** Native model preferences shared by legacy plugin rows and template-created accounts. */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ModelBinding, ProviderPublic } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button, Field, Input, OverlayBackdrop, portalOverlay } from "../ui";
import { ModelSelectionPanes, useModelSelection } from "./ModelSelectionPanes";
import type { ProviderModelsState } from "./useProviderModels";

export function PluginProviderSettingsDialog({
  provider,
  imageModelIds,
  onClose,
  onSaved,
  initialModelSource = "cache",
  onReauthenticate,
}: {
  provider: ProviderPublic;
  imageModelIds: string[];
  onClose: () => void;
  onSaved: (provider: ProviderPublic, models: ModelBinding[], imageModelIds?: string[]) => Promise<void>;
  initialModelSource?: "cache" | "refresh";
  onReauthenticate?: () => void;
}) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [name, setName] = useState(provider.name);
  const [models, setModels] = useState(provider.models);
  const [images, setImages] = useState(imageModelIds);
  const [saving, setSaving] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const templateAccount = !!provider.pluginTemplateId;
  const [discovery, setDiscovery] = useState<ProviderModelsState>({ status: "idle", models: [] });
  const mounted = useRef(false);
  const request = useRef(0);
  const savingRef = useRef(false);
  const selection = useModelSelection(discovery, models, setModels);

  const loadModels = async (source: "cache" | "refresh") => {
    const sequence = ++request.current;
    setDiscovery((current) => ({ ...current, status: "loading", error: undefined }));
    try {
      const result = await api.listProviderModels({ providerId: provider.id, source });
      if (!mounted.current || request.current !== sequence) return;
      setDiscovery({ status: "ready", models: result.models, source: result.source, error: result.error });
      if (result.error) showToast(result.error, { variant: "warning" });
    } catch (error) {
      if (!mounted.current || request.current !== sequence) return;
      setDiscovery((current) => ({
        ...current,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      }));
      showToast(error instanceof Error ? error.message : String(error), { variant: "warning" });
    }
  };

  useEffect(() => {
    mounted.current = true;
    // Opening Settings never invokes plugin inference or a paid operation.
    void loadModels(initialModelSource);
    return () => {
      mounted.current = false;
      request.current += 1;
    };
  }, [provider.id, initialModelSource]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !savingRef.current) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const save = async () => {
    if (savingRef.current || !name.trim()) return;
    savingRef.current = true;
    setSaving(true);
    const bindings = selection.bindingsToPersist;
    try {
      if (templateAccount && provider.authKind === "api_key" && (apiKey.trim() || clearKey)) {
        const secret = await api.setProviderSecret({ id: provider.id, secretValue: clearKey ? "" : apiKey });
        if (!mounted.current) return;
        if (!secret.provider) throw new Error(t("settings.providerUnavailable"));
        setApiKey("");
        setClearKey(false);
      }
      // Do not submit manifest-owned fields, OAuth state, or credential values.
      const result = await api.updateProvider({ id: provider.id, name: name.trim(), models: bindings });
      if (!mounted.current) return;
      if (!result.provider) throw new Error(t("settings.providerUnavailable"));
      const remainingImages = images.filter((id) => bindings.some((model) => model.id.toLowerCase() === id.toLowerCase()));
      await onSaved(result.provider, bindings, remainingImages);
    } catch (error) {
      if (mounted.current) {
        showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
      }
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  return portalOverlay(
    <OverlayBackdrop className="overlay provider-setup-overlay" role="presentation" onClick={() => { if (!savingRef.current) onClose(); }}>
      <div className="dialog provider-setup-dialog" role="dialog" aria-modal="true" aria-labelledby="plugin-provider-settings-title" onClick={(event) => event.stopPropagation()}>
        <div className="provider-setup-head">
          <h3 id="plugin-provider-settings-title" className="provider-setup-title">{t("settings.editProviderTitle")}</h3>
          <div className="provider-setup-head-actions">
            <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>{t("settings.cancel")}</Button>
            <Button variant="primary" size="sm" disabled={saving || !name.trim()} onClick={() => void save()}>
              {saving ? t("settings.saving") : t("settings.saveProvider")}
            </Button>
          </div>
        </div>
        <div className="provider-setup-body">
          {templateAccount ? <>
            <p className="settings-hint">{t("settings.pluginProviderBy", { plugin: provider.ownerPluginId })}</p>
            <Field label={t("settings.baseUrl")}><div>{provider.baseUrl}</div></Field>
            {provider.authKind === "api_key" ? (
              <Field label={t("settings.apiKey")} hint={t("settings.apiKeyKeepHint")}>
                <Input type="password" autoComplete="off" value={apiKey} disabled={saving || clearKey}
                  onChange={(event) => setApiKey(event.target.value)} />
                {provider.hasSecret ? <Button variant="ghost" size="sm" disabled={saving || clearKey}
                  onClick={() => { setApiKey(""); setClearKey(true); }}>{t("settings.clearApiKey")}</Button> : null}
              </Field>
            ) : provider.authKind === "oauth" && onReauthenticate ? (
              <Button variant="ghost" size="sm" disabled={saving} onClick={onReauthenticate}>
                {t("settings.vendorSignInTo", { vendor: provider.name })}
              </Button>
            ) : null}
          </> : null}
          <p className="settings-hint">{t("settings.pluginProviderModelSettingsHint")}</p>
          <Field label={t("settings.name")}>
            <Input value={name} disabled={saving} autoFocus onChange={(event) => setName(event.target.value)} />
          </Field>
          <ModelSelectionPanes
            discovery={{ ...discovery, canReload: !saving && discovery.status !== "loading" }}
            selection={selection}
            listTitle={t("settings.serviceModels")}
            busy={saving}
            onReload={() => void loadModels("refresh")}
            apiStyle={provider.apiStyle ?? ""}
            lookupContext={{ providerId: provider.id, vendorKey: provider.vendorKey, baseUrl: provider.baseUrl }}
            imageModelIds={images}
            modelOperations={provider.pluginModelOperations}
            onImageModelChange={(id, selected) => setImages((current) => selected
              ? current.some((entry) => entry.toLowerCase() === id.toLowerCase()) ? current : [...current, id]
              : current.filter((entry) => entry.toLowerCase() !== id.toLowerCase()))}
          />
        </div>
      </div>
    </OverlayBackdrop>,
  );
}

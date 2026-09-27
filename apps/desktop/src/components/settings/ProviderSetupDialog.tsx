/** Platform API token setup with the existing discovery and model selection flow. */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AI_PLATFORM_BASE_URL,
  AI_PLATFORM_NAME,
  AI_PLATFORM_VENDOR_KEY,
  PLATFORM_IMAGE_MODELS,
  platformMediaKind,
  platformMediaModelBindings,
  type CatalogApiStyle,
  type ModelBinding,
  type ProviderPublic,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { pairsToRecord, recordToPairs } from "../extensions/KeyValueRows";
import { Button, Field, HelpIcon, Input, portalOverlay } from "../ui";
import { ProviderHeadersEditor } from "./ProviderHeadersEditor";
import { useProviderModels } from "./useProviderModels";
import { ModelSelectionPanes, useModelSelection } from "./ModelSelectionPanes";
import { ConnectionStatus, ProviderConnectionFields } from "./ProviderConnectionFields";
import { isPlatformApiStyle, isPlatformProvider } from "./service-catalog";
import { useRecommendedModelSelection } from "./useRecommendedModelSelection";
import type { ProviderCopyDraft } from "./provider-copy";

export type ProviderSetupDialogProps = {
  provider?: ProviderPublic | null;
  initialDraft?: ProviderCopyDraft | null;
  onClose: () => void;
  imageModelIds?: string[];
  onSaved: (provider: ProviderPublic, models: ModelBinding[], imageModelIds?: string[]) => void | Promise<void>;
};

export function ProviderSetupDialog({
  provider,
  initialDraft,
  onClose,
  onSaved,
  imageModelIds,
}: ProviderSetupDialogProps) {
  const { t } = useTranslation();
  const [imageModelDraft, setImageModelDraft] = useState<string[] | undefined>();
  const editing = !!provider;
  const [name, setName] = useState(() => initialDraft?.name ?? provider?.name ?? AI_PLATFORM_NAME);
  const [apiKey, setApiKey] = useState("");
  const [apiStyle, setApiStyle] = useState<CatalogApiStyle>(() => {
    const style = initialDraft?.apiStyle ?? provider?.apiStyle;
    return isPlatformApiStyle(style) ? style : "chat_completions";
  });
  const [headerPairs, setHeaderPairs] = useState(() => recordToPairs(provider?.headers));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [models, setModelsState] = useState<ModelBinding[]>(() =>
    platformMediaModelBindings(initialDraft?.models ?? provider?.models ?? []));
  const setModels = useCallback((next: ModelBinding[] | ((current: ModelBinding[]) => ModelBinding[])) => {
    setModelsState(current => platformMediaModelBindings(typeof next === "function" ? next(current) : next));
  }, []);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [testResult, setTestResult] = useState("");
  // Never reuse a secret belonging to an unrelated legacy or plugin provider.
  const allowedProvider = !provider || isPlatformProvider(provider);
  const discoveryActive = allowedProvider && Boolean(apiKey.trim() || provider?.hasSecret);
  const headers = pairsToRecord(headerPairs);
  const discovery = useProviderModels(
    discoveryActive,
    {
      baseUrl: AI_PLATFORM_BASE_URL,
      apiKey,
      apiStyle,
      headers,
    },
    provider,
  );
  const recommended = useRecommendedModelSelection({
    // A copy keeps the models it was copied with.
    enabled: !provider && !initialDraft?.models?.length,
    serviceKey: `${AI_PLATFORM_VENDOR_KEY}|${apiStyle}`,
    discovery,
    setModels,
    namedService: true,
  });
  // Every edit made through the picker or the summary ends preselection.
  const selection = useModelSelection(discovery, models, recommended.setModels);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || saving) return;
      if (advancedOpen) {
        setAdvancedOpen(false);
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [advancedOpen, onClose, saving]);

  const testConnection = async () => {
    if (!provider || !allowedProvider) return;
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
    if (!allowedProvider || !providerName || !isPlatformApiStyle(apiStyle) ||
      !discoveryActive || models.length === 0 || saving) return;
    const persisted = platformMediaModelBindings(selection.bindingsToPersist);
    // Removing a configured model releases its image binding even when the
    // capability checkbox was untouched. Ordinary provider edits keep their
    // existing save path when the image selection did not change.
    const imageSelection = [...new Set([...(imageModelDraft ?? imageModelIds ?? []), ...PLATFORM_IMAGE_MODELS])];
    const remainingImageModels = imageSelection?.filter((imageModelId) =>
      persisted.some((model) => model.id.toLowerCase() === imageModelId.toLowerCase()),
    );
    const imageModelIdsToSave = remainingImageModels;
    setSaving(true);
    setError("");
    try {
      if (provider) {
        const result = await api.updateProvider({
          id: provider.id,
          name: providerName,
          vendorKey: AI_PLATFORM_VENDOR_KEY,
          baseUrl: AI_PLATFORM_BASE_URL,
          defaultModelId: persisted.find(model => !platformMediaKind(model.id))?.id,
          models: persisted,
          apiStyle,
          headers,
          ...(apiKey.trim() ? { secretValue: apiKey.trim() } : {}),
        });
        await onSaved(result.provider ?? provider, persisted, imageModelIdsToSave);
      } else {
        const result = await api.createProvider({
          name: providerName,
          vendorKey: AI_PLATFORM_VENDOR_KEY,
          type: "openai_compatible",
          protocol: "openai_compatible",
          baseUrl: AI_PLATFORM_BASE_URL,
          authKind: "api_key_and_base_url",
          defaultModelId: persisted.find(model => !platformMediaKind(model.id))?.id,
          models: persisted,
          secretValue: apiKey.trim(),
          apiStyle,
          headers,
        });
        await onSaved(result.provider, persisted, imageModelIdsToSave);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const updateImageModelDraft = (id: string, selected: boolean) => {
    setImageModelDraft((current) => {
      const next = current ?? imageModelIds ?? [];
      if (selected) {
        return next.some((entry) => entry.toLowerCase() === id.toLowerCase()) ? next : [...next, id];
      }
      return next.filter((entry) => entry.toLowerCase() !== id.toLowerCase());
    });
  };

  const canSave = !saving && allowedProvider && discoveryActive &&
    !!name.trim() && isPlatformApiStyle(apiStyle) && models.length > 0;

  const formView = (
    <>
      <div className="provider-setup-head">
        <h3 id="provider-setup-title" className="provider-setup-title">
          {initialDraft ? t("settings.copyProviderTitle") : editing ? t("settings.editProviderTitle") : t("settings.addProviderTitle")}
          {/* What a copy does and does not take is the title's own promise. */}
          {initialDraft ? <HelpIcon label={t("settings.copyProviderHint")} /> : null}
        </h3>
        <div className="provider-setup-head-actions">
          {allowedProvider ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => setAdvancedOpen(true)}
            >
              {t("settings.advancedSettings")}
            </Button>
          ) : null}
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
        {error ? <div className="provider-setup-error">{error}</div> : null}

        <div className="provider-setup-credentials">
          <ProviderConnectionFields
            editing={editing}
            saving={saving}
            apiKey={apiKey}
            onApiKeyChange={setApiKey}
            apiStyle={apiStyle}
            onApiStyleChange={setApiStyle}
            status={<ConnectionStatus active={discoveryActive} discovery={discovery} named />}
          />

          {testResult ? (
            <div className="provider-credential-test">
              <span className="provider-credential-test-result">{testResult}</span>
            </div>
          ) : null}
        </div>

        <p className="text-sm text-text-secondary">{t("settings.platformMediaDefaultsHint")}</p>
        <ModelSelectionPanes
          discovery={discovery}
          selection={selection}
          listTitle={t("settings.serviceModels")}
          busy={saving}
          onReload={discovery.reload}
          apiStyle={apiStyle}
          imageModelIds={[...new Set([...(imageModelDraft ?? imageModelIds ?? []), ...PLATFORM_IMAGE_MODELS])]}
          onImageModelChange={updateImageModelDraft}
          lookupContext={{
            baseUrl: AI_PLATFORM_BASE_URL,
            vendorKey: AI_PLATFORM_VENDOR_KEY,
            providerId: provider?.id,
          }}
          autoPicked={recommended.autoPicked}
        />
      </div>
    </>
  );

  return portalOverlay(
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
        {formView}
      </div>

      {advancedOpen && allowedProvider ? (
        <div
          className="overlay provider-advanced-overlay"
          role="presentation"
          onClick={(event) => {
            event.stopPropagation();
            if (event.target === event.currentTarget) setAdvancedOpen(false);
          }}
        >
          <div
            className="dialog provider-advanced-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="provider-advanced-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="provider-advanced-head">
              <h4 id="provider-advanced-title" className="provider-advanced-title">
                {t("settings.advancedSettings")}
              </h4>
              <Button variant="ghost" size="sm" onClick={() => setAdvancedOpen(false)}>
                {t("settings.close")}
              </Button>
            </div>
            <div className="provider-advanced-body">
              <div className="provider-setup-advanced">
                {allowedProvider ? (
                  <Field label={t("settings.name")}>
                    <Input
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </Field>
                ) : null}
                <ProviderHeadersEditor pairs={headerPairs} onChange={setHeaderPairs} />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

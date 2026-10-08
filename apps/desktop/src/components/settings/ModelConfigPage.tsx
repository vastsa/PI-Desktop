/**
 * Model configuration tab: image model selection, the AI service list, and the
 * models.dev enrichment snapshot status.
 *
 * API services, plugin-declared services and vendor subscription accounts
 * share one list (D625). An account row still lives and dies through the
 * vendor-account editor and `deleteOauthAccount`, never the provider CRUD.
 *
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  vendorAccountImageCandidates,
  type ImageGenerationBinding,
  type ModelBinding,
  type ProviderPublic,
} from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";
import { Button } from "../ui";
import {
  IconConfig,
  IconPlus,
  IconServer,
} from "../icons";
import { providerServesChatModels } from "./default-model";
import {
  imageGenerationPickerCandidates,
  isImageGenerationPickerCandidate,
  planImageGenerationDefaults,
} from "./image-generation-default";
import { copyProviderConfiguration, type ProviderCopyDraft } from "./provider-copy";
import { ImageGenerationModelRow } from "./ImageGenerationModelRow";
import { OAuthLoginDialog } from "./OAuthLoginDialog";
import { ProviderSetupDialog } from "./ProviderSetupDialog";
import { ServiceList } from "./ServiceList";
import { serviceRowKind } from "./service-row-status";
import { useVendorAccounts } from "./useVendorAccounts";
import { VendorAccountDialog, type VendorAccountForm } from "./VendorAccountDialog";
import { ModelConfigImportPanel } from "../../features/settings/imports/ModelConfigImportPanel";
import { ImportToggleButton } from "../../features/settings/import-workbench";
import { JevSettingsCard } from "./JevSettingsCard";
import { JEV_SERVICE } from "./service-catalog";

type CatalogStatus = {
  loaded: boolean;
  source: "bundled" | "remote" | "empty";
  catalogPath: string;
  fetchedAt?: string;
  providerCount: number;
  modelCount: number;
  lastError?: string;
};

const sameWireId = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

/** Image candidates and chat choices are keyed by complete provider + wire id. */
function imageCandidates(
  candidates: readonly ImageGenerationBinding[] | null | undefined,
  active: ImageGenerationBinding | null | undefined,
): ImageGenerationBinding[] {
  const source = candidates === undefined ? (active ? [active] : []) : candidates ?? [];
  const result: ImageGenerationBinding[] = [];
  for (const entry of source) {
    if (!result.some((other) =>
      other.providerId === entry.providerId && sameWireId(other.modelId, entry.modelId)
    )) result.push(entry);
  }
  if (active && !result.some((entry) =>
    entry.providerId === active.providerId && sameWireId(entry.modelId, active.modelId)
  )) result.push(active);
  return result;
}

function chatModelOptions(providers: readonly ProviderPublic[], imageModels: readonly ImageGenerationBinding[]) {
  return providers.flatMap((provider) => {
    const ids = provider.models?.length
      ? provider.models.map((model) => model.id)
      : [provider.defaultModelId ?? ""];
    return ids.filter((id) => !!id.trim() && !isImageGenerationPickerCandidate(imageModels, provider.id, id))
      .map((modelId) => ({ provider, modelId }));
  });
}


export function ModelConfigPage() {
  const { t, i18n } = useTranslation();
  const providers = useAppStore((s) => s.providers);
  const settings = useAppStore((s) => s.settings);
  const refreshProviders = useAppStore((s) => s.refreshProviders);
  const showToast = useAppStore((s) => s.showToast);

  // null = closed, "" = add flow, provider id = edit flow.
  const [copyDraft, setCopyDraft] = useState<ProviderCopyDraft | null>(null);
  const [setupFor, setSetupFor] = useState<string | null>(null);
  const [pluginCatalogSetup, setPluginCatalogSetup] = useState<{
    providerId: string;
    pluginName: string;
  } | null>(null);

  // The Jev card opens the same dialog, straight on the Jev service.
  const [jevSetup, setJevSetup] = useState(false);
  // Bumped when that dialog stored a key, so the card re-reads what exists.
  const [jevStatusRevision, setJevStatusRevision] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [changingImageModel, setChangingImageModel] = useState(false);
  const [refreshingCatalog, setRefreshingCatalog] = useState(false);
  const [catalogStatus, setCatalogStatus] = useState<CatalogStatus | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const {
    vendors,
    accountFor,
    login,
    busyAccountId,
    savingAccount,
    startLogin,
    finishLogin,
    closeLogin,
    removeAccount,
    saveAccount,
  } = useVendorAccounts();
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const result = await api.modelCatalogStatus();
        setCatalogStatus(result.status);
      } catch {
        // The status line simply stays hidden when the catalog cannot report.
        setCatalogStatus(null);
      }
    })();
  }, []);

  const imageGenerationCandidates = useMemo(
    () => imageCandidates([
      ...imageCandidates(settings?.imageGenerationModels, settings?.imageGeneration),
      // A signed-in vendor account serves its image model without listing it as
      // a chat model, so it must reach this list or the picker row never renders.
      ...vendorAccountImageCandidates(providers),
    ], null),
    [settings?.imageGenerationModels, settings?.imageGeneration, providers],
  );
  const providerReady = (provider: ProviderPublic) =>
    providerServesChatModels(provider, imageGenerationCandidates);

  if (!settings) return null;

  const editingProvider =
    setupFor ? providers.find((provider) => provider.id === setupFor) ?? null : null;
  const editingAccount = editingAccountId
    ? providers.find((provider) => provider.id === editingAccountId) ?? null
    : null;
  /**
   * Preserve the selected app defaults unless they were removed from the
   * provider or no longer resolve, and let a newly added provider claim a
   * default only while none resolves.
   */
  const afterSaved = async (
    saved: ProviderPublic,
    models: ModelBinding[],
    imageModelIds?: string[],
  ) => {
    const selectedImageIds = imageModelIds ?? imageGenerationCandidates
      .filter((entry) => entry.providerId === saved.id)
      .map((entry) => entry.modelId);
    const firstModelId = models.find((model) =>
      !selectedImageIds.some((id) => sameWireId(id, model.id)),
    )?.id;
    const replacementChatModelId =
      settings.defaultProviderId === saved.id && firstModelId &&
      !models.some((model) => sameWireId(model.id, settings.defaultModelId ?? "") &&
        !selectedImageIds.some((id) => sameWireId(id, model.id)))
    ? firstModelId
    : undefined;
    try {
      if (pluginCatalogSetup?.providerId === saved.id) {
        const defaultsProviders = [...providers.filter((provider) => provider.id !== saved.id), saved];
        const currentDefault = defaultsProviders.find(
          (provider) => provider.id === settings.defaultProviderId,
        );
        const keepsCurrentDefault = !!currentDefault &&
          providerServesChatModels(currentDefault, imageGenerationCandidates) &&
          chatModelOptions([currentDefault], imageGenerationCandidates).some(
            ({ modelId }) => sameWireId(modelId, settings.defaultModelId ?? ""),
          );
        if (!keepsCurrentDefault && firstModelId) {
          const nextSettings = {
            ...settings,
            defaultProviderId: saved.id,
            defaultModelId: firstModelId,
          };
          await api.setSettings(nextSettings);
          useAppStore.setState({ settings: nextSettings });
        }
        showToast(t("settings.pluginProviderKeySaved"), { variant: "success" });
      } else if (imageModelIds !== undefined) {
        const current = await api.getSettings();
        const plan = planImageGenerationDefaults(
          current,
          saved.id,
          imageModelIds,
          [...providers.filter((provider) => provider.id !== saved.id), saved],
          current.imageGeneration?.providerId === saved.id &&
            (!imageModelIds.some((id) => sameWireId(id, current.imageGeneration?.modelId ?? "")) ||
              !models.some((model) => sameWireId(model.id, current.imageGeneration?.modelId ?? ""))),
        );
        const nextSettings = {
          ...current,
          ...plan,
          ...(replacementChatModelId ? { defaultModelId: replacementChatModelId } : {}),
        };
        await api.setSettings(nextSettings);
        useAppStore.setState({ settings: nextSettings });
        showToast(t(editingProvider ? "settings.providerUpdated" : "settings.providerSaved"), {
          variant: "success",
        });
      } else if (copyDraft) {
        showToast(t("settings.providerSaved"), { variant: "success" });
      } else if (!editingProvider) {
        // A freshly added provider must not take over the app default: whatever
        // the user already picked keeps running — as long as that default's own
        // provider is still runnable — until they change it themselves.
        const currentProvider = providers.find((provider) => provider.id === settings.defaultProviderId);
        const keepsCurrentDefault = !!currentProvider && providerReady(currentProvider) &&
          chatModelOptions([currentProvider], imageGenerationCandidates).some(
            ({ modelId }) => sameWireId(modelId, settings.defaultModelId ?? ""),
          );
        if (!keepsCurrentDefault && firstModelId) {
          await api.setSettings({
            ...settings,
            defaultProviderId: saved.id,
            defaultModelId: firstModelId ?? "",
          });
        }
        showToast(t("settings.providerSaved"), { variant: "success" });
      } else {
        if (replacementChatModelId) {
          await api.setSettings({ ...settings, defaultModelId: replacementChatModelId });
        }
        showToast(t("settings.providerUpdated"), { variant: "success" });
      }
      setSetupFor(null);
      setCopyDraft(null);
      setPluginCatalogSetup(null);
      await refreshProviders();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    }
  };

  const setImageGenerationDefault = async (binding: ImageGenerationBinding) => {
    setChangingImageModel(true);
    try {
      const current = await api.getSettings();
      // Exactly the list the picker row offered, so a choice the user could
      // make is always one this page accepts — including the image model of a
      // signed-in vendor account, which is never stored as a chat model.
      const candidates = imageGenerationPickerCandidates(
        current.imageGenerationModels,
        current.imageGeneration,
        providers,
      );
      if (!isImageGenerationPickerCandidate(candidates, binding.providerId, binding.modelId)) {
        return;
      }
      const nextSettings = { ...current, imageGeneration: binding };
      await api.setSettings(nextSettings);
      useAppStore.setState({ settings: nextSettings });
      showToast(t("settings.imageModelSelected"), { variant: "success" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      setChangingImageModel(false);
    }
  };

  const toggleEnabled = async (provider: ProviderPublic) => {
    setBusyId(provider.id);
    try {
      await api.updateProvider({ id: provider.id, enabled: !provider.enabled });
      await refreshProviders();
      showToast(
        t(provider.enabled ? "settings.providerDisabled" : "settings.providerEnabled"),
        { variant: "success" },
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      setBusyId(null);
    }
  };

  const removeProvider = async (provider: ProviderPublic) => {
    setBusyId(provider.id);
    try {
      await api.deleteProvider(provider.id);
      await refreshProviders();
      showToast(t("settings.providerRemoved"), { variant: "success" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      setBusyId(null);
    }
  };

  /** Resolves true once the key is stored, so the row can close its entry. */
  const saveProviderKey = async (provider: ProviderPublic, value: string) => {
    setBusyId(provider.id);
    try {
      await api.setProviderSecret({ id: provider.id, secretValue: value });
      await refreshProviders();
      showToast(
        t(value.trim() ? "settings.pluginProviderKeySaved" : "settings.pluginProviderKeyRemoved"),
        { variant: "success" },
      );
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const saveEditingAccount = async (provider: ProviderPublic, form: VendorAccountForm) => {
    if (await saveAccount(provider, form)) setEditingAccountId(null);
  };

  const testProvider = async (provider: ProviderPublic) => {
    setTestingId(provider.id);
    try {
      const result = (await api.testProvider(provider.id)) as {
        ok?: boolean;
        message?: string;
        status?: number;
      };
      if (result?.ok) {
        showToast(t("settings.testOk"), { variant: "success" });
      } else {
        showToast(
          result?.message ||
            (result?.status
              ? t("settings.testFailedStatus", { status: result.status })
              : t("settings.testFailed")),
          { variant: "error" },
        );
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      setTestingId(null);
    }
  };

  const refreshCatalog = async () => {
    setRefreshingCatalog(true);
    try {
      const result = await api.refreshModelCatalog();
      setCatalogStatus(result.status);
      await refreshProviders();
      if (result.refreshed) {
        showToast(t("settings.modelCatalogUpdated"), { variant: "success" });
      } else {
        showToast(result.status.lastError || t("settings.modelCatalogUpdateFailed"), {
          variant: "error",
        });
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      setRefreshingCatalog(false);
    }
  };

  const catalogSourceLabel = catalogStatus
    ? t(
        catalogStatus.source === "remote"
          ? "settings.catalogSourceRemote"
          : catalogStatus.source === "bundled"
            ? "settings.catalogSourceBundled"
            : "settings.catalogSourceEmpty",
      )
    : "";

  return (
    <div className="settings-stack model-config-page">
      {imageGenerationCandidates.length > 0 ? (
        <section className="settings-card-block">
          <div className="settings-panel model-default-panel">
            <ImageGenerationModelRow
              settings={settings}
              providers={providers}
              busy={changingImageModel}
              onChange={setImageGenerationDefault}
            />
          </div>
        </section>
      ) : null}

      <JevSettingsCard
        settings={settings}
        onConfigure={() => {
          setJevSetup(true);
          setSetupFor("");
        }}
        statusRevision={jevStatusRevision}
      />

      <section className="settings-card-block">
        <div className="model-config-section-head">
          <div className="settings-card-heading-line">
            <h3 className="settings-card-heading">{t("settings.providers")}</h3>
            {providers.length > 0 ? (
              <span className="provider-section-count">{providers.length}</span>
            ) : null}
          </div>
          <div className="provider-section-head-actions">
            <ImportToggleButton
              open={importOpen}
              controls="model-config-import-panel"
              label={t("settings.importTitle")}
              onClick={() => setImportOpen((current) => !current)}
            />
            <Button
              variant="primary"
              className="model-provider-add"
              onClick={() => setSetupFor("")}
            >
              <span className="model-config-btn-inner">
                <IconPlus size={14} />
                <span>{t("settings.addProvider")}</span>
              </span>
            </Button>
          </div>
        </div>

        <div
          id="model-config-import-panel"
          className="import-inline-workbench"
          hidden={!importOpen}
        >
          <ModelConfigImportPanel />
        </div>

        <div className="settings-panel model-provider-panel">
          {providers.length === 0 ? (
            <div className="model-provider-empty">
              <div className="model-provider-empty-icon" aria-hidden>
                <IconServer size={18} />
              </div>
              <div className="model-provider-empty-title">{t("settings.noProviders")}</div>
              <div className="model-provider-empty-desc">{t("settings.noProvidersDesc")}</div>
              <Button variant="primary" onClick={() => setSetupFor("")}>
                <span className="model-config-btn-inner">
                  <IconPlus size={14} />
                  <span>{t("settings.addProvider")}</span>
                </span>
              </Button>
            </div>
          ) : (
            <ServiceList
              providers={providers}
              accountFor={accountFor}
              busy={
                busyId !== null ||
                testingId !== null ||
                setupFor !== null ||
                editingAccountId !== null ||
                busyAccountId !== null ||
                savingAccount ||
                login !== null
              }
              isRowBusy={(id) => busyId === id || testingId === id || busyAccountId === id}
              testingId={testingId}
              onEdit={(provider) =>
                serviceRowKind(provider) === "account"
                  ? setEditingAccountId(provider.id)
                  : setSetupFor(provider.id)
              }
              onTest={(provider) => void testProvider(provider)}
              onCopy={(provider) => {
                setCopyDraft(
                  copyProviderConfiguration(
                    provider,
                    t("settings.copyProviderName", { name: provider.name }),
                  ),
                );
                setSetupFor("");
              }}
              onToggleEnabled={(provider) => void toggleEnabled(provider)}
              onRemove={(provider) =>
                void (serviceRowKind(provider) === "account"
                  ? removeAccount(provider)
                  : removeProvider(provider))
              }
              onSaveKey={saveProviderKey}
            />
          )}
        </div>
      </section>

      <div className="model-catalog-status">
        <span className="model-catalog-status-text">
          {catalogStatus
            ? t("settings.catalogStatusLine", {
                source: catalogSourceLabel,
                models: catalogStatus.modelCount,
                fetchedAt: catalogStatus.fetchedAt
                  ? new Date(catalogStatus.fetchedAt).toLocaleString(
                      i18n.resolvedLanguage ?? i18n.language,
                    )
                  : t("settings.catalogNeverFetched"),
              })
            : t("settings.catalogStatusUnknown")}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={refreshingCatalog}
          onClick={() => void refreshCatalog()}
        >
          <span className="model-config-btn-inner">
            <IconConfig size={13} />
            <span>
              {refreshingCatalog
                ? t("settings.refreshingModelCatalog")
                : t("settings.refreshModelCatalog")}
            </span>
          </span>
        </Button>
      </div>

      {setupFor !== null ? (
        <ProviderSetupDialog
          key={setupFor}
          provider={editingProvider}
          pluginCatalogSetup={pluginCatalogSetup?.providerId === editingProvider?.id}
          pluginCatalogPluginName={pluginCatalogSetup?.pluginName}
          initialDraft={copyDraft}
          initialService={jevSetup ? JEV_SERVICE : undefined}
          onClose={() => {
            setSetupFor(null);
            setCopyDraft(null);
            setPluginCatalogSetup(null);
            setJevSetup(false);
          }}
          imageModelIds={editingProvider
            ? imageGenerationCandidates
                .filter((binding) => binding.providerId === editingProvider.id)
                .map((binding) => binding.modelId)
            : undefined}
          onSaved={afterSaved}
          onJevConfigured={() => {
            setSetupFor(null);
            setCopyDraft(null);
            setJevSetup(false);
            // The card is already mounted: tell it the key it read has changed.
            setJevStatusRevision((revision) => revision + 1);
          }}
          vendors={vendors}
          onPickSubscription={(vendor) => {
            setSetupFor(null);
            setCopyDraft(null);
            setPluginCatalogSetup(null);
            // Started here, not in the dialog: a click happens once, where
            // StrictMode would run a mount effect twice and open two browsers.
            startLogin(vendor);
          }}
          onPickPluginProvider={(providerId, pluginName) => {
            setPluginCatalogSetup({ providerId, pluginName });
            setCopyDraft(null);
            setJevSetup(false);
            setSetupFor(providerId);
          }}
        />
      ) : null}

      {editingAccount ? (
        <VendorAccountDialog
          provider={editingAccount}
          initialName={
            accountFor(editingAccount.id)?.account.accountLabel ||
            editingAccount.oauthAccountLabel ||
            editingAccount.name
          }
          saving={savingAccount}
          onClose={() => setEditingAccountId(null)}
          onSave={(form) => void saveEditingAccount(editingAccount, form)}
        />
      ) : null}

      {login ? (
        <OAuthLoginDialog
          vendor={login.vendor}
          session={login.session}
          onDone={finishLogin}
          onClose={closeLogin}
        />
      ) : null}
    </div>
  );
}

/**
 * Model configuration tab: default model, the AI service list, and the
 * models.dev enrichment snapshot status.
 *
 * API services, plugin-declared services and vendor subscription accounts
 * share one list (D625). An account row still lives and dies through the
 * vendor-account editor and `deleteOauthAccount`, never the provider CRUD.
 *
 * The default picker lists each configured model, while provider rows use
 * `models[0]` as the provider's quick default. Editing the default provider
 * preserves `settings.defaultModelId` while that model remains configured, and
 * adding a provider claims the chat or image default only while none resolves.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type ImageGenerationBinding,
  type ModelBinding,
  type ProviderPublic,
} from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";
import { providerDisplayName, providerSearchText } from "../../lib/provider-display";
import { Button, Input, cx } from "../ui";
import {
  IconCheck,
  IconChevronDown,
  IconConfig,
  IconPlus,
  IconServer,
  IconSearch,
} from "../icons";
import { AnchoredMenu } from "./AnchoredMenu";
import { providerServesChatModels } from "./default-model";
import { planImageGenerationDefaults } from "./image-generation-default";
import { copyProviderConfiguration, type ProviderCopyDraft } from "./provider-copy";
import { ImageGenerationModelRow } from "./ImageGenerationModelRow";
import { OAuthLoginDialog } from "./OAuthLoginDialog";
import { ProviderSetupDialog } from "./ProviderSetupDialog";
import { ServiceList } from "./ServiceList";
import { serviceRowKind } from "./service-row-status";
import { useVendorAccounts } from "./useVendorAccounts";
import { VendorAccountDialog, type VendorAccountForm } from "./VendorAccountDialog";

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

function isImageCandidate(candidates: readonly ImageGenerationBinding[], providerId: string, modelId: string) {
  return candidates.some((entry) => entry.providerId === providerId && sameWireId(entry.modelId, modelId));
}

function chatModelOptions(providers: readonly ProviderPublic[], imageModels: readonly ImageGenerationBinding[]) {
  return providers.flatMap((provider) => {
    const ids = provider.models?.length
      ? provider.models.map((model) => model.id)
      : [provider.defaultModelId ?? ""];
    return ids.filter((id) => !!id.trim() && !isImageCandidate(imageModels, provider.id, id))
      .map((modelId) => ({ provider, modelId }));
  });
}


function displayedChatModelId(
  provider: ProviderPublic,
  selected: string | undefined,
  imageModels: readonly ImageGenerationBinding[],
) {
  const configured = chatModelOptions([provider], imageModels).map(({ modelId }) => modelId);
  // Never display a different configured model in place of the saved wire ID.
  return selected?.trim() || configured[0];
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
  const [pickingDefault, setPickingDefault] = useState(false);
  const [defaultModelQuery, setDefaultModelQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [changingImageModel, setChangingImageModel] = useState(false);
  const [refreshingCatalog, setRefreshingCatalog] = useState(false);
  const [catalogStatus, setCatalogStatus] = useState<CatalogStatus | null>(null);
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
    () => imageCandidates(settings?.imageGenerationModels, settings?.imageGeneration),
    [settings?.imageGenerationModels, settings?.imageGeneration],
  );
  const providerReady = (provider: ProviderPublic) =>
    providerServesChatModels(provider, imageGenerationCandidates);

  const readyProviders = providers.filter(providerReady);
  const defaultModelOptionsList = chatModelOptions(readyProviders, imageGenerationCandidates);
  const visibleDefaultModelOptions = useMemo(() => {
    const query = defaultModelQuery.trim().toLowerCase();
    if (!query) return defaultModelOptionsList;
    return defaultModelOptionsList.filter(({ provider, modelId }) =>
      `${providerSearchText(provider)} ${modelId}`.toLowerCase().includes(query),
    );
  }, [defaultModelOptionsList, defaultModelQuery]);


  if (!settings) return null;

  const defaultProvider =
    providers.find((provider) => provider.id === settings.defaultProviderId) ?? null;
  const editingProvider =
    setupFor ? providers.find((provider) => provider.id === setupFor) ?? null : null;
  const editingAccount = editingAccountId
    ? providers.find((provider) => provider.id === editingAccountId) ?? null
    : null;
  const effectiveDefaultModelId = settings.defaultModelId?.trim() ||
    defaultProvider?.models?.[0]?.id || defaultProvider?.defaultModelId;
  const defaultProviderReady = defaultProvider !== null && providerReady(defaultProvider) &&
    chatModelOptions([defaultProvider], imageGenerationCandidates).some(
      ({ modelId }) => sameWireId(modelId, effectiveDefaultModelId ?? ""),
    );


  const setDefaultModel = async (provider: ProviderPublic, modelId: string) => {
    if (isImageCandidate(
      imageCandidates(
        useAppStore.getState().settings?.imageGenerationModels,
        useAppStore.getState().settings?.imageGeneration,
      ),
      provider.id,
      modelId,
    )) return;
    setBusyId(provider.id);
    try {
      await api.setSettings({
        ...settings,
        defaultProviderId: provider.id,
        defaultModelId: modelId,
      });
      await refreshProviders();
      showToast(t("settings.defaultUpdated"), { variant: "success" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      setBusyId(null);
      setPickingDefault(false);
    }
  };

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
      if (imageModelIds !== undefined) {
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
      const candidates = imageCandidates(
        current.imageGenerationModels,
        current.imageGeneration,
      );
      if (!isImageCandidate(candidates, binding.providerId, binding.modelId)) return;
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
      <section className="settings-card-block">
        <div className="model-config-section-head">
          <h3 className="settings-card-heading">{t("settings.defaultsTitle")}</h3>
        </div>
        <div className="settings-panel model-default-panel">
          <div className="settings-row model-default-row">
            <div className="settings-row-copy model-default-copy">
              <div className="settings-row-title model-default-label">
                {t("settings.defaultModel")}
              </div>
              {defaultProviderReady ? (
                <div className="settings-row-detail model-default-value">
                  <span className="model-default-provider">
                    {providerDisplayName(defaultProvider)}
                  </span>
                  <span className="model-default-sep" aria-hidden>
                    ·
                  </span>
                  <span className="model-default-model font-mono">
                    {displayedChatModelId(defaultProvider, effectiveDefaultModelId, imageGenerationCandidates) ||
                      t("settings.noModel")}
                  </span>
                </div>
              ) : (
                <div className="settings-row-detail model-default-value">
                  {defaultProvider && settings.defaultModelId ? (
                    <>
                      <span className="model-default-provider">{providerDisplayName(defaultProvider)}</span>
                      <span className="model-default-sep" aria-hidden>·</span>
                      <span className="model-default-model font-mono" title={t("settings.noDefaultProvider")}>
                        {settings.defaultModelId}
                      </span>
                      <span className="model-default-empty">{t("settings.noDefaultProvider")}</span>
                    </>
                  ) : (
                    <span className="model-default-empty">
                      {readyProviders.length === 0
                        ? t("settings.defaultModelNone")
                        : t("settings.noDefaultProvider")}
                    </span>
                  )}
                </div>
              )}
            </div>
            <AnchoredMenu
              className="model-default-anchor"
              open={pickingDefault}
              onClose={() => setPickingDefault(false)}
              menuClassName="model-default-menu"
              label={t("settings.changeDefaultModel")}
              align="end"
              trigger={(ref) => (
                <Button
                  ref={ref}
                  className="settings-text-action model-default-trigger"
                  variant="ghost"
                  disabled={readyProviders.length === 0}
                  onClick={() => {
                    setDefaultModelQuery("");
                    setPickingDefault((current) => !current);
                  }}
                  aria-haspopup="listbox"
                  aria-expanded={pickingDefault}
                >
                  {t("settings.changeDefaultModel")}
                  <IconChevronDown className="model-default-trigger-chevron" size={13} aria-hidden />
                </Button>
              )}
            >
              <div className="model-default-search">
                <IconSearch size={14} aria-hidden />
                <Input
                  value={defaultModelQuery}
                  onChange={(event) => setDefaultModelQuery(event.target.value)}
                  placeholder={t("settings.defaultModelSearch")}
                  aria-label={t("settings.defaultModelSearch")}
                  autoFocus
                />
              </div>
              <div className="model-default-results" role="presentation">
                {visibleDefaultModelOptions.length === 0 ? (
                  <div className="model-default-no-results">{t("settings.noModelMatches")}</div>
                ) : null}
                <ul className="model-default-list">
                  {visibleDefaultModelOptions.map(({ provider, modelId }, index) => {
                    const isCurrent =
                      provider.id === settings.defaultProviderId &&
                      sameWireId(settings.defaultModelId ?? "", modelId);
                    const previous = visibleDefaultModelOptions[index - 1];
                    const startsGroup = !previous || previous.provider.id !== provider.id;
                    return (
                      <li key={`${provider.id}:${modelId}`}>
                        {startsGroup ? (
                          <div
                            className={cx(
                              "model-default-provider-group",
                              index > 0 && "has-divider",
                            )}
                          >
                            {providerDisplayName(provider)}
                          </div>
                        ) : null}
                        <button
                          type="button"
                          role="option"
                          aria-selected={isCurrent}
                          aria-label={`${providerDisplayName(provider)} · ${modelId}`}
                          className={cx("model-default-option", isCurrent && "is-current")}
                          disabled={busyId === provider.id}
                          onClick={() => void setDefaultModel(provider, modelId)}
                        >
                          <span className="model-default-option-check" aria-hidden>
                            {isCurrent ? <IconCheck size={12} /> : null}
                          </span>
                          <span className="model-default-option-model font-mono">{modelId}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </AnchoredMenu>
          </div>
          {imageGenerationCandidates.length > 0 ? (
            <ImageGenerationModelRow
              settings={settings}
              providers={providers}
              busy={changingImageModel}
              onChange={setImageGenerationDefault}
            />
          ) : null}
        </div>
      </section>

      <section className="settings-card-block">
        <div className="model-config-section-head">
          <div className="settings-card-heading-line">
            <h3 className="settings-card-heading">{t("settings.providers")}</h3>
            {providers.length > 0 ? (
              <span className="provider-section-count">{providers.length}</span>
            ) : null}
          </div>
          <div className="provider-section-head-actions">
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
              defaultProviderId={settings.defaultProviderId}
              isReady={providerReady}
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
              onMakeDefault={(provider) =>
                void setDefaultModel(
                  provider,
                  chatModelOptions([provider], imageGenerationCandidates)[0]?.modelId ?? "",
                )
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
          provider={editingProvider}
          initialDraft={copyDraft}
          onClose={() => { setSetupFor(null); setCopyDraft(null); }}
          imageModelIds={editingProvider
            ? imageGenerationCandidates
                .filter((binding) => binding.providerId === editingProvider.id)
                .map((binding) => binding.modelId)
            : undefined}
          onSaved={afterSaved}
          vendors={vendors}
          onPickSubscription={(vendor) => {
            setSetupFor(null);
            setCopyDraft(null);
            // Started here, not in the dialog: a click happens once, where
            // StrictMode would run a mount effect twice and open two browsers.
            startLogin(vendor);
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

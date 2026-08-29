/**
 * Model configuration tab: default model, configured AI services, OAuth
 * vendor accounts, and the models.dev enrichment snapshot status.
 *
 * Provider rows treat `models[0]` as the provider's default model, and editing
 * the default provider re-syncs `settings.defaultModelId` when that first
 * model changed.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  OAUTH_AUTH_KIND,
  type ModelBinding,
  type ProviderPublic,
} from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";
import { Badge, Button, cx } from "../ui";
import {
  IconCheck,
  IconConfig,
  IconPencil,
  IconPlug,
  IconPlus,
  IconServer,
  IconTrash,
} from "../icons";
import { defaultModelIdOf, displayedDefaultModelId } from "./default-model";
import { ProviderSetupDialog } from "./ProviderSetupDialog";
import { VendorAccountsSection } from "./VendorAccountsSection";

const DELETE_CONFIRM_MS = 3000;

type CatalogStatus = {
  loaded: boolean;
  source: "bundled" | "remote" | "empty";
  catalogPath: string;
  fetchedAt?: string;
  providerCount: number;
  modelCount: number;
  lastError?: string;
};

/** Host part of a base URL, or an em dash when nothing is configured. */
function hostFromBaseUrl(baseUrl?: string | null): string {
  if (!baseUrl) return "—";
  try {
    return new URL(baseUrl).host || baseUrl;
  } catch {
    return baseUrl.replace(/^https?:\/\//, "").split("/")[0] || baseUrl;
  }
}

export function ModelConfigPage() {
  const { t } = useTranslation();
  const providers = useAppStore((s) => s.providers);
  const settings = useAppStore((s) => s.settings);
  const refreshProviders = useAppStore((s) => s.refreshProviders);
  const showToast = useAppStore((s) => s.showToast);

  // null = closed, "" = add flow, provider id = edit flow.
  const [setupFor, setSetupFor] = useState<string | null>(null);
  const [pickingDefault, setPickingDefault] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [refreshingCatalog, setRefreshingCatalog] = useState(false);
  const [catalogStatus, setCatalogStatus] = useState<CatalogStatus | null>(null);
  // Two-step delete: the first click arms the row, the second removes it.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!confirmDeleteId) return;
    confirmTimer.current = setTimeout(() => setConfirmDeleteId(null), DELETE_CONFIRM_MS);
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, [confirmDeleteId]);

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

  const providerReady = (provider: ProviderPublic) =>
    provider.enabled &&
    !!defaultModelIdOf(provider) &&
    (provider.hasSecret || provider.hasOauth || provider.authKind === "none");

  const aiProviders = useMemo(
    () => providers.filter((provider) => provider.authKind !== OAUTH_AUTH_KIND),
    [providers],
  );
  const readyProviders = providers.filter(providerReady);

  if (!settings) return null;

  const defaultProvider =
    providers.find((provider) => provider.id === settings.defaultProviderId) ?? null;
  const editingProvider =
    setupFor ? providers.find((provider) => provider.id === setupFor) ?? null : null;

  const setDefaultProvider = async (provider: ProviderPublic) => {
    setBusyId(provider.id);
    try {
      await api.setSettings({
        ...settings,
        defaultProviderId: provider.id,
        // Falling back to the old value here would point the new default at a
        // model the selected provider does not serve.
        defaultModelId: defaultModelIdOf(provider) ?? "",
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
   * A saved provider that is also the global default may have changed its first
   * model, which is what `settings.defaultModelId` points at.
   */
  const afterSaved = async (saved: ProviderPublic, models: ModelBinding[]) => {
    const firstModelId = models[0]?.id;
    try {
      if (!editingProvider) {
        await api.setSettings({
          ...settings,
          defaultProviderId: saved.id,
          defaultModelId: firstModelId ?? "",
        });
        showToast(t("settings.providerSaved"), { variant: "success" });
      } else {
        if (settings.defaultProviderId === saved.id && firstModelId) {
          await api.setSettings({ ...settings, defaultModelId: firstModelId });
        }
        showToast(t("settings.providerUpdated"), { variant: "success" });
      }
      setSetupFor(null);
      await refreshProviders();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
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
    setConfirmDeleteId(null);
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
          <div className="model-default-row">
            <div className="model-default-copy">
              <div className="model-default-label">{t("settings.defaultModel")}</div>
              <div className="model-default-value">
                {defaultProvider && providerReady(defaultProvider) ? (
                  <>
                    <span className="model-default-provider">{defaultProvider.name}</span>
                    <span className="model-default-sep" aria-hidden>
                      ·
                    </span>
                    <span className="model-default-model font-mono">
                      {displayedDefaultModelId(
                        defaultProvider,
                        settings.defaultModelId,
                      ) || t("settings.noModel")}
                    </span>
                  </>
                ) : (
                  <span className="model-default-empty">
                    {readyProviders.length === 0
                      ? t("settings.defaultModelNone")
                      : t("settings.noDefaultProvider")}
                  </span>
                )}
              </div>
            </div>
            <Button
              variant="secondary"
              disabled={readyProviders.length === 0}
              onClick={() => setPickingDefault((current) => !current)}
              aria-expanded={pickingDefault}
            >
              {t("settings.changeDefaultModel")}
            </Button>
          </div>

          {pickingDefault ? (
            <ul className="model-default-picker" aria-label={t("settings.changeDefaultModel")}>
              {readyProviders.map((provider) => {
                const isCurrent = provider.id === settings.defaultProviderId;
                return (
                  <li key={provider.id}>
                    <button
                      type="button"
                      className={cx("model-default-option", isCurrent && "is-current")}
                      disabled={busyId === provider.id}
                      onClick={() => void setDefaultProvider(provider)}
                    >
                      <span className="model-default-option-check" aria-hidden>
                        {isCurrent ? <IconCheck size={12} /> : null}
                      </span>
                      <span className="model-default-option-name">{provider.name}</span>
                      <span className="model-default-option-model font-mono">
                        {defaultModelIdOf(provider)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      </section>

      <section className="settings-card-block">
        <div className="model-config-section-head">
          <div className="settings-card-heading-line">
            <h3 className="settings-card-heading">{t("settings.providers")}</h3>
            {aiProviders.length > 0 ? (
              <span className="provider-section-count">{aiProviders.length}</span>
            ) : null}
          </div>
          <Button variant="primary" onClick={() => setSetupFor("")}>
            <span className="model-config-btn-inner">
              <IconPlus size={14} />
              <span>{t("settings.addProvider")}</span>
            </span>
          </Button>
        </div>

        <div className="settings-panel model-provider-panel">
          {aiProviders.length === 0 ? (
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
            <ul className="model-provider-list">
              {aiProviders.map((provider) => {
                const isDefault = settings.defaultProviderId === provider.id;
                const rowBusy = busyId === provider.id || testingId === provider.id;
                const confirming = confirmDeleteId === provider.id;
                const modelCount = provider.models?.length ?? 0;
                return (
                  <li
                    key={provider.id}
                    className={cx("model-provider-row", !provider.enabled && "is-disabled")}
                  >
                    <div className="model-provider-row-copy">
                      <div className="model-provider-row-title">
                        <span className="model-provider-row-name">{provider.name}</span>
                        {isDefault ? (
                          <Badge tone="success">{t("settings.default")}</Badge>
                        ) : null}
                        {!provider.hasSecret && provider.authKind !== "none" ? (
                          <Badge tone="warning">{t("settings.noSecret")}</Badge>
                        ) : null}
                        {!provider.enabled ? (
                          <Badge tone="neutral">{t("settings.providerDisabledBadge")}</Badge>
                        ) : null}
                      </div>
                      <div className="model-provider-row-meta">
                        <span>{hostFromBaseUrl(provider.baseUrl)}</span>
                        <span className="model-provider-meta-dot" aria-hidden>
                          ·
                        </span>
                        <span>{t("settings.providerModelCount", { count: modelCount })}</span>
                      </div>
                    </div>

                    <div className="model-provider-row-actions">
                      {!isDefault ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={rowBusy || !providerReady(provider)}
                          onClick={() => void setDefaultProvider(provider)}
                        >
                          {t("settings.makeDefault")}
                        </Button>
                      ) : null}
                      <button
                        type="button"
                        className="icon-btn model-provider-icon-btn"
                        title={t("settings.editProvider")}
                        aria-label={t("settings.editProvider")}
                        disabled={rowBusy}
                        onClick={() => setSetupFor(provider.id)}
                      >
                        <IconPencil size={14} />
                      </button>
                      <button
                        type="button"
                        className={cx(
                          "icon-btn model-provider-icon-btn",
                          testingId === provider.id && "is-testing",
                        )}
                        title={t("settings.testConnection")}
                        aria-label={t("settings.testConnection")}
                        disabled={rowBusy}
                        onClick={() => void testProvider(provider)}
                      >
                        <IconPlug size={14} />
                      </button>
                      {confirming ? (
                        <button
                          type="button"
                          className="model-provider-delete-confirm"
                          disabled={rowBusy}
                          onBlur={() => setConfirmDeleteId(null)}
                          onClick={() => void removeProvider(provider)}
                        >
                          {t("settings.deleteConfirm")}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="icon-btn model-provider-icon-btn is-danger"
                          title={t("settings.delete")}
                          aria-label={t("settings.delete")}
                          disabled={rowBusy}
                          onClick={() => setConfirmDeleteId(provider.id)}
                        >
                          <IconTrash size={14} />
                        </button>
                      )}
                      <button
                        type="button"
                        className={cx("settings-toggle", provider.enabled && "on")}
                        role="switch"
                        aria-checked={provider.enabled}
                        aria-label={t("settings.enabledToggle")}
                        title={t("settings.enabledToggle")}
                        disabled={rowBusy}
                        onClick={() => void toggleEnabled(provider)}
                      >
                        <span className="settings-toggle-thumb" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      <VendorAccountsSection />

      <div className="model-catalog-status">
        <span className="model-catalog-status-text">
          {catalogStatus
            ? t("settings.catalogStatusLine", {
                source: catalogSourceLabel,
                models: catalogStatus.modelCount,
                fetchedAt: catalogStatus.fetchedAt
                  ? new Date(catalogStatus.fetchedAt).toLocaleString()
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
          onClose={() => setSetupFor(null)}
          onSaved={(saved, models) => void afterSaved(saved, models)}
        />
      ) : null}
    </div>
  );
}

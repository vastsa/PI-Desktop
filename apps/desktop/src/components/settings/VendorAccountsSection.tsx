/**
 * Sign in with a vendor subscription instead of pasting an API key (ADR 0098).
 * Vendor accounts are separate from API providers in the settings hierarchy;
 * each account row owns exactly one OAuth provider row and can be removed on
 * its own.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OAuthAccount, OAuthVendor, ProviderPublic } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";
import {
  beginOAuthLogin,
  type OAuthLoginSession,
} from "../../lib/oauth-login-session";
import { Badge, Button, cx } from "../ui";
import { IconKey, IconPencil, IconPlug, IconTrash } from "../icons";
import { OAuthLoginDialog } from "./OAuthLoginDialog";
import {
  VendorAccountDialog,
  type VendorAccountForm,
} from "./VendorAccountDialog";
import { VendorPickerDialog } from "./VendorPickerDialog";

/** A login in flight, together with the dialog reporting on it. */
type ActiveLogin = { vendor: OAuthVendor; session: OAuthLoginSession };

type AccountEntry = {
  vendor: OAuthVendor;
  account: OAuthAccount;
  ordinal: number;
  totalForVendor: number;
};

function providerIsReady(provider: ProviderPublic, excludedId?: string): boolean {
  return (
    provider.id !== excludedId &&
    provider.enabled &&
    !!provider.defaultModelId &&
    (provider.hasSecret || provider.hasOauth || provider.authKind === "none")
  );
}

export function VendorAccountsSection() {
  const { t } = useTranslation();
  const providers = useAppStore((s) => s.providers);
  const settings = useAppStore((s) => s.settings);
  const refreshProviders = useAppStore((s) => s.refreshProviders);
  const showToast = useAppStore((s) => s.showToast);

  const [vendors, setVendors] = useState<OAuthVendor[] | null>(null);
  const [busyAccount, setBusyAccount] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [login, setLogin] = useState<ActiveLogin | null>(null);
  const [editingAccount, setEditingAccount] = useState<AccountEntry | null>(null);
  const [savingAccount, setSavingAccount] = useState(false);
  const [testingAccount, setTestingAccount] = useState<string | null>(null);

  const loadVendors = useCallback(async () => {
    try {
      const result = await api.listOauthVendors();
      setVendors(result.vendors);
    } catch {
      // A runtime without OAuth flows registered simply has no accounts to
      // offer; the section stays hidden rather than showing an error.
      setVendors([]);
    }
  }, []);

  useEffect(() => {
    void loadVendors();
  }, [loadVendors]);

  // Closing the dialog — done, cancelled, or the whole page going away — stops
  // the renderer listening. Cancelling the attempt itself is the dialog's job.
  useEffect(() => () => login?.session.dispose(), [login]);

  const accounts = useMemo<AccountEntry[]>(() => {
    if (!vendors) return [];
    return vendors.flatMap((vendor) => {
      const totalForVendor = vendor.accounts.length;
      return vendor.accounts.map((account, index) => ({
        vendor,
        account,
        ordinal: index + 1,
        totalForVendor,
      }));
    });
  }, [vendors]);

  const removeAccount = async (entry: AccountEntry) => {
    const { account, vendor } = entry;
    setConfirmDeleteId(null);
    setBusyAccount(account.providerId);
    try {
      await api.deleteOauthAccount(account.providerId);

      // A deleted account cannot remain the global default. Pick the first
      // still-ready service, including an API provider, so the model picker
      // does not point at a deleted row after refresh.
      if (settings?.defaultProviderId === account.providerId) {
        const next = providers.find((provider) =>
          providerIsReady(provider, account.providerId),
        );
        const nextSettings = {
          ...settings,
          defaultProviderId: next?.id ?? "",
          defaultModelId: next?.defaultModelId ?? "",
        };
        await api.setSettings(nextSettings);
        useAppStore.setState({ settings: nextSettings });
      }
      await Promise.all([loadVendors(), refreshProviders()]);
      showToast(t("settings.vendorAccountRemoved", { vendor: vendor.name }), {
        variant: "success",
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      setBusyAccount(null);
    }
  };

  const saveAccount = async (form: VendorAccountForm) => {
    const entry = editingAccount;
    const provider = entry
      ? providers.find((candidate) => candidate.id === entry.account.providerId)
      : null;
    if (!entry || !provider || !form.name.trim() || !form.modelId.trim()) return;
    setSavingAccount(true);
    try {
      await api.updateProvider({
        id: provider.id,
        oauthAccountLabel: form.name.trim(),
        defaultModelId: form.modelId.trim(),
        models: form.models,
      });
      if (settings?.defaultProviderId === provider.id) {
        await api.setSettings({
          ...settings,
          defaultModelId: form.modelId.trim(),
        });
      }
      await Promise.all([loadVendors(), refreshProviders()]);
      setEditingAccount(null);
      showToast(t("settings.vendorAccountUpdated"), { variant: "success" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      setSavingAccount(false);
    }
  };

  const testAccount = async (entry: AccountEntry) => {
    const provider = providers.find((candidate) => candidate.id === entry.account.providerId);
    if (!provider) return;
    setTestingAccount(provider.id);
    try {
      const result = (await api.testProvider(provider.id)) as {
        ok?: boolean;
        message?: string;
        status?: number;
      };
      if (result.ok) {
        showToast(t("settings.testOk"), { variant: "success" });
      } else {
        showToast(
          result.message ||
            (result.status
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
      setTestingAccount(null);
    }
  };

  const onLoginDone = useCallback(
    (accountLabel?: string) => {
      const vendorName = login?.vendor.name ?? "";
      setLogin(null);
      void loadVendors();
      void refreshProviders();
      showToast(
        accountLabel
          ? t("settings.vendorSignedInAs", { account: accountLabel })
          : t("settings.vendorSignedIn", { vendor: vendorName }),
        { variant: "success" },
      );
    },
    [login, loadVendors, refreshProviders, showToast, t],
  );

  // Nothing to offer until the runtime reports at least one OAuth vendor.
  if (!vendors || vendors.length === 0) return null;

  const editingProvider = editingAccount
    ? providers.find((candidate) => candidate.id === editingAccount.account.providerId) ?? null
    : null;

  return (
    <section className="settings-card-block vendor-accounts-block">
      <div className="provider-section-head">
        <div>
          <div className="settings-card-heading-line">
            <h3 className="settings-card-heading">{t("settings.vendorAccounts")}</h3>
            {accounts.length > 0 ? (
              <span className="provider-section-count">{accounts.length}</span>
            ) : null}
          </div>
        </div>
        <Button
          variant="primary"
          disabled={login !== null}
          onClick={() => setPicking(true)}
        >
          <span className="vendor-btn-inner">
            <IconKey size={14} />
            <span>{t("settings.vendorAddAccount")}</span>
          </span>
        </Button>
      </div>

      <div className="settings-panel provider-list-panel">
        {accounts.length === 0 ? (
          <div className="vendor-account-empty">{t("settings.vendorNoAccounts")}</div>
        ) : (
          <div className="provider-row-list">
            {accounts.map((entry) => {
              const { vendor, account } = entry;
              const provider = providers.find((candidate) => candidate.id === account.providerId);
              const connected = account.connected;
              const accountName =
                account.accountLabel ||
                provider?.oauthAccountLabel ||
                t("settings.vendorSignedInGeneric");
              const duplicateLabel =
                entry.totalForVendor > 1
                  ? ` · ${t("settings.vendorAccountNumber", { number: entry.ordinal })}`
                  : "";
              const confirming = confirmDeleteId === account.providerId;
              const busy = busyAccount === account.providerId;
              const testing = testingAccount === account.providerId;
              const rowBusy = busy || testing;
              return (
                <div
                  key={account.providerId}
                  className={cx(
                    "provider-row",
                    "vendor-account-row",
                    !connected && "is-disconnected",
                  )}
                >
                  <div className="provider-row-info">
                    <div className="provider-row-title-line">
                      <span className="provider-row-name">{vendor.name}</span>
                      {vendor.isSubscription ? (
                        <Badge tone="neutral">{t("settings.vendorSubscription")}</Badge>
                      ) : null}
                      <Badge tone={connected ? "success" : "warning"}>
                        {connected
                          ? t("settings.vendorConnected")
                          : t("settings.vendorDisconnected")}
                      </Badge>
                    </div>
                    <div className="provider-row-meta">
                      <span className="vendor-account-label">
                        {accountName}
                        {duplicateLabel}
                      </span>
                    </div>
                    {!connected ? (
                      <div className="vendor-account-status">
                        {t("settings.vendorDisconnectedDesc")}
                      </div>
                    ) : null}
                  </div>
                  <div className="provider-row-actions">
                    <button
                      type="button"
                      className="icon-btn provider-icon-btn"
                      title={t("settings.editVendorAccount")}
                      aria-label={t("settings.editVendorAccount")}
                      disabled={rowBusy || !provider}
                      onClick={() => setEditingAccount(entry)}
                    >
                      <IconPencil size={14} />
                    </button>
                    <button
                      type="button"
                      className={cx(
                        "icon-btn provider-icon-btn",
                        testing && "is-testing",
                      )}
                      title={t("settings.testConnection")}
                      aria-label={t("settings.testConnection")}
                      disabled={rowBusy || !provider}
                      onClick={() => void testAccount(entry)}
                    >
                      <IconPlug size={14} />
                    </button>
                    {confirming ? (
                      <button
                        type="button"
                        className="provider-delete-confirm"
                        disabled={rowBusy}
                        onBlur={() => setConfirmDeleteId(null)}
                        onClick={() => void removeAccount(entry)}
                      >
                        {t("settings.deleteConfirm")}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="icon-btn provider-icon-btn provider-icon-btn-danger"
                        title={t("settings.vendorRemoveAccount")}
                        aria-label={t("settings.vendorRemoveAccount")}
                        disabled={rowBusy}
                        onClick={() => setConfirmDeleteId(account.providerId)}
                      >
                        <IconTrash size={14} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {picking ? (
        <VendorPickerDialog
          vendors={vendors}
          onPick={(vendor) => {
            setPicking(false);
            // Started here, not in the dialog: a click happens once, where
            // StrictMode would run a mount effect twice and open two browsers.
            setLogin({
              vendor,
              session: beginOAuthLogin({ api, vendorId: vendor.vendorId }),
            });
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}

      {editingAccount && editingProvider ? (
        <VendorAccountDialog
          provider={editingProvider}
          initialName={
            editingAccount.account.accountLabel ||
            editingProvider.oauthAccountLabel ||
            editingProvider.name
          }
          saving={savingAccount}
          onClose={() => setEditingAccount(null)}
          onSave={(form) => void saveAccount(form)}
        />
      ) : null}

      {login ? (
        <OAuthLoginDialog
          vendor={login.vendor}
          session={login.session}
          onDone={onLoginDone}
          onClose={() => {
            setLogin(null);
            void loadVendors();
          }}
        />
      ) : null}
    </section>
  );
}

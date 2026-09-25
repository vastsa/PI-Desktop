/**
 * Vendor (OAuth) accounts for the model settings page (ADR 0098, D625).
 *
 * Account rows share the AI service list with API services; this hook owns what
 * such a row needs beyond its provider row: the vendor list the runtime
 * reports, the login attempt in flight, and the writes that must keep the app
 * default consistent — a finished login claiming an empty default, removing an
 * account and saving its edits. Rendering stays with the caller.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  imageGenerationBindings,
  type OAuthAccount,
  type OAuthVendor,
  type ProviderPublic,
} from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";
import {
  beginOAuthLogin,
  type OAuthLoginSession,
} from "../../lib/oauth-login-session";
import { loginDefaultModel } from "./default-model";
import type { VendorAccountForm } from "./VendorAccountDialog";

/** A login in flight, together with the dialog reporting on it. */
export type ActiveLogin = { vendor: OAuthVendor; session: OAuthLoginSession };

export type AccountEntry = {
  vendor: OAuthVendor;
  account: OAuthAccount;
  /** 1-based position among this vendor's accounts. */
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

/**
 * Let a finished login claim the app default the way adding an API service
 * does. Reads the host's rows and settings rather than the store, which has
 * not seen the new account yet.
 */
async function claimLoginDefault(providerId: string): Promise<void> {
  const [{ providers }, current] = await Promise.all([
    api.listProviders(),
    api.getSettings(),
  ]);
  const claim = loginDefaultModel(
    providers,
    providerId,
    current,
    imageGenerationBindings(current.imageGenerationModels, current.imageGeneration),
  );
  if (!claim) return;
  await api.setSettings({
    ...current,
    defaultProviderId: claim.providerId,
    defaultModelId: claim.modelId,
  });
}

export function useVendorAccounts() {
  const { t } = useTranslation();
  const providers = useAppStore((s) => s.providers);
  const settings = useAppStore((s) => s.settings);
  const refreshProviders = useAppStore((s) => s.refreshProviders);
  const showToast = useAppStore((s) => s.showToast);

  const [vendors, setVendors] = useState<OAuthVendor[] | null>(null);
  const [login, setLogin] = useState<ActiveLogin | null>(null);
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null);
  const [savingAccount, setSavingAccount] = useState(false);

  const loadVendors = useCallback(async () => {
    try {
      const result = await api.listOauthVendors();
      setVendors(result.vendors);
    } catch {
      // A runtime without OAuth flows registered simply has no accounts to
      // offer; the accounts stay hidden rather than showing an error.
      setVendors([]);
    }
  }, []);

  useEffect(() => {
    void loadVendors();
  }, [loadVendors]);

  // Closing the dialog — done, cancelled, or the whole page going away — stops
  // the renderer listening. Cancelling the attempt itself is the dialog's job.
  useEffect(() => () => login?.session.dispose(), [login]);

  const accounts = useMemo(() => {
    const byProvider = new Map<string, AccountEntry>();
    for (const vendor of vendors ?? []) {
      const totalForVendor = vendor.accounts.length;
      vendor.accounts.forEach((account, index) => {
        byProvider.set(account.providerId, {
          vendor,
          account,
          ordinal: index + 1,
          totalForVendor,
        });
      });
    }
    return byProvider;
  }, [vendors]);

  /** The vendor account behind a provider row, once the vendor list loaded. */
  const accountFor = useCallback(
    (providerId: string): AccountEntry | null => accounts.get(providerId) ?? null,
    [accounts],
  );

  /**
   * Started from the caller's click handler, never from an effect: a click
   * happens once, where StrictMode would run a mount effect twice and open two
   * browsers.
   */
  const startLogin = (vendor: OAuthVendor) => {
    setLogin({
      vendor,
      session: beginOAuthLogin({ api, vendorId: vendor.vendorId }),
    });
  };

  const finishLogin = useCallback(
    (accountLabel?: string, providerId?: string) => {
      const vendorName = login?.vendor.name ?? "";
      setLogin(null);
      void loadVendors();
      showToast(
        accountLabel
          ? t("settings.vendorSignedInAs", { account: accountLabel })
          : t("settings.vendorSignedIn", { vendor: vendorName }),
        { variant: "success" },
      );
      void (async () => {
        try {
          if (providerId) await claimLoginDefault(providerId);
        } catch (error) {
          showToast(error instanceof Error ? error.message : String(error), {
            variant: "error",
          });
        } finally {
          await refreshProviders();
        }
      })();
    },
    [login, loadVendors, refreshProviders, showToast, t],
  );

  // Main discards the row a failed or cancelled login created before it
  // reports the outcome, so the list can drop it now.
  const closeLogin = () => {
    setLogin(null);
    void loadVendors();
    void refreshProviders();
  };

  const removeAccount = async (provider: ProviderPublic) => {
    const vendorName = accounts.get(provider.id)?.vendor.name ?? provider.name;
    setBusyAccountId(provider.id);
    try {
      await api.deleteOauthAccount(provider.id);

      // A deleted account cannot remain the global default. Pick the first
      // still-ready service, including an API provider, so the model picker
      // does not point at a deleted row after refresh.
      if (settings?.defaultProviderId === provider.id) {
        const next = providers.find((candidate) =>
          providerIsReady(candidate, provider.id),
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
      showToast(t("settings.vendorAccountRemoved", { vendor: vendorName }), {
        variant: "success",
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      setBusyAccountId(null);
    }
  };

  /** Resolves true once the account is saved, so the caller can close its editor. */
  const saveAccount = async (
    provider: ProviderPublic,
    form: VendorAccountForm,
  ): Promise<boolean> => {
    if (!form.name.trim() || !form.modelId.trim()) return false;
    setSavingAccount(true);
    try {
      await api.updateProvider({
        id: provider.id,
        oauthAccountLabel: form.name.trim(),
        defaultModelId: form.modelId.trim(),
        models: form.models,
        headers: form.headers,
      });
      if (settings?.defaultProviderId === provider.id) {
        await api.setSettings({
          ...settings,
          defaultModelId: form.modelId.trim(),
        });
      }
      await Promise.all([loadVendors(), refreshProviders()]);
      showToast(t("settings.vendorAccountUpdated"), { variant: "success" });
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
      return false;
    } finally {
      setSavingAccount(false);
    }
  };

  return {
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
  };
}

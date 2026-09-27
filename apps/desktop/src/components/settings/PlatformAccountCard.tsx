/** Platform onboarding and API-token allowance; account funds stay on the website. */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AI_PLATFORM_ORIGIN,
  AI_PLATFORM_WALLET_URL,
  type PlatformTokenUsage as TokenUsage,
  type ProviderPublic,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";
import { Button } from "../ui";
import { SettingsMenuSelect } from "./SettingsMenuSelect";
import { isPlatformProvider } from "./service-catalog";

type UsageState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; usage: TokenUsage };

function PlatformTokenUsage({ providerId }: { providerId: string }) {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<UsageState>({ status: "loading" });
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++request.current;
    setState({ status: "loading" });
    try {
      const usage = await api.platformTokenUsage(providerId);
      if (current === request.current) setState({ status: "ready", usage });
    } catch {
      // Host failures may contain request details; never render credential-bearing errors.
      if (current === request.current) setState({ status: "error" });
    }
  }, [providerId]);

  useEffect(() => {
    void refresh();
    return () => { request.current += 1; };
  }, [refresh]);

  const locale = i18n.resolvedLanguage ?? i18n.language;
  const usage = state.status === "ready" ? state.usage : null;
  const formatter = new Intl.NumberFormat(locale, usage?.unit === "USD"
    ? { style: "currency", currency: "USD", currencyDisplay: "code", minimumFractionDigits: 2, maximumFractionDigits: 6 }
    : { maximumFractionDigits: 6 });
  const amount = (value: number) => usage?.unit === "quota"
    ? t("settings.platformQuotaAmount", { amount: formatter.format(value) })
    : formatter.format(value);

  return (
    <div aria-busy={state.status === "loading"}>
      <SettingsRow title={t("settings.platformTokenUsage")}>
        <Button variant="ghost" size="sm" disabled={state.status === "loading"} onClick={() => void refresh()}>
          {t("settings.platformRefreshUsage")}
        </Button>
      </SettingsRow>
      <div className="px-4 pb-4 space-y-2" aria-live="polite">
        {state.status === "loading" ? <p role="status">{t("settings.platformUsageLoading")}</p> : null}
        {state.status === "error" ? <p role="alert">{t("settings.platformUsageError")}</p> : null}
        {usage ? (
          <dl className="space-y-2 text-sm">
            <div className="flex flex-wrap justify-between gap-2">
              <dt>{t("settings.platformTokenGranted")}</dt>
              <dd>{usage.unlimited ? t("settings.platformUnlimited") : amount(usage.totalGranted)}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-2">
              <dt>{t("settings.platformTokenUsed")}</dt><dd>{amount(usage.totalUsed)}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-2">
              <dt>{t("settings.platformTokenAvailable")}</dt>
              <dd>{usage.unlimited ? t("settings.platformUnlimited") : amount(usage.totalAvailable)}</dd>
            </div>
            {usage.expiresAt != null && usage.expiresAt > 0 ? (
              <div className="flex flex-wrap justify-between gap-2">
                <dt>{t("settings.platformTokenExpires")}</dt>
                <dd>{new Date(usage.expiresAt * 1000).toLocaleString(locale)}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
        <p className="text-sm text-text-secondary">{t("settings.platformTokenNotWallet")}</p>
      </div>
    </div>
  );
}

export function PlatformAccountCard({
  providers,
  onConfigure,
}: {
  providers: readonly ProviderPublic[];
  onConfigure: () => void;
}) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState("");
  const [linkError, setLinkError] = useState(false);
  const eligible = providers.filter((provider) =>
    isPlatformProvider(provider) && provider.enabled && provider.hasSecret,
  );
  // One eligible key is unambiguous. With multiple keys, the user chooses the
  // row whose allowance they want; app defaults never silently choose a wallet.
  const selected = eligible.length === 1 ? eligible[0] : eligible.find((provider) => provider.id === selectedId);
  const openWebsite = async (url: string) => {
    setLinkError(false);
    try {
      await api.browserOpenExternal(url);
    } catch {
      setLinkError(true);
    }
  };

  return (
    <SettingsCard title={t("settings.platformAccountTitle")}>
      <div className="p-4 space-y-3">
        <ol className="list-decimal pl-5 space-y-1 text-sm">
          <li>{t("settings.platformOnboardingAccount")}</li>
          <li>{t("settings.platformOnboardingRecharge")}</li>
          <li>{t("settings.platformOnboardingToken")}</li>
        </ol>
        <p className="text-sm text-text-secondary">{t("settings.platformCredentialHint")}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => void openWebsite(AI_PLATFORM_ORIGIN)}>
            {t("settings.platformRegisterLogin")}
          </Button>
          <Button variant="ghost" onClick={() => void openWebsite(AI_PLATFORM_WALLET_URL)}>
            {t("settings.platformWallet")}
          </Button>
          <Button variant="primary" onClick={onConfigure}>
            {t("settings.platformConfigure")}
          </Button>
        </div>
        <p className="text-sm text-text-secondary">{t("settings.platformWebPayment")}</p>
        {linkError ? <p role="alert">{t("settings.platformLinkError")}</p> : null}
      </div>
      {eligible.length > 0 ? (
        <SettingsRow title={t("settings.platformUsageProvider")}>
          {eligible.length === 1 ? <span>{selected?.name}</span> : <SettingsMenuSelect
            label={t("settings.platformUsageProvider")}
            value={selected?.id ?? ""}
            options={[
              { id: "", label: t("settings.platformChooseProvider"), disabled: true },
              ...eligible.map((provider) => ({ id: provider.id, label: provider.name })),
            ]}
            onChange={setSelectedId}
          />}
        </SettingsRow>
      ) : null}
      {selected ? (
        <PlatformTokenUsage key={`${selected.id}:${selected.updatedAt}`} providerId={selected.id} />
      ) : (
        <p className="px-4 pb-4 text-sm text-text-secondary" role="status">
          {t(eligible.length === 0 ? "settings.platformNoToken" : "settings.platformChooseProvider")}
        </p>
      )}
    </SettingsCard>
  );
}

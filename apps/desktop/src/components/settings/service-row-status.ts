/**
 * What one row of the AI service list says about itself (D625).
 *
 * API services, plugin-declared services and vendor subscription accounts share
 * one list. These pure helpers decide a row's kind, title, badges and meta line
 * so the rules stay testable without rendering, and the row only lays them out.
 */
import { OAUTH_AUTH_KIND, type ProviderPublic } from "@pi-desktop/shared";
import type { AccountEntry } from "./useVendorAccounts";

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * `api` is a service the user configured, `plugin` one a plugin declares (only
 * its key is the user's), `account` a vendor subscription login.
 */
export type ServiceRowKind = "api" | "plugin" | "account";

export function serviceRowKind(provider: ProviderPublic): ServiceRowKind {
  if (provider.authKind === OAUTH_AUTH_KIND) return "account";
  return provider.ownerPluginId ? "plugin" : "api";
}

export type ServiceRowTitle = {
  /** The service, or the vendor an account signs in to. */
  name: string;
  /** Which account of that vendor, when the row is one. */
  account: string | null;
  /** Both together, for accessible names. */
  label: string;
};

/**
 * An account row reads "vendor · account"; a second login to the same vendor
 * adds its ordinal so two unlabeled accounts stay tellable apart. A label that
 * merely repeats the vendor name (the account editor's prefill) adds nothing.
 */
export function serviceRowTitle(
  provider: ProviderPublic,
  entry: AccountEntry | null | undefined,
  t: Translate,
): ServiceRowTitle {
  if (serviceRowKind(provider) !== "account") {
    return { name: provider.name, account: null, label: provider.name };
  }
  const name = entry?.vendor.name || provider.name;
  const accountLabel = entry?.account.accountLabel || provider.oauthAccountLabel;
  const parts = accountLabel && accountLabel !== name ? [accountLabel] : [];
  if (entry && entry.totalForVendor > 1) {
    parts.push(t("settings.vendorAccountNumber", { number: entry.ordinal }));
  }
  const account = parts.length > 0 ? parts.join(" · ") : null;
  return { name, account, label: account ? `${name} · ${account}` : name };
}

export type ServiceRowBadge = {
  key: "default" | "no-secret" | "signed-out" | "disabled" | "plugin" | "subscription";
  label: string;
  tone: "neutral" | "success" | "warning";
  title?: string;
};

/** Only the badges that say something about this row right now. */
export function serviceRowBadges(
  provider: ProviderPublic,
  context: { isDefault: boolean; entry?: AccountEntry | null },
  t: Translate,
): ServiceRowBadge[] {
  const kind = serviceRowKind(provider);
  const badges: ServiceRowBadge[] = [];
  if (context.isDefault) {
    badges.push({ key: "default", label: t("settings.default"), tone: "success" });
  }
  if (kind === "account") {
    if (!provider.hasOauth) {
      badges.push({ key: "signed-out", label: t("settings.vendorDisconnected"), tone: "warning" });
    }
  } else if (!provider.hasSecret && provider.authKind !== "none") {
    badges.push({ key: "no-secret", label: t("settings.noSecret"), tone: "warning" });
  }
  if (!provider.enabled) {
    badges.push({ key: "disabled", label: t("settings.providerDisabledBadge"), tone: "neutral" });
  }
  if (kind === "plugin") {
    badges.push({
      key: "plugin",
      label: t("settings.pluginProviderBadge"),
      tone: "neutral",
      title: t("settings.pluginProviderManaged", { plugin: provider.ownerPluginId }),
    });
  }
  if (kind === "account" && context.entry?.vendor.isSubscription) {
    badges.push({ key: "subscription", label: t("settings.vendorSubscription"), tone: "neutral" });
  }
  return badges;
}

/**
 * The quiet second line: where an API service points and how many models it
 * serves. An account has no endpoint worth showing, and a signed-out one says
 * what to do instead.
 */
export function serviceRowMeta(provider: ProviderPublic, t: Translate): string[] {
  const kind = serviceRowKind(provider);
  const models = t("settings.providerModelCount", { count: provider.models?.length ?? 0 });
  if (kind === "account") {
    return provider.hasOauth ? [models] : [t("settings.vendorDisconnectedDesc")];
  }
  const parts = [hostFromBaseUrl(provider.baseUrl), models];
  if (kind === "plugin") {
    parts.push(t("settings.pluginProviderBy", { plugin: provider.ownerPluginId }));
  }
  return parts;
}

/** The first letter or digit of a name, or "" when it has none. */
export function monogramLetter(name: string): string {
  const match = name.match(/[\p{L}\p{N}]/u);
  return match ? match[0].toLocaleUpperCase() : "";
}

/** Host part of a base URL, or an em dash when nothing is configured. */
export function hostFromBaseUrl(baseUrl?: string | null): string {
  if (!baseUrl) return "—";
  try {
    return new URL(baseUrl).host || baseUrl;
  } catch {
    return baseUrl.replace(/^https?:\/\//, "").split("/")[0] || baseUrl;
  }
}

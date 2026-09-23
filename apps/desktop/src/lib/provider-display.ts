/**
 * How a configured provider is named wherever the UI lists providers.
 *
 * An OAuth row keeps the vendor name in `provider.name` for runtime identity,
 * while the label the user gave that account lives in `oauthAccountLabel`.
 * Preferring the account label is what keeps two accounts of the same vendor
 * distinguishable, so every provider list resolves its heading through here
 * rather than reading `provider.name` directly.
 */
import type { ProviderPublic } from "@pi-desktop/shared";

/** The fields a provider list needs to name a row. */
export type ProviderDisplayFields = Pick<ProviderPublic, "name" | "oauthAccountLabel">;

/** The provider heading shown to the user: account label first, vendor name otherwise. */
export function providerDisplayName(provider: ProviderDisplayFields): string {
  return provider.oauthAccountLabel?.trim() || provider.name.trim();
}

/** Keep both the account label and the vendor name searchable. */
export function providerSearchText(provider: ProviderDisplayFields): string {
  const displayName = providerDisplayName(provider);
  const providerName = provider.name.trim();
  return displayName === providerName
    ? displayName
    : `${displayName} ${providerName}`;
}

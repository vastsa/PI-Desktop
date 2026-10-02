import { deEntries } from "./changelog-de.js";
import { enEntries } from "./changelog-en.js";
import { esEntries } from "./changelog-es.js";
import { frEntries } from "./changelog-fr.js";
import { zhCNEntries } from "./changelog-zh-CN.js";
import { zhTWEntries } from "./changelog-zh-TW.js";
import { koEntries } from "./changelog-ko.js";
import { ptBREntries } from "./changelog-pt-BR.js";
import { trEntries } from "./changelog-tr.js";
import { normalizeChangelogVersion, resolveChangelogLocale } from "./changelog-runtime.js";

export { normalizeChangelogVersion, resolveChangelogLocale } from "./changelog-runtime.js";

/**
 * Shipped-locale product changelog for PI-Desktop app releases.
 *
 * English is the source of truth (ADR 0009). The translated catalogs mirror
 * the same versions and bullet counts so in-app "what's new" can follow the
 * active UI locale without a network fetch or renderer-supplied feed URL.
 *
 * Update this file before cutting a release tag. GitHub release bodies may
 * still be auto-generated for the web; they are not the in-app source.
 * Stable product versions only — omit pre-releases.
 */

export type ChangelogLocale = "en" | "zh-CN" | "zh-TW" | "tr" | "de" | "es" | "fr" | "ko" | "pt-BR";

export type ChangelogEntry = {
  /** Semver without a leading `v`, matching apps/desktop package version. */
  version: string;
  /** Optional ISO date (YYYY-MM-DD) of the release. */
  date?: string;
  /** Short user-facing highlights; keep each line one idea. */
  highlights: string[];
};

/** Locale → newest-first product notes. */
export const CHANGELOG: Record<ChangelogLocale, readonly ChangelogEntry[]> = {
  en: enEntries,
  "zh-CN": zhCNEntries,
  "zh-TW": zhTWEntries,
  tr: trEntries,
  de: deEntries,
  es: esEntries,
  fr: frEntries,
  ko: koEntries,
  "pt-BR": ptBREntries,
};

export function getChangelogEntry(
  version: string | null | undefined,
  locale: ChangelogLocale = "en",
): ChangelogEntry | undefined {
  const key = normalizeChangelogVersion(version);
  if (!key) return undefined;
  const catalog = CHANGELOG[locale] ?? CHANGELOG.en;
  return catalog.find((entry) => entry.version === key);
}

/**
 * Format highlights as plain multi-line text for UpdateState / compact UI.
 * Returns undefined when the version has no catalog entry or empty highlights.
 */
export function formatChangelogNotes(
  version: string | null | undefined,
  localeInput?: string | null,
): string | undefined {
  const locale = resolveChangelogLocale(localeInput);
  const entry =
    getChangelogEntry(version, locale) ??
    (locale === "en" ? undefined : getChangelogEntry(version, "en"));
  if (!entry?.highlights.length) return undefined;
  return entry.highlights.map((line) => `• ${line}`).join("\n");
}

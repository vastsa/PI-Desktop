export { en, type EnglishCatalog } from "./locales/en/index.js";
export { default as enDefault } from "./locales/en/index.js";
export { zhCN } from "./locales/zh-CN/index.js";
export { default as zhCNDefault } from "./locales/zh-CN/index.js";
export { zhTW } from "./locales/zh-TW/index.js";
export { default as zhTWDefault } from "./locales/zh-TW/index.js";
export { tr } from "./locales/tr/index.js";
export { default as trDefault } from "./locales/tr/index.js";
export { es } from "./locales/es/index.js";
export { default as esDefault } from "./locales/es/index.js";
export { fr } from "./locales/fr/index.js";
export { default as frDefault } from "./locales/fr/index.js";
export { de } from "./locales/de/index.js";
export { default as deDefault } from "./locales/de/index.js";
export { ko } from "./locales/ko/index.js";
export { default as koDefault } from "./locales/ko/index.js";

import { en, type EnglishCatalog } from "./locales/en/index.js";
import { zhCN } from "./locales/zh-CN/index.js";
import { zhTW } from "./locales/zh-TW/index.js";
import { tr } from "./locales/tr/index.js";
import { es } from "./locales/es/index.js";
import { fr } from "./locales/fr/index.js";
import { de } from "./locales/de/index.js";
import { ko } from "./locales/ko/index.js";

export const defaultLocale = "en";

/**
 * Shipped UI locales. Native names are endonyms and must stay untranslated
 * in the picker (D073). English names are the stable sort/search labels.
 */
export const supportedLocales = [
  { id: "en", nativeName: "English", englishName: "English" },
  { id: "zh-CN", nativeName: "简体中文", englishName: "Chinese (Simplified)" },
  { id: "zh-TW", nativeName: "繁體中文", englishName: "Chinese (Traditional)" },
  { id: "de", nativeName: "Deutsch", englishName: "German" },
  { id: "es", nativeName: "Español", englishName: "Spanish" },
  { id: "tr", nativeName: "Türkçe", englishName: "Turkish" },
  { id: "fr", nativeName: "Français", englishName: "French" },
  { id: "ko", nativeName: "한국어", englishName: "Korean" },
] as const;

export type AppLocale = (typeof supportedLocales)[number]["id"];
export type AppLanguageSetting = "auto" | AppLocale;

export const catalogs: Record<AppLocale, EnglishCatalog> = {
  en,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  tr,
  de,
  es,
  fr,
  ko,
};

export function isAppLocale(value: string | null | undefined): value is AppLocale {
  return supportedLocales.some((locale) => locale.id === value);
}

export function isAppLanguageSetting(
  value: string | null | undefined,
): value is AppLanguageSetting {
  return value === "auto" || isAppLocale(value);
}

export function localeInfo(id: AppLocale) {
  return supportedLocales.find((locale) => locale.id === id)!;
}

/** English first, then the other shipped locales by English name. */
export function listedLocales(): (typeof supportedLocales)[number][] {
  const english = supportedLocales.find((locale) => locale.id === "en")!;
  const rest = supportedLocales
    .filter((locale) => locale.id !== "en")
    .slice()
    .sort((a, b) => a.englishName.localeCompare(b.englishName, "en"));
  return [english, ...rest];
}

export function resolveLocale(input?: string | null): AppLocale {
  const raw = (input || "").trim();
  if (!raw) return "en";
  const lower = raw.replaceAll("_", "-").toLowerCase();
  if (
    lower === "zh-tw" ||
    lower.startsWith("zh-tw-") ||
    lower === "zh-hant" ||
    lower.startsWith("zh-hant-") ||
    lower === "zh-hk" ||
    lower.startsWith("zh-hk-") ||
    lower === "zh-mo" ||
    lower.startsWith("zh-mo-")
  ) {
    return "zh-TW";
  }
  if (lower === "zh" || lower.startsWith("zh-")) return "zh-CN";
  if (lower === "tr" || lower.startsWith("tr-")) return "tr";
  if (lower === "de" || lower.startsWith("de-")) return "de";
  if (lower === "es" || lower.startsWith("es-")) return "es";
  if (lower === "fr" || lower.startsWith("fr-")) return "fr";
  if (lower === "ko" || lower.startsWith("ko-")) return "ko";
  const exact = supportedLocales.find((locale) => locale.id.toLowerCase() === lower);
  if (exact) return exact.id;
  const prefix = supportedLocales.find(
    (locale) =>
      locale.id !== "zh-CN" && lower.startsWith(`${locale.id.toLowerCase()}-`),
  );
  if (prefix) return prefix.id;
  return "en";
}

export function flattenCatalog(
  obj: Record<string, unknown>,
  prefix = "",
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      out[path] = value;
    } else if (value && typeof value === "object") {
      Object.assign(out, flattenCatalog(value as Record<string, unknown>, path));
    }
  }
  return out;
}

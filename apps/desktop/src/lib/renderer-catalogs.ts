import {
  flattenCatalog,
  type AppLocale,
  type EnglishCatalog,
} from "@pi-desktop/i18n/locale-info";
import { en } from "@pi-desktop/i18n/locales/en";

type LocaleModule = { default: EnglishCatalog };
type NonEnglishLocale = Exclude<AppLocale, "en">;

const localeLoaders: Record<NonEnglishLocale, () => Promise<LocaleModule>> = {
  "zh-CN": () => import("@pi-desktop/i18n/locales/zh-CN"),
  "zh-TW": () => import("@pi-desktop/i18n/locales/zh-TW"),
  tr: () => import("@pi-desktop/i18n/locales/tr"),
  de: () => import("@pi-desktop/i18n/locales/de"),
  es: () => import("@pi-desktop/i18n/locales/es"),
  fr: () => import("@pi-desktop/i18n/locales/fr"),
  ko: () => import("@pi-desktop/i18n/locales/ko"),
  "pt-BR": () => import("@pi-desktop/i18n/locales/pt-BR"),
};

const catalogCache = new Map<AppLocale, Promise<EnglishCatalog>>();

export function loadRendererCatalog(locale: AppLocale): Promise<EnglishCatalog> {
  const cached = catalogCache.get(locale);
  if (cached) return cached;

  const pending =
    locale === "en"
      ? Promise.resolve(en)
      : localeLoaders[locale]().then((module) => module.default);
  catalogCache.set(locale, pending);
  void pending.catch(() => catalogCache.delete(locale));
  return pending;
}

export async function loadRendererResources(
  locale: AppLocale,
): Promise<Record<string, { translation: Record<string, string> }>> {
  const localeIds = [...new Set<AppLocale>(["en", locale])];
  const entries = await Promise.all(
    localeIds.map(async (id) => {
      const catalog = await loadRendererCatalog(id);
      return [
        id,
        {
          translation: flattenCatalog(
            catalog as unknown as Record<string, unknown>,
          ),
        },
      ] as const;
    }),
  );
  return Object.fromEntries(entries);
}

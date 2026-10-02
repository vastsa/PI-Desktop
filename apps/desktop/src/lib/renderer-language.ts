import i18n from "i18next";
import {
  flattenCatalog,
  isAppLocale,
  resolveLocale,
  type AppLocale,
} from "@pi-desktop/i18n/locale-info";
import type { AppSettings } from "@pi-desktop/shared";
import { loadRendererCatalog } from "./renderer-catalogs.ts";

export type AppLanguageSetting = NonNullable<AppSettings["language"]>;

/**
 * Authoritative OS locale for "auto" detection.
 *
 * The renderer's `navigator.language` often reports `en-US` regardless of
 * the actual system language, so we prefer the main-process
 * `app.getLocale()` exposed synchronously by the preload bridge.
 */
export function resolveOsLocale(): string {
  return (
    window.piDesktop?.locale ||
    navigator.language ||
    (navigator as { userLanguage?: string }).userLanguage ||
    "en-US"
  );
}

/** Concrete locale for a stored language setting; `auto`/absent follows the OS. */
export function resolveAppLanguage(
  language: AppSettings["language"],
): AppLocale {
  if (language && language !== "auto" && isAppLocale(language)) return language;
  return resolveLocale(resolveOsLocale());
}

let languageRequest = 0;
let languageApplyQueue = Promise.resolve();

export async function applyAppLanguage(
  language: AppSettings["language"],
): Promise<void> {
  const target = resolveAppLanguage(language);
  const request = ++languageRequest;
  const apply = languageApplyQueue.then(async () => {
    if (request !== languageRequest) return;
    const catalog = await loadRendererCatalog(target);
    if (request !== languageRequest) return;
    i18n.addResourceBundle(
      target,
      "translation",
      flattenCatalog(catalog as unknown as Record<string, unknown>),
      true,
      true,
    );
    await i18n.changeLanguage(target);
    if (request === languageRequest) document.documentElement.lang = target;
  });
  languageApplyQueue = apply.catch(() => undefined);
  await apply;
}

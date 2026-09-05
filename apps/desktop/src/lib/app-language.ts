import i18n from "i18next";
import {
  isAppLocale,
  resolveLocale,
  type AppLocale,
} from "@pi-desktop/i18n";
import type { AppSettings } from "@pi-desktop/shared";
import { useAppStore } from "../stores/app-store";

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

export function applyAppLanguage(language: AppSettings["language"]) {
  const target = resolveAppLanguage(language);
  document.documentElement.lang = target;
  if (i18n.language !== target) void i18n.changeLanguage(target);
}

/** Keep i18n in step with the persisted settings.language for the app lifetime. */
export function initLanguageSync() {
  applyAppLanguage(useAppStore.getState().settings?.language);
  useAppStore.subscribe((state, prev) => {
    if (state.settings?.language !== prev.settings?.language) {
      applyAppLanguage(state.settings?.language);
    }
  });
}

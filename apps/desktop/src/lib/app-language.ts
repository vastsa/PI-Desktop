import type { AppSettings } from "@pi-desktop/shared";
import {
  applyAppLanguage,
  resolveAppLanguage,
  resolveOsLocale,
  type AppLanguageSetting,
} from "./renderer-language.ts";
import { useAppStore } from "../stores/app-store";

export { applyAppLanguage, resolveAppLanguage, resolveOsLocale };
export type { AppLanguageSetting };

function applyStoreLanguage(language: AppSettings["language"]): Promise<void> {
  return applyAppLanguage(language).catch((error: unknown) => {
    console.error("Failed to load the selected UI language", error);
  });
}

/** Keep i18n in step with the persisted settings.language for the app lifetime. */
export function initLanguageSync(): Promise<void> {
  const initialLanguage = applyStoreLanguage(
    useAppStore.getState().settings?.language,
  );
  useAppStore.subscribe((state, prev) => {
    if (state.settings?.language !== prev.settings?.language) {
      void applyStoreLanguage(state.settings?.language);
    }
  });
  return initialLanguage;
}

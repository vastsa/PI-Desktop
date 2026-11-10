import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  normalizeProviderRetryFixedDelayMs,
  normalizeProviderRetryInitialDelayMs,
  normalizeProviderRetryMaxAttempts,
  PROVIDER_RETRY_MAX_RETRIES,
  type AppSettings,
} from "@pi-desktop/shared";
import { Input, SettingsToggle } from "../../components/ui";
import { useAppStore } from "../../stores/app-store";
import { SettingsRow } from "./primitives";

/** Empty overrides preserve the released schedules; clearing writes a reset. */
export function ProviderRetrySettingsRows({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();

  return (
    <>
      <SettingsRow
        title={t("settings.infiniteProviderRetry")}
        description={t("settings.infiniteProviderRetryDesc")}
      >
        <SettingsToggle
          checked={settings.infiniteProviderRetry === true}
          label={t("settings.infiniteProviderRetry")}
          onChange={() => void saveSettings({ infiniteProviderRetry: settings.infiniteProviderRetry !== true })}
        />
      </SettingsRow>
      <RetryLimitRow
        label={t("settings.providerRetryMaxAttempts")}
        description={t("settings.providerRetryMaxAttemptsDesc")}
        stored={normalizeProviderRetryMaxAttempts(settings.providerRetryMaxAttempts)}
        placeholder={String(PROVIDER_RETRY_MAX_RETRIES)}
        saveSettings={saveSettings}
        save={(value) => ({ providerRetryMaxAttempts: value })}
      />
      <RetryLimitRow
        label={t("settings.providerRetryInitialDelayMs")}
        description={t("settings.providerRetryInitialDelayMsDesc")}
        stored={normalizeProviderRetryInitialDelayMs(settings.providerRetryInitialDelayMs)}
        saveSettings={saveSettings}
        save={(value) => ({ providerRetryInitialDelayMs: value })}
      />
      <RetryLimitRow
        label={t("settings.providerRetryFixedDelayMs")}
        description={t("settings.providerRetryFixedDelayMsDesc")}
        stored={normalizeProviderRetryFixedDelayMs(settings.providerRetryFixedDelayMs)}
        saveSettings={saveSettings}
        save={(value) => ({ providerRetryFixedDelayMs: value })}
      />
    </>
  );
}

/** Commit on blur/Enter, not per keystroke. A first wait has no single default. */
function RetryLimitRow({
  label,
  description,
  stored,
  placeholder,
  saveSettings,
  save,
}: {
  label: string;
  description: string;
  stored: number | undefined;
  placeholder?: string;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
  save: (value: number | null) => Partial<AppSettings>;
}) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const draftValue = stored === undefined ? "" : String(stored);
  const [draft, setDraft] = useState(draftValue);

  // Follow persisted replacements from another surface (config sync, recovery).
  useEffect(() => {
    setDraft(draftValue);
  }, [draftValue]);

  const commit = async (badInput: boolean) => {
    const text = draft.trim();
    const parsed = text === "" ? null : Number(text);
    if (badInput || (parsed !== null && (!Number.isSafeInteger(parsed) || parsed < 0))) {
      setDraft(draftValue);
      showToast(t("settings.providerRetryInvalidValue"), { variant: "error" });
      return;
    }
    setDraft(parsed === null ? "" : String(parsed));
    if (parsed === null ? stored === undefined : parsed === stored) return;
    try {
      await saveSettings(save(parsed));
    } catch {
      setDraft(draftValue);
      showToast(t("settings.providerRetrySaveError"), { variant: "error" });
    }
  };

  return (
    <SettingsRow title={label} description={description}>
      <div className="settings-number-control">
        <Input
          type="number"
          min={0}
          step={1}
          inputMode="numeric"
          value={draft}
          placeholder={placeholder}
          aria-label={label}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={(event) => void commit(event.currentTarget.validity.badInput)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
      </div>
    </SettingsRow>
  );
}

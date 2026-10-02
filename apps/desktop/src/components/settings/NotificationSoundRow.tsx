import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings, NotificationSoundSettings } from "@pi-desktop/shared";
import { Button } from "../ui";
import {
  MAX_CUSTOM_NOTIFICATION_SOUND_BYTES,
  normalizeNotificationSoundSettings,
  playNotificationChime,
  setNotificationSoundSettings,
} from "../../lib/notification-sound";
import { SettingsMenuSelect } from "./SettingsMenuSelect";
import { SettingsRow } from "../../features/settings/primitives";

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const result = reader.result;
      if (typeof result === "string") resolve(result);
      else reject(new Error("audio file could not be read"));
    });
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("audio file could not be read")),
    );
    reader.readAsDataURL(file);
  });
}

function isAudioFile(file: File): boolean {
  return (
    file.type.startsWith("audio/") ||
    /\.(aac|flac|m4a|mp3|ogg|wav|webm)$/i.test(file.name)
  );
}

export function NotificationSoundRow({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = normalizeNotificationSoundSettings(settings.notificationSound);

  const persist = async (next: NotificationSoundSettings) => {
    setSaving(true);
    setError(null);
    try {
      setNotificationSoundSettings(next);
      await saveSettings({ notificationSound: next });
    } catch {
      setNotificationSoundSettings(settings.notificationSound);
      setError(t("settings.notificationSoundSaveError"));
    } finally {
      setSaving(false);
    }
  };

  const chooseFile = async (file: File | undefined) => {
    if (!file) return;
    if (!isAudioFile(file)) {
      setError(t("settings.notificationSoundInvalidFile"));
      return;
    }
    if (file.size > MAX_CUSTOM_NOTIFICATION_SOUND_BYTES) {
      setError(
        t("settings.notificationSoundFileTooLarge", {
          size: Math.round(MAX_CUSTOM_NOTIFICATION_SOUND_BYTES / 1024 / 1024),
        }),
      );
      return;
    }
    try {
      const customDataUrl = await readFileAsDataUrl(file);
      await persist({
        ...current,
        mode: "custom",
        customDataUrl,
        customName: file.name,
      });
    } catch {
      setError(t("settings.notificationSoundReadError"));
    }
  };

  const openFilePicker = () => fileInputRef.current?.click();
  const customName = current.customName || t("settings.notificationSoundNoFile");

  return (
    <SettingsRow
      title={t("settings.notificationSound")}
      description={t("settings.notificationSoundDesc")}
    >
      <div className="settings-notification-sound-control" aria-busy={saving}>
        <SettingsMenuSelect
          label={t("settings.notificationSound")}
          value={current.mode}
          busy={saving}
          onChange={(mode) => {
            if (mode === "custom" && !current.customDataUrl) {
              openFilePicker();
              return;
            }
            void persist({
              ...current,
              mode: mode as NotificationSoundSettings["mode"],
            });
          }}
          options={[
            { id: "system", label: t("settings.notificationSoundSystem") },
            { id: "custom", label: t("settings.notificationSoundCustom") },
          ]}
        />
        {current.mode === "custom" ? (
          <>
            <span className="settings-notification-sound-name" title={customName}>
              {customName}
            </span>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={saving}
              onClick={openFilePicker}
            >
              {t("settings.notificationSoundChoose")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={saving || !current.customDataUrl}
              onClick={() => {
                setNotificationSoundSettings(current);
                playNotificationChime();
              }}
            >
              {t("settings.notificationSoundPreview")}
            </Button>
          </>
        ) : null}
        <input
          ref={fileInputRef}
          className="settings-notification-sound-file"
          type="file"
          accept="audio/*"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            void chooseFile(file);
          }}
        />
        {error ? (
          <span className="settings-command-shell-state error" role="status">
            {error}
          </span>
        ) : null}
      </div>
    </SettingsRow>
  );
}

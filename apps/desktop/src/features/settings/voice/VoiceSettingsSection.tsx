/**
 * Voice settings panel — uses project-standard SettingsRow, SettingsCard,
 * SettingsToggle, Select (field-select), and Button components.
 */

import { useCallback, useEffect, useState } from "react";
import type { TFunction } from "i18next";
import type { AppSettings } from "@pi-desktop/shared";
import { Button, Badge, CheckboxGroup, SettingsToggle } from "../../../components/ui";
import { SettingsMenuSelect } from "../../../components/settings/SettingsMenuSelect";
import { SettingsRow, SettingsCard } from "../primitives";
import { voiceIpc } from "../../voice/voice-ipc";

interface AudioInputDevice {
  deviceId: string;
  label: string;
  isDefault: boolean;
}

interface ModelInfo {
  id: string;
  name: string;
  description: string;
  sizeBytes: number;
  recommended: boolean;
}

interface ModelState {
  info: ModelInfo;
  status: string;
  downloadProgress?: number;
  error?: string;
}

export function VoiceSettingsSection({
  t,
  settings,
  saveSettings,
}: {
  t: TFunction;
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const voice = settings.voice ?? {
    enabled: false,
    deviceId: null,
    languages: ["zh", "en"],
    chineseVariant: "simplified" as const,
    modelId: "",
  };

  const [devices, setDevices] = useState<AudioInputDevice[]>([]);
  const [models, setModels] = useState<ModelState[]>([]);
  const [permission, setPermission] = useState<string>("undetermined");

  useEffect(() => {
    voiceIpc
      .getDevices()
      .then((d) => setDevices(Array.isArray(d) ? d as AudioInputDevice[] : []))
      .catch(() => {});
    voiceIpc
      .getModels()
      .then((m) => setModels(Array.isArray(m) ? m as ModelState[] : []))
      .catch(() => {});
    voiceIpc
      .checkPermission()
      .then((p) => setPermission(typeof p === "string" ? p : "undetermined"))
      .catch(() => {});
  }, []);

  useEffect(() => {
    return voiceIpc.onModelProgress(({ modelId, progress }) => {
      setModels((prev) =>
        prev.map((m) =>
          m.info.id === modelId
            ? {
                ...m,
                status: progress >= 1 ? "downloaded" : "downloading",
                downloadProgress: progress,
              }
            : m,
        ),
      );
    });
  }, []);

  const save = useCallback(
    (patch: Record<string, unknown>) => {
      const next = { ...voice, ...patch };
      void saveSettings({ voice: next as any });
      void voiceIpc.updateSettings(next);
    },
    [voice, saveSettings],
  );

  const formatSize = (bytes: number) => {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    return `${(bytes / 1e6).toFixed(0)} MB`;
  };

  return (
    <div className="settings-stack voice-settings">
      {/* ---- Enable ---- */}
      <SettingsCard title={t("settings.voice")}>
        <SettingsRow title={t("settings.voiceEnable")}>
          <SettingsToggle
            checked={voice.enabled}
            label={t("settings.voiceEnable")}
            onChange={() => save({ enabled: !voice.enabled })}
          />
        </SettingsRow>
      </SettingsCard>

      {/* ---- Permission warning ---- */}
      {permission === "denied" && (
        <SettingsCard title={t("settings.voiceMicDenied")}>
          <SettingsRow title={t("settings.voiceMicDeniedDesc")}>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => voiceIpc.requestPermission()}
            >
              {t("settings.voiceOpenSystemSettings")}
            </Button>
          </SettingsRow>
        </SettingsCard>
      )}

      {/* ---- Input ---- */}
      <SettingsCard title={t("settings.voiceMicrophone")}>
        <SettingsRow title={t("settings.voiceMicrophone")}>
          <SettingsMenuSelect
            value={voice.deviceId ?? ""}
            label={t("settings.voiceMicrophone")}
            disabled={!voice.enabled}
            options={[
              { id: "", label: t("settings.voiceSystemDefault") },
              ...devices.map((d) => ({ id: d.deviceId, label: d.label })),
            ]}
            onChange={(id) => save({ deviceId: id || null })}
          />
        </SettingsRow>

        <SettingsRow title={t("settings.voiceLanguages")}>
          <CheckboxGroup
            values={voice.languages}
            onChange={(langs) => save({ languages: langs })}
            options={[
              { value: "zh", label: t("settings.voiceLanguageChinese") },
              { value: "en", label: t("settings.voiceLanguageEnglish") },
              { value: "ja", label: t("settings.voiceLanguageJapanese") },
              { value: "ko", label: t("settings.voiceLanguageKorean") },
            ]}
            label={t("settings.voiceLanguages")}
            disabled={!voice.enabled}
            minSelected={1}
          />
        </SettingsRow>

        <SettingsRow title={t("settings.voiceChineseVariant")}>
          <SettingsMenuSelect
            value={voice.chineseVariant}
            label={t("settings.voiceChineseVariant")}
            disabled={!voice.enabled}
            options={[
              { id: "simplified", label: t("settings.voiceSimplified") },
              { id: "traditional-taiwan", label: t("settings.voiceTraditionalTaiwan") },
              { id: "traditional-hong-kong", label: t("settings.voiceTraditionalHK") },
            ]}
            onChange={(id) => save({ chineseVariant: id })}
          />
        </SettingsRow>
      </SettingsCard>

      {/* ---- Model ---- */}
      <SettingsCard title={t("settings.voiceModel")}>
        <SettingsRow title={t("settings.voiceModel")}>
          <SettingsMenuSelect
            value={voice.modelId}
            label={t("settings.voiceModel")}
            disabled={!voice.enabled}
            options={[
              { id: "", label: t("settings.voiceNoModelSelected") },
              ...models.map((m) => ({
                id: m.info.id,
                label: `${m.info.name}${m.info.recommended ? " ★" : ""}${m.status === "downloaded" || m.status === "loaded" ? " ✓" : ""}`,
              })),
            ]}
            onChange={(id) => save({ modelId: id })}
          />
        </SettingsRow>

        {models.map((m) => (
          <SettingsRow
            key={m.info.id}
            title={m.info.name}
            detail={
              <>
                {formatSize(m.info.sizeBytes)}
                {m.info.recommended ? (
                  <Badge tone="success" style={{ marginLeft: 6 }}>
                    {t("settings.voiceRecommended")}
                  </Badge>
                ) : null}
              </>
            }
          >
            {m.status === "downloaded" || m.status === "loaded" ? (
              <div className="voice-model-actions">
                <Badge tone="success">
                  {t("settings.voiceModelDownloaded")}
                </Badge>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void voiceIpc.deleteModel(m.info.id);
                    setModels((prev) =>
                      prev.map((x) =>
                        x.info.id === m.info.id
                          ? { ...x, status: "not-downloaded" }
                          : x,
                      ),
                    );
                  }}
                >
                  {t("settings.voiceModelDelete")}
                </Button>
              </div>
            ) : m.status === "downloading" ? (
              <div className="voice-model-actions">
                <div className="voice-progress-track">
                  <div
                    className="voice-progress-fill"
                    style={{
                      width: `${(m.downloadProgress ?? 0) * 100}%`,
                    }}
                  />
                </div>
                <span className="voice-progress-label">
                  {Math.round((m.downloadProgress ?? 0) * 100)}%
                </span>
              </div>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  void voiceIpc.downloadModel(m.info.id);
                  setModels((prev) =>
                    prev.map((x) =>
                      x.info.id === m.info.id
                        ? { ...x, status: "downloading", downloadProgress: 0 }
                        : x,
                    ),
                  );
                }}
              >
                {t("settings.voiceModelDownload")}
              </Button>
            )}
          </SettingsRow>
        ))}
      </SettingsCard>
    </div>
  );
}

/**
 * Voice settings panel — matches the project's SettingsRow/SettingsCard pattern.
 */

import { useCallback, useEffect, useState } from "react";
import type { TFunction } from "i18next";
import type { AppSettings, VoiceInputSettings } from "@pi-desktop/shared";
import { cx } from "../../../components/ui";
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
    voiceIpc.getDevices().then((d) => setDevices(Array.isArray(d) ? d as AudioInputDevice[] : [])).catch(() => {});
    voiceIpc.getModels().then((m) => setModels(Array.isArray(m) ? m as ModelState[] : [])).catch(() => {});
    voiceIpc.checkPermission().then((p) => setPermission(typeof p === "string" ? p : "undetermined")).catch(() => {});
  }, []);

  useEffect(() => {
    return voiceIpc.onModelProgress(({ modelId, progress }) => {
      setModels((prev) =>
        prev.map((m) =>
          m.info.id === modelId
            ? { ...m, status: progress >= 1 ? "downloaded" : "downloading", downloadProgress: progress }
            : m,
        ),
      );
    });
  }, []);

  const save = useCallback(
    (patch: Partial<VoiceInputSettings>) => {
      const next = { ...voice, ...patch };
      void saveSettings({ voice: next });
      void voiceIpc.updateSettings(next);
    },
    [voice, saveSettings],
  );

  const formatSize = (bytes: number) => {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    return `${(bytes / 1e6).toFixed(0)} MB`;
  };

  return (
    <div className="settings-stack">
      {/* Enable toggle */}
      <SettingsCard title={t("settings.voice")}>
        <SettingsRow title={t("settings.voiceEnable")}>
          <button
            type="button"
            className={cx("settings-toggle", voice.enabled && "on")}
            role="switch"
            aria-checked={voice.enabled}
            aria-label={t("settings.voiceEnable")}
            onClick={() => save({ enabled: !voice.enabled })}
          >
            <span className="settings-toggle-thumb" />
          </button>
        </SettingsRow>
      </SettingsCard>

      {/* Permission warning */}
      {permission === "denied" && (
        <SettingsCard title={t("settings.voiceMicDenied")}>
          <SettingsRow title={t("settings.voiceMicDeniedDesc")}>
            <button
              type="button"
              className="settings-btn-secondary"
              onClick={() => voiceIpc.requestPermission()}
            >
              {t("settings.voiceOpenSystemSettings")}
            </button>
          </SettingsRow>
        </SettingsCard>
      )}

      {/* Microphone + Language + Chinese variant */}
      <SettingsCard title={t("settings.voiceMicrophone")}>
        <SettingsRow title={t("settings.voiceMicrophone")}>
          <select
            className="settings-select"
            value={voice.deviceId ?? ""}
            disabled={!voice.enabled}
            onChange={(e) => save({ deviceId: e.target.value || null })}
          >
            <option value="">{t("settings.voiceSystemDefault")}</option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
            ))}
          </select>
        </SettingsRow>

        <SettingsRow title={t("settings.voiceLanguages")}>
          <div className="voice-lang-checks">
            {(["zh", "en", "ja", "ko"] as const).map((code) => (
              <label key={code} className="voice-lang-label">
                <input
                  type="checkbox"
                  checked={voice.languages.includes(code)}
                  disabled={!voice.enabled}
                  onChange={(e) => {
                    const langs = e.target.checked
                      ? [...voice.languages, code]
                      : voice.languages.filter((l: string) => l !== code);
                    save({ languages: langs.length > 0 ? langs : [code] });
                  }}
                />
                {code === "zh" ? "中文" : code === "en" ? "English" : code === "ja" ? "日本語" : "한국어"}
              </label>
            ))}
          </div>
        </SettingsRow>

        <SettingsRow title={t("settings.voiceChineseVariant")}>
          <select
            className="settings-select"
            value={voice.chineseVariant}
            disabled={!voice.enabled}
            onChange={(e) => {
              const chineseVariant = e.target.value;
              if (chineseVariant === "simplified" || chineseVariant === "traditional-taiwan" || chineseVariant === "traditional-hong-kong") {
                save({ chineseVariant });
              }
            }}
          >
            <option value="simplified">{t("settings.voiceSimplified")}</option>
            <option value="traditional-taiwan">{t("settings.voiceTraditionalTaiwan")}</option>
            <option value="traditional-hong-kong">{t("settings.voiceTraditionalHK")}</option>
          </select>
        </SettingsRow>
      </SettingsCard>

      {/* Model selection + management */}
      <SettingsCard title={t("settings.voiceModel")}>
        <SettingsRow title={t("settings.voiceModel")}>
          <select
            className="settings-select"
            value={voice.modelId}
            disabled={!voice.enabled}
            onChange={(e) => save({ modelId: e.target.value })}
          >
            <option value="">{t("settings.voiceNoModelSelected")}</option>
            {models.map((m) => (
              <option key={m.info.id} value={m.info.id}>
                {m.info.name}{m.info.recommended ? " ★" : ""}
                {m.status === "downloaded" || m.status === "loaded" ? " ✓" : ""}
              </option>
            ))}
          </select>
        </SettingsRow>

        {/* Model list */}
        {models.map((m) => (
          <SettingsRow key={m.info.id} title={m.info.name} description={`${formatSize(m.info.sizeBytes)}${m.info.recommended ? " · Recommended" : ""}`}>
            {m.status === "downloaded" || m.status === "loaded" ? (
              <div className="voice-model-actions">
                <span className="voice-model-badge voice-model-ok">{t("settings.voiceModelDownloaded")}</span>
                <button
                  type="button"
                  className="voice-model-btn voice-model-btn-danger"
                  onClick={() => {
                    void voiceIpc.deleteModel(m.info.id);
                    setModels((prev) => prev.map((x) => x.info.id === m.info.id ? { ...x, status: "not-downloaded" } : x));
                  }}
                >
                  {t("settings.voiceModelDelete")}
                </button>
              </div>
            ) : m.status === "downloading" ? (
              <div className="voice-model-actions">
                <div className="voice-progress-track">
                  <div className="voice-progress-fill" style={{ width: `${(m.downloadProgress ?? 0) * 100}%` }} />
                </div>
                <span className="voice-model-badge">{Math.round((m.downloadProgress ?? 0) * 100)}%</span>
              </div>
            ) : (
              <button
                type="button"
                className="voice-model-btn voice-model-btn-primary"
                onClick={() => {
                  void voiceIpc.downloadModel(m.info.id);
                  setModels((prev) => prev.map((x) => x.info.id === m.info.id ? { ...x, status: "downloading", downloadProgress: 0 } : x));
                }}
              >
                {t("settings.voiceModelDownload")}
              </button>
            )}
          </SettingsRow>
        ))}
      </SettingsCard>
    </div>
  );
}

/**
 * Voice settings panel in the Settings page.
 */

import { useCallback, useEffect, useState } from "react";
import type { TFunction } from "i18next";
import { useAppStore } from "../../../stores/app-store";
import { voiceIpc } from "../../voice/voice-ipc";

interface AudioInputDevice {
  deviceId: string;
  label: string;
  isDefault: boolean;
}

interface ModelState {
  info: {
    id: string;
    name: string;
    description: string;
    sizeBytes: number;
    recommended: boolean;
  };
  status: string;
  downloadProgress?: number;
  error?: string;
}

export function VoiceSettingsSection({ t }: { t: TFunction }) {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);

  const voiceSettings = settings?.voice ?? {
    enabled: false,
    deviceId: null,
    languages: ["zh", "en"],
    chineseVariant: "simplified" as const,
    modelId: "",
  };

  const [devices, setDevices] = useState<AudioInputDevice[]>([]);
  const [models, setModels] = useState<ModelState[]>([]);
  const [permission, setPermission] = useState<string>("undetermined");

  // Load devices and models on mount
  useEffect(() => {
    voiceIpc.getDevices().then(setDevices).catch(() => {});
    voiceIpc.getModels().then(setModels).catch(() => {});
    voiceIpc.checkPermission().then(setPermission).catch(() => {});
  }, []);

  // Listen for model progress
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

  const update = useCallback(
    (patch: Record<string, unknown>) => {
      const next = { ...voiceSettings, ...patch };
      void updateSettings({ voice: next as any });
      void voiceIpc.updateSettings(next);
    },
    [voiceSettings, updateSettings],
  );

  const formatSize = (bytes: number) => {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    return `${(bytes / 1e6).toFixed(0)} MB`;
  };

  return (
    <div className="settings-section">
      {/* Enable toggle */}
      <label className="settings-row settings-row-toggle">
        <span>{t("settings.voiceEnable")}</span>
        <input
          type="checkbox"
          checked={voiceSettings.enabled}
          onChange={(e) => update({ enabled: e.target.checked })}
        />
      </label>

      {/* Microphone permission warning */}
      {permission === "denied" && (
        <div className="settings-row settings-warning">
          <span>{t("settings.voiceMicDenied")}</span>
          <p className="text-xs opacity-70">{t("settings.voiceMicDeniedDesc")}</p>
        </div>
      )}

      {/* Microphone selection */}
      <div className="settings-row">
        <label>{t("settings.voiceMicrophone")}</label>
        <select
          value={voiceSettings.deviceId ?? ""}
          onChange={(e) => update({ deviceId: e.target.value || null })}
          disabled={!voiceSettings.enabled}
        >
          <option value="">{t("settings.voiceSystemDefault")}</option>
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label}
            </option>
          ))}
        </select>
      </div>

      {/* Languages */}
      <div className="settings-row">
        <label>{t("settings.voiceLanguages")}</label>
        <div className="flex gap-3">
          {[
            { code: "zh", label: "Chinese" },
            { code: "en", label: "English" },
            { code: "ja", label: "Japanese" },
            { code: "ko", label: "Korean" },
          ].map(({ code, label }) => (
            <label key={code} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={voiceSettings.languages.includes(code)}
                disabled={!voiceSettings.enabled}
                onChange={(e) => {
                  const langs = e.target.checked
                    ? [...voiceSettings.languages, code]
                    : voiceSettings.languages.filter((l: string) => l !== code);
                  update({ languages: langs.length > 0 ? langs : [code] });
                }}
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      {/* Chinese variant */}
      <div className="settings-row">
        <label>{t("settings.voiceChineseVariant")}</label>
        <select
          value={voiceSettings.chineseVariant}
          onChange={(e) => update({ chineseVariant: e.target.value })}
          disabled={!voiceSettings.enabled}
        >
          <option value="simplified">{t("settings.voiceSimplified")}</option>
          <option value="traditional-taiwan">{t("settings.voiceTraditionalTaiwan")}</option>
          <option value="traditional-hong-kong">{t("settings.voiceTraditionalHK")}</option>
        </select>
      </div>

      {/* Model selection */}
      <div className="settings-row">
        <label>{t("settings.voiceModel")}</label>
        <select
          value={voiceSettings.modelId}
          onChange={(e) => update({ modelId: e.target.value })}
          disabled={!voiceSettings.enabled}
        >
          <option value="">{t("settings.voiceNoModelSelected")}</option>
          {models.map((m) => (
            <option key={m.info.id} value={m.info.id}>
              {m.info.name}
              {m.info.recommended ? " ★" : ""}
              {m.status === "downloaded" || m.status === "loaded" ? " ✓" : ""}
            </option>
          ))}
        </select>
      </div>

      {/* Local models management */}
      <div className="settings-row">
        <label>{t("settings.voiceLocalModels")}</label>
      </div>
      <div className="settings-model-list">
        {models.map((m) => (
          <div key={m.info.id} className="settings-model-item">
            <div className="settings-model-info">
              <span className="settings-model-name">
                {m.info.name}
                {m.info.recommended && <span className="text-xs opacity-60"> ★</span>}
              </span>
              <span className="text-xs opacity-60">
                {formatSize(m.info.sizeBytes)}
              </span>
            </div>
            <div className="settings-model-status">
              {m.status === "downloaded" || m.status === "loaded" ? (
                <>
                  <span className="text-xs text-green-500">{t("settings.voiceModelDownloaded")}</span>
                  <button
                    type="button"
                    className="text-xs text-red-400 hover:underline"
                    onClick={() => {
                      void voiceIpc.deleteModel(m.info.id);
                      setModels((prev) =>
                        prev.map((x) =>
                          x.info.id === m.info.id ? { ...x, status: "not-downloaded" } : x,
                        ),
                      );
                    }}
                  >
                    {t("settings.voiceModelDelete")}
                  </button>
                </>
              ) : m.status === "downloading" ? (
                <div className="flex items-center gap-2">
                  <div className="voice-volume-bar" style={{ width: 100 }}>
                    <div
                      className="voice-volume-fill"
                      style={{ width: `${(m.downloadProgress ?? 0) * 100}%` }}
                    />
                  </div>
                  <span className="text-xs opacity-60">
                    {Math.round((m.downloadProgress ?? 0) * 100)}%
                  </span>
                </div>
              ) : (
                <button
                  type="button"
                  className="text-xs text-blue-400 hover:underline"
                  onClick={() => {
                    void voiceIpc.downloadModel(m.info.id);
                    setModels((prev) =>
                      prev.map((x) =>
                        x.info.id === m.info.id ? { ...x, status: "downloading", downloadProgress: 0 } : x,
                      ),
                    );
                  }}
                >
                  {t("settings.voiceModelDownload")}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

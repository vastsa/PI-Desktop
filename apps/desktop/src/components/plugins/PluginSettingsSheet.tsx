import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  KEYBOARD_SHORTCUTS,
  isAllowedKeybinding,
  isReservedKeybinding,
  keybindingDisplayParts,
  keybindingFromEvent,
  keybindingsConflict,
  normalizeKeybinding,
  resolveKeybinding,
  type PluginSettingDefinition,
  type PluginSummary,
  type ShortcutPlatform,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button, cx, Input, Select, Textarea } from "../ui";
import { IconKeyboard, IconSettings, IconX } from "../icons";

type Props = {
  plugin: PluginSummary;
  platform: ShortcutPlatform;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
};

function initialValue(setting: PluginSettingDefinition): unknown {
  if (setting.value !== undefined) return setting.value;
  if (setting.default !== undefined) return setting.default;
  switch (setting.type) {
    case "boolean":
      return false;
    case "number":
      return 0;
    case "json":
      return {};
    case "select":
      return setting.enum?.[0]?.value ?? "";
    default:
      return "";
  }
}

function shortcutLabel(value: unknown, platform: ShortcutPlatform): string {
  const normalized = normalizeKeybinding(value);
  if (!normalized) return "—";
  return keybindingDisplayParts(normalized, platform).join(platform === "darwin" ? "" : "+");
}

function serializeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

export function PluginSettingsSheet({ plugin, platform, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const appKeybindings = useAppStore((state) => state.settings?.keybindings);
  const settings = plugin.settings ?? [];
  const [draft, setDraft] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(settings.map((setting) => [setting.key, initialValue(setting)])),
  );
  const [recordingKey, setRecordingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(Object.fromEntries(settings.map((setting) => [setting.key, initialValue(setting)])));
    setRecordingKey(null);
    setError(null);
  }, [plugin.id, plugin.settings]);

  const shortcutConflict = useMemo(() => {
    const shortcuts = settings.filter((setting) => setting.type === "shortcut");
    for (const left of shortcuts) {
      const leftValue = String(draft[left.key] ?? "");
      if (!leftValue) continue;
      if (isReservedKeybinding(leftValue, platform)) return left.key;
      const appConflict = KEYBOARD_SHORTCUTS.some((shortcut) =>
        keybindingsConflict(resolveKeybinding(shortcut, appKeybindings, platform), leftValue),
      );
      if (appConflict) return left.key;
      for (const right of shortcuts) {
        if (left.key === right.key) continue;
        if (keybindingsConflict(leftValue, String(draft[right.key] ?? ""))) return left.key;
      }
    }
    return null;
  }, [appKeybindings, draft, platform, settings]);

  const setValue = (key: string, value: unknown) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setError(null);
  };

  const resetValue = (setting: PluginSettingDefinition) => {
    setValue(setting.key, initialValue({ ...setting, value: undefined }));
  };

  const save = async () => {
    if (shortcutConflict) {
      setError(t("plugins.settingsShortcutConflict"));
      return;
    }
    const payload = { ...draft };
    for (const setting of settings) {
      if (setting.type !== "json") continue;
      try {
        payload[setting.key] = JSON.parse(String(payload[setting.key] ?? "{}"));
      } catch {
        setError(t("plugins.settingsInvalidJson", { name: setting.title }));
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      await api.setPluginSettings(plugin.id, payload);
      await onSaved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const recordShortcut = (event: ReactKeyboardEvent<HTMLButtonElement>, setting: PluginSettingDefinition) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setRecordingKey(null);
      return;
    }
    event.preventDefault();
    const binding = keybindingFromEvent(event, platform);
    if (!binding || !isAllowedKeybinding(binding) || isReservedKeybinding(binding, platform)) {
      setError(t("plugins.settingsShortcutInvalid"));
      return;
    }
    setValue(setting.key, binding);
    setRecordingKey(null);
  };

  return (
    <div className="plugins-modal-backdrop" role="presentation">
      <div
        className="plugins-modal plugins-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("plugins.settingsTitle", { name: plugin.name })}
      >
        <header className="plugins-modal-head">
          <span className="plugins-modal-icon" aria-hidden>
            <IconSettings size={17} />
          </span>
          <div className="plugins-settings-heading">
            <h2 className="plugins-modal-title">{t("plugins.settingsTitle", { name: plugin.name })}</h2>
            <p className="plugins-modal-subtitle">{t("plugins.settingsHint")}</p>
          </div>
          <button
            type="button"
            className="plugins-icon-btn"
            aria-label={t("plugins.closeSettings")}
            title={t("plugins.closeSettings")}
            onClick={onClose}
          >
            <IconX size={15} />
          </button>
        </header>

        <div className="plugins-settings-body">
          {settings.map((setting) => {
            const value = draft[setting.key];
            const isShortcut = setting.type === "shortcut";
            const shortcutError = isShortcut && shortcutConflict === setting.key;
            return (
              <div key={setting.key} className="plugins-setting-row">
                <div className="plugins-setting-copy">
                  <div className="plugins-setting-title">
                    {isShortcut ? <IconKeyboard size={14} aria-hidden="true" /> : null}
                    <span>{setting.title}</span>
                  </div>
                  {setting.description ? (
                    <p className="plugins-setting-description">{setting.description}</p>
                  ) : null}
                  {isShortcut ? (
                    <span className="plugins-setting-scope">{t("plugins.settingsPluginScope")}</span>
                  ) : null}
                </div>
                <div className="plugins-setting-control">
                  {setting.type === "string" ? (
                    <Input value={String(value ?? "")} onChange={(event) => setValue(setting.key, event.target.value)} />
                  ) : setting.type === "number" ? (
                    <Input
                      type="number"
                      value={typeof value === "number" ? value : ""}
                      onChange={(event) => setValue(setting.key, event.target.value === "" ? 0 : Number(event.target.value))}
                    />
                  ) : setting.type === "boolean" ? (
                    <button
                      type="button"
                      className={cx("settings-toggle", value === true && "on")}
                      role="switch"
                      aria-checked={value === true}
                      aria-label={setting.title}
                      onClick={() => setValue(setting.key, value !== true)}
                    >
                      <span className="settings-toggle-thumb" />
                    </button>
                  ) : setting.type === "select" ? (
                    <Select
                      value={String((setting.enum ?? []).findIndex((option) => Object.is(option.value, value)))}
                      onChange={(event) => {
                        const option = setting.enum?.[Number(event.target.value)];
                        if (option) setValue(setting.key, option.value);
                      }}
                    >
                      {(setting.enum ?? []).map((option, index) => (
                        <option key={`${setting.key}-${index}`} value={index}>{option.label}</option>
                      ))}
                    </Select>
                  ) : setting.type === "json" ? (
                    <Textarea
                      className="plugins-setting-json"
                      value={typeof value === "string" ? value : serializeJson(value)}
                      onChange={(event) => setValue(setting.key, event.target.value)}
                    />
                  ) : (
                    <button
                      type="button"
                      className={cx("plugins-shortcut-recorder", recordingKey === setting.key && "recording", shortcutError && "error")}
                      onClick={() => setRecordingKey(recordingKey === setting.key ? null : setting.key)}
                      onKeyDown={(event) => recordingKey === setting.key && recordShortcut(event, setting)}
                      aria-label={t("plugins.settingsShortcutChange", { name: setting.title })}
                    >
                      {recordingKey === setting.key ? t("plugins.settingsShortcutRecording") : shortcutLabel(value, platform)}
                    </button>
                  )}
                  <button type="button" className="plugins-setting-reset" onClick={() => resetValue(setting)}>
                    {t("plugins.settingsReset")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {error ? <p className="plugins-settings-error" role="alert">{error}</p> : null}
        <div className="plugins-modal-actions">
          <Button variant="secondary" onClick={onClose}>{t("plugins.cancel")}</Button>
          <Button variant="primary" disabled={saving} onClick={() => void save()}>
            {saving ? t("settings.saving") : t("plugins.settingsSave")}
          </Button>
        </div>
      </div>
    </div>
  );
}

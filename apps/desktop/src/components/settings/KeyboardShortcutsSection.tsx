import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  KEYBOARD_SHORTCUTS,
  defaultKeybinding,
  isAllowedKeybinding,
  isReservedKeybinding,
  keybindingDisplayParts,
  keybindingFromEvent,
  keybindingsConflict,
  resolveKeybinding,
  type AppSettings,
  type KeyboardShortcutDefinition,
  type KeyboardShortcutGroup,
  type KeyboardShortcutId,
  type ShortcutPlatform,
} from "@pi-desktop/shared";
import { IconPower, IconSnapshot } from "../icons";

type Props = {
  settings: AppSettings;
  platform: ShortcutPlatform;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
};

const GROUP_ORDER: readonly KeyboardShortcutGroup[] = [
  "navigation",
  "agent",
  "window",
];

function shortcutLabelKey(id: KeyboardShortcutId): string {
  return `settings.shortcutAction.${id}`;
}

function Keybinding({
  binding,
  platform,
  unboundLabel,
}: {
  binding: string | null;
  platform: ShortcutPlatform;
  unboundLabel: string;
}) {
  if (!binding) {
    return (
      <span className="shortcut-unbound" aria-label={unboundLabel}>
        {unboundLabel}
      </span>
    );
  }
  const parts = keybindingDisplayParts(binding, platform);
  return (
    <span className="shortcut-keybinding" aria-label={parts.join("+")}>
      {parts.map((part, index) => (
        <span key={`${part}-${index}`} className="shortcut-key-part">
          {index > 0 ? <span className="shortcut-key-plus">+</span> : null}
          <kbd>{part}</kbd>
        </span>
      ))}
    </span>
  );
}

export function KeyboardShortcutsSection({ settings, platform, saveSettings }: Props) {
  const { t } = useTranslation();
  const [recordingId, setRecordingId] = useState<KeyboardShortcutId | null>(null);
  const [savingId, setSavingId] = useState<KeyboardShortcutId | null>(null);
  const [error, setError] = useState<{ id: KeyboardShortcutId; message: string } | null>(
    null,
  );

  const groups = useMemo(
    () =>
      GROUP_ORDER.map((group) => ({
        group,
        shortcuts: KEYBOARD_SHORTCUTS.filter((shortcut) => shortcut.group === group),
      })),
    [],
  );
  const hasOverrides = Object.keys(settings.keybindings ?? {}).length > 0;

  const storeBinding = async (
    shortcut: KeyboardShortcutDefinition,
    binding: string | null,
    mode: "binding" | "disabled" | "default" = "binding",
  ) => {
    const next = { ...(settings.keybindings ?? {}) };
    if (mode === "default") {
      delete next[shortcut.id];
    } else if (mode === "disabled") {
      next[shortcut.id] = null;
    } else if (!binding || binding === defaultKeybinding(shortcut, platform)) {
      delete next[shortcut.id];
    } else {
      next[shortcut.id] = binding;
    }
    setSavingId(shortcut.id);
    setError(null);
    try {
      await saveSettings({ keybindings: next });
      setRecordingId(null);
    } catch (saveError) {
      setError({
        id: shortcut.id,
        message:
          saveError instanceof Error ? saveError.message : t("settings.shortcutSaveFailed"),
      });
    } finally {
      setSavingId(null);
    }
  };

  const recordBinding = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    shortcut: KeyboardShortcutDefinition,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setRecordingId(null);
      setError(null);
      return;
    }
    const binding = keybindingFromEvent(event.nativeEvent, platform);
    if (!binding || !isAllowedKeybinding(binding)) {
      setError({ id: shortcut.id, message: t("settings.shortcutRequiresModifier") });
      return;
    }
    if (isReservedKeybinding(binding, platform)) {
      setError({ id: shortcut.id, message: t("settings.shortcutReserved") });
      return;
    }
    const conflict = KEYBOARD_SHORTCUTS.find(
      (candidate) =>
        candidate.id !== shortcut.id &&
        keybindingsConflict(
          resolveKeybinding(candidate, settings.keybindings, platform),
          binding,
        ),
    );
    if (conflict) {
      setError({
        id: shortcut.id,
        message: t("settings.shortcutConflict", {
          action: t(shortcutLabelKey(conflict.id)),
        }),
      });
      return;
    }
    void storeBinding(shortcut, binding);
  };

  return (
    <section className="settings-card-block">
      <div className="settings-card-heading-row">
        <div>
          <h3 className="settings-card-heading">{t("settings.keyboard")}</h3>
          <p className="settings-card-description">{t("settings.shortcutDescription")}</p>
        </div>
        <button
          type="button"
          className="settings-text-action"
          disabled={!hasOverrides || savingId !== null}
          onClick={() => {
            setRecordingId(null);
            setError(null);
            void saveSettings({ keybindings: {} });
          }}
        >
          <IconSnapshot size={13} />
          <span>{t("settings.shortcutResetAll")}</span>
        </button>
      </div>
      <div className="settings-panel shortcut-map">
        {groups.map(({ group, shortcuts }) => (
          <div key={group} className="shortcut-group">
            <div className="shortcut-group-label">
              {t(`settings.shortcutGroup.${group}`)}
            </div>
            {shortcuts.map((shortcut) => {
              const binding = resolveKeybinding(shortcut, settings.keybindings, platform);
              const customized = Object.prototype.hasOwnProperty.call(
                settings.keybindings ?? {},
                shortcut.id,
              );
              const disabled = customized && settings.keybindings?.[shortcut.id] === null;
              const recording = recordingId === shortcut.id;
              const rowError = error?.id === shortcut.id ? error.message : null;
              return (
                <div key={shortcut.id} className="shortcut-row">
                  <div className="shortcut-row-copy">
                    <div className="settings-row-title">
                      {t(shortcutLabelKey(shortcut.id))}
                    </div>
                    {rowError ? (
                      <div className="shortcut-error" role="alert">
                        {rowError}
                      </div>
                    ) : null}
                  </div>
                  <div className="shortcut-row-controls">
                    <button
                      type="button"
                      className={`shortcut-recorder${recording ? " recording" : ""}`}
                      aria-label={t("settings.shortcutChange", {
                        action: t(shortcutLabelKey(shortcut.id)),
                      })}
                      aria-pressed={recording}
                      disabled={savingId !== null && savingId !== shortcut.id}
                      onClick={() => {
                        setError(null);
                        setRecordingId(shortcut.id);
                      }}
                      onBlur={() => setRecordingId((current) =>
                        current === shortcut.id ? null : current,
                      )}
                      onKeyDown={
                        recording
                          ? (event) => recordBinding(event, shortcut)
                          : undefined
                      }
                    >
                      {recording ? (
                        <span className="shortcut-recording-label">
                          {t("settings.shortcutRecording")}
                        </span>
                      ) : (
                        <Keybinding
                          binding={binding}
                          platform={platform}
                          unboundLabel={t("settings.shortcutUnbound")}
                        />
                      )}
                    </button>
                    <button
                      type="button"
                      className="shortcut-disable"
                      aria-label={t("settings.shortcutDisable", {
                        action: t(shortcutLabelKey(shortcut.id)),
                      })}
                      title={t("settings.shortcutDisable", {
                        action: t(shortcutLabelKey(shortcut.id)),
                      })}
                      disabled={disabled || savingId !== null}
                      onClick={() => void storeBinding(shortcut, null, "disabled")}
                    >
                      <IconPower size={13} />
                    </button>
                    <button
                      type="button"
                      className="shortcut-reset"
                      aria-label={t("settings.shortcutReset", {
                        action: t(shortcutLabelKey(shortcut.id)),
                      })}
                      title={t("settings.shortcutReset", {
                        action: t(shortcutLabelKey(shortcut.id)),
                      })}
                      disabled={!customized || savingId !== null}
                      onClick={() => void storeBinding(shortcut, null, "default")}
                    >
                      <IconSnapshot size={13} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}

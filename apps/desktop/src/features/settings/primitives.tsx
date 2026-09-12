import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type {
  AppSettings,
  CommandShellCatalog,
  CommandShellId,
} from "@pi-desktop/shared";
import {
  MAX_LARGE_PASTE_THRESHOLD,
  MIN_LARGE_PASTE_THRESHOLD,
  normalizeLargePasteThreshold,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { resolveContextUsageDisplay } from "../../lib/context-usage";
import { Input, Select, cx } from "../../components/ui";

export function SettingsRow({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <div className="settings-row-title">{title}</div>
        {description ? <div className="settings-row-desc">{description}</div> : null}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

export function SettingsCard({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-card-block">
      {title ? <h3 className="settings-card-heading">{title}</h3> : null}
      <div className="settings-panel">{children}</div>
    </section>
  );
}

export function CommandShellRow({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<CommandShellCatalog | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [selectedOverride, setSelectedOverride] =
    useState<CommandShellId | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .listCommandShells()
      .then((next) => {
        if (cancelled) return;
        setCatalog(next);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedId =
    selectedOverride ??
    catalog?.configuredId ??
    catalog?.effective?.id ??
    settings.defaultCommandShell ??
    "";
  const configuredChoice = catalog?.choices.find(
    (choice) => choice.id === catalog.configuredId,
  );
  const effectiveChoice = catalog?.effective;

  let effectiveStatus: string | null = null;
  if (catalog && !effectiveChoice && catalog.choices.length > 0) {
    effectiveStatus = t("settings.commandShellNoEffective");
  } else if (catalog && effectiveChoice) {
    if (!catalog.configuredId) {
      effectiveStatus = t("settings.commandShellDefault", {
        shell: effectiveChoice.label,
      });
    } else if (
      catalog.fallback ||
      catalog.configuredId !== effectiveChoice.id ||
      configuredChoice?.available === false
    ) {
      effectiveStatus = t("settings.commandShellFallback", {
        shell: effectiveChoice.label,
      });
    }
  }

  const onChange = async (value: string) => {
    if (!catalog || saving) return;
    const choice = catalog.choices.find((candidate) => candidate.id === value);
    if (!choice || !choice.available) return;
    setSaving(true);
    setSaveError(false);
    setSelectedOverride(choice.id);
    try {
      await saveSettings({ defaultCommandShell: choice.id });
      setCatalog((current) =>
        current
          ? {
              ...current,
              configuredId: choice.id,
              effective: choice,
              fallback: false,
            }
          : current,
      );
    } catch {
      setSelectedOverride(null);
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsRow
      title={t("settings.commandShell")}
      description={t("settings.commandShellDesc")}
    >
      <div
        className="settings-command-shell-control"
        aria-busy={saving || (!catalog && !loadError)}
      >
        {!catalog ? (
          <span className="settings-command-shell-state" role="status">
            {loadError
              ? t("settings.commandShellLoadError")
              : t("settings.commandShellLoading")}
          </span>
        ) : catalog.choices.length === 0 ? (
          <span className="settings-command-shell-state" role="status">
            {t("settings.commandShellNoChoices")}
          </span>
        ) : (
          <Select
            className="settings-command-shell-select"
            value={selectedId}
            disabled={saving}
            aria-label={t("settings.commandShell")}
            onChange={(event) => void onChange(event.target.value)}
          >
            {catalog.choices.map((choice) => (
              <option key={choice.id} value={choice.id} disabled={!choice.available}>
                {choice.label}
                {!choice.available
                  ? ` - ${t("settings.commandShellUnavailable")}`
                  : ""}
              </option>
            ))}
          </Select>
        )}
        {effectiveStatus ? (
          <span className="settings-command-shell-status">{effectiveStatus}</span>
        ) : null}
        {saveError ? (
          <span className="settings-command-shell-state error" role="status">
            {t("settings.commandShellSaveError")}
          </span>
        ) : null}
      </div>
    </SettingsRow>
  );
}
export function LinkOpenTargetRow({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const current = settings.linkOpenTarget ?? "workpanel";
  return (
    <SettingsRow
      title={t("settings.linkOpenTarget")}
      description={t("settings.linkOpenTargetDesc")}
    >
      <div
        className="settings-segment"
        role="group"
        aria-label={t("settings.linkOpenTarget")}
      >
        {([
          ["workpanel", "settings.linkOpenTargetWorkpanel"],
          ["external", "settings.linkOpenTargetExternal"],
        ] as const).map(([value, labelKey]) => (
          <button
            key={value}
            type="button"
            className={cx(
              "settings-segment-item",
              current === value && "active",
            )}
            aria-pressed={current === value}
            onClick={() => void saveSettings({ linkOpenTarget: value })}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>
    </SettingsRow>
  );
}

/**
 * Which figure the composer context ring leads with (D398). Color thresholds
 * stay on remaining capacity in both modes, so "used" never repaints the
 * warning state.
 */
export function ContextUsageDisplayRow({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const current = resolveContextUsageDisplay(settings.contextUsageDisplay);
  return (
    <SettingsRow
      title={t("settings.contextUsageDisplay")}
      description={t("settings.contextUsageDisplayDesc")}
    >
      <div
        className="settings-segment"
        role="radiogroup"
        aria-label={t("settings.contextUsageDisplay")}
      >
        {([
          ["remaining", "settings.contextUsageDisplayRemaining"],
          ["used", "settings.contextUsageDisplayUsed"],
        ] as const).map(([value, labelKey]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={current === value}
            className={cx(
              "settings-segment-item",
              current === value && "active",
            )}
            onClick={() => void saveSettings({ contextUsageDisplay: value })}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>
    </SettingsRow>
  );
}

export function LargePasteThresholdRow({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const currentThreshold = normalizeLargePasteThreshold(
    settings.largePasteThreshold,
  );
  const [draft, setDraft] = useState(String(currentThreshold));
  const [saveError, setSaveError] = useState(false);

  useEffect(() => {
    setDraft(String(currentThreshold));
  }, [currentThreshold]);

  const commit = async () => {
    const parsed = Number(draft.trim());
    const next =
      Number.isInteger(parsed) &&
      parsed >= MIN_LARGE_PASTE_THRESHOLD &&
      parsed <= MAX_LARGE_PASTE_THRESHOLD
        ? parsed
        : currentThreshold;
    setDraft(String(next));
    if (next === currentThreshold) {
      setSaveError(false);
      return;
    }
    setSaveError(false);
    try {
      await saveSettings({ largePasteThreshold: next });
    } catch {
      setDraft(String(currentThreshold));
      setSaveError(true);
    }
  };

  return (
    <SettingsRow
      title={t("settings.largePasteThreshold")}
      description={t("settings.largePasteThresholdDesc")}
    >
      <div className="settings-number-control">
        <Input
          type="number"
          min={MIN_LARGE_PASTE_THRESHOLD}
          max={MAX_LARGE_PASTE_THRESHOLD}
          step={1}
          inputMode="numeric"
          value={draft}
          aria-label={t("settings.largePasteThreshold")}
          aria-invalid={saveError}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
        {saveError ? (
          <span className="settings-command-shell-state error" role="status">
            {t("settings.largePasteThresholdSaveError")}
          </span>
        ) : null}
      </div>
    </SettingsRow>
  );
}

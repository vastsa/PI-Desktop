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
import { HelpIcon, Input, SegmentedControl } from "../../components/ui";
import { SettingsMenuSelect } from "../../components/settings/SettingsMenuSelect";

/**
 * One settings decision: the title and its control on a single line.
 *
 * The explanation never occupies a permanent second line — it is reached from
 * the question mark beside the title, which keeps a card scannable (D601).
 * `detail` is the exception in kind, not in styling: a row that shows a live
 * value (the pinned default model) keeps it visible, because that is data the
 * user came to read, not prose explaining a switch.
 */
export function SettingsRow({
  title,
  description,
  detail,
  children,
}: {
  title: string;
  /** Explanatory copy, revealed on demand from the help icon. */
  description?: string;
  /** Live row metadata that stays visible (not an explanation). */
  detail?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <div className="settings-row-title">
          {title}
          {description ? <HelpIcon label={description} /> : null}
        </div>
        {detail ? <div className="settings-row-detail">{detail}</div> : null}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

/**
 * A titled group of rows. `description` follows the same rule as a row's: it
 * explains the card, so it lives behind the heading's help icon.
 */
export function SettingsCard({
  title,
  description,
  children,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-card-block">
      {title ? (
        /*
          The help mark is the heading's sibling, not its child: a nested
          button joins the heading's accessible name, and a screen reader's
          list of headings should not read out every explanation.
        */
        <div className="settings-card-heading-help">
          <h3 className="settings-card-heading">{title}</h3>
          {description ? <HelpIcon label={description} /> : null}
        </div>
      ) : null}
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
    <SettingsRow title={t("settings.commandShell")}>
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
          <SettingsMenuSelect
            className="settings-command-shell-select"
            label={t("settings.commandShell")}
            value={selectedId}
            busy={saving}
            onChange={(value) => void onChange(value)}
            options={catalog.choices.map((choice) => ({
              id: choice.id,
              label: `${choice.label}${
                choice.available
                  ? ""
                  : ` - ${t("settings.commandShellUnavailable")}`
              }`,
              disabled: !choice.available,
            }))}
          />
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
    <SettingsRow title={t("settings.linkOpenTarget")}>
      <SegmentedControl
        value={current}
        onChange={(value) => void saveSettings({ linkOpenTarget: value })}
        options={[
          { value: "workpanel", label: t("settings.linkOpenTargetWorkpanel") },
          { value: "external", label: t("settings.linkOpenTargetExternal") },
        ]}
        label={t("settings.linkOpenTarget")}
        role="group"
      />
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
    <SettingsRow title={t("settings.contextUsageDisplay")}>
      <SegmentedControl
        value={current}
        onChange={(value) => void saveSettings({ contextUsageDisplay: value })}
        options={[
          { value: "remaining", label: t("settings.contextUsageDisplayRemaining") },
          { value: "used", label: t("settings.contextUsageDisplayUsed") },
        ]}
        label={t("settings.contextUsageDisplay")}
      />
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

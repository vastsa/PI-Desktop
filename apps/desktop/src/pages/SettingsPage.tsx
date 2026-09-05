import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type {
  AppSettings,
  AgentInstructionFile,
  CloseBehavior,
  CommandShellCatalog,
  CommandShellId,
  GlobalPermissionMode,
  ShortcutPlatform,
} from "@pi-desktop/shared";
import {
  MAX_LARGE_PASTE_THRESHOLD,
  MIN_LARGE_PASTE_THRESHOLD,
  normalizeLargePasteThreshold,
} from "@pi-desktop/shared";
import { useAppStore } from "../stores/app-store";
import { api } from "../lib/api";
import type { ImportCandidate } from "../lib/api";
import { useUpdateState } from "../hooks/use-update-state";
import {
  DEFAULT_IMPORT_GROUP_BY,
  formatImportDate,
  groupImportCandidates,
  type ImportGroupBy,
} from "../lib/import-groups";
import { Badge, Button, Input, Select, cx } from "../components/ui";
import {
  SETTINGS_NAV,
  SETTINGS_NAV_GROUP_LABELS,
  type SettingsNavGroupId,
} from "../lib/settings-search";
import {
  IconArchive,
  IconBookOpen,
  IconBot,
  IconChevronLeft,
  IconDownload,
  IconFileText,
  IconInfo,
  IconKeyboard,
  IconSearch,
  IconServer,
  IconSliders,
  IconSparkles,
} from "../components/icons";
import { ModelConfigPage } from "../components/settings/ModelConfigPage";
import { KeyboardShortcutsSection } from "../components/settings/KeyboardShortcutsSection";
import { FontFamilyRow } from "../components/settings/FontFamilyRow";
import { LanguageRow } from "../components/settings/LanguageRow";
import { ThemeRow } from "../components/settings/ThemeRow";
import { ReleaseNotesDialog } from "../components/ReleaseNotesDialog";
import { ProjectsPage } from "./ProjectsPage";
import { AgentSkillsPage } from "../components/settings/AgentSkillsPage";
import { AgentMcpPage } from "../components/settings/AgentMcpPage";
import { AgentSubagentsPage } from "../components/settings/AgentSubagentsPage";

type SettingsTab = ReturnType<typeof useAppStore.getState>["settingsTab"];

type NavItem = {
  id: SettingsTab;
  labelKey: string;
  titleKey: string;
  icon: ReactNode;
  group: SettingsNavGroupId;
  /** i18n keys of the rows inside the tab; search matches their translations. */
  keywordKeys: string[];
};

function SettingsRow({
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

function SettingsCard({
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

function CommandShellRow({
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

function LargePasteThresholdRow({
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

function AgentInstructionsSection() {
  const { t } = useTranslation();
  const [global, setGlobal] = useState<AgentInstructionFile | null>(null);
  const [globalDraft, setGlobalDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.getAgentInstructions().then((result) => {
      if (cancelled) return;
      setGlobal(result.global);
      setGlobalDraft(result.global.content);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const result = await api.saveAgentInstructions("global", globalDraft);
      setGlobal(result.file);
    } finally {
      setSaving(false);
    }
  };

  const globalDirty = global !== null && globalDraft !== global.content;
  return (
    <div className="settings-stack">
      <SettingsCard title={t("settings.instructionsGlobal")}>
        <div className="settings-form-grid">
          <div className="settings-row-copy">
            <div className="settings-row-desc">{t("settings.instructionsGlobalDesc")}</div>
            <div className="settings-instruction-path">{global?.path ?? ""}</div>
          </div>
          <textarea
            className="field-textarea settings-instruction-editor"
            value={globalDraft}
            onChange={(event) => setGlobalDraft(event.target.value)}
            aria-label={t("settings.instructionsGlobal")}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
          />
        </div>
        <div className="settings-panel-actions">
          <Button
            variant="primary"
            disabled={!globalDirty || saving}
            onClick={() => void save()}
          >
            {saving ? t("settings.saving") : t("settings.instructionsSave")}
          </Button>
        </div>
      </SettingsCard>
    </div>
  );
}

function UpdatesRow({ currentVersion }: { currentVersion?: string }) {
  const { t } = useTranslation();
  const update = useUpdateState();
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const closeReleaseNotes = useCallback(() => setReleaseNotesOpen(false), []);
  const disabled = !update || update.mode === "disabled";
  const busy = update?.status === "checking" || update?.status === "downloading";

  let action: ReactNode;
  if (update?.status === "downloaded") {
    action = (
      <Button
        variant="primary"
        onClick={() => void api.updatesInstall().catch(() => undefined)}
      >
        {t("updates.restart")}
      </Button>
    );
  } else if (update?.status === "available" && update.mode === "manual") {
    action = (
      <Button
        variant="secondary"
        onClick={() => void api.updatesOpenReleases().catch(() => undefined)}
      >
        {t("updates.viewRelease")}
      </Button>
    );
  } else {
    action = (
      <Button
        variant="secondary"
        disabled={disabled || busy}
        onClick={() => void api.updatesCheck().catch(() => undefined)}
      >
        {busy ? t("updates.checking") : t("updates.check")}
      </Button>
    );
  }

  let statusText: string | null = null;
  if (disabled) {
    statusText = t("updates.devDisabled");
  } else {
    switch (update.status) {
      case "checking":
        statusText = t("updates.checking");
        break;
      case "up-to-date":
        statusText = t("updates.upToDate");
        break;
      case "available":
        statusText = `${t("updates.available", { version: update.availableVersion })}${
          update.mode === "manual" ? ` ${t("updates.manualHint")}` : ""
        }`;
        break;
      case "downloading":
        statusText = t("updates.downloading", {
          percent: update.progressPercent ?? 0,
        });
        break;
      case "downloaded":
        statusText = t("updates.downloaded", {
          version: update.availableVersion,
        });
        break;
      case "error":
        statusText = t("updates.error", { message: update.error ?? "" });
        break;
      default:
        statusText = null;
    }
  }

  const notes = update?.releaseNotes?.trim() || null;
  const showNotes =
    notes &&
    (update?.status === "available" ||
      update?.status === "downloading" ||
      update?.status === "downloaded");

  return (
    <SettingsRow title={t("updates.title")} description={t("updates.desc")}>
      <div className="flex flex-col items-end gap-1.5">
        <div className="update-settings-actions">
          <Button
            variant="secondary"
            onClick={() => setReleaseNotesOpen(true)}
          >
            <IconFileText size={14} />
            {t("updates.releaseNotes")}
          </Button>
          {action}
        </div>
        {statusText ? (
          <div className="text-right text-xs-plus text-text-muted">{statusText}</div>
        ) : null}
        {showNotes ? (
          <div className="update-settings-notes">
            <div className="update-settings-notes-label">{t("updates.whatsNew")}</div>
            <pre className="update-settings-notes-body">{notes}</pre>
          </div>
        ) : null}
      </div>
      {releaseNotesOpen ? (
        <ReleaseNotesDialog
          currentVersion={update?.currentVersion ?? currentVersion}
          availableVersion={update?.availableVersion}
          onClose={closeReleaseNotes}
        />
      ) : null}
    </SettingsRow>
  );
}

function ImportSection() {
  const { t, i18n } = useTranslation();
  const refreshSessions = useAppStore((s) => s.refreshSessions);
  const showToast = useAppStore((s) => s.showToast);
  const [candidates, setCandidates] = useState<ImportCandidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupBy, setGroupBy] = useState<ImportGroupBy>(DEFAULT_IMPORT_GROUP_BY);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);

  const keyOf = (c: ImportCandidate) => `${c.source}:${c.externalId}`;

  const scan = async () => {
    setScanning(true);
    try {
      const res = await api.scanImportSessions();
      setCandidates(res.sessions);
      setSelected(new Set());
      setExpandedGroups(new Set());
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setScanning(false);
    }
  };

  const runImport = async () => {
    if (!candidates) return;
    const items = candidates.filter((c) => selected.has(keyOf(c)));
    if (items.length === 0) return;
    setImporting(true);
    try {
      const res = await api.runImportSessions(items);
      await refreshSessions();
      showToast(
        t("settings.importResult", {
          imported: res.imported,
          skipped: res.skipped,
          failed: res.failed,
        }),
        { variant: res.failed > 0 ? "error" : "success" },
      );
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setImporting(false);
    }
  };

  const importLabels = useMemo(
    () => ({
      noProject: t("settings.importNoProject"),
      sources: {
        "claude-code": t("settings.importSourceClaudeCode"),
        opencode: t("settings.importSourceOpenCode"),
        codex: t("settings.importSourceCodex"),
        pi: t("settings.importSourcePi"),
      },
    }),
    [t],
  );

  const groups = useMemo(
    () => groupImportCandidates(candidates ?? [], groupBy, importLabels),
    [candidates, groupBy, importLabels],
  );

  const allKeys = useMemo(() => (candidates ?? []).map(keyOf), [candidates]);
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selected.has(k));

  const toggleKeys = (keys: string[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  };

  return (
    <div className="settings-stack">
      <SettingsCard title={t("settings.importTitle")}>
        <SettingsRow
          title={t("settings.importScan")}
          description={t("settings.importScanDesc")}
        >
          <Button variant="secondary" disabled={scanning} onClick={() => void scan()}>
            {scanning ? t("settings.importScanning") : t("settings.importScan")}
          </Button>
        </SettingsRow>
      </SettingsCard>

      {candidates !== null && (
        <SettingsCard>
          {candidates.length === 0 ? (
            <div className="settings-empty">{t("settings.importNone")}</div>
          ) : (
            <>
              <div className="import-toolbar">
                <label className="import-select-all">
                  <input
                    type="checkbox"
                    aria-label={t("settings.importSelectAll")}
                    checked={allSelected}
                    onChange={(e) => toggleKeys(allKeys, e.target.checked)}
                  />
                  <span>
                    {t("settings.importFound", { count: candidates.length })}
                    {selected.size > 0
                      ? ` · ${t("settings.importSelectedCount", { count: selected.size })}`
                      : ""}
                  </span>
                </label>
                <div className="import-toolbar-actions">
                  <label className="import-group-by">
                    <span>{t("settings.importGroupBy")}</span>
                    <Select
                      value={groupBy}
                      className="settings-pill-select import-group-select"
                      onChange={(event) => {
                        setGroupBy(event.target.value as ImportGroupBy);
                        setExpandedGroups(new Set());
                      }}
                    >
                      <option value="source">{t("settings.importGroupBySource")}</option>
                      <option value="path">{t("settings.importGroupByPath")}</option>
                    </Select>
                  </label>
                  <Button
                    variant="primary"
                    disabled={importing || selected.size === 0}
                    onClick={() => void runImport()}
                  >
                    {importing
                      ? t("settings.importing")
                      : t("settings.importSelected", { count: selected.size })}
                  </Button>
                </div>
              </div>

              <div className="import-groups">
                {groups.map((group, groupIndex) => {
                  const groupKeys = group.items.map(keyOf);
                  const groupSelected = groupKeys.filter((k) => selected.has(k)).length;
                  const isCollapsed = !expandedGroups.has(group.id);
                  const groupBodyId = `import-group-body-${groupIndex}`;
                  return (
                    <div key={group.id} className="import-group">
                      <div className="import-group-header">
                        <input
                          type="checkbox"
                          aria-label={t("settings.importSelectGroup", { name: group.name })}
                          checked={groupSelected === groupKeys.length}
                          ref={(el) => {
                            if (el)
                              el.indeterminate =
                                groupSelected > 0 && groupSelected < groupKeys.length;
                          }}
                          onChange={(e) => toggleKeys(groupKeys, e.target.checked)}
                        />
                        <button
                          type="button"
                          className="import-group-toggle"
                          aria-controls={groupBodyId}
                          aria-expanded={!isCollapsed}
                          onClick={() =>
                            setExpandedGroups((prev) => {
                              const next = new Set(prev);
                              if (next.has(group.id)) next.delete(group.id);
                              else next.add(group.id);
                              return next;
                            })
                          }
                        >
                          <span
                            className={cx("import-group-chevron", isCollapsed && "collapsed")}
                            aria-hidden
                          >
                            <IconChevronLeft size={13} />
                          </span>
                          <span className="import-group-name">{group.name}</span>
                          {group.projectPath ? (
                            <span className="import-group-path">{group.projectPath}</span>
                          ) : null}
                          <span className="import-group-count">
                            {t("settings.importSessionCount", { count: group.items.length })}
                          </span>
                        </button>
                      </div>
                      {!isCollapsed && (
                        <div id={groupBodyId} className="import-group-body">
                          {group.items.map((c) => {
                            const k = keyOf(c);
                            return (
                              <label key={k} className="import-row">
                                <input
                                  type="checkbox"
                                  checked={selected.has(k)}
                                  onChange={(e) => toggleKeys([k], e.target.checked)}
                                />
                                <span className="import-row-main">
                                  <span className="import-row-title">{c.title}</span>
                                  <span className="import-row-meta">
                                    {t("settings.importMessages", { count: c.messageCount })}
                                    {" · "}
                                    {formatImportDate(
                                      c.updatedAt,
                                      i18n.resolvedLanguage || i18n.language,
                                    )}
                                  </span>
                                </span>
                                <Badge tone="neutral">{importLabels.sources[c.source]}</Badge>
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </SettingsCard>
      )}
    </div>
  );
}


/**
 * Developer mode gate: the console stays unreachable until the toggle is on,
 * which is also what unlocks F12 and the macOS View ▸ developer tools item
 * (enforced in the main process, not here).
 */
function DeveloperSection({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const showToast = useAppStore((s) => s.showToast);
  const enabled = settings.developerMode === true;

  const openConsole = async () => {
    try {
      await api.toggleDevTools(true);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    }
  };

  return (
    <SettingsCard title={t("settings.developer")}>
      <SettingsRow
        title={t("settings.developerMode")}
        description={t("settings.developerModeDesc")}
      >
        <button
          type="button"
          className={cx("settings-toggle", enabled && "on")}
          role="switch"
          aria-checked={enabled}
          aria-label={t("settings.developerMode")}
          onClick={() => void saveSettings({ developerMode: !enabled })}
        >
          <span className="settings-toggle-thumb" />
        </button>
      </SettingsRow>
      <SettingsRow
        title={t("settings.devTools")}
        description={
          enabled ? t("settings.devToolsDesc") : t("settings.devToolsDisabledHint")
        }
      >
        <Button variant="secondary" disabled={!enabled} onClick={() => void openConsole()}>
          {t("settings.openDevTools")}
        </Button>
      </SettingsRow>
    </SettingsCard>
  );
}

/**
 * Windows/Linux only: how closing the main window behaves. The first close
 * prompts once (main-process dialog); the remembered choice can be changed
 * here between tray and quit, but never reverted to prompting.
 */
function CloseBehaviorSection() {
  const { t } = useTranslation();
  const [behavior, setBehavior] = useState<CloseBehavior | null>(null);
  const [saveError, setSaveError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .getCloseBehavior()
      .then(({ behavior: next }) => {
        if (!cancelled) setBehavior(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // The "ask" state (unset) is transient and cannot be re-selected: once a
  // choice is made it is remembered permanently. An unset preference shows
  // no active option.
  const options: [CloseBehavior, string, string][] = [
    ["tray", "settings.closeBehaviorTray", "settings.closeBehaviorTrayDesc"],
    ["quit", "settings.closeBehaviorQuit", "settings.closeBehaviorQuitDesc"],
  ];

  const choose = async (next: CloseBehavior) => {
    setSaveError(false);
    try {
      await api.setCloseBehavior(next);
      setBehavior(next);
    } catch {
      setSaveError(true);
    }
  };

  return (
    <SettingsCard title={t("settings.closeBehaviorTitle")}>
      <SettingsRow
        title={t("settings.closeBehaviorTitle")}
        description={t("settings.closeBehaviorDesc")}
      >
        <div
          className="settings-segment"
          role="radiogroup"
          aria-label={t("settings.closeBehaviorTitle")}
        >
          {options.map(([value, labelKey, descKey]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={behavior === value}
              title={t(descKey)}
              className={cx(
                "settings-segment-item",
                behavior === value && "active",
              )}
              onClick={() => void choose(value)}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
      </SettingsRow>
      {saveError ? (
        <span className="settings-command-shell-state error" role="status">
          {t("settings.closeBehaviorSaveError")}
        </span>
      ) : null}
    </SettingsCard>
  );
}

export function SettingsPage() {
  const { t } = useTranslation();
  const tab = useAppStore((s) => s.settingsTab);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const settingsAnchor = useAppStore((s) => s.settingsAnchor);
  const setSettingsAnchor = useAppStore((s) => s.setSettingsAnchor);
  const setPage = useAppStore((s) => s.setPage);
  const settings = useAppStore((s) => s.settings);
  const version = useAppStore((s) => s.version);
  const refreshProviders = useAppStore((s) => s.refreshProviders);
  const platform = (window.piDesktop?.platform ?? "darwin") as ShortcutPlatform;

  const [query, setQuery] = useState("");

  // Arriving from the global search dialog: scroll to and flash the row
  // whose title matches the pending anchor key. Rows are located by their
  // translated title so async tab content (providers, import) needs no
  // per-row wiring; a short retry window covers late mounts.
  useEffect(() => {
    if (!settingsAnchor) return;
    const target = t(settingsAnchor).trim();
    let cancelled = false;
    let timer: number | undefined;
    const tryFind = (attempt: number) => {
      if (cancelled) return;
      const titles = document.querySelectorAll<HTMLElement>(
        ".settings-content .settings-row-title, .settings-content .settings-card-heading",
      );
      const match = [...titles].find(
        (node) => node.textContent?.trim() === target,
      );
      if (match) {
        const row =
          match.closest<HTMLElement>(".settings-row") ??
          match.closest<HTMLElement>(".settings-card-block") ??
          match;
        row.scrollIntoView({ block: "center" });
        row.classList.add("settings-anchor-flash");
        window.setTimeout(
          () => row.classList.remove("settings-anchor-flash"),
          1800,
        );
        setSettingsAnchor(null);
        return;
      }
      if (attempt < 8) timer = window.setTimeout(() => tryFind(attempt + 1), 120);
      else setSettingsAnchor(null);
    };
    tryFind(0);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [settingsAnchor, tab, t, setSettingsAnchor]);

  const saveSettings = async (patch: Partial<AppSettings>) => {
    if (!settings) return;
    const nextSettings = { ...settings, ...patch };
    await api.setSettings(nextSettings);
    useAppStore.setState({ settings: nextSettings });
    await refreshProviders();
  };

  // Nav structure comes from the shared settings index (lib/settings-search)
  // so the global search dialog and this page stay in sync; only the icons
  // are view-level.
  const navItems: NavItem[] = useMemo(() => {
    const iconFor: Record<SettingsTab, ReactNode> = {
      // Semantic Lucide glyphs for the settings destinations.
      general: <IconSliders size={14} />,
      ai: <IconSparkles size={14} />,
      shortcuts: <IconKeyboard size={14} />,
      instructions: <IconFileText size={14} />,
      agent: <IconBot size={14} />,
      skills: <IconBookOpen size={14} />,
      mcp: <IconServer size={14} />,
      subagents: <IconBot size={14} />,
      import: <IconDownload size={14} />,
      projects: <IconArchive size={14} />,
      about: <IconInfo size={14} />,
    };
    return SETTINGS_NAV.map((entry) => ({
      id: entry.id,
      labelKey: entry.labelKey,
      titleKey: entry.titleKey,
      icon: iconFor[entry.id],
      group: entry.group,
      keywordKeys: entry.keywordKeys,
    }));
  }, []);

  // Search matches the tab label and the titles of the rows inside it, so
  // typing e.g. "theme" or "主题" surfaces Basics even though the tab is
  // named differently.
  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return navItems;
    return navItems.filter((item) =>
      [t(item.labelKey), ...item.keywordKeys.map((key) => t(key))].some((text) =>
        text.toLowerCase().includes(q),
      ),
    );
  }, [navItems, query, t]);

  // Keep the destination index flat for search, while giving the rail titled
  // visual clusters so the eight rows do not read as one dense block.
  const filteredGroups = useMemo(() => {
    const groups = new Map<SettingsNavGroupId, NavItem[]>();
    for (const item of filteredItems) {
      const items = groups.get(item.group) ?? [];
      items.push(item);
      groups.set(item.group, items);
    }
    return [...groups.entries()].map(([id, items]) => ({ id, items }));
  }, [filteredItems]);

  const activeTitleKey =
    navItems.find((item) => item.id === tab)?.titleKey ?? "settings.title";

  return (
    <div className="settings-shell settings-shell-full">
      <div className="settings-titlebar" aria-hidden="true" />
      <aside className="settings-nav" aria-label={t("settings.title")}>
        <div className="settings-nav-top drag">
          <button
            type="button"
            className="settings-back no-drag"
            onClick={() => setPage("chat")}
          >
            <IconChevronLeft size={15} />
            <span>{t("settings.backToApp")}</span>
          </button>
          <div className="settings-search-wrap no-drag">
            <IconSearch size={14} />
            <input
              className="settings-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("settings.searchPlaceholder")}
              aria-label={t("settings.search")}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
            />
          </div>
        </div>

        <div className="settings-nav-scroll no-drag">
          {filteredGroups.length === 0 ? (
            <div className="settings-nav-empty">{t("settings.noResults")}</div>
          ) : (
            filteredGroups.map(({ id, items }) => (
              <div key={id} className="settings-nav-group">
                <div className="settings-nav-group-label">
                  {t(SETTINGS_NAV_GROUP_LABELS[id])}
                </div>
                {items.map((item) => (
                  <button
                    key={item.id}
                    className={cx("settings-nav-item", tab === item.id && "active")}
                    onClick={() => setSettingsTab(item.id)}
                  >
                    <span className="settings-nav-icon">{item.icon}</span>
                    <span className="settings-nav-label">{t(item.labelKey)}</span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </aside>

      <div className="settings-content">
        <div className="settings-content-inner">
          <h1 className="settings-section-title">{t(activeTitleKey)}</h1>

          {tab === "general" && settings && (
            <div className="settings-stack">
              <SettingsCard title={t("settings.appearance")}>
                <ThemeRow settings={settings} saveSettings={saveSettings} />
                <LanguageRow settings={settings} saveSettings={saveSettings} />
                <FontFamilyRow settings={settings} saveSettings={saveSettings} />
              </SettingsCard>

              {platform !== "darwin" && <CloseBehaviorSection />}
            </div>
          )}

          {tab === "ai" && settings && (
            <div className="settings-stack">
              <SettingsCard title={t("settings.permissions")}>
                <SettingsRow
                  title={t("settings.permissionMode")}
                  description={t("settings.permissionModeDesc")}
                >
                  <select
                    className="field-select"
                    aria-label={t("settings.permissionMode")}
                    value={settings.defaultPermissionMode ?? "ask"}
                    onChange={(e) =>
                      void saveSettings({
                        defaultPermissionMode: e.target.value as GlobalPermissionMode,
                      })
                    }
                  >
                    <option value="ask">{t("settings.permissionModeAsk")}</option>
                    <option value="accept-edits">
                      {t("settings.permissionModeAcceptEdits")}
                    </option>
                    <option value="auto">{t("settings.permissionModeAuto")}</option>
                  </select>
                </SettingsRow>
              </SettingsCard>

              <SettingsCard title={t("settings.defaultsTitle")}>
                <SettingsRow title={t("settings.mode")} description={t("settings.modeDesc")}>
                  <div
                    className="settings-segment"
                    role="group"
                    aria-label={t("settings.mode")}
                  >
                    {([
                      ["agent", "settings.modeAgent"],
                      ["plan", "settings.modePlan"],
                      ["goal", "settings.modeGoal"],
                    ] as const).map(([value, labelKey]) => (
                      <button
                        key={value}
                        type="button"
                        className={cx(
                          "settings-segment-item",
                          settings.defaultMode === value && "active",
                        )}
                        aria-pressed={settings.defaultMode === value}
                        onClick={() => void saveSettings({ defaultMode: value })}
                      >
                        {t(labelKey)}
                      </button>
                    ))}
                  </div>
                </SettingsRow>
                <CommandShellRow settings={settings} saveSettings={saveSettings} />
                <SettingsRow
                  title={t("settings.enterToSend")}
                  description={t("settings.enterToSendDesc")}
                >
                  <button
                    type="button"
                    className={cx("settings-toggle", settings.enterToSend && "on")}
                    role="switch"
                    aria-checked={settings.enterToSend}
                    aria-label={t("settings.enterToSend")}
                    onClick={() =>
                      void saveSettings({ enterToSend: !settings.enterToSend })
                    }
                  >
                    <span className="settings-toggle-thumb" />
                  </button>
                </SettingsRow>
                <LargePasteThresholdRow
                  settings={settings}
                  saveSettings={saveSettings}
                />
              </SettingsCard>
            </div>
          )}

          {tab === "shortcuts" && settings && (
            <div className="settings-stack">
              <KeyboardShortcutsSection
                settings={settings}
                platform={platform}
                saveSettings={saveSettings}
              />
            </div>
          )}

          {tab === "agent" && <ModelConfigPage />}

          {tab === "skills" && <AgentSkillsPage />}

          {tab === "mcp" && <AgentMcpPage />}

          {tab === "subagents" && <AgentSubagentsPage />}

          {tab === "instructions" && <AgentInstructionsSection />}

          {tab === "import" && <ImportSection />}

          {tab === "projects" && <ProjectsPage />}

          {tab === "about" && (
            <div className="settings-stack">
              <SettingsCard>
                <SettingsRow title={t("settings.application")} description={t("settings.applicationDesc")}>
                  <div className="settings-about-meta">
                    <div className="font-medium">
                      {version?.name || "PI-Desktop"} {version?.version}
                    </div>
                    <div className="font-mono text-xs-plus text-text-muted">
                      protocol {version?.protocolVersion} · host {version?.hostVersion}
                    </div>
                  </div>
                </SettingsRow>
                <SettingsRow title={t("settings.logs")} description={t("settings.logsDesc")}>
                  <Button variant="secondary" onClick={() => void api.openLogs()}>
                    {t("settings.openLogs")}
                  </Button>
                </SettingsRow>
                <SettingsRow
                  title={t("settings.feedback")}
                  description={t("settings.feedbackDesc")}
                >
                  <Button
                    variant="secondary"
                    onClick={() => void api.openFeedback().catch(() => undefined)}
                  >
                    {t("settings.openFeedback")}
                  </Button>
                </SettingsRow>
                <UpdatesRow currentVersion={version?.version} />
              </SettingsCard>

              {settings && (
                <DeveloperSection settings={settings} saveSettings={saveSettings} />
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

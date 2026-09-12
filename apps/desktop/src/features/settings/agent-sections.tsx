import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AgentInstructionFile } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";
import type { ImportCandidate, ModelConfigImportCandidate } from "../../lib/api";
import { useUpdateState } from "../../hooks/use-update-state";
import {
  DEFAULT_IMPORT_GROUP_BY,
  formatImportDate,
  groupImportCandidates,
  type ImportGroupBy,
} from "../../lib/import-groups";
import { Badge, Button, Select, cx } from "../../components/ui";
import { IconChevronLeft, IconFileText } from "../../components/icons";
import { ReleaseNotesDialog } from "../../components/ReleaseNotesDialog";
import { SettingsCard, SettingsRow } from "./primitives";

export function AgentInstructionsSection() {
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

export function UpdatesRow({ currentVersion }: { currentVersion?: string }) {
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

export function ImportSection() {
  return (
    <div className="settings-stack">
      <SessionImportPanel />
      <ModelConfigImportPanel />
    </div>
  );
}

export function SessionImportPanel() {
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
    <>
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
    </>
  );
}

function hostOf(baseUrl: string | null): string {
  if (!baseUrl) return "";
  try {
    return new URL(baseUrl).host || baseUrl;
  } catch {
    return baseUrl.replace(/^https?:\/\//, "").split("/")[0] || baseUrl;
  }
}

export function ModelConfigImportPanel() {
  const { t } = useTranslation();
  const refreshProviders = useAppStore((s) => s.refreshProviders);
  const showToast = useAppStore((s) => s.showToast);
  const [candidates, setCandidates] = useState<ModelConfigImportCandidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);

  const keyOf = (c: ModelConfigImportCandidate) => `${c.source}:${c.externalId}`;

  const scan = async () => {
    setScanning(true);
    try {
      const res = await api.scanImportModelConfigs();
      setCandidates(res.providers);
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
      const res = await api.runImportModelConfigs(items);
      await refreshProviders();
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

  const sourceLabels = useMemo(
    () => ({
      "claude-code": t("settings.importSourceClaudeCode"),
      opencode: t("settings.importSourceOpenCode"),
      codex: t("settings.importSourceCodex"),
      pi: t("settings.importSourcePi"),
      "cc-switch": t("settings.importSourceCcSwitch"),
    }),
    [t],
  );

  const groups = useMemo(() => {
    if (!candidates) return [];
    const grouped = new Map<ModelConfigImportCandidate["source"], ModelConfigImportCandidate[]>();
    for (const candidate of candidates) {
      const items = grouped.get(candidate.source) ?? [];
      items.push(candidate);
      grouped.set(candidate.source, items);
    }
    return [...grouped.entries()].map(([source, items]) => ({
      id: source,
      name: sourceLabels[source],
      items,
    }));
  }, [candidates, sourceLabels]);

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
    <>
      <SettingsCard title={t("settings.importModelsTitle")}>
        <SettingsRow
          title={t("settings.importScan")}
          description={t("settings.importModelsScanDesc")}
        >
          <Button variant="secondary" disabled={scanning} onClick={() => void scan()}>
            {scanning ? t("settings.importScanning") : t("settings.importScan")}
          </Button>
        </SettingsRow>
      </SettingsCard>

      {candidates !== null && (
        <SettingsCard>
          {candidates.length === 0 ? (
            <div className="settings-empty">{t("settings.importModelsNone")}</div>
          ) : (
            <>
              <div className="import-toolbar">
                <label className="import-select-all">
                  <input
                    type="checkbox"
                    aria-label={t("settings.importModelsSelectAll")}
                    checked={allSelected}
                    onChange={(e) => toggleKeys(allKeys, e.target.checked)}
                  />
                  <span>
                    {t("settings.importModelsFound", { count: candidates.length })}
                    {selected.size > 0
                      ? ` · ${t("settings.importSelectedCount", { count: selected.size })}`
                      : ""}
                  </span>
                </label>
                <div className="import-toolbar-actions">
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
                  const groupBodyId = `import-model-group-body-${groupIndex}`;
                  return (
                    <div key={group.id} className="import-group">
                      <div className="import-group-header">
                        <input
                          type="checkbox"
                          aria-label={t("settings.importModelsSelectGroup", { name: group.name })}
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
                          <span className="import-group-count">
                            {t("settings.importModelsFound", { count: group.items.length })}
                          </span>
                        </button>
                      </div>
                      {!isCollapsed && (
                        <div id={groupBodyId} className="import-group-body">
                          {group.items.map((c) => {
                            const k = keyOf(c);
                            const host = hostOf(c.baseUrl);
                            return (
                              <label key={k} className="import-row">
                                <input
                                  type="checkbox"
                                  checked={selected.has(k)}
                                  onChange={(e) => toggleKeys([k], e.target.checked)}
                                />
                                <span className="import-row-main">
                                  <span className="import-row-title">{c.name}</span>
                                  <span className="import-row-meta">
                                    {t("settings.importModelsCount", { count: c.modelIds.length })}
                                    {host ? ` · ${host}` : ""}
                                  </span>
                                </span>
                                <Badge tone={c.hasSecret ? "success" : "warning"}>
                                  {c.hasSecret
                                    ? t("settings.importModelsHasKey")
                                    : t("settings.importModelsNoKey")}
                                </Badge>
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
    </>
  );
}

/**
 * Developer mode gate: the console stays unreachable until the toggle is on,
 * which is also what unlocks F12 and the macOS View ▸ developer tools item
 * (enforced in the main process, not here).
 */

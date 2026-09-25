/**
 * Settings ▸ Import.
 *
 * One workbench for everything this machine can hand over: sessions, provider
 * and model configuration, skills, and MCP servers. A tab per kind means a
 * scan result survives a switch; the active kind owns one toolbar (select-all
 * with both counts, its own options, rescan, import selected) and one list
 * panel whose group headers are quiet label lines and whose rows are
 * individual tiles — the same rhythm as the agent capability destinations.
 *
 * Every kind keeps its own explicit scan: switching tabs never starts one.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type {
  ExternalMcpCandidate,
  ExternalMcpImportItem,
  ExternalMcpScanResult,
  ExternalMcpSourceKind,
  ExternalSkillCandidate,
  ExternalSkillImportItem,
  ExternalSkillScanResult,
  ExternalSkillSourceKind,
  ImportCandidate,
  ModelConfigImportCandidate,
} from "../../lib/api";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import {
  DEFAULT_IMPORT_GROUP_BY,
  formatImportDate,
  groupImportCandidates,
  type ImportGroupBy,
} from "../../lib/import-groups";
import { Badge, Button, HelpIcon, SegmentedControl, cx } from "../../components/ui";
import { IconChevronLeft, IconDownload } from "../../components/icons";
import { SettingsMenuSelect } from "../../components/settings/SettingsMenuSelect";

type ImportKind = "sessions" | "models" | "skills" | "mcp";

/**
 * Tab labels reuse the sessions / models / skills / MCP labels the sidebar and
 * the settings rail already ship, so the switcher adds no catalog entries and
 * cannot drift from the destination it mirrors.
 */
const IMPORT_KINDS: readonly { id: ImportKind; labelKey: string }[] = [
  { id: "sessions", labelKey: "nav.sessions" },
  { id: "models", labelKey: "settings.nav.models" },
  { id: "skills", labelKey: "settings.nav.skills" },
  { id: "mcp", labelKey: "settings.nav.mcp" },
];

export function ImportSection() {
  const { t } = useTranslation();
  const [kind, setKind] = useState<ImportKind>("sessions");

  return (
    <div className="import-page">
      <SegmentedControl
        value={kind}
        onChange={(value) => setKind(value)}
        options={IMPORT_KINDS.map((entry) => ({
          value: entry.id,
          label: t(entry.labelKey),
          id: `import-tab-${entry.id}`,
          controls: `import-panel-${entry.id}`,
        }))}
        label={t("settings.import")}
        role="tablist"
        className="import-segment"
        itemClassName="import-segment-btn"
      />

      {IMPORT_KINDS.map((entry) => (
        <div
          key={entry.id}
          className="import-view"
          id={`import-panel-${entry.id}`}
          role="tabpanel"
          aria-labelledby={`import-tab-${entry.id}`}
          hidden={kind !== entry.id}
        >
          <ImportKindPanel kind={entry.id} />
        </div>
      ))}
    </div>
  );
}

/**
 * The four workbenches stay mounted: `hidden` only takes one out of view, so a
 * scan result and its selection survive a tab switch.
 */
function ImportKindPanel({ kind }: { kind: ImportKind }) {
  if (kind === "sessions") return <SessionImportPanel />;
  if (kind === "models") return <ModelConfigImportPanel />;
  if (kind === "skills") return <SkillsScanImportPanel />;
  return <McpScanImportPanel />;
}

/* ---------------------------------------------------------------------------
 * Shared page anatomy
 * ------------------------------------------------------------------------- */

/**
 * The only action row on a kind: both counts behind the select-all control,
 * kind options and the two actions on the right. `found` is the kind's own
 * localized sentence, so the row never needs a per-kind copy of itself.
 */
function ImportToolbar({
  found,
  selectedCount,
  allSelected,
  selectAllLabel,
  onToggleAll,
  scanning,
  importing,
  onScan,
  onImport,
  options,
  hint,
}: {
  found: string;
  selectedCount: number;
  allSelected: boolean;
  selectAllLabel: string;
  onToggleAll: (on: boolean) => void;
  scanning: boolean;
  importing: boolean;
  onScan: () => void;
  onImport: () => void;
  /** Kind-specific control in front of the actions, e.g. grouping or mode. */
  options?: ReactNode;
  /** The current result set's caveat (a source cap), on demand. */
  hint?: string;
}) {
  const { t } = useTranslation();
  const selectAllRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const node = selectAllRef.current;
    if (node) node.indeterminate = selectedCount > 0 && !allSelected;
  }, [selectedCount, allSelected]);

  return (
    <div className="import-toolbar">
      <label className="import-select-all">
        <input
          ref={selectAllRef}
          type="checkbox"
          checked={allSelected}
          aria-label={selectAllLabel}
          onChange={(event) => onToggleAll(event.target.checked)}
        />
        <span className="import-count">
          <span className="import-count-found">{found}</span>
          {selectedCount > 0 ? (
            <span className="import-count-selected">
              {t("settings.importSelectedCount", { count: selectedCount })}
            </span>
          ) : null}
        </span>
      </label>
      <div className="import-toolbar-actions">
        {options}
        {hint ? <HelpIcon label={hint} /> : null}
        <Button
          variant="secondary"
          disabled={scanning}
          aria-busy={scanning || undefined}
          onClick={onScan}
        >
          {scanning ? t("settings.importScanning") : t("settings.importScan")}
        </Button>
        <Button
          variant="primary"
          disabled={importing || selectedCount === 0}
          aria-busy={importing || undefined}
          onClick={onImport}
        >
          {importing
            ? t("settings.importing")
            : t("settings.importSelected", { count: selectedCount })}
        </Button>
      </div>
    </div>
  );
}

/** A labelled menu select inside the toolbar, for grouping or import mode. */
function ImportOption({
  label,
  value,
  options,
  hint,
  onChange,
}: {
  label: string;
  value: string;
  options: { id: string; label: string }[];
  /** Explains the choice, reached from the label's help icon. */
  hint?: string;
  onChange: (id: string) => void;
}) {
  return (
    <label className="import-option">
      <span className="import-option-label">
        {label}
        {hint ? <HelpIcon label={hint} /> : null}
      </span>
      <SettingsMenuSelect
        className="import-option-select"
        label={label}
        value={value}
        options={options}
        onChange={onChange}
      />
    </label>
  );
}

/** One group: a quiet label line that also discloses its rows. */
function ImportGroup({
  bodyId,
  name,
  path,
  count,
  countLabel,
  expanded,
  onToggle,
  selection,
  children,
}: {
  bodyId: string;
  name: string;
  /** Exact project path, or the resolved config path, when the group has one. */
  path?: string | null;
  count: number;
  countLabel: string;
  expanded: boolean;
  onToggle: () => void;
  /** Kinds whose groups are selectable render the leading checkbox. */
  selection?: {
    label: string;
    checked: boolean;
    indeterminate: boolean;
    onChange: (on: boolean) => void;
  };
  children: ReactNode;
}) {
  return (
    <section className="import-group">
      <div className="import-group-header">
        {selection ? (
          <input
            type="checkbox"
            checked={selection.checked}
            aria-label={selection.label}
            ref={(node) => {
              if (node) node.indeterminate = selection.indeterminate;
            }}
            onChange={(event) => selection.onChange(event.target.checked)}
          />
        ) : null}
        <button
          type="button"
          className="import-group-toggle"
          aria-controls={bodyId}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <span
            className={cx("import-group-chevron", !expanded && "collapsed")}
            aria-hidden
          >
            <IconChevronLeft size={13} />
          </span>
          <span className="import-group-name">{name}</span>
          {path ? (
            <code className="import-group-path" title={path}>
              {path}
            </code>
          ) : null}
          <span className="import-group-count" title={countLabel}>
            {count}
          </span>
        </button>
      </div>
      {expanded ? (
        <div id={bodyId} className="import-group-body">
          {children}
        </div>
      ) : null}
    </section>
  );
}

/**
 * One candidate. The checkbox, the identity, and the row's own badge are the
 * whole anatomy, so every kind reads the same way.
 */
function ImportRow({
  title,
  meta,
  checked,
  onChange,
  badge,
}: {
  title: string;
  meta: ReactNode;
  checked: boolean;
  onChange: (on: boolean) => void;
  badge?: ReactNode;
}) {
  return (
    <label className="import-row">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="import-row-main">
        <span className="import-row-title">{title}</span>
        <span className="import-row-meta">{meta}</span>
      </span>
      {badge}
    </label>
  );
}

/**
 * Pre-scan state: what the scan will look at, and the action that starts it.
 * Empty states carry no filler, so a kind without a description shows only the
 * glyph and the action.
 */
function ImportIdle({
  description,
  note,
  onScan,
  scanning,
}: {
  description?: string;
  note?: string;
  onScan: () => void;
  scanning: boolean;
}) {
  const { t } = useTranslation();
  const help = [description, note].filter(Boolean).join(" · ");
  return (
    <div className="settings-panel import-panel">
      <div className="import-idle">
        <span className="import-idle-glyph" aria-hidden>
          <IconDownload size={20} />
        </span>
        <div className="import-idle-actions">
          <Button variant="secondary" disabled={scanning} onClick={onScan}>
            {scanning ? t("settings.importScanning") : t("settings.importScan")}
          </Button>
          {help ? <HelpIcon label={help} /> : null}
        </div>
      </div>
    </div>
  );
}

/** The result surface: rows when a scan found something, a line when it did not. */
function ImportResults({ message, children }: { message?: string; children?: ReactNode }) {
  return (
    <div className="settings-panel import-panel">
      {message ? <p className="import-empty">{message}</p> : children}
    </div>
  );
}

/**
 * Clears a selection when the underlying candidate set is replaced.
 * `keyOf` stays with the caller so every kind keeps its own identity rule.
 */
function toggleKey(previous: Set<string>, key: string, on: boolean): Set<string> {
  const next = new Set(previous);
  if (on) next.add(key);
  else next.delete(key);
  return next;
}


/**
 * Group disclosure. Groups start expanded — the found candidates are the
 * answer to a scan — and every kind's label line discloses its own rows, so all
 * four read the same way.
 */
function useGroupDisclosure() {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  return {
    isExpanded: (id: string) => !collapsed.has(id),
    toggle: (id: string) =>
      setCollapsed((previous) =>
        previous.has(id)
          ? new Set([...previous].filter((entry) => entry !== id))
          : new Set([...previous, id]),
      ),
    reset: () => setCollapsed(new Set()),
  };
}
/* ---------------------------------------------------------------------------
 * Sessions
 * ------------------------------------------------------------------------- */

export function SessionImportPanel() {
  const { t, i18n } = useTranslation();
  const refreshSessions = useAppStore((s) => s.refreshSessions);
  const showToast = useAppStore((s) => s.showToast);
  const [candidates, setCandidates] = useState<ImportCandidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupBy, setGroupBy] = useState<ImportGroupBy>(DEFAULT_IMPORT_GROUP_BY);
  const disclosure = useGroupDisclosure();
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [codexCap, setCodexCap] = useState<number | null>(null);


  const keyOf = (candidate: ImportCandidate) =>
    `${candidate.source}:${candidate.externalId}`;

  const scan = async () => {
    setScanning(true);
    try {
      const res = await api.scanImportSessions();
      setCandidates(res.sessions);
      setCodexCap(typeof res.truncated?.codex === "number" ? res.truncated.codex : null);
      setSelected(new Set());
      disclosure.reset();

    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setScanning(false);
    }
  };

  const runImport = async () => {
    if (!candidates) return;
    const items = candidates.filter((candidate) => selected.has(keyOf(candidate)));
    if (items.length === 0) return;
    setImporting(true);
    try {
      const res = await api.runImportSessions(items);
      await refreshSessions({ revealImportedProjects: true });
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
      } as Record<ImportCandidate["source"], string>,
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
    setSelected((previous) => {
      const next = new Set(previous);
      for (const key of keys) {
        if (on) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  };

  return (
    <div className="import-workbench">
      {candidates === null ? (
        <ImportIdle
          note={importLabels.sources && [
            importLabels.sources["claude-code"],
            importLabels.sources.opencode,
            importLabels.sources.codex,
            importLabels.sources.pi,
          ].join(" · ")}
          onScan={() => void scan()}
          scanning={scanning}
        />
      ) : (
        <>
          <ImportToolbar
            found={t("settings.importFound", { count: candidates.length })}
            selectedCount={selected.size}
            allSelected={allSelected}
            selectAllLabel={t("settings.importSelectAll")}
            onToggleAll={(on) => toggleKeys(allKeys, on)}
            scanning={scanning}
            importing={importing}
            onScan={() => void scan()}
            onImport={() => void runImport()}
            hint={
              codexCap != null
                ? t("settings.importCodexCapped", { limit: codexCap })
                : undefined
            }
            options={
              <ImportOption
                label={t("settings.importGroupBy")}
                value={groupBy}
                onChange={(id) => {
                  setGroupBy(id as ImportGroupBy);
                  disclosure.reset();
                }}
                options={[
                  { id: "source", label: t("settings.importGroupBySource") },
                  { id: "path", label: t("settings.importGroupByPath") },
                ]}
              />
            }
          />
          <ImportResults
            message={
              candidates.length === 0 ? t("settings.importNone") : undefined
            }
          >
            <div className="import-groups">

              {groups.map((group, groupIndex) => {
                const groupKeys = group.items.map(keyOf);
                const groupSelected = groupKeys.filter((k) => selected.has(k)).length;
                const bodyId = `import-session-group-${groupIndex}`;
                return (
                  <ImportGroup
                    key={group.id}
                    bodyId={bodyId}
                    name={group.name}
                    path={group.projectPath}
                    count={group.items.length}
                    countLabel={t("settings.importSessionCount", {
                      count: group.items.length,
                    })}
                    expanded={disclosure.isExpanded(group.id)}
                    onToggle={() => disclosure.toggle(group.id)}
                    selection={{
                      label: t("settings.importSelectGroup", { name: group.name }),
                      checked: groupSelected === groupKeys.length,
                      indeterminate:
                        groupSelected > 0 && groupSelected < groupKeys.length,
                      onChange: (on) => toggleKeys(groupKeys, on),
                    }}
                  >
                    {group.items.map((candidate) => {
                      const key = keyOf(candidate);
                      return (
                        <ImportRow
                          key={key}
                          title={candidate.title}
                          meta={`${
                            candidate.messageCount === null
                              ? t("settings.importMessagesUnknown")
                              : t("settings.importMessages", {
                                  count: candidate.messageCount,
                                })
                          } · ${formatImportDate(
                            candidate.updatedAt,
                            i18n.resolvedLanguage || i18n.language,
                          )}`}
                          checked={selected.has(key)}
                          onChange={(on) => setSelected((previous) => toggleKey(previous, key, on))}
                          badge={
                            <Badge tone="neutral">
                              {importLabels.sources[candidate.source]}
                            </Badge>
                          }
                        />
                      );
                    })}
                  </ImportGroup>
                );
              })}
            </div>
          </ImportResults>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Provider and model configuration
 * ------------------------------------------------------------------------- */

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
  const [candidates, setCandidates] = useState<ModelConfigImportCandidate[] | null>(
    null,
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const disclosure = useGroupDisclosure();
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);

  const keyOf = (candidate: ModelConfigImportCandidate) =>
    `${candidate.source}:${candidate.externalId}`;

  const scan = async () => {
    setScanning(true);
    try {
      const res = await api.scanImportModelConfigs();
      setCandidates(res.providers);
      setSelected(new Set());
      disclosure.reset();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setScanning(false);
    }
  };

  const runImport = async () => {
    if (!candidates) return;
    const items = candidates.filter((candidate) => selected.has(keyOf(candidate)));
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

  const sourceLabels: Record<ModelConfigImportCandidate["source"], string> = useMemo(
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
    const grouped = new Map<
      ModelConfigImportCandidate["source"],
      ModelConfigImportCandidate[]
    >();
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
    setSelected((previous) => {
      const next = new Set(previous);
      for (const key of keys) {
        if (on) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  };

  return (
    <div className="import-workbench">
      {candidates === null ? (
        <ImportIdle
          description={t("settings.importModelsScanDesc")}
          onScan={() => void scan()}
          scanning={scanning}
        />
      ) : (
        <>
          <ImportToolbar
            found={t("settings.importModelsFound", { count: candidates.length })}
            selectedCount={selected.size}
            allSelected={allSelected}
            selectAllLabel={t("settings.importModelsSelectAll")}
            onToggleAll={(on) => toggleKeys(allKeys, on)}
            scanning={scanning}
            importing={importing}
            onScan={() => void scan()}
            onImport={() => void runImport()}
          />
          <ImportResults
            message={
              candidates.length === 0 ? t("settings.importModelsNone") : undefined
            }
          >
            <div className="import-groups">
              {groups.map((group, groupIndex) => {
                const groupKeys = group.items.map(keyOf);
                const groupSelected = groupKeys.filter((k) => selected.has(k)).length;
                const bodyId = `import-model-group-${groupIndex}`;
                return (
                  <ImportGroup
                    key={group.id}
                    bodyId={bodyId}
                    name={group.name}
                    count={group.items.length}
                    countLabel={t("settings.importModelsFound", {
                      count: group.items.length,
                    })}
                    expanded={disclosure.isExpanded(group.id)}
                    onToggle={() => disclosure.toggle(group.id)}
                    selection={{
                      label: t("settings.importModelsSelectGroup", { name: group.name }),
                      checked: groupSelected === groupKeys.length,
                      indeterminate:
                        groupSelected > 0 && groupSelected < groupKeys.length,
                      onChange: (on) => toggleKeys(groupKeys, on),
                    }}
                  >
                    {group.items.map((candidate) => {
                      const key = keyOf(candidate);
                      const host = hostOf(candidate.baseUrl);
                      return (
                        <ImportRow
                          key={key}
                          title={candidate.name}
                          meta={`${t("settings.importModelsCount", {
                            count: candidate.modelIds.length,
                          })}${host ? ` · ${host}` : ""}`}
                          checked={selected.has(key)}
                          onChange={(on) => setSelected((previous) => toggleKey(previous, key, on))}
                          badge={
                            <Badge tone={candidate.hasSecret ? "success" : "warning"}>
                              {candidate.hasSecret
                                ? t("settings.importModelsHasKey")
                                : t("settings.importModelsNoKey")}
                            </Badge>
                          }
                        />
                      );
                    })}
                  </ImportGroup>
                );
              })}
            </div>
          </ImportResults>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Skills and MCP servers scanned from the other agent tools on this machine
 * ------------------------------------------------------------------------- */

const SKILL_SOURCE_KEY: Record<ExternalSkillSourceKind, string> = {
  "claude-user": "settings.importAgentScanSourceClaudeUser",
  "claude-project": "settings.importAgentScanSourceClaudeProject",
  "pi-user": "settings.importAgentScanSourcePiUser",
  "pi-project": "settings.importAgentScanSourcePiProject",
};

const MCP_SOURCE_KEY: Record<ExternalMcpSourceKind, string> = {
  "claude-desktop": "settings.importAgentScanSourceClaudeDesktop",
  "claude-code": "settings.importAgentScanSourceClaudeCode",
  "cursor-global": "settings.importAgentScanSourceCursorGlobal",
  "cursor-project": "settings.importAgentScanSourceCursorProject",
  codex: "settings.importAgentScanSourceCodex",
  opencode: "settings.importAgentScanSourceOpenCode",
  "chatgpt-desktop": "settings.importAgentScanSourceChatgpt",
};

function groupBySource<C extends { source: string }>(
  candidates: C[],
): Array<{ id: string; items: C[] }> {
  const map = new Map<string, C[]>();
  for (const candidate of candidates) {
    const bucket = map.get(candidate.source);
    if (bucket) bucket.push(candidate);
    else map.set(candidate.source, [candidate]);
  }
  return Array.from(map.entries()).map(([id, items]) => ({ id, items }));
}

export function SkillsScanImportPanel() {
  const { t } = useTranslation();
  const showToast = useAppStore((s) => s.showToast);
  const [result, setResult] = useState<ExternalSkillScanResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const disclosure = useGroupDisclosure();
  const [mode, setMode] = useState<"copy" | "link">("copy");
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);

  const keyOf = (candidate: ExternalSkillCandidate) =>
    `${candidate.source}:${candidate.sourcePath}`;

  const scan = async () => {
    setScanning(true);
    try {
      const res = await api.scanExternalSkills();
      setResult(res);
      setSelected(new Set());
      disclosure.reset();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setScanning(false);
    }
  };

  const runImport = async () => {
    if (!result) return;
    const items: ExternalSkillImportItem[] = result.candidates
      .filter((candidate) => selected.has(keyOf(candidate)))
      .map((candidate) => ({
        source: candidate.source,
        sourcePath: candidate.sourcePath,
        shape: candidate.shape,
        rootDir: candidate.rootDir,
        id: candidate.id,
        name: candidate.name,
        description: candidate.description,
      }));
    if (items.length === 0) return;
    setImporting(true);
    try {
      const res = await api.runExternalSkillsImport({
        level: "global",
        mode,
        items,
      });
      showToast(
        t("settings.importAgentScanResult", {
          imported: res.imported.length,
          skipped: res.skipped.length,
          failed: res.failed.length,
        }),
        { variant: res.failed.length > 0 ? "error" : "success" },
      );
      // Refresh the scan so already-imported rows disappear next round.
      await scan();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setImporting(false);
    }
  };

  const groups = useMemo(() => groupBySource(result?.candidates ?? []), [result]);
  const allKeys = useMemo(
    () => (result?.candidates ?? []).map(keyOf),
    [result],
  );
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selected.has(k));

  return (
    <div className="import-workbench">
      {result === null ? (
        <ImportIdle
          description={t("settings.importAgentSkillsDesc")}
          onScan={() => void scan()}
          scanning={scanning}
        />
      ) : (
        <>
          <ImportToolbar
            found={t("settings.importAgentScanFoundSkills", {
              count: result.candidates.length,
            })}
            selectedCount={selected.size}
            allSelected={allSelected}
            selectAllLabel={t("settings.importSelectAll")}
            onToggleAll={(on) => setSelected(on ? new Set(allKeys) : new Set())}
            scanning={scanning}
            importing={importing}
            onScan={() => void scan()}
            onImport={() => void runImport()}
            options={
              <ImportOption
                label={t("settings.importAgentScanMode")}
                value={mode}
                onChange={(id) => setMode(id as "copy" | "link")}
                hint={t("settings.importAgentScanModeHint")}
                options={[
                  { id: "copy", label: t("settings.importAgentScanModeCopy") },
                  { id: "link", label: t("settings.importAgentScanModeLink") },
                ]}
              />
            }
          />
          <ImportResults
            message={
              result.candidates.length === 0
                ? t("settings.importAgentScanNone")
                : undefined
            }
          >
            <div className="import-groups">
              {groups.map((group, groupIndex) => (
                <ImportGroup
                  key={group.id}
                  bodyId={`import-skill-group-${groupIndex}`}
                  name={t(
                    SKILL_SOURCE_KEY[group.id as ExternalSkillSourceKind] ??
                      "settings.importSourcePi",
                  )}
                  count={group.items.length}
                  countLabel={t("settings.importAgentScanFoundSkills", {
                    count: group.items.length,
                  })}
                  expanded={disclosure.isExpanded(group.id)}
                  onToggle={() => disclosure.toggle(group.id)}
                >
                  {group.items.map((candidate) => {
                    const key = keyOf(candidate);
                    return (
                      <ImportRow
                        key={key}
                        title={candidate.name || candidate.id}
                        meta={candidate.description || candidate.sourcePath}
                        checked={selected.has(key)}
                        onChange={(on) => setSelected((previous) => toggleKey(previous, key, on))}
                        badge={
                          <Badge tone="neutral">
                            {candidate.shape === "dir"
                              ? t("settings.importAgentScanShapeDir")
                              : t("settings.importAgentScanShapeFile")}
                          </Badge>
                        }
                      />
                    );
                  })}
                </ImportGroup>
              ))}
            </div>
          </ImportResults>
        </>
      )}
    </div>
  );
}

export function McpScanImportPanel() {
  const { t } = useTranslation();
  const showToast = useAppStore((s) => s.showToast);
  const [result, setResult] = useState<ExternalMcpScanResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const disclosure = useGroupDisclosure();
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);

  const keyOf = (candidate: ExternalMcpCandidate) =>
    `${candidate.source}:${candidate.id}`;

  const scan = async () => {
    setScanning(true);
    try {
      const res = await api.scanExternalMcp();
      setResult(res);
      setSelected(new Set());
      disclosure.reset();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setScanning(false);
    }
  };

  const runImport = async () => {
    if (!result) return;
    const items: ExternalMcpImportItem[] = result.candidates
      .filter((candidate) => selected.has(keyOf(candidate)))
      .map((candidate) => ({
        source: candidate.source,
        sourcePath: candidate.sourcePath,
        id: candidate.id,
        rawKey: candidate.rawKey,
        label: candidate.label,
        description: candidate.description,
        transport: candidate.transport,
        command: candidate.command,
        args: candidate.args,
        env: candidate.env,
        url: candidate.url,
        headers: candidate.headers,
        disabled: candidate.disabled,
      }));
    if (items.length === 0) return;
    setImporting(true);
    try {
      const res = await api.runExternalMcpImport({ items });
      showToast(
        t("settings.importAgentScanResult", {
          imported: res.imported.length,
          skipped: res.skipped.length,
          failed: res.failed.length,
        }),
        { variant: res.failed.length > 0 ? "error" : "success" },
      );
      await scan();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setImporting(false);
    }
  };

  const groups = useMemo(() => groupBySource(result?.candidates ?? []), [result]);
  const allKeys = useMemo(
    () => (result?.candidates ?? []).map(keyOf),
    [result],
  );
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selected.has(k));

  return (
    <div className="import-workbench">
      {result === null ? (
        <ImportIdle
          description={t("settings.importAgentMcpDesc")}
          onScan={() => void scan()}
          scanning={scanning}
        />
      ) : (
        <>
          <ImportToolbar
            found={t("settings.importAgentScanFoundMcp", {
              count: result.candidates.length,
            })}
            selectedCount={selected.size}
            allSelected={allSelected}
            selectAllLabel={t("settings.importSelectAll")}
            onToggleAll={(on) => setSelected(on ? new Set(allKeys) : new Set())}
            scanning={scanning}
            importing={importing}
            onScan={() => void scan()}
            onImport={() => void runImport()}
          />
          <ImportResults
            message={
              result.candidates.length === 0
                ? t("settings.importAgentScanNone")
                : undefined
            }
          >
            <div className="import-groups">
              {groups.map((group, groupIndex) => (
                <ImportGroup
                  key={group.id}
                  bodyId={`import-mcp-group-${groupIndex}`}
                  name={t(
                    MCP_SOURCE_KEY[group.id as ExternalMcpSourceKind] ??
                      "settings.importSourcePi",
                  )}
                  count={group.items.length}
                  countLabel={t("settings.importAgentScanFoundMcp", {
                    count: group.items.length,
                  })}
                  expanded={disclosure.isExpanded(group.id)}
                  onToggle={() => disclosure.toggle(group.id)}
                >
                  {group.items.map((candidate) => {
                    const key = keyOf(candidate);
                    return (
                      <ImportRow
                        key={key}
                        title={candidate.label || candidate.id}
                        meta={
                          candidate.description ||
                          candidate.command ||
                          candidate.url ||
                          candidate.sourcePath
                        }
                        checked={selected.has(key)}
                        onChange={(on) => setSelected((previous) => toggleKey(previous, key, on))}
                        badge={
                          <Badge tone="neutral">
                            {candidate.transport === "http"
                              ? t("settings.importAgentScanTransportHttp")
                              : t("settings.importAgentScanTransportStdio")}
                          </Badge>
                        }
                      />
                    );
                  })}
                </ImportGroup>
              ))}
            </div>
          </ImportResults>
        </>
      )}
    </div>
  );
}

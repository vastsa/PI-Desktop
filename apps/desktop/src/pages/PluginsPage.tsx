import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../stores/app-store";
import { api } from "../lib/api";
import { Button, cx } from "../components/ui";
import {
  IconCheck,
  IconCircleAlert,
  IconCloudDown,
  IconChevronDown,
  IconDownload,
  IconLink,
  IconMore,
  IconPanel,
  IconPlug,
  IconReview,
  IconSearch,
  IconSettings,
  IconShield,
  IconSparkles,
  IconTrash,
  IconTriangleAlert,
  IconX,
} from "../components/icons";
import { Markdown } from "../components/Markdown";
import { ScopeControl } from "../components/extensions/ScopeControl";
import { MarketplaceSourceSettings } from "../components/plugins/MarketplaceSourceSettings";
import { PluginSettingsSheet } from "../components/plugins/PluginSettingsSheet";
import type {
  ActivationScope,
  MarketPluginDetail,
  MarketPluginSummary,
  PluginCapability,
  PluginFsPolicy,
  PluginServiceStatus,
  PluginSummary,
  ProjectRecord,
  ProjectWorkspace,
} from "@pi-desktop/shared";

/** Plugins has two tabs only; agent capabilities live under Settings > Agent. */
type TabId = "installed" | "market";

/**
 * Always-visible sections of the installed index. Broken plugins come first and
 * pending updates second, so the two states that need a decision are never
 * buried under the plugins that are simply working.
 */
type GroupId = "attention" | "updates" | "active" | "disabled";

const GROUP_ORDER: GroupId[] = ["attention", "updates", "active", "disabled"];

/**
 * Rough height of the row overflow menu (two items plus a separator). When the
 * trigger sits closer than this to the viewport bottom the menu flips upwards.
 */
const ROW_MENU_HEIGHT = 108;

const GROUP_LABEL_KEYS: Record<GroupId, string> = {
  attention: "plugins.groupAttention",
  updates: "plugins.groupUpdates",
  active: "plugins.groupActive",
  disabled: "plugins.groupDisabled",
};

/** Mirrors TEMPLATE_NAMES in @pi-desktop/plugin-devkit; main rejects anything else. */
const TEMPLATE_IDS = [
  "panel-basic",
  "agent-tool-basic",
  "skill-pack",
  "full-demo",
] as const;

type TemplateId = (typeof TEMPLATE_IDS)[number];

type RiskTier = "high" | "medium" | "low";

/** Mirrors the risk column of docs/spec/07-plugins/13-plugin-permissions-matrix.md. */
const PERMISSION_RISK: Record<string, RiskTier> = {
  "net.fetch": "high",
  "fs.write": "high",
  "fs.delete": "high",
  "fs.write.workspace": "high",
  "fs.delete.workspace": "high",
  "agent.prompt.inject": "high",
  "agent.tool.register": "high",
  // Reading is a tier below writing because what makes a read dangerous is
  // where the data can go, and outbound requests are declared separately.
  "fs.read": "medium",
  "fs.read.workspace": "medium",
  "clipboard.read": "medium",
  "clipboard.write": "medium",
  "shell.openExternal": "medium",
  "mcp.server.local": "high",
  "mcp.server.remote": "high",
  "background.service": "high",
  "bus.publish": "medium",
  "bus.subscribe": "medium",
  "ui.panel": "low",
  "ui.theme": "low",
  notify: "low",
};

/** Display order for capability badges: what it adds before what it runs. */
const CAPABILITY_ORDER: PluginCapability[] = [
  "panel",
  "commands",
  "tools",
  "skills",
  "themes",
  "mcp",
  "services",
  "bus",
];

/** File modes in escalating order, so a row reads read → write → delete. */
const FS_MODES = ["read", "write", "delete"] as const;

/** Permission names that predate scopes; the host cuts these back on load. */
const LEGACY_FS_PERMISSIONS = [
  "fs.read.workspace",
  "fs.write.workspace",
  "fs.delete.workspace",
];

const RISK_TIERS: RiskTier[] = ["high", "medium", "low"];

const RISK_WEIGHT: Record<RiskTier, number> = { high: 0, medium: 1, low: 2 };

const RISK_LABEL_KEYS: Record<RiskTier, string> = {
  high: "plugins.riskHigh",
  medium: "plugins.riskMedium",
  low: "plugins.riskLow",
};

/** Chips rendered in row details or cards before collapsing into a "+N" counter. */
const INLINE_PERMISSION_LIMIT = 3;

/**
 * An unrecognized permission counts as high risk: a capability the matrix does
 * not classify must never read as safer than one it does.
 */
function permissionRisk(key: string): RiskTier {
  return PERMISSION_RISK[key] ?? "high";
}

function permissionLabel(key: string, t: (k: string, o?: any) => string): string {
  return t(`plugins.permissions.${key}`, { defaultValue: key });
}

/** Deduplicates permissions and orders them by descending risk, then by label. */
function orderPermissions(permissions: readonly string[] | undefined): string[] {
  return [...new Set(permissions ?? [])].sort(
    (a, b) =>
      RISK_WEIGHT[permissionRisk(a)] - RISK_WEIGHT[permissionRisk(b)] ||
      a.localeCompare(b),
  );
}

function formatBytes(size?: number): string {
  if (!size || size <= 0) return "—";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDate(value: string | undefined, locale: string): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  try {
    return new Intl.DateTimeFormat(locale || undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(parsed);
  } catch {
    return parsed.toLocaleDateString();
  }
}

function shortSha(value?: string): string {
  if (!value) return "—";
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

/**
 * A catalog version is installable only once its package is published and
 * while it is still offered. The host refuses the download otherwise, so every
 * install affordance reads this instead of offering a button that can only
 * fail.
 */
function versionInstallable(
  version?: { url?: string; shasum?: string; yanked?: boolean } | null,
): boolean {
  return !!version?.url?.trim() && !!version?.shasum?.trim() && !version.yanked;
}

/**
 * Withdrawn is a different refusal from not-yet-published: the version existed
 * and was pulled, so the sheet explains it rather than telling the user to wait
 * for an upload that will never come.
 */
function versionWithdrawn(version?: { yanked?: boolean } | null): boolean {
  return !!version?.yanked;
}

/**
 * Whether a marketplace entry may render the verified shield.
 *
 * Catalog v2 carries an explicit tier that only the plugin center can issue,
 * and the host already downgrades a claim it cannot attribute to the official
 * source. A v1 entry has no tier, so its maintainer-written boolean still
 * decides. Rendering `trust` first keeps the badge from being something a
 * publisher can grant themselves.
 */
function showsVerifiedBadge(entry?: { trust?: string; verified?: boolean } | null): boolean {
  if (!entry) return false;
  if (entry.trust) return entry.trust === "verified";
  return !!entry.verified;
}

/** Single-glyph stand-in for a marketplace icon we deliberately do not fetch. */
function monogram(name: string): string {
  const first = [...name.trim()][0];
  return first ? first.toLocaleUpperCase() : "?";
}

function matchesQuery(query: string, ...fields: Array<string | undefined>): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return fields.some((field) => field?.toLocaleLowerCase().includes(needle));
}

/** Development-only sample plugins are fixtures, not client product offerings. */
function isClientVisibleMarketPlugin(plugin: Pick<MarketPluginSummary, "id">): boolean {
  return !plugin.id.startsWith("demo.");
}

function groupOf(plugin: PluginSummary): GroupId {
  if (plugin.status === "error" || plugin.status === "load_error") return "attention";
  if (plugin.updateAvailable) return "updates";
  return plugin.enabled ? "active" : "disabled";
}

/** Risk-tinted permission chips with an overflow counter. */
function PermissionChips({
  permissions,
  limit = INLINE_PERMISSION_LIMIT,
}: {
  permissions: readonly string[] | undefined;
  limit?: number;
}) {
  const { t } = useTranslation();
  const ordered = orderPermissions(permissions);
  if (ordered.length === 0) {
    return <span className="plugins-perm-none">{t("plugins.noPermissions")}</span>;
  }
  const shown = ordered.slice(0, limit);
  const hidden = ordered.length - shown.length;
  return (
    <span className="plugins-perm-chips">
      {shown.map((permission) => (
        <span
          key={permission}
          className={cx("plugins-perm-chip", `risk-${permissionRisk(permission)}`)}
          title={t(`plugins.permissionHelp.${permission}`, { defaultValue: permission })}
        >
          {permissionLabel(permission, t)}
        </span>
      ))}
      {hidden > 0 ? (
        <span
          className="plugins-perm-chip is-more"
          title={ordered
            .slice(limit)
            .map((permission) => permissionLabel(permission, t))
            .join(" · ")}
        >
          {t("plugins.permsMore", { count: hidden })}
        </span>
      ) : null}
    </span>
  );
}

/**
 * `manifest.fs` read back to the user. A permission says the plugin may touch
 * files; this says which ones, and it is the only place that distinction is
 * visible outside the manifest.
 */
function FsScopeChips({ policy }: { policy: PluginFsPolicy | undefined }) {
  const { t } = useTranslation();
  const chips = FS_MODES.flatMap((mode) => {
    const rule = policy?.[mode];
    if (!rule) return [];
    const parts: string[] = [];
    if (rule.root === "userSelected") parts.push(t("plugins.fsRootPicked"));
    if (rule.scope?.length) parts.push(rule.scope.join(" · "));
    if (rule.own) parts.push(t("plugins.fsOwnFiles"));
    // No standing reach at all: every access stops at a confirmation.
    if (!parts.length) parts.push(t("plugins.fsAsksEachTime"));
    return [{ mode, text: `${t(`plugins.fsMode.${mode}`)} · ${parts.join(" · ")}` }];
  });
  if (!chips.length) return null;
  return (
    <span className="plugins-perm-chips">
      {chips.map((chip) => (
        <span
          key={chip.mode}
          className={cx("plugins-perm-chip", `risk-${permissionRisk(`fs.${chip.mode}`)}`)}
          title={chip.text}
        >
          {chip.text}
        </span>
      ))}
    </span>
  );
}

/** What the plugin contributes, in a fixed order so rows stay comparable. */
function CapabilityChips({ capabilities }: { capabilities: readonly PluginCapability[] | undefined }) {
  const { t } = useTranslation();
  const ordered = CAPABILITY_ORDER.filter((cap) => capabilities?.includes(cap));
  if (ordered.length === 0) return null;
  return (
    <span className="plugins-cap-chips">
      {ordered.map((cap) => (
        <span key={cap} className="plugins-cap-chip">
          {t(`plugins.capabilities.${cap}`, { defaultValue: cap })}
        </span>
      ))}
    </span>
  );
}

/**
 * Supervision state of the plugin's resident services. Restart counts are shown
 * because a service that keeps coming back is a different problem from one that
 * is simply running.
 */
function ServiceChips({ statuses }: { statuses: readonly PluginServiceStatus[] | undefined }) {
  const { t } = useTranslation();
  if (!statuses?.length) return null;
  return (
    <span className="plugins-service-chips">
      {statuses.map((status) => (
        <span
          key={status.serviceId}
          className={cx("plugins-service-chip", `is-${status.state}`)}
          title={status.message || undefined}
        >
          <span className="plugins-service-dot" aria-hidden />
          <span className="plugins-service-name">{status.label}</span>
          <span className="plugins-service-state">
            {t(`plugins.serviceState.${status.state}`)}
          </span>
          {status.restarts > 0 ? (
            <span className="plugins-service-restarts">
              {t("plugins.serviceRestarts", { count: status.restarts })}
            </span>
          ) : null}
        </span>
      ))}
    </span>
  );
}

/** Keep the installed row calm while retaining the full capability readout on demand. */
function PluginRowDetails({
  plugin,
  services,
}: {
  plugin: PluginSummary;
  services: readonly PluginServiceStatus[] | undefined;
}) {
  const { t } = useTranslation();
  const hasCapabilities = (plugin.capabilities?.length ?? 0) > 0;
  const hasServices = (services?.length ?? 0) > 0;
  const hasPermissions = (plugin.permissions?.length ?? 0) > 0;
  const hasFsScope = FS_MODES.some((mode) => plugin.fs?.[mode]);
  const legacyFs = (plugin.permissions ?? []).filter((permission) =>
    LEGACY_FS_PERMISSIONS.includes(permission),
  );

  if (!hasCapabilities && !hasServices && !hasPermissions) return null;

  return (
    <details className="plugins-row-details">
      <summary
        className="plugins-row-details-toggle"
        aria-label={t("plugins.viewDetailsOf", { name: plugin.name })}
      >
        <IconChevronDown size={13} aria-hidden="true" />
        <span>{t("plugins.details")}</span>
      </summary>
      <div className="plugins-row-details-body">
        {hasCapabilities ? (
          <div className="plugins-row-detail">
            <span className="plugins-row-detail-label">
              {t("plugins.capabilitiesTitle")}
            </span>
            <CapabilityChips capabilities={plugin.capabilities} />
          </div>
        ) : null}
        {hasServices ? (
          <div className="plugins-row-detail">
            <span className="plugins-row-detail-label">{t("plugins.servicesTitle")}</span>
            <ServiceChips statuses={services} />
          </div>
        ) : null}
        {hasPermissions ? (
          <div className="plugins-row-detail">
            <span className="plugins-row-detail-label">
              {t("plugins.permissionsTitle")}
            </span>
            <PermissionChips permissions={plugin.permissions} />
          </div>
        ) : null}
        {hasFsScope ? (
          <div className="plugins-row-detail">
            <span className="plugins-row-detail-label">{t("plugins.fileAccessTitle")}</span>
            <FsScopeChips policy={plugin.fs} />
          </div>
        ) : null}
        {legacyFs.length ? (
          // The plugin still loads, with less reach than its author expected.
          // Saying so is the difference between "broken" and "needs an update".
          <p className="plugins-row-detail-note">{t("plugins.legacyFsDowngraded")}</p>
        ) : null}
      </div>
    </details>
  );
}

/** Pill search field with a leading icon and a clear affordance. */
function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <div className="plugins-search-wrap">
      <IconSearch size={14} />
      <input
        ref={inputRef}
        className="plugins-search"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.preventDefault();
            e.stopPropagation();
            onChange("");
          }
        }}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
      />
      {value ? (
        <button
          type="button"
          className="plugins-search-clear"
          aria-label={t("plugins.clearSearch")}
          title={t("plugins.clearSearch")}
          onClick={() => {
            onChange("");
            inputRef.current?.focus();
          }}
        >
          <IconX size={12} />
        </button>
      ) : null}
    </div>
  );
}

export function PluginsPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const plugins = useAppStore((s) => s.plugins);
  const settings = useAppStore((s) => s.settings);
  const refreshPlugins = useAppStore((s) => s.refreshPlugins);
  const showToast = useAppStore((s) => s.showToast);
  const openUrlInWorkPanel = useAppStore((s) => s.openUrlInWorkPanel);
  const activateProject = useAppStore((s) => s.activateProject);
  /**
   * The folder open in this window. Scoping something to "this project" is only
   * meaningful relative to it, so the control needs it as its default target.
   */
  const currentProjectPath = useAppStore((s) => s.workspace?.path ?? null);

  const [tab, setTab] = useState<TabId>("installed");
  const [installedQuery, setInstalledQuery] = useState("");
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [market, setMarket] = useState<MarketPluginSummary[]>([]);
  const [marketLoading, setMarketLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reloadingId, setReloadingId] = useState<string | null>(null);
  const [pendingInstall, setPendingInstall] = useState<{
    id: string;
    name: string;
    permissions: string[];
    newPermissions: string[];
    version?: string;
  } | null>(null);
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [templatePick, setTemplatePick] = useState<TemplateId | null>(null);
  const [creating, setCreating] = useState(false);
  const [marketSource, setMarketSource] = useState("");
  const [headerMenu, setHeaderMenu] = useState(false);
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const [rowMenuUp, setRowMenuUp] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MarketPluginDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [services, setServices] = useState<PluginServiceStatus[]>([]);
  const [selectedVersion, setSelectedVersion] = useState("");
  const [settingsPlugin, setSettingsPlugin] = useState<PluginSummary | null>(null);
  const headerMenuRef = useRef<HTMLDivElement | null>(null);
  const rowMenuRef = useRef<HTMLDivElement | null>(null);

  const refreshMarket = async (q = query, opts?: { refreshRemote?: boolean }) => {
    setMarketLoading(true);
    try {
      if (opts?.refreshRemote) {
        const meta = await api.marketRefresh(true);
        setMarketSource(meta.sourceUrl || meta.homepage || "");
        showToast(
          t("plugins.marketRefreshed", {
            count: meta.pluginCount,
            defaultValue: `Marketplace refreshed (${meta.pluginCount} plugins)`,
          }),
          { variant: "success" },
        );
      }
      const res = await api.marketSearch(q);
      setMarket((res.plugins ?? []).filter(isClientVisibleMarketPlugin));
      if (!marketSource) {
        // The host reports the catalog URL actually in effect, so a mirror or
        // custom source shows up here instead of the official repo.
        setMarketSource(res.sourceUrl || res.providerId || "");
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setMarketLoading(false);
    }
  };

  const openDetail = async (id: string) => {
    setSelectedId(id);
    setDetailLoading(true);
    try {
      const res = await api.marketGetDetail(id);
      const raw = res.plugin as MarketPluginDetail & {
        summary?: MarketPluginSummary;
      };
      const plugin: MarketPluginDetail = raw.summary
        ? {
            ...raw.summary,
            readmeMarkdown: raw.readmeMarkdown,
            versions: raw.versions ?? [],
            screenshots: raw.screenshots,
            homepage: raw.homepage,
            repository: raw.repository,
            permissions: raw.permissions ?? raw.summary.permissionSummary ?? [],
            safetyNotes: raw.safetyNotes,
          }
        : raw;
      setDetail(plugin);
      setSelectedVersion(plugin.versions?.[0]?.version || plugin.latestVersion || "");
    } catch (e) {
      setDetail(null);
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setDetailLoading(false);
    }
  };

  const closeDetail = () => {
    setSelectedId(null);
    setDetail(null);
    setSelectedVersion("");
  };

  // Every scope control offers the same folder list, so it is fetched once here
  // and handed down rather than re-queried per row.
  useEffect(() => {
    void api
      .listProjects()
      .then((res) => setProjects(res.projects ?? []))
      .catch(() => setProjects([]));
  }, []);

  // Refresh installed-plugin update metadata whenever this surface opens. The
  // host keeps the last valid catalog for offline use, so a failed check is
  // intentionally silent and never hides the installed list.
  useEffect(() => {
    void (async () => {
      try {
        await api.marketCheckUpdates(false);
        await refreshPlugins();
      } catch {
        // Marketplace availability must not block local plugin management.
      }
    })();
  }, [refreshPlugins]);

  // The marketplace query drives a debounced provider search: typing is the only
  // control, so there is no separate Search button that can fall out of sync.
  useEffect(() => {
    if (tab !== "market") return;
    const delay = query.trim() ? 240 : 0;
    const handle = window.setTimeout(() => void refreshMarket(query), delay);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, query]);

  // Menus are popovers: Escape or any outside press dismisses them, so a menu
  // never outlives the control it belongs to.
  useEffect(() => {
    if (!headerMenu && !rowMenu) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (headerMenu && !headerMenuRef.current?.contains(target)) setHeaderMenu(false);
      if (rowMenu && !rowMenuRef.current?.contains(target)) setRowMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setHeaderMenu(false);
      setRowMenu(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [headerMenu, rowMenu]);

  // Escape closes the detail sheet, but only while it owns the top layer: the
  // permission dialog in front of it handles its own dismissal.
  useEffect(() => {
    if (!selectedId || pendingInstall) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDetail();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selectedId, pendingInstall]);

  useEffect(() => {
    if (!pendingInstall) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPendingInstall(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [pendingInstall]);

  // Service state changes arrive as pluginChanged events, so the list stays
  // truthful while the supervisor restarts a crashed worker.
  useEffect(() => {
    const refresh = () => {
      void api
        .listPluginServices()
        .then(setServices)
        .catch(() => setServices([]));
    };
    refresh();
    return api.onPluginChanged(refresh);
  }, []);

  const servicesByPlugin = useMemo(() => {
    const map = new Map<string, PluginServiceStatus[]>();
    for (const status of services) {
      const list = map.get(status.pluginId);
      if (list) list.push(status);
      else map.set(status.pluginId, [status]);
    }
    return map;
  }, [services]);

  const installedById = useMemo(() => {
    const map = new Map<string, PluginSummary>();
    for (const plugin of plugins) map.set(plugin.id, plugin);
    return map;
  }, [plugins]);

  const stats = useMemo(() => {
    let updates = 0;
    for (const plugin of plugins) {
      if (plugin.updateAvailable) updates += 1;
    }
    return { total: plugins.length, updates };
  }, [plugins]);

  const filteredInstalled = useMemo(
    () =>
      plugins.filter((plugin) =>
        matchesQuery(
          installedQuery,
          plugin.name,
          plugin.id,
          plugin.description,
          plugin.author,
        ),
      ),
    [plugins, installedQuery],
  );

  const installedGroups = useMemo(() => {
    const buckets = new Map<GroupId, PluginSummary[]>();
    for (const plugin of filteredInstalled) {
      const id = groupOf(plugin);
      const bucket = buckets.get(id);
      if (bucket) bucket.push(plugin);
      else buckets.set(id, [plugin]);
    }
    return GROUP_ORDER.flatMap((id) => {
      const rows = buckets.get(id);
      if (!rows?.length) return [];
      rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      return [{ id, rows }];
    });
  }, [filteredInstalled]);

  const categories = useMemo(() => {
    const seen = new Set<string>();
    for (const item of market) {
      for (const value of item.categories ?? []) if (value) seen.add(value);
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [market]);

  const visibleMarket = useMemo(
    () =>
      category
        ? market.filter((item) => (item.categories ?? []).includes(category))
        : market,
    [market, category],
  );

  const activeVersion = useMemo(() => {
    if (!detail?.versions?.length) return null;
    return (
      detail.versions.find((v) => v.version === selectedVersion) ||
      detail.versions[0] ||
      null
    );
  }, [detail, selectedVersion]);

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    }
  };

  const loadDev = () =>
    run(async () => {
      await api.loadDevPlugin();
      await refreshPlugins();
      showToast(t("plugins.loadDevDone"), { variant: "success" });
    });

  const reloadPlugin = (id: string) =>
    run(async () => {
      setReloadingId(id);
      try {
        await api.reloadPlugin(id);
        await refreshPlugins();
        showToast(t("plugins.reloadDone"), { variant: "success" });
      } finally {
        setReloadingId(null);
      }
    });

  const installPackage = () =>
    run(async () => {
      await api.installPluginFromPackage();
      await refreshPlugins();
      showToast(t("plugins.installPackageDone"), { variant: "success" });
    });

  const createFromTemplate = async (template: TemplateId) => {
    setCreating(true);
    try {
      const created = await api.createPluginFromTemplate(template);
      await refreshPlugins();
      setTemplatePick(null);
      // A canceled folder picker is not a failure: leave the page untouched.
      if (created.canceled) return;
      // Scaffolding only makes the plugin run; development also needs the folder
      // itself open, so activate it as the project and land on chat with the
      // plugin sources in the workspace the agent and the file panel read.
      let opened: ProjectWorkspace | null = null;
      let openError: unknown = null;
      try {
        opened = created.dir ? await activateProject(created.dir) : null;
      } catch (e) {
        // The plugin is already created and loaded; a failed open must not erase
        // that, so it is reported on its own instead of replacing the result.
        openError = e;
      }
      showToast(
        t(
          opened
            ? "plugins.newFromTemplateOpened"
            : "plugins.newFromTemplateDone",
          { name: created.name ?? "" },
        ),
        { variant: "success" },
      );
      if (openError) {
        showToast(
          openError instanceof Error ? openError.message : String(openError),
          { variant: "error" },
        );
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setCreating(false);
    }
  };

  const checkUpdates = () =>
    run(async () => {
      const res = await api.marketCheckUpdates();
      await refreshPlugins();
      const count = res.updates?.length ?? 0;
      showToast(t("plugins.updatesFound", { count }), {
        variant: count > 0 ? "success" : "info",
      });
    });

  const applyAutoUpdates = () =>
    run(async () => {
      const res = await api.marketApplyUpdates(true);
      await refreshPlugins();
      showToast(t("plugins.autoUpdatesApplied", { count: res.results?.length ?? 0 }), {
        variant: "success",
      });
    });

  const queueInstall = (input: {
    id: string;
    name: string;
    permissions: readonly string[];
    newPermissions?: readonly string[];
    version?: string;
  }) => {
    const newPermissions = orderPermissions(input.newPermissions);
    setPendingInstall({
      id: input.id,
      name: input.name,
      version: input.version,
      permissions: orderPermissions([...input.permissions, ...newPermissions]),
      newPermissions,
    });
    setAutoUpdate(true);
    setRowMenu(null);
  };

  const confirmInstall = async () => {
    if (!pendingInstall) return;
    setBusyId(pendingInstall.id);
    try {
      await api.marketInstall({
        id: pendingInstall.id,
        version: pendingInstall.version,
        enable: true,
        autoUpdate,
        grantedPermissions: pendingInstall.permissions,
      });
      await refreshPlugins();
      await refreshMarket();
      if (selectedId === pendingInstall.id) await openDetail(pendingInstall.id);
      showToast(t("plugins.installed", { name: pendingInstall.name }), {
        variant: "success",
      });
      setPendingInstall(null);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

  const overflowActions = [
    { key: "checkUpdates", run: checkUpdates },
    { key: "applyAutoUpdates", run: applyAutoUpdates },
    { key: "installPackage", run: installPackage },
    { key: "loadDev", run: loadDev },
    {
      key: "newFromTemplate",
      run: async () => {
        setTemplatePick(TEMPLATE_IDS[0]);
      },
    },
  ];

  const installTarget = activeVersion?.version || detail?.latestVersion;
  const installedDetail = detail ? installedById.get(detail.id) : undefined;
  const detailPermissions = orderPermissions(
    activeVersion?.permissions ?? detail?.permissions ?? [],
  );
  const detailUpToDate = !!installedDetail && installedDetail.version === installTarget;
  // The sheet knows each version's package fields, so it judges the selected
  // version rather than the summary's latest one.
  const detailPackagePending = detail
    ? activeVersion
      ? !versionInstallable(activeVersion)
      : detail.installable === false
    : false;
  // Withdrawn and not-yet-published both block the install, and they are not
  // the same news: one is over, the other is pending.
  const detailWithdrawn = versionWithdrawn(activeVersion);

  return (
    <div className="thread-scroll">
      <div className="page-frame plugins-page">
        <div className="page-header plugins-page-header">
          <div className="plugins-title-block">
            <span className="plugins-title-icon" aria-hidden>
              <IconPlug size={14} />
            </span>
            <div className="plugins-title-copy">
              <h1 className="page-title">{t("plugins.title")}</h1>
            </div>
          </div>
          <div className="plugins-header-actions">
            {tab === "market" ? (
              <Button
                variant="primary"
                size="sm"
                onClick={() => void refreshMarket(query, { refreshRemote: true })}
              >
                <IconCloudDown size={14} />
                {t("plugins.refreshMarket")}
              </Button>
            ) : tab === "installed" ? (
              <Button variant="primary" size="sm" onClick={() => setTab("market")}>
                <IconDownload size={14} />
                {t("plugins.browseMarket")}
              </Button>
            ) : null}
            <div
              className="plugins-menu-wrap"
              ref={headerMenu ? headerMenuRef : undefined}
            >
              <button
                type="button"
                className="plugins-icon-btn plugins-header-menu"
                aria-label={t("plugins.moreActions")}
                title={t("plugins.moreActions")}
                aria-haspopup="menu"
                aria-expanded={headerMenu}
                onClick={() => setHeaderMenu((open) => !open)}
              >
                <IconMore size={16} />
              </button>
              {headerMenu ? (
                <div className="plugins-menu is-end" role="menu">
                  {overflowActions.map((action) => (
                    <button
                      key={action.key}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setHeaderMenu(false);
                        void action.run();
                      }}
                    >
                      {t(`plugins.${action.key}`)}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {stats.updates > 0 ? (
          <div className="plugins-alert" role="status">
            <span className="plugins-alert-icon" aria-hidden>
              <IconCloudDown size={15} />
            </span>
            <div className="plugins-alert-copy">
              <span className="plugins-alert-title">
                {t("plugins.updatesReady", { count: stats.updates })}
              </span>
            </div>
            <Button variant="secondary" size="sm" onClick={() => void applyAutoUpdates()}>
              {t("plugins.applyAutoUpdates")}
            </Button>
          </div>
        ) : null}

        <div className="plugins-toolbar">
          <div className="plugins-segment" role="tablist" aria-label={t("plugins.title")}>
            <button
              type="button"
              role="tab"
              id="plugins-tab-installed"
              aria-selected={tab === "installed"}
              aria-controls="plugins-panel-installed"
              className={cx("plugins-segment-btn", tab === "installed" && "active")}
              onClick={() => setTab("installed")}
            >
              {t("plugins.tabInstalled")}
              <span className="plugins-segment-count">{stats.total}</span>
            </button>
            <button
              type="button"
              role="tab"
              id="plugins-tab-market"
              aria-selected={tab === "market"}
              aria-controls="plugins-panel-market"
              className={cx("plugins-segment-btn", tab === "market" && "active")}
              onClick={() => setTab("market")}
            >
              {t("plugins.tabMarket")}
              {market.length ? (
                <span className="plugins-segment-count">{market.length}</span>
              ) : null}
            </button>
          </div>
          {tab === "installed" ? (
            plugins.length ? (
              <div className="plugins-toolbar-end">
                {installedQuery.trim() ? (
                  <span className="plugins-result-count" aria-live="polite">
                    {t("plugins.resultCount", {
                      count: filteredInstalled.length,
                      total: plugins.length,
                    })}
                  </span>
                ) : null}
                <SearchField
                  value={installedQuery}
                  onChange={setInstalledQuery}
                  placeholder={t("plugins.searchInstalled")}
                />
              </div>
            ) : null
          ) : (
            <div className="plugins-toolbar-end">
              {marketLoading ? (
                <span className="plugins-result-count" aria-live="polite">
                  {t("plugins.marketLoading")}
                </span>
              ) : null}
              <SearchField
                value={query}
                onChange={setQuery}
                placeholder={t("plugins.marketSearchPlaceholder")}
              />
            </div>
          )}
        </div>

        {tab === "installed" ? (
          <div
            id="plugins-panel-installed"
            role="tabpanel"
            aria-labelledby="plugins-tab-installed"
            className="plugins-panel"
          >
            {plugins.length === 0 ? (
              <div className="plugins-empty">
                <span className="plugins-empty-icon" aria-hidden>
                  <IconPlug size={18} />
                </span>
                <p className="plugins-empty-title">{t("plugins.empty")}</p>
                <div className="plugins-empty-actions">
                  <Button variant="primary" onClick={() => setTab("market")}>
                    {t("plugins.browseMarket")}
                  </Button>
                  <Button variant="secondary" onClick={() => void loadDev()}>
                    {t("plugins.loadDev")}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => setTemplatePick(TEMPLATE_IDS[0])}
                  >
                    {t("plugins.newFromTemplate")}
                  </Button>
                </div>
              </div>
            ) : installedGroups.length === 0 ? (
              <div className="plugins-empty">
                <span className="plugins-empty-icon" aria-hidden>
                  <IconSearch size={18} />
                </span>
                <p className="plugins-empty-title">{t("plugins.noMatches")}</p>
                <div className="plugins-empty-actions">
                  <Button variant="secondary" onClick={() => setInstalledQuery("")}>
                    {t("plugins.clearSearch")}
                  </Button>
                </div>
              </div>
            ) : (
              installedGroups.map((group) => (
                <section key={group.id} className="plugins-group">
                  <header className="plugins-group-head">
                    <h2 className="plugins-group-label">{t(GROUP_LABEL_KEYS[group.id])}</h2>
                    <span className="plugins-group-count">{group.rows.length}</span>
                  </header>
                  <div
                    className="plugins-list"
                    role="list"
                    aria-label={t(GROUP_LABEL_KEYS[group.id])}
                  >
                    {group.rows.map((plugin) => {
                      const broken = group.id === "attention";
                      const menuOpen = rowMenu === plugin.id;
                      const update = plugin.updateAvailable;
                      return (
                        <div
                          key={plugin.id}
                          role="listitem"
                          className={cx(
                            "plugins-row",
                            !plugin.enabled && "off",
                            broken && "broken",
                            menuOpen && "menu-open",
                          )}
                        >
                          <span className="plugins-glyph" aria-hidden>
                            {broken ? (
                              <IconCircleAlert size={15} />
                            ) : (
                              <IconPlug size={15} />
                            )}
                          </span>
                          <div className="plugins-row-copy">
                            <div className="plugins-row-title">
                              <span className="plugins-row-name">{plugin.name}</span>
                              {plugin.source === "dev" ? (
                                <span className="plugins-tag">{t("plugins.tagLocal")}</span>
                              ) : null}
                            </div>
                            <div className="plugins-row-meta">
                              <span className="plugins-row-id">{plugin.id}</span>
                              <span className="plugins-dot" aria-hidden>
                                ·
                              </span>
                              <span>v{plugin.version}</span>
                            </div>
                            {plugin.errorMessage ? (
                              <p className="plugins-row-error">{plugin.errorMessage}</p>
                            ) : null}
                            <PluginRowDetails
                              plugin={plugin}
                              services={servicesByPlugin.get(plugin.id)}
                            />
                          </div>
                          <div className="plugins-row-controls">
                            {update ? (
                              <Button
                                variant="secondary"
                                size="sm"
                                disabled={busyId === plugin.id}
                                onClick={() =>
                                  queueInstall({
                                    id: plugin.id,
                                    name: plugin.name,
                                    version: update.version,
                                    permissions: plugin.permissions ?? [],
                                    newPermissions: update.permissionDiff ?? [],
                                  })
                                }
                              >
                                {busyId === plugin.id
                                  ? t("plugins.updating")
                                  : t("plugins.updateNow")}
                              </Button>
                            ) : null}
                            <ScopeControl
                              target={plugin}
                              label={plugin.name}
                              compact
                              projects={projects}
                              currentProjectPath={currentProjectPath}
                              onSetEnabled={(enabled) =>
                                run(async () => {
                                  if (enabled) await api.enablePlugin(plugin.id);
                                  else await api.disablePlugin(plugin.id);
                                  await refreshPlugins();
                                })
                              }
                              onSetScope={(scope: ActivationScope) =>
                                run(async () => {
                                  await api.setPluginScope(plugin.id, scope);
                                  await refreshPlugins();
                                })
                              }
                            />
                            <div className="plugins-row-actions">
                              {plugin.ui?.panel ? (
                                <button
                                  type="button"
                                  className="plugins-icon-btn"
                                  aria-label={t("plugins.openPanel")}
                                  title={t("plugins.openPanel")}
                                  data-tip={t("plugins.openPanel")}
                                  onClick={() =>
                                    void run(() => api.openPluginPanel(plugin.id))
                                  }
                                >
                                  <IconPanel size={15} />
                                </button>
                              ) : null}
                              {plugin.enabled && plugin.settings?.length ? (
                                <button
                                  type="button"
                                  className="plugins-icon-btn"
                                  aria-label={t("plugins.openSettings")}
                                  title={t("plugins.openSettings")}
                                  data-tip={t("plugins.openSettings")}
                                  onClick={() => setSettingsPlugin(plugin)}
                                >
                                  <IconSettings size={15} />
                                </button>
                              ) : null}
                              <div
                                className="plugins-menu-wrap"
                                ref={menuOpen ? rowMenuRef : undefined}
                              >
                                <button
                                  type="button"
                                  className="plugins-icon-btn"
                                  aria-label={t("plugins.rowActions", {
                                    name: plugin.name,
                                  })}
                                  title={t("plugins.rowActions", { name: plugin.name })}
                                  data-tip={t("plugins.rowActions", { name: plugin.name })}
                                  aria-haspopup="menu"
                                  aria-expanded={menuOpen}
                                  onClick={(event) => {
                                    const rect =
                                      event.currentTarget.getBoundingClientRect();
                                    setRowMenuUp(
                                      window.innerHeight - rect.bottom <
                                        ROW_MENU_HEIGHT,
                                    );
                                    setRowMenu((cur) =>
                                      cur === plugin.id ? null : plugin.id,
                                    );
                                  }}
                                >
                                  <IconMore size={15} />
                                </button>
                                {menuOpen ? (
                                  <div
                                    className={cx(
                                      "plugins-menu is-end",
                                      rowMenuUp && "is-up",
                                    )}
                                    role="menu"
                                  >
                                    {plugin.source === "dev" ? (
                                      <button
                                        type="button"
                                        role="menuitem"
                                        disabled={
                                          busyId === plugin.id ||
                                          reloadingId === plugin.id
                                        }
                                        onClick={() => {
                                          setRowMenu(null);
                                          void reloadPlugin(plugin.id);
                                        }}
                                      >
                                        <IconReview size={14} />
                                        {t("plugins.reload")}
                                      </button>
                                    ) : null}
                                    <button
                                      type="button"
                                      role="menuitem"
                                      onClick={() => {
                                        setRowMenu(null);
                                        void run(async () => {
                                          await api.setPluginAutoUpdate(
                                            plugin.id,
                                            !plugin.autoUpdate,
                                          );
                                          await refreshPlugins();
                                        });
                                      }}
                                    >
                                      <IconCloudDown size={14} />
                                      {plugin.autoUpdate
                                        ? t("plugins.disableAutoUpdate")
                                        : t("plugins.enableAutoUpdate")}
                                    </button>
                                    <div className="plugins-menu-sep" />
                                    <button
                                      type="button"
                                      role="menuitem"
                                      className="danger"
                                      onClick={() => {
                                        setRowMenu(null);
                                        void run(async () => {
                                          await api.uninstallPlugin(plugin.id);
                                          await refreshPlugins();
                                        });
                                      }}
                                    >
                                      <IconTrash size={14} />
                                      {t("plugins.uninstall")}
                                    </button>
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))
            )}
          </div>
        ) : (
          <div
            id="plugins-panel-market"
            role="tabpanel"
            aria-labelledby="plugins-tab-market"
            className="plugins-panel"
          >
            {settings ? (
              <MarketplaceSourceSettings
                settings={settings}
                activeSource={marketSource}
                onSourceRefreshed={(source) => {
                  setMarketSource(source);
                  void refreshMarket(query);
                }}
              />
            ) : null}

            {categories.length > 1 ? (
              <div
                className="plugins-filters"
                role="group"
                aria-label={t("plugins.categories")}
              >
                <button
                  type="button"
                  className={cx("plugins-filter", !category && "active")}
                  aria-pressed={!category}
                  onClick={() => setCategory("")}
                >
                  {t("plugins.categoryAll")}
                </button>
                {categories.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={cx("plugins-filter", category === value && "active")}
                    aria-pressed={category === value}
                    onClick={() => setCategory(category === value ? "" : value)}
                  >
                    {value}
                  </button>
                ))}
              </div>
            ) : null}

            {marketLoading && market.length === 0 ? (
              <div className="plugins-card-grid" aria-hidden>
                {[0, 1, 2, 3].map((index) => (
                  <div key={index} className="plugins-card is-skeleton">
                    <span className="plugins-skeleton-line is-short" />
                    <span className="plugins-skeleton-line" />
                    <span className="plugins-skeleton-line is-long" />
                  </div>
                ))}
              </div>
            ) : visibleMarket.length === 0 ? (
              <div className="plugins-empty">
                <span className="plugins-empty-icon" aria-hidden>
                  <IconSearch size={18} />
                </span>
                <p className="plugins-empty-title">{t("plugins.marketEmpty")}</p>
                <div className="plugins-empty-actions">
                  {query || category ? (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setQuery("");
                        setCategory("");
                      }}
                    >
                      {t("plugins.clearSearch")}
                    </Button>
                  ) : null}
                  <Button
                    variant="secondary"
                    onClick={() => void refreshMarket(query, { refreshRemote: true })}
                  >
                    {t("plugins.refreshMarket")}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="plugins-card-grid" role="list">
                {visibleMarket.map((item) => {
                  const installed = installedById.get(item.id);
                  const upgradable = !!installed && !!item.updateAvailable;
                  // Older hosts do not report the field; absence means the
                  // catalog was trusted, so only an explicit false blocks.
                  const packagePending = item.installable === false;
                  return (
                    <article
                      key={item.id}
                      role="listitem"
                      className={cx("plugins-card", selectedId === item.id && "active")}
                    >
                      <button
                        type="button"
                        className="plugins-card-hit"
                        aria-label={t("plugins.viewDetailsOf", { name: item.name })}
                        onClick={() => void openDetail(item.id)}
                      >
                        <span className="plugins-card-head">
                          <span className="plugins-card-glyph" aria-hidden>
                            {monogram(item.name)}
                          </span>
                          <span className="plugins-card-ident">
                            <span className="plugins-card-title">
                              <span className="plugins-card-name">{item.name}</span>
                              {showsVerifiedBadge(item) ? (
                                <span
                                  className="plugins-verified"
                                  title={t("plugins.verified")}
                                  aria-label={t("plugins.verified")}
                                >
                                  <IconShield size={12} />
                                </span>
                              ) : null}
                            </span>
                            <span className="plugins-card-meta">
                              <span className="plugins-card-author">{item.author}</span>
                              <span className="plugins-dot" aria-hidden>
                                ·
                              </span>
                              <span>v{item.latestVersion}</span>
                              {item.downloads != null ? (
                                <>
                                  <span className="plugins-dot" aria-hidden>
                                    ·
                                  </span>
                                  <span>
                                    {t("plugins.downloads", { count: item.downloads })}
                                  </span>
                                </>
                              ) : null}
                            </span>
                          </span>
                        </span>
                        <span className="plugins-card-desc">{item.description}</span>
                        <PermissionChips permissions={item.permissionSummary} />
                      </button>
                      <div className="plugins-card-foot">
                        <span className="plugins-card-state">
                          {installed
                            ? t("plugins.installedVersion", { version: installed.version })
                            : t("plugins.updatedOn", {
                                date: formatDate(item.updatedAt, locale),
                              })}
                        </span>
                        {installed && !upgradable ? (
                          <span className="plugins-installed-mark">
                            <IconCheck size={13} />
                            {t("plugins.installedLabel")}
                          </span>
                        ) : (
                          <Button
                            variant="primary"
                            size="sm"
                            disabled={busyId === item.id || packagePending}
                            title={
                              packagePending
                                ? t("plugins.packagePendingHint", {
                                    version: item.latestVersion,
                                  })
                                : undefined
                            }
                            onClick={() =>
                              queueInstall({
                                id: item.id,
                                name: item.name,
                                permissions: item.permissionSummary ?? [],
                                version: item.latestVersion,
                              })
                            }
                          >
                            {packagePending
                              ? t("plugins.packagePending")
                              : busyId === item.id
                                ? t("plugins.installing")
                                : upgradable
                                  ? t("plugins.updateNow")
                                  : t("plugins.install")}
                          </Button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {selectedId ? (
        <div className="plugins-sheet-layer">
          <button
            type="button"
            className="plugins-sheet-scrim"
            aria-label={t("plugins.closeDetail")}
            onClick={closeDetail}
          />
          <aside
            className="plugins-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={t("plugins.detailTitle")}
          >
            <header className="plugins-sheet-head">
              <span className="plugins-card-glyph is-large" aria-hidden>
                {monogram(detail?.name || selectedId)}
              </span>
              <div className="plugins-sheet-ident">
                <h2 className="plugins-sheet-title">
                  {detail?.name || selectedId}
                  {showsVerifiedBadge(detail) ? (
                    <span
                      className="plugins-verified"
                      title={t("plugins.verified")}
                      aria-label={t("plugins.verified")}
                    >
                      <IconShield size={12} />
                    </span>
                  ) : null}
                </h2>
                <div className="plugins-sheet-meta">
                  <span className="plugins-row-id">{detail?.id || selectedId}</span>
                  {detail?.author ? (
                    <>
                      <span className="plugins-dot" aria-hidden>
                        ·
                      </span>
                      <span>{detail.author}</span>
                    </>
                  ) : null}
                </div>
              </div>
              <button
                type="button"
                className="plugins-icon-btn"
                aria-label={t("plugins.closeDetail")}
                title={t("plugins.closeDetail")}
                onClick={closeDetail}
              >
                <IconX size={15} />
              </button>
            </header>

            {detailLoading ? (
              <div className="plugins-sheet-state">{t("plugins.detailLoading")}</div>
            ) : !detail ? (
              <div className="plugins-sheet-state">{t("plugins.detailFailed")}</div>
            ) : (
              <>
                <div className="plugins-sheet-cta">
                  <div className="plugins-sheet-cta-copy">
                    <span className="plugins-sheet-cta-version">v{installTarget}</span>
                    <span className="plugins-sheet-cta-meta">
                      {detailWithdrawn
                        ? t("plugins.withdrawnHint", { version: installTarget })
                        : detailPackagePending
                        ? t("plugins.packagePendingHint", { version: installTarget })
                        : (
                            <>
                              {formatDate(activeVersion?.publishedAt, locale)}
                              {activeVersion?.sizeBytes ? (
                                <>
                                  <span className="plugins-dot" aria-hidden>
                                    ·
                                  </span>
                                  {formatBytes(activeVersion.sizeBytes)}
                                </>
                              ) : null}
                            </>
                          )}
                    </span>
                  </div>
                  {detailUpToDate ? (
                    <span className="plugins-installed-mark">
                      <IconCheck size={13} />
                      {t("plugins.installedLabel")}
                    </span>
                  ) : (
                    <Button
                      variant="primary"
                      disabled={busyId === detail.id || detailPackagePending}
                      onClick={() =>
                        queueInstall({
                          id: detail.id,
                          name: detail.name,
                          version: installTarget,
                          permissions: detailPermissions,
                        })
                      }
                    >
                      {detailWithdrawn
                        ? t("plugins.withdrawn")
                        : detailPackagePending
                        ? t("plugins.packagePending")
                        : busyId === detail.id
                          ? t("plugins.installing")
                          : installedDetail
                            ? t("plugins.updateNow")
                            : t("plugins.installVersion", { version: installTarget })}
                    </Button>
                  )}
                </div>

                <div className="plugins-sheet-body">
                  <section className="plugins-sheet-section">
                    <h3 className="plugins-sheet-section-title">
                      {t("plugins.aboutTitle")}
                    </h3>
                    <p className="plugins-sheet-desc">{detail.description}</p>
                    {detail.repository || detail.homepage ? (
                      <div className="plugins-sheet-links">
                        {[
                          { key: "repository", url: detail.repository },
                          { key: "homepage", url: detail.homepage },
                        ]
                          .filter((link): link is { key: string; url: string } => !!link.url)
                          .map((link) => (
                            <button
                              key={link.key}
                              type="button"
                              className="plugins-sheet-link"
                              onClick={() => openUrlInWorkPanel(link.url)}
                            >
                              <IconLink size={13} />
                              <span className="plugins-sheet-link-label">
                                {t(`plugins.${link.key}`)}
                              </span>
                              <span className="plugins-sheet-link-url">{link.url}</span>
                            </button>
                          ))}
                      </div>
                    ) : null}
                  </section>

                  {activeVersion?.provenance?.sourceRepository ? (
                    <section className="plugins-sheet-section">
                      <h3 className="plugins-sheet-section-title">
                        {t("plugins.sourceTitle")}
                      </h3>
                      <div className="plugins-sheet-links">
                        <button
                          type="button"
                          className="plugins-sheet-link"
                          onClick={() =>
                            openUrlInWorkPanel(activeVersion.provenance!.sourceRepository)
                          }
                        >
                          <IconLink size={13} />
                          <span className="plugins-sheet-link-label">
                            {t("plugins.repository")}
                          </span>
                          <span className="plugins-sheet-link-url">
                            {activeVersion.provenance.sourceRepository}
                          </span>
                        </button>
                      </div>
                      <dl className="plugins-provenance">
                        {activeVersion.provenance.sourceCommit ? (
                          <div className="plugins-provenance-row">
                            <dt>{t("plugins.sourceCommit")}</dt>
                            <dd>
                              <code title={activeVersion.provenance.sourceCommit}>
                                {shortSha(activeVersion.provenance.sourceCommit)}
                              </code>
                            </dd>
                          </div>
                        ) : null}
                        {activeVersion.provenance.builder ? (
                          <div className="plugins-provenance-row">
                            <dt>{t("plugins.sourceBuiltBy")}</dt>
                            <dd>{activeVersion.provenance.builder}</dd>
                          </div>
                        ) : null}
                      </dl>
                    </section>
                  ) : null}

                  {detail.safetyNotes ? (
                    <section className="plugins-callout">
                      <span className="plugins-callout-icon" aria-hidden>
                        <IconTriangleAlert size={15} />
                      </span>
                      <div>
                        <h3 className="plugins-callout-title">{t("plugins.safetyNotes")}</h3>
                        <p className="plugins-callout-body">{detail.safetyNotes}</p>
                      </div>
                    </section>
                  ) : null}

                  <section className="plugins-sheet-section">
                    <h3 className="plugins-sheet-section-title">
                      {t("plugins.permissionsTitle")}
                    </h3>
                    {detailPermissions.length === 0 ? (
                      <p className="plugins-sheet-desc">{t("plugins.noPermissions")}</p>
                    ) : (
                      <ul className="plugins-perm-list">
                        {detailPermissions.map((permission) => {
                          const risk = permissionRisk(permission);
                          return (
                            <li key={permission} className={`risk-${risk}`}>
                              <span className="plugins-perm-risk">
                                {t(RISK_LABEL_KEYS[risk])}
                              </span>
                              <span className="plugins-perm-copy">
                                <strong>{permissionLabel(permission, t)}</strong>
                                <span>
                                  {t(`plugins.permissionHelp.${permission}`, {
                                    defaultValue: permission,
                                  })}
                                </span>
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </section>

                  <section className="plugins-sheet-section">
                    <h3 className="plugins-sheet-section-title">
                      {t("plugins.versions")}
                      <span className="plugins-sheet-section-hint">
                        {t("plugins.selectVersion")}
                      </span>
                    </h3>
                    <div className="plugins-version-list">
                      {(detail.versions ?? []).map((version) => {
                        const active = activeVersion?.version === version.version;
                        const withdrawn = versionWithdrawn(version);
                        const pending = !withdrawn && !versionInstallable(version);
                        return (
                          <button
                            key={version.version}
                            type="button"
                            className={cx(
                              "plugins-version",
                              active && "active",
                              withdrawn && "withdrawn",
                            )}
                            aria-pressed={active}
                            onClick={() => setSelectedVersion(version.version)}
                          >
                            <span className="plugins-version-mark" aria-hidden>
                              {active ? <IconCheck size={12} /> : null}
                            </span>
                            <span className="plugins-version-copy">
                              <span className="plugins-version-top">
                                <strong>v{version.version}</strong>
                                <span>{formatDate(version.publishedAt, locale)}</span>
                              </span>
                              <span className="plugins-version-meta">
                                {withdrawn ? (
                                  <span className="plugins-version-withdrawn">
                                    {t("plugins.withdrawn")}
                                  </span>
                                ) : pending ? (
                                  <span className="plugins-version-pending">
                                    {t("plugins.packagePending")}
                                  </span>
                                ) : (
                                  <>
                                    {formatBytes(version.sizeBytes)}
                                    <span className="plugins-dot" aria-hidden>
                                      ·
                                    </span>
                                    <code title={version.shasum}>
                                      {shortSha(version.shasum)}
                                    </code>
                                  </>
                                )}
                              </span>
                              {withdrawn && version.yankedReason ? (
                                <span className="plugins-version-changelog">
                                  {t("plugins.withdrawnReason", {
                                    reason: version.yankedReason,
                                  })}
                                </span>
                              ) : version.changelog ? (
                                <span className="plugins-version-changelog">
                                  {version.changelog}
                                </span>
                              ) : null}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </section>

                  <section className="plugins-sheet-section">
                    <h3 className="plugins-sheet-section-title">{t("plugins.readme")}</h3>
                    {detail.readmeMarkdown ? (
                      <div className="plugins-readme">
                        <Markdown source={detail.readmeMarkdown} />
                      </div>
                    ) : (
                      <p className="plugins-sheet-desc">{t("plugins.readmeEmpty")}</p>
                    )}
                  </section>
                </div>
              </>
            )}
          </aside>
        </div>
      ) : null}

      {pendingInstall ? (
        <div className="plugins-modal-backdrop" role="presentation">
          <div
            className="plugins-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t("plugins.permissionReview")}
          >
            <header className="plugins-modal-head">
              <span className="plugins-modal-icon" aria-hidden>
                <IconShield size={17} />
              </span>
              <div>
                <h2 className="plugins-modal-title">
                  {t("plugins.permissionReviewTitle", { name: pendingInstall.name })}
                </h2>
                {pendingInstall.version ? (
                  <p className="plugins-modal-subtitle">
                    {t("plugins.installingVersion", { version: pendingInstall.version })}
                  </p>
                ) : null}
              </div>
            </header>

            <div className="plugins-modal-body">
              <p className="plugins-modal-lede">{t("plugins.permissionReviewBody")}</p>
              {pendingInstall.permissions.length === 0 ? (
                <p className="plugins-modal-lede">{t("plugins.noPermissions")}</p>
              ) : (
                RISK_TIERS.map((tier) => {
                  const scoped = pendingInstall.permissions.filter(
                    (permission) => permissionRisk(permission) === tier,
                  );
                  if (!scoped.length) return null;
                  return (
                    <div key={tier} className={cx("plugins-risk-group", `risk-${tier}`)}>
                      <div className="plugins-risk-head">
                        {tier === "high" ? (
                          <IconTriangleAlert size={13} />
                        ) : (
                          <IconShield size={13} />
                        )}
                        {t(RISK_LABEL_KEYS[tier])}
                        <span className="plugins-risk-count">{scoped.length}</span>
                      </div>
                      <ul className="plugins-perm-list is-plain">
                        {scoped.map((permission) => (
                          <li key={permission}>
                            <span className="plugins-perm-copy">
                              <strong>
                                {permissionLabel(permission, t)}
                                {pendingInstall.newPermissions.includes(permission) ? (
                                  <span className="plugins-tag is-update">
                                    {t("plugins.newPermission")}
                                  </span>
                                ) : null}
                              </strong>
                              <span>
                                {t(`plugins.permissionHelp.${permission}`, {
                                  defaultValue: permission,
                                })}
                              </span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })
              )}
            </div>

            <div className="plugins-switch-row">
              <span className="plugins-switch-label">
                {t("plugins.enableAutoUpdateOnInstall")}
              </span>
              <button
                type="button"
                className={cx("settings-toggle", autoUpdate && "on")}
                role="switch"
                aria-checked={autoUpdate}
                aria-label={t("plugins.enableAutoUpdateOnInstall")}
                onClick={() => setAutoUpdate((on) => !on)}
              >
                <span className="settings-toggle-thumb" />
              </button>
            </div>

            <div className="plugins-modal-actions">
              <Button variant="secondary" onClick={() => setPendingInstall(null)}>
                {t("plugins.cancel")}
              </Button>
              <Button
                variant="primary"
                disabled={busyId === pendingInstall.id}
                onClick={() => void confirmInstall()}
              >
                {busyId === pendingInstall.id
                  ? t("plugins.installing")
                  : t("plugins.acceptInstall")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {settingsPlugin ? (
        <PluginSettingsSheet
          plugin={settingsPlugin}
          platform={(window.piDesktop?.platform ?? "darwin") as "darwin" | "win32" | "linux"}
          onClose={() => setSettingsPlugin(null)}
          onSaved={async () => {
            await refreshPlugins();
            const updated = useAppStore
              .getState()
              .plugins.find((plugin) => plugin.id === settingsPlugin.id);
            if (updated) setSettingsPlugin(updated);
          }}
        />
      ) : null}

      {templatePick ? (
        <div className="plugins-modal-backdrop" role="presentation">
          <div
            className="plugins-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t("plugins.newFromTemplateTitle")}
          >
            <header className="plugins-modal-head">
              <span className="plugins-modal-icon" aria-hidden>
                <IconSparkles size={17} />
              </span>
              <div>
                <h2 className="plugins-modal-title">
                  {t("plugins.newFromTemplateTitle")}
                </h2>
                <p className="plugins-modal-subtitle">
                  {t("plugins.newFromTemplateHint")}
                </p>
              </div>
            </header>

            <div className="plugins-modal-body">
              <p className="plugins-modal-lede">{t("plugins.newFromTemplateBody")}</p>
              <div
                className="plugins-template-list"
                role="radiogroup"
                aria-label={t("plugins.newFromTemplateTitle")}
              >
                {TEMPLATE_IDS.map((template) => {
                  const active = templatePick === template;
                  return (
                    <button
                      key={template}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={cx("plugins-template", active && "active")}
                      onClick={() => setTemplatePick(template)}
                    >
                      <span className="plugins-template-mark" aria-hidden>
                        {active ? <IconCheck size={13} /> : null}
                      </span>
                      <span className="plugins-template-copy">
                        <strong className="plugins-template-name">
                          {t(`plugins.templateName.${template}`)}
                        </strong>
                        <span className="plugins-template-body">
                          {t(`plugins.templateBody.${template}`)}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="plugins-modal-actions">
              <Button
                variant="secondary"
                disabled={creating}
                onClick={() => setTemplatePick(null)}
              >
                {t("plugins.cancel")}
              </Button>
              <Button
                variant="primary"
                disabled={creating}
                onClick={() => void createFromTemplate(templatePick)}
              >
                {creating
                  ? t("plugins.newFromTemplateCreating")
                  : t("plugins.newFromTemplateCreate")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

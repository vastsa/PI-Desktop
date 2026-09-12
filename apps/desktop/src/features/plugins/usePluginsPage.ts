import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";
import type {
  ActivationScope,
  MarketPluginDetail,
  MarketPluginSummary,
  PluginServiceStatus,
  PluginSummary,
  ProjectRecord,
  ProjectWorkspace,
} from "@pi-desktop/shared";
import {
  GROUP_ORDER,
  type GroupId,
  type TabId,
  TEMPLATE_IDS,
  type TemplateId,
  groupOf,
  isClientVisibleMarketPlugin,
  matchesQuery,
  orderPermissions,
  versionInstallable,
  versionWithdrawn,
} from "./model";

export function usePluginsPage() {
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MarketPluginDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [services, setServices] = useState<PluginServiceStatus[]>([]);
  const [selectedVersion, setSelectedVersion] = useState("");
  const [settingsPlugin, setSettingsPlugin] = useState<PluginSummary | null>(null);

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

  // A pi CLI extension becomes a development plugin holding `agent.extension`
  // (spec 07-plugins/16 §3); the confirm is the trust decision. Declared npm
  // dependencies are installed (scripts disabled) before the first load.
  const importExtension = () =>
    run(async () => {
      if (!window.confirm(t("plugins.agentExtension.importConfirm"))) return;
      const result = await api.importPiExtension();
      if (result.canceled) return;
      await refreshPlugins();
      if (result.dependencies.state === "failed") {
        showToast(
          t("plugins.importExtensionDepsFailed", { id: result.id, error: result.dependencies.error }),
          { variant: "warning" },
        );
        return;
      }
      showToast(t("plugins.importExtensionDone", { id: result.id }), { variant: "success" });
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
    { key: "importExtension", run: importExtension },
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

  return {
    t,
    locale,
    plugins,
    settings,
    refreshPlugins,
    showToast,
    openUrlInWorkPanel,
    activateProject,
    currentProjectPath,
    tab,
    setTab,
    installedQuery,
    setInstalledQuery,
    projects,
    query,
    setQuery,
    category,
    setCategory,
    market,
    marketLoading,
    busyId,
    reloadingId,
    pendingInstall,
    setPendingInstall,
    autoUpdate,
    setAutoUpdate,
    templatePick,
    setTemplatePick,
    creating,
    marketSource,
    setMarketSource,
    headerMenu,
    setHeaderMenu,
    rowMenu,
    setRowMenu,
    selectedId,
    detail,
    detailLoading,
    servicesByPlugin,
    selectedVersion,
    setSelectedVersion,
    settingsPlugin,
    setSettingsPlugin,
    refreshMarket,
    openDetail,
    closeDetail,
    stats,
    filteredInstalled,
    installedGroups,
    installedById,
    categories,
    visibleMarket,
    activeVersion,
    run,
    loadDev,
    importExtension,
    reloadPlugin,
    installPackage,
    createFromTemplate,
    checkUpdates,
    applyAutoUpdates,
    queueInstall,
    confirmInstall,
    overflowActions,
    installTarget,
    installedDetail,
    detailPermissions,
    detailUpToDate,
    detailPackagePending,
    detailWithdrawn,
  };
}

export type PluginsPageModel = ReturnType<typeof usePluginsPage>;

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";
import { usePluginBrowseState } from "./browse-state";
import type {
  MarketPluginDetail,
  MarketPluginSummary,
  PluginPermissionReview,
  PluginServiceStatus,
  PluginSummary,
  ProjectRecord,
} from "@pi-desktop/shared";
import {
  GROUP_ORDER,
  type GroupId,
  TEMPLATE_IDS,
  type TemplateId,
  groupOf,
  isClientVisibleMarketPlugin,
  matchesQuery,
  orderPermissions,
  versionInstallable,
  versionWithdrawn,
} from "./model";
import {
  canCancelInstall,
  isInstallCancelled,
  newInstallJob,
  nextInstallSample,
  withInstallProgress,
  type InstallSample,
  type PluginInstallJob,
  type PluginInstallRequest,
} from "./install-progress";

export function usePluginsPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const plugins = useAppStore((s) => s.plugins);
  const settings = useAppStore((s) => s.settings);
  const refreshPlugins = useAppStore((s) => s.refreshPlugins);
  const showToast = useAppStore((s) => s.showToast);
  const activateProject = useAppStore((s) => s.activateProject);
  /**
   * The folder open in this window. Scoping something to "this project" is only
   * meaningful relative to it, so the control needs it as its default target.
   */
  const currentProjectPath = useAppStore((s) => s.workspace?.path ?? null);

  const { tab, setTab, installedQuery, setInstalledQuery, query, setQuery, category, setCategory } = usePluginBrowseState();
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [market, setMarket] = useState<MarketPluginSummary[]>([]);
  const [marketLoading, setMarketLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [installJob, setInstallJob] = useState<PluginInstallJob | null>(null);
  /**
   * The job, and the reading a transfer speed is measured against, are mirrored
   * in refs: the progress subscription and the request's own answer must both
   * see the install as it is now, not as it was when it started.
   */
  const installJobRef = useRef<PluginInstallJob | null>(null);
  const installSampleRef = useRef<InstallSample | null>(null);
  const [reloadingId, setReloadingId] = useState<string | null>(null);
  const [pendingInstall, setPendingInstall] = useState<{
    id: string;
    name: string;
    permissions: string[];
    newPermissions: string[];
    version?: string;
  } | null>(null);
  /**
   * A development plugin whose folder was chosen but not yet granted. Loading a
   * folder is a request: nothing is registered until the user answers, so the
   * declaration waits here the same way an install does.
   */
  const [pendingReview, setPendingReview] = useState<PluginPermissionReview | null>(null);
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

  /**
   * The install dialog is the top layer while it is open: the permission review
   * behind it and the detail sheet below that both leave Escape to it.
   */
  const installDialogOpen = installJob !== null;

  /** Apply a change to the open install; reports whether a dialog was there. */
  const updateInstallJob = (update: (job: PluginInstallJob) => PluginInstallJob): boolean => {
    const current = installJobRef.current;
    if (!current) return false;
    const next = update(current);
    installJobRef.current = next;
    setInstallJob(next);
    return true;
  };

  const closeInstallDialog = () => {
    installJobRef.current = null;
    installSampleRef.current = null;
    setInstallJob(null);
  };

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
    // Escape leaves the opener focused; match pointer dismissal without
    // removing the focus indicator used by subsequent keyboard navigation.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.matches(".plugins-card-hit")) {
      focused.blur();
    }
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

  // Plugin and catalog labels are resolved in the host, so a language switch
  // has to re-read the marketplace list; otherwise the previous language stays
  // on the cards until the user happens to type (ADR 0160).
  useEffect(() => {
    if (tab !== "market") return;
    void refreshMarket(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale]);

  // Escape closes the detail sheet, but only while it owns the top layer: the
  // permission dialog and the install dialog in front of it handle their own
  // dismissal.
  useEffect(() => {
    if (!selectedId || pendingInstall || installDialogOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDetail();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selectedId, pendingInstall, installDialogOpen]);

  useEffect(() => {
    if (!pendingInstall) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPendingInstall(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [pendingInstall]);

  // An install reports itself while it runs: the phase, the mirror it is trying
  // and the bytes that have arrived. Reports for another plugin are ignored, and
  // the request's own answer still decides how the install ends.
  useEffect(() => {
    return api.onPluginInstallProgress((event) => {
      const job = installJobRef.current;
      if (!job || job.request.id !== event.pluginId) return;
      // A cancellation is the user's own action, not a failure to report: the
      // dialog leaves quietly instead of showing it as an error.
      if (event.error && isInstallCancelled(event.error)) {
        closeInstallDialog();
        return;
      }
      const sample = nextInstallSample(installSampleRef.current, event, Date.now());
      installSampleRef.current = sample;
      const next = withInstallProgress(job, event, sample);
      installJobRef.current = next;
      setInstallJob(next);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      const result = await api.loadDevPlugin();
      // The folder picker reports the declaration; the review is the grant.
      if (result.canceled || !result.review) return;
      setPendingReview(result.review);
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
        const result = await api.reloadPlugin(id);
        // The manifest asks for more than it is running with: ask first, and
        // load only after the answer.
        if (result.review) {
          setPendingReview(result.review);
          return;
        }
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
      setTemplatePick(null);
      // A canceled folder picker is not a failure: leave the page untouched.
      if (created.canceled) return;
      // Scaffolding writes files; loading waits for the same review a folder
      // picked by hand goes through.
      if (created.review) {
        await activateTemplateProject(created);
        setPendingReview(created.review);
        return;
      }
      await finishTemplate(created);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setCreating(false);
    }
  };

  /** Open the scaffolded folder so the sources land in the workspace. */
  const activateTemplateProject = async (created: { dir?: string }) => {
    try {
      return created.dir ? await activateProject(created.dir) : null;
    } catch (e) {
      // The plugin exists on disk either way; a failed open is reported on its
      // own instead of replacing the result.
      return e;
    }
  };

  const finishTemplate = async (created: { dir?: string; name?: string }) => {
    await refreshPlugins();
    const opened = await activateTemplateProject(created);
    showToast(
      t(
        opened && !(opened instanceof Error)
          ? "plugins.newFromTemplateOpened"
          : "plugins.newFromTemplateDone",
        { name: created.name ?? "" },
      ),
      { variant: "success" },
    );
    if (opened instanceof Error) {
      showToast(opened.message, { variant: "error" });
    }
  };

  /**
   * The answer to a development permission review. The accepted set is what the
   * user just saw, and it becomes the ceiling every later hot reload is measured
   * against — a folder or a manifest edit can never widen it on its own.
   */
  const confirmReview = async () => {
    const review = pendingReview;
    if (!review) return;
    setBusyId(review.id);
    try {
      if (review.kind === "reload") {
        await api.confirmReloadPlugin({
          id: review.id,
          grantedPermissions: review.permissions,
        });
        await refreshPlugins();
        showToast(t("plugins.reloadDone"), { variant: "success" });
      } else {
        await api.confirmLoadDevPlugin({
          path: review.path,
          grantedPermissions: review.permissions,
        });
        await refreshPlugins();
        showToast(t("plugins.loadDevDone"), { variant: "success" });
      }
      setPendingReview(null);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setBusyId(null);
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

  /**
   * Run one install: the request the review approved, or the same request again
   * after a failure. The dialog opens before the request is sent, so a slow
   * first step is visible, and the request's own answer is what ends it.
   */
  const runInstall = async (request: PluginInstallRequest) => {
    installSampleRef.current = null;
    const job = newInstallJob(request);
    installJobRef.current = job;
    setInstallJob(job);
    setBusyId(request.id);
    try {
      await api.marketInstall({
        id: request.id,
        version: request.version,
        enable: true,
        autoUpdate: request.autoUpdate,
        grantedPermissions: request.grantedPermissions,
      });
      await refreshPlugins();
      await refreshMarket();
      if (selectedId === request.id) await openDetail(request.id);
      showToast(t("plugins.installed", { name: request.name }), {
        variant: "success",
      });
      updateInstallJob((current) => ({
        ...current,
        status: "success",
        phase: "enable",
        speed: 0,
        error: null,
      }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (isInstallCancelled(e)) {
        // The user stopped it: the dialog leaves quietly, without an error.
        closeInstallDialog();
        return;
      }
      const shown = updateInstallJob((current) => ({
        ...current,
        status: "failed",
        speed: 0,
        error: message,
      }));
      // The dialog was dismissed while the install ran, so the failure has to
      // be reported where the user is looking.
      if (!shown) showToast(message, { variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

  const confirmInstall = async () => {
    if (!pendingInstall) return;
    const request: PluginInstallRequest = {
      id: pendingInstall.id,
      name: pendingInstall.name,
      version: pendingInstall.version,
      autoUpdate,
      grantedPermissions: pendingInstall.permissions,
    };
    // The review is answered, so it steps aside for the install it approved.
    setPendingInstall(null);
    await runInstall(request);
  };

  /** Ask the host to stop the running download, at most once. */
  const cancelInstallDownload = async () => {
    const job = installJobRef.current;
    if (!job || !canCancelInstall(job)) return;
    updateInstallJob((current) => ({ ...current, cancelling: true }));
    try {
      const res = await api.marketCancelInstall(job.request.id);
      // Nothing was running: the install is past its last safe stop, so the
      // dialog keeps watching it instead of pretending it stopped.
      if (!res.cancelled) updateInstallJob((current) => ({ ...current, cancelling: false }));
    } catch (e) {
      updateInstallJob((current) => ({ ...current, cancelling: false }));
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    }
  };

  const retryInstall = async () => {
    const job = installJobRef.current;
    if (!job || job.status === "running") return;
    await runInstall(job.request);
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
    installJob,
    cancelInstallDownload,
    retryInstall,
    closeInstallDialog,
    overflowActions,
    installTarget,
    installedDetail,
    detailPermissions,
    detailUpToDate,
    detailPackagePending,
    detailWithdrawn,
    pendingReview,
    setPendingReview,
    confirmReview,
  };
}

export type PluginsPageModel = ReturnType<typeof usePluginsPage>;

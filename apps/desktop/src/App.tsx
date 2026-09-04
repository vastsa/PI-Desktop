import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type AnimationEvent as ReactAnimationEvent,
  type CSSProperties,
  type ErrorInfo,
  type ReactNode,
} from "react";
import i18n from "i18next";
import { useTranslation } from "react-i18next";
import {
  KEYBOARD_SHORTCUTS,
  isActiveInProject,
  keybindingDisplayParts,
  keybindingMatchesEvent,
  resolveKeybinding,
  type AppMenuCommand,
  type KeyboardShortcutId,
  type ShortcutPlatform,
} from "@pi-desktop/shared";
import { Sidebar } from "./components/Sidebar";
import { ConversationTopbar } from "./components/ConversationTopbar";
import { WorkPanel } from "./components/workpanel/WorkPanel";
import { ChatSurface } from "./components/ChatSurface";
import { SearchDialog } from "./components/SearchDialog";
import { ToastHost } from "./components/Toast";
import { UpdateBanner } from "./components/UpdateBanner";
import { WindowControls } from "./components/WindowControls";
import { useAppStore } from "./stores/app-store";
import type { ToastOptions } from "./stores/app-store";
import { api } from "./lib/api";
import { commitWorkPanelPresentation } from "./lib/work-panel-presentation";
import { toolWorkPanelTab } from "./lib/work-panel-tabs";
import {
  clampSidebarWidth,
  loadSidebarWidth,
  saveSidebarWidth,
} from "./lib/sidebar-preferences";
import { StartupSplash } from "./components/StartupSplash";
import { cx } from "./components/ui";
import {
  IconNewSession,
  IconSidebar,
} from "./components/icons";
import type {
  McpServerRecord,
  McpServerStatus,
  PluginSummary,
  PluginTheme,
  ProjectRecord,
  SubagentDefinition,
  UserSkillRecord,
  UserSubagentRecord,
} from "@pi-desktop/shared";

const MODIFIER_ONLY_KEYS = new Set([
  "Alt",
  "AltGraph",
  "Control",
  "Meta",
  "Shift",
]);

const SettingsPage = lazy(() =>
  import("./pages/SettingsPage").then((module) => ({
    default: module.SettingsPage,
  })),
);
const PullRequestsPage = lazy(() =>
  import("./pages/PullRequestsPage").then((module) => ({
    default: module.PullRequestsPage,
  })),
);
const ScheduledPage = lazy(() =>
  import("./pages/ScheduledPage").then((module) => ({
    default: module.ScheduledPage,
  })),
);
const PluginsPage = lazy(() =>
  import("./pages/PluginsPage").then((module) => ({
    default: module.PluginsPage,
  })),
);

/** Holds the sanitized CSS of the active plugin theme, appended last in head. */
const PLUGIN_THEME_STYLE_ID = "pi-plugin-theme";

class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("UI crash", error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full items-center justify-center bg-bg-primary p-8 text-text-primary">
          <div className="max-w-lg rounded-lg-plus border border-border-default bg-bg-secondary p-5">
            <div className="mb-2 text-base-plus font-semibold">{i18n.t("app.uiCrashed")}</div>
            <pre className="whitespace-pre-wrap text-sm-plus text-error">
              {this.state.error.message}
            </pre>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function CollapsedTitlebarActions({
  onToggleSidebar,
  onNewTask,
  sidebarToggleShortcut,
}: {
  onToggleSidebar: () => void;
  onNewTask: () => void;
  sidebarToggleShortcut: string;
}) {
  const { t } = useTranslation();
  const toggleLabel = t("nav.expandSidebar");
  return (
    <div className="titlebar-nav no-drag">
      <button
        className="title-nav-btn"
        title={
          sidebarToggleShortcut
            ? `${toggleLabel} (${sidebarToggleShortcut})`
            : toggleLabel
        }
        aria-label={toggleLabel}
        aria-expanded={false}
        data-nav="toggle-sidebar"
        onClick={onToggleSidebar}
      >
        <IconSidebar size={13} />
      </button>
      <button
        className="title-nav-btn"
        title={t("nav.newTask")}
        aria-label={t("nav.newTask")}
        data-nav="new-task"
        onClick={onNewTask}
      >
        <IconNewSession size={13} />
      </button>
    </div>
  );
}

function RoutePending() {
  const { t } = useTranslation();
  return (
    <div className="route-pending" role="status" aria-label={t("app.loadingView")}>
      <span className="route-pending-indicator" aria-hidden />
    </div>
  );
}

function AppShell() {
  const { t } = useTranslation();
  const platform = window.piDesktop?.platform ?? "darwin";
  const bootstrap = useAppStore((s) => s.bootstrap);
  const ready = useAppStore((s) => s.ready);
  const page = useAppStore((s) => s.page);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const showToast = useAppStore((s) => s.showToast);
  const handleAgentEvent = useAppStore((s) => s.handleAgentEvent);
  const handlePlansChanged = useAppStore((s) => s.handlePlansChanged);
  const abort = useAppStore((s) => s.abort);
  const settings = useAppStore((s) => s.settings);
  const workPanelOpen = useAppStore((s) => s.workPanelOpen);
  const pluginThemes = useAppStore((s) => s.pluginThemes);
  const refreshPluginThemes = useAppStore((s) => s.refreshPluginThemes);
  const plugins = useAppStore((s) => s.plugins);
  const projectPath = useAppStore((s) => s.workspace?.path ?? null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => loadSidebarWidth());
  const [sidebarExiting, setSidebarExiting] = useState(false);
  const handleSidebarWidthChange = useCallback((width: number) => {
    setSidebarWidth(clampSidebarWidth(width));
  }, []);
  const handleSidebarWidthCommit = useCallback((width: number) => {
    const nextWidth = clampSidebarWidth(width);
    setSidebarWidth(nextWidth);
    saveSidebarWidth(nextWidth);
  }, []);
  // Stable identity: the keydown and native-menu handlers register once and
  // must never capture a stale `sidebarCollapsed`. A functional update keeps
  // the toggle symmetrical, so the second Cmd/Ctrl+B re-expands the sidebar.
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((collapsed) => !collapsed);
  }, []);
  // Keep the exit flag in sync with the collapsed state so collapsing plays
  // the sidebar-out keyframe and expanding cancels it (mirrors the work-panel
  // mount-then-animate-then-unmount machine).
  //
  // This is adjusted during render, not in an effect. An effect runs after the
  // commit, so the collapsing render would evaluate `!collapsed || exiting` as
  // `false || false` and unmount the dock outright; the effect then remounts it
  // with `is-exiting`. That paints one frame with no dock at all — the whole
  // sidebar blinks out and back before the collapse keyframe even starts.
  const prevSidebarCollapsed = useRef(sidebarCollapsed);
  if (prevSidebarCollapsed.current !== sidebarCollapsed) {
    prevSidebarCollapsed.current = sidebarCollapsed;
    setSidebarExiting(sidebarCollapsed);
  }
  const handleSidebarAnimationEnd = (event: ReactAnimationEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (!sidebarExiting) return;
    if (!event.animationName.startsWith("sidebar-out")) return;
    setSidebarExiting(false);
  };

  // Fallback in case animationend is skipped (e.g. display:none mid-flight).
  useEffect(() => {
    if (!sidebarExiting) return;
    const timer = window.setTimeout(() => setSidebarExiting(false), 240);
    return () => window.clearTimeout(timer);
  }, [sidebarExiting]);
  const [presentedWorkPanelOpen, setPresentedWorkPanelOpen] = useState(false);
  const [workPanelExiting, setWorkPanelExiting] = useState(false);
  const workPanelReservationRequest = useRef(0);
  const workPanelExitGeneration = useRef(0);
  const workPanelExitClosing = useRef(false);
  const presentedWorkPanelRef = useRef(false);
  const workPanelExitingRef = useRef(false);
  const [backendDown, setBackendDown] = useState<
    { fatal: boolean; component?: string } | null
  >(null);
  const [splashPhase, setSplashPhase] = useState<"loading" | "exiting" | "done">(
    "loading",
  );
  const splashStartedAt = useRef(
    typeof performance !== "undefined" ? performance.now() : 0,
  );
  const bootstrapStartedRef = useRef(false);

  useEffect(() => {
    presentedWorkPanelRef.current = presentedWorkPanelOpen;
  }, [presentedWorkPanelOpen]);

  useEffect(() => {
    workPanelExitingRef.current = workPanelExiting;
  }, [workPanelExiting]);

  const finishWorkPanelExit = useCallback((generation: number) => {
    if (generation !== workPanelExitGeneration.current) return;
    if (workPanelExitClosing.current) return;
    if (!workPanelExitingRef.current) return;
    workPanelExitClosing.current = true;
    const request = ++workPanelReservationRequest.current;
    void commitWorkPanelPresentation({
      reservation: api.setWorkPanelReservation(0),
      isCurrent: () =>
        request === workPanelReservationRequest.current &&
        generation === workPanelExitGeneration.current,
      commit: () => {
        setPresentedWorkPanelOpen(false);
        setWorkPanelExiting(false);
        workPanelExitingRef.current = false;
        workPanelExitClosing.current = false;
      },
    }).then((committed) => {
      // Reservation failed or was superseded — allow a later exit retry.
      if (!committed) workPanelExitClosing.current = false;
    });
  }, []);

  useEffect(() => {
    const shouldPresent = ready && page !== "settings" && workPanelOpen;
    const request = ++workPanelReservationRequest.current;

    if (shouldPresent) {
      // The panel is an internal flex column. Keep the reservation seam
      // explicitly at zero so opening it can only reflow the existing client
      // area; it must never grow the native window before mounting.
      workPanelExitGeneration.current += 1;
      workPanelExitClosing.current = false;
      workPanelExitingRef.current = false;
      setWorkPanelExiting(false);
      void commitWorkPanelPresentation({
        reservation: api.setWorkPanelReservation(0),
        isCurrent: () => request === workPanelReservationRequest.current,
        commit: () => setPresentedWorkPanelOpen(shouldPresent),
      });
      return;
    }

    // Close: keep the dock mounted through work-panel-out. The zero
    // reservation is already native-window-neutral, so only the flex column
    // collapses and returns its space to MainChat.
    if (presentedWorkPanelRef.current || workPanelExitingRef.current) {
      if (presentedWorkPanelRef.current && !workPanelExitingRef.current) {
        workPanelExitGeneration.current += 1;
        workPanelExitingRef.current = true;
        setWorkPanelExiting(true);
      }
      return;
    }

    void commitWorkPanelPresentation({
      reservation: api.setWorkPanelReservation(0),
      isCurrent: () => request === workPanelReservationRequest.current,
      commit: () => setPresentedWorkPanelOpen(shouldPresent),
    });
  }, [page, ready, workPanelOpen]);

  // Fallback if animationend is skipped (display:none mid-flight, etc.).
  useEffect(() => {
    if (!workPanelExiting) return;
    const generation = workPanelExitGeneration.current;
    const timer = window.setTimeout(() => {
      finishWorkPanelExit(generation);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [workPanelExiting, finishWorkPanelExit]);

  const runMenuCommand = useCallback(
    async (command: AppMenuCommand) => {
      try {
        const store = useAppStore.getState();
        switch (command) {
          case "newTask":
            await store.newSession();
            requestAnimationFrame(() =>
              document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus(),
            );
            break;
          case "openProject":
            await store.openProject();
            break;
          case "openSettings":
            store.setSettingsTab("general");
            break;
          case "openSearch":
            setSearchOpen(true);
            break;
          case "openCommandPalette":
            setSearchOpen(true);
            break;
          case "toggleSidebar":
            toggleSidebar();
            break;
          case "openHelp":
            store.setSettingsTab("about");
            break;
          case "openLogs":
            await api.openLogs();
            break;
          case "checkForUpdates": {
            const updateState = await api.updatesCheck();
            if (updateState.status === "up-to-date") {
              showToast(t("updates.upToDate"), { variant: "success" });
            }
            break;
          }
        }
      } catch (menuError) {
        showToast(
          menuError instanceof Error ? menuError.message : String(menuError),
          { variant: "error" },
        );
      }
    },
    [showToast, toggleSidebar],
  );

  useEffect(() => {
    const unsubscribe = api.onMenuCommand((command) => void runMenuCommand(command));
    void api.menuRendererReady().catch(() => undefined);
    return unsubscribe;
  }, [runMenuCommand]);

  useEffect(() => {
    // Fullscreen hides the macOS traffic lights; CSS shifts titlebar
    // controls left via this attribute.
    const off = api.onWindowFullScreen(({ fullScreen }) => {
      document.documentElement.dataset.fullscreen = fullScreen ? "true" : "false";
    });
    return off;
  }, []);

  useEffect(() => {
    const viewingSessionId = page === "chat" ? activeSessionId ?? null : null;
    void api
      .setNotificationViewingSession(viewingSessionId)
      .catch(() => undefined);
  }, [activeSessionId, page]);

  useEffect(() => {
    if (!ready) return;
    void refreshPluginThemes();
    // Enabling, disabling or uninstalling a plugin changes which themes exist.
    return api.onPluginChanged(() => void refreshPluginThemes());
  }, [ready, refreshPluginThemes]);

  useEffect(() => {
    if (!ready) return;
    void useAppStore.getState().refreshPlugins();
    return api.onPluginChanged(() => void useAppStore.getState().refreshPlugins());
  }, [ready]);

  // Work panel views are filtered by activation scope, so opening a different
  // project changes the list as much as installing a plugin does.
  useEffect(() => {
    if (!ready) return;
    const refresh = () => void useAppStore.getState().refreshPluginViews();
    refresh();
    return api.onPluginChanged(refresh);
  }, [ready, projectPath]);

  useEffect(() => {
    const preference = settings?.theme ?? "system";
    const pluginTheme = preference.startsWith("plugin:")
      ? pluginThemes.find((entry) => entry.id === preference)
      : undefined;
    // A plugin theme whose provider was disabled or uninstalled falls back to
    // `system` instead of leaving the shell on a half-applied palette.
    const base: "system" | "light" | "dark" = pluginTheme
      ? pluginTheme.base
      : preference === "light" || preference === "dark"
        ? preference
        : "system";

    let style = document.getElementById(PLUGIN_THEME_STYLE_ID) as HTMLStyleElement | null;
    if (pluginTheme) {
      if (!style) {
        style = document.createElement("style");
        style.id = PLUGIN_THEME_STYLE_ID;
        // Appended last so plugin overrides win over the base token sheet.
        document.head.append(style);
      }
      style.textContent = pluginTheme.css;
      document.documentElement.dataset.pluginTheme = pluginTheme.id;
    } else {
      style?.remove();
      delete document.documentElement.dataset.pluginTheme;
    }

    const apply = () => {
      document.documentElement.dataset.theme =
        base === "system"
          ? window.matchMedia("(prefers-color-scheme: light)").matches
            ? "light"
            : "dark"
          : base;
    };
    apply();
    if (base !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => apply();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [settings?.theme, pluginThemes]);

  // Global UI font: the Settings picker stores a CSS `font-family` stack in
  // `AppSettings.fontFamily`; absent means the built-in token stack.
  useEffect(() => {
    const root = document.documentElement;
    if (settings?.fontFamily) {
      root.style.setProperty("--font-sans", settings.fontFamily);
    } else {
      root.style.removeProperty("--font-sans");
    }
  }, [settings?.fontFamily]);

  useEffect(() => {
    if (bootstrapStartedRef.current) return;
    bootstrapStartedRef.current = true;
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    const offEvent = api.onAgentEvent(handleAgentEvent);
    const offPlansChanged = api.onPlansChanged(handlePlansChanged);
    // Host-pushed toasts (plugin runtime etc.) are informational.
    const offToast = api.onToast((message) => showToast(message));
    // Agent-driven HTML preview: surface the browser tab when the agent
    // opens a workspace file in the embedded browser (BrowserPreview tool).
    const offBrowserPreview = api.onBrowserPreview((event) => {
      useAppStore
        .getState()
        .openWorkPanelTabForSession(event.sessionId, {
          ...toolWorkPanelTab("browser"),
          resource: event.path,
        });
    });
    const offHostStatus = api.onHostStatus((status) => {
      if (status.ok) {
        setBackendDown(null);
        if (status.restarted) {
          showToast(t("status.restored"), { variant: "success" });
          void useAppStore.getState().refreshPlanCheckpoints();
        }
      } else {
        setBackendDown({
          fatal: status.fatal === true,
          component: status.component,
        });
        // A dead sidecar cannot finish the turn; unstick the composer.
        useAppStore.setState({ isRunning: false });
      }
    });
    const offNotificationChanged = api.onNotificationChanged((notification) => {
      useAppStore.getState().receiveNotification(notification);
      const failed = notification.kind === "task.failed";
      const title = t(
        failed ? "notifications.failedTitle" : "notifications.completedTitle",
        { sessionTitle: notification.sessionTitle },
      );
      const body = failed
        ? notification.errorCode
          ? t("notifications.failedBodyWithCode", { code: notification.errorCode })
          : t("notifications.failedBody")
        : t("notifications.completedBody");
      void api
        .showNativeNotification({
          id: notification.id,
          sessionId: notification.sessionId,
          title,
          body,
        })
        .catch(() => undefined);
    });
    const offNotificationActivated = api.onNotificationActivated(({ id }) => {
      void useAppStore
        .getState()
        .openNotification(id)
        .catch((activationError) =>
          showToast(
            activationError instanceof Error
              ? activationError.message
              : String(activationError),
            { variant: "error" },
          ),
        );
    });
    const onKey = (e: KeyboardEvent) => {
      const modifierOnly = MODIFIER_ONLY_KEYS.has(e.key);
      if (modifierOnly || e.isComposing || e.keyCode === 229) return;
      const shortcut = KEYBOARD_SHORTCUTS.find((candidate) =>
        keybindingMatchesEvent(
          resolveKeybinding(
            candidate,
            settings?.keybindings,
            platform as ShortcutPlatform,
          ),
          e,
          platform as ShortcutPlatform,
        ),
      );
      if (!shortcut) {
        const pluginShortcut = plugins
          .filter((plugin) => isActiveInProject(plugin, projectPath))
          .flatMap((plugin) =>
            (plugin.settings ?? []).map((setting) => ({ plugin, setting })),
          )
          .find(
            ({ setting }) =>
              setting.type === "shortcut" &&
              typeof setting.command === "string" &&
              keybindingMatchesEvent(
                String(setting.value ?? setting.default ?? ""),
                e,
                platform as ShortcutPlatform,
              ),
          );
        if (!pluginShortcut) return;
        e.preventDefault();
        void api.executeCommand(pluginShortcut.setting.command!);
        return;
      }
      if (
        e.repeat &&
        (shortcut.id === "navigateBack" || shortcut.id === "navigateForward")
      ) {
        return;
      }
      e.preventDefault();

      const runShortcut = (id: KeyboardShortcutId) => {
        switch (id) {
          case "navigateBack":
            useAppStore.getState().navBack();
            break;
          case "navigateForward":
            useAppStore.getState().navForward();
            break;
          case "newTask":
          case "openProject":
          case "openSettings":
            void runMenuCommand(id);
            break;
          case "openSearch":
            setSearchOpen(true);
            break;
          case "openCommandPalette":
            setSearchOpen(true);
            break;
          case "openPluginLauncher":
            void api.togglePluginLauncher();
            break;
          case "toggleSidebar":
            toggleSidebar();
            break;
          case "openWorkPanel":
            if (useAppStore.getState().page !== "settings") {
              useAppStore.getState().toggleWorkPanel();
            }
            break;
          case "abort":
            void abort();
            break;
          case "closeWindow":
            void api.windowControl("close");
            break;
          case "resetZoom":
          case "zoomIn":
          case "zoomOut":
          case "toggleFullScreen":
            void api.nativeMenuAction(id);
            break;
        }
      };
      runShortcut(shortcut.id);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      offEvent();
      offPlansChanged();
      offToast();
      offBrowserPreview();
      offHostStatus();
      offNotificationChanged();
      offNotificationActivated();
      window.removeEventListener("keydown", onKey);
    };
  }, [
    bootstrap,
    handleAgentEvent,
    handlePlansChanged,
    showToast,
    abort,
    t,
    platform,
    runMenuCommand,
    plugins,
    projectPath,
    settings?.keybindings,
    toggleSidebar,
  ]);

  useEffect(() => {
    const originalRefreshNotifications =
      useAppStore.getState().refreshNotifications;
    const originalListPluginServices = api.listPluginServices;
    const originalListMcpServers = api.listMcpServers;
    const originalListUserSkills = api.listUserSkills;
    const originalListUserSubagents = api.listUserSubagents;
    const originalSubagentCatalog = api.subagentCatalog;
    const originalListProjects = api.listProjects;
    (window as any).__PI_DESKTOP__ = {
      setPage: (page: string) => useAppStore.getState().setPage(page as any),
      refreshProviders: () => useAppStore.getState().refreshProviders(),
      selectSession: (id: string) => useAppStore.getState().selectSession(id),
      setSettingsTab: (tab: string) => useAppStore.getState().setSettingsTab(tab as any),
      setThemeAttr: (theme: "light" | "dark") => {
        document.documentElement.dataset.theme = theme;
      },
      clearProject: () => useAppStore.getState().clearProject(),
      showToast: (message: string, opts?: ToastOptions) =>
        useAppStore.getState().showToast(message, opts),
      openWorkPanelArtifact: (
        kind: "review" | "browser" | "file",
        resource?: string,
      ) => {
        if (!(window as any).__PI_CAPTURE__) return;
        if (kind === "file" && resource) {
          useAppStore.getState().openFileInWorkPanel(resource);
          return;
        }
        if (kind !== "file") {
          useAppStore.getState().openWorkPanelTab(toolWorkPanelTab(kind));
        }
      },
      collapseWorkPanel: () => {
        if (!(window as any).__PI_CAPTURE__) return;
        useAppStore.getState().collapseWorkPanel();
      },
      /**
       * Reveals the panel with whatever tabs the session already has — none, in
       * the capture suite, which is the point: this is how the no-resource
       * empty body is photographed. Production reaches it via `Cmd/Ctrl+J`.
       */
      openWorkPanel: () => {
        if (!(window as any).__PI_CAPTURE__) return;
        useAppStore.getState().openWorkPanel();
      },
      seedTranscript: (count = 12) => {
        // Capture-only transcript fixture (conversation minimap scenes);
        // count 0 restores the empty transcript for later scenes.
        if (!(window as any).__PI_CAPTURE__) return;
        if (count <= 0) {
          useAppStore.setState({ messages: [] });
          return;
        }
        const base = Date.parse("2026-07-20T09:00:00Z");
        const samples: [role: "user" | "assistant", content: string][] = [
          ["user", "帮我配置一下这个项目并启动"],
          [
            "assistant",
            "好的。先安装依赖并生成本地配置：\n\n1. `pnpm install`\n2. 复制 `.env.example` 为 `.env`\n3. `pnpm dev` 启动开发服务\n\n启动后默认监听 5173 端口。",
          ],
          ["user", "启动报错了，说找不到 host 二进制"],
          [
            "assistant",
            "这是因为 Rust 侧还没编译。运行 `cargo build -p pi-desktop-host-core`，产物会出现在 `target/debug/` 下，Electron 主进程会自动拾取。",
          ],
          ["user", "编译通过了，界面也起来了"],
          [
            "assistant",
            "很好。接下来可以在设置里添加模型提供方并保存 API 密钥，然后打开一个项目文件夹就能开始对话了。",
          ],
          ["user", "顺便把侧边栏最近会话按项目分组"],
          [
            "assistant",
            "已按项目路径分组：每组显示项目名与最近活动时间，未关联项目的会话归入“临时会话”。分组逻辑在 `sidebar-session-groups.ts`。",
          ],
          ["user", "分组标题的字号再小一点"],
          [
            "assistant",
            "已把分组标题从 `--text-sm` 调整为 `--text-2xs`，同时收紧了上下间距，现在与 PI-Desktop 的密度一致。",
          ],
          ["user", "最后跑一遍检查"],
          [
            "assistant",
            "`pnpm typecheck` 与样式令牌检查均通过，无回归。",
          ],
        ];
        const messages = Array.from(
          { length: Math.min(count, samples.length) },
          (_, i) => ({
            id: `capture-msg-${i}`,
            role: samples[i][0],
            content: samples[i][1],
            createdAt: new Date(base + i * 60_000).toISOString(),
            status: "complete" as const,
          }),
        );
        useAppStore.setState({ messages });
      },
      seedReviewChanges: (count = 4) => {
        // Capture-only review fixture (inline change rows + Review tab scenes).
        // The Review tab reads the session transcript, so the fixture is a set
        // of successful workspace Write/Edit tool messages carrying
        // `details.review`; count 0 restores the empty transcript.
        if (!(window as any).__PI_CAPTURE__) return;
        if (count <= 0) {
          useAppStore.setState({ messages: [] });
          return;
        }
        const base = Date.parse("2026-08-14T09:00:00Z");
        const samples = [
          {
            tool: "Edit",
            path: "apps/desktop/src/components/workpanel/ReviewTab.tsx",
            operation: "edit",
            status: "modified",
            state: "active",
            additions: 4,
            deletions: 6,
            hunks: [
              {
                header: "@@ -25,9 +25,7 @@",
                lines: [
                  { type: "context", text: '    <div className="review-toolbar">' },
                  { type: "del", text: '      <span className="review-toolbar-icon">' },
                  { type: "del", text: "        <IconDiff size={14} />" },
                  { type: "del", text: "      </span>" },
                  { type: "add", text: '      <span className="review-summary">' },
                ],
              },
            ],
          },
          {
            tool: "Write",
            path: "apps/desktop/src/lib/review-row-metrics.ts",
            operation: "write",
            status: "added",
            state: "active",
            additions: 12,
            deletions: 0,
            hunks: [
              {
                header: "@@ -0,0 +1,12 @@",
                lines: [
                  { type: "add", text: "export const REVIEW_ROW_HEIGHT = 24;" },
                  { type: "add", text: "export const REVIEW_MARK_WIDTH = 10;" },
                ],
              },
            ],
          },
          {
            tool: "Edit",
            path: "apps/desktop/src/styles/work-panel.css",
            operation: "edit",
            status: "deleted",
            state: "active",
            additions: 0,
            deletions: 9,
            hunks: [
              {
                header: "@@ -528,9 +528,0 @@",
                lines: [
                  { type: "del", text: ".diff-file {" },
                  { type: "del", text: "  border: 1px solid var(--ds-border-subtle);" },
                  { type: "del", text: "}" },
                ],
              },
            ],
          },
          {
            tool: "Edit",
            path: "apps/desktop/src/styles/messages.css",
            operation: "edit",
            status: "modified",
            state: "rolledBack",
            additions: 3,
            deletions: 2,
            hunks: [
              {
                header: "@@ -269,4 +269,5 @@",
                lines: [
                  { type: "context", text: ".review-change-card {" },
                  { type: "del", text: "  border-radius: var(--radius-md);" },
                  { type: "add", text: "  margin: 0 0 2px 24px;" },
                ],
              },
            ],
          },
        ];
        const messages = samples.slice(0, Math.min(count, samples.length)).flatMap(
          (sample, i) => [
            {
              id: `capture-review-user-${i}`,
              role: "user" as const,
              content:
                i === 0 ? "把审阅面板里每条改动的样式简化一下" : `继续第 ${i + 1} 处`,
              createdAt: new Date(base + i * 120_000).toISOString(),
              status: "complete" as const,
            },
            {
              id: `capture-review-${i}`,
              role: "tool" as const,
              content: "",
              createdAt: new Date(base + i * 120_000 + 30_000).toISOString(),
              toolName: sample.tool,
              toolStatus: "success" as const,
              toolArgs: { path: sample.path },
              toolResult: {
                details: {
                  root: "workspace",
                  review: {
                    version: 1,
                    snapshotId: `capture-snapshot-${i}`,
                    messageId: `capture-review-${i}`,
                    path: sample.path,
                    operation: sample.operation,
                    status: sample.status,
                    state: sample.state,
                    additions: sample.additions,
                    deletions: sample.deletions,
                    hunks: sample.hunks,
                    reversible: true,
                  },
                },
              },
            },
          ],
        );
        useAppStore.setState({ messages: messages as any });
      },
      seedRunRows: (count = 3) => {
        // Capture-only run-row fixture (D226/D227 head scenes). A Bash tool
        // message per state: a command that exits 1 while its call reports
        // success — the case the head must not read as done (D227) — a success
        // with output, and one still running; count 0 restores the empty
        // transcript.
        if (!(window as any).__PI_CAPTURE__) return;
        if (count <= 0) {
          useAppStore.setState({ messages: [] });
          return;
        }
        const base = Date.parse("2026-08-14T09:00:00Z");
        const samples = [
          {
            command: "pnpm test",
            status: "success" as const,
            details: {
              exitCode: 1,
              stdout: "desktop test 648 tests\n",
              stderr: "1 failing: run head keeps its caret\n",
            },
          },
          {
            command: "git log --oneline -6",
            status: "success" as const,
            details: {
              exitCode: 0,
              stdout: [
                "78cc1f3 test(desktop): photograph the panel's empty state",
                "df88040 docs(spec): record the no-resource empty state",
                "f81fb94 fix(desktop): give the work panel a real empty state",
                "6c8b2f0 feat(work-panel): toggle work panel visibility",
                "8f09cf9 refactor(desktop): flatten review change rows",
                "e408d88 fix(desktop): keep macOS in the Dock and Cmd+Tab",
              ].join("\n"),
              stderr: "",
            },
          },
          {
            command: "pnpm --filter @pi-desktop/desktop build",
            status: "running" as const,
            details: undefined,
          },
        ];
        const messages = samples.slice(0, Math.min(count, samples.length)).flatMap(
          (sample, i) => [
            {
              id: `capture-run-user-${i}`,
              role: "user" as const,
              content: i === 0 ? "跑一下测试" : `再跑 ${sample.command}`,
              createdAt: new Date(base + i * 120_000).toISOString(),
              status: "complete" as const,
            },
            {
              id: `capture-run-${i}`,
              role: "tool" as const,
              content: "",
              createdAt: new Date(base + i * 120_000 + 30_000).toISOString(),
              toolName: "Bash",
              toolStatus: sample.status,
              toolArgs: { command: sample.command },
              ...(sample.details ? { toolResult: { details: sample.details } } : {}),
            },
          ],
        );
        useAppStore.setState({ messages: messages as any });
      },
      seedDelegationRows: (count = 3) => {
        // Capture-only delegation fixture. One `Task` and a two-`Task` fan-out
        // in the same transcript, so the scene shows that a lone delegation now
        // gets the same card as a fan-out; count 0 restores the empty
        // transcript.
        if (!(window as any).__PI_CAPTURE__) return;
        if (count <= 0) {
          useAppStore.setState({ messages: [] });
          return;
        }
        const base = Date.parse("2026-08-14T09:00:00Z");
        const delegation = (
          index: number,
          agent: string,
          description: string,
          status: string,
          runtimeMs: number,
        ) => ({
          id: `capture-task-${index}`,
          role: "tool" as const,
          content: "",
          createdAt: new Date(base + index * 60_000).toISOString(),
          toolName: "Task",
          toolCallId: `capture-call-${index}`,
          toolStatus: status === "running" ? "running" : "success",
          toolArgs: { agent, description, task: description },
          toolResult: {
            details: {
              delegationId: `capture-delegation-${index}`,
              status,
              // A running node ticks from `startedAt`, so a fixed fixture start
              // would render the days since the fixture date. Settled nodes take
              // their runtime from the pair.
              ...(status === "running"
                ? {}
                : {
                    startedAt: base + index * 60_000,
                    completedAt: base + index * 60_000 + runtimeMs,
                  }),
              turns: 4,
              toolCalls: 9,
            },
          },
        });
        const delegateRow = (index: number, agent: string, path: string) => ({
          id: `capture-task-${index}-step`,
          role: "tool" as const,
          content: "",
          createdAt: new Date(base + index * 60_000 + 5_000).toISOString(),
          toolName: "Read",
          toolCallId: `capture-call-${index}-step`,
          toolStatus: "success" as const,
          toolArgs: { file_path: path },
          parentToolCallId: `capture-call-${index}`,
          agentName: agent,
        });
        const messages = [
          {
            id: "capture-task-user-0",
            role: "user" as const,
            content: "帮我审一下 store 的改动",
            createdAt: new Date(base - 30_000).toISOString(),
            status: "complete" as const,
          },
          delegation(0, "code-reviewer", "check the store diff", "completed", 32_000),
          delegateRow(0, "code-reviewer", "apps/desktop/src/stores/app-store.ts"),
          {
            id: "capture-task-answer-0",
            role: "assistant" as const,
            content: "审阅完成：队列按 id 丢弃请求，没有发现回归。",
            createdAt: new Date(base + 40_000).toISOString(),
            status: "complete" as const,
          },
          {
            id: "capture-task-user-1",
            role: "user" as const,
            content: "再并行看下 runtime 和 shared",
            createdAt: new Date(base + 55_000).toISOString(),
            status: "complete" as const,
          },
          delegation(1, "code-reviewer", "audit agent-runtime", "completed", 48_000),
          delegateRow(1, "code-reviewer", "packages/agent-runtime/src/runtime.ts"),
          delegation(2, "explorer", "map the shared protocol", "running", 0),
        ];
        useAppStore.setState({ messages: messages as any });
      },
      seedPlugins: (count = 4) => {
        // Capture-only plugins fixture (plugins index scenes); count 0 clears.
        // One sample per row group so the D169 bands are all exercised, and one
        // sample per new contribution kind so the capability/service chips do.
        if (!(window as any).__PI_CAPTURE__) return;
        if (count <= 0) {
          useAppStore.setState({ plugins: [] });
          (api as any).listPluginServices = originalListPluginServices;
          return;
        }
        // The rows read service state straight from IPC, which reports nothing
        // for a fixture plugin; stand in for the supervisor here.
        (api as any).listPluginServices = async () => [
          {
            pluginId: "pi.git-insights",
            serviceId: "indexer",
            label: "Repository indexer",
            state: "running",
            restarts: 0,
          },
          {
            pluginId: "pi.markdown-tools",
            serviceId: "watcher",
            label: "Document watcher",
            state: "failed",
            restarts: 3,
            message: "start() threw: ENOENT",
          },
        ];
        const samples: PluginSummary[] = [
          {
            id: "pi.deploy-preview",
            name: "Deploy Preview",
            version: "0.4.1",
            enabled: true,
            source: "installed",
            status: "load_error",
            errorMessage: "Manifest declares net.fetch but the grant is missing.",
            permissions: ["net.fetch", "ui.panel"],
            capabilities: ["panel", "tools", "mcp"],
            author: "Pi Labs",
            description: "Builds a preview deployment for the current branch.",
          },
          {
            id: "pi.git-insights",
            name: "Git Insights",
            version: "1.4.2",
            enabled: true,
            source: "marketplace",
            status: "ready",
            permissions: ["fs.read", "fs.write", "ui.panel", "notify"],
            fs: {
              read: { root: "workspace", scope: ["**/*"] },
              write: { root: "workspace", scope: ["docs/**", "*.md"] },
            },
            capabilities: ["panel", "commands", "skills", "services", "bus"],
            author: "Pi Labs",
            description: "Summarizes repository activity into a review panel.",
            updateAvailable: {
              version: "1.5.0",
              shasum: "capture",
              url: "https://example.invalid/git-insights-1.5.0.piplug",
            },
          },
          {
            id: "pi.markdown-tools",
            name: "Markdown Tools",
            version: "0.9.0",
            enabled: true,
            source: "marketplace",
            status: "ready",
            permissions: ["clipboard.read", "clipboard.write", "ui.panel"],
            capabilities: ["commands", "themes", "services"],
            author: "Community",
            description: "Formats tables and normalizes headings on demand.",
            autoUpdate: true,
          },
          {
            id: "pi.scratchpad",
            name: "Scratchpad",
            version: "dev",
            enabled: false,
            source: "dev",
            status: "disabled",
            permissions: ["ui.panel"],
            author: "Local build",
            description: "A local panel for quick notes beside the transcript.",
          },
        ];
        useAppStore.setState({ plugins: samples.slice(0, count) });
      },
      seedExtensions: (count = 3) => {
        // Capture-only fixture for the Settings > Agent capability pages. Those
        // pages read
        // straight from IPC into local state rather than the store, so the rig
        // has to stand in for the host rather than seed a slice; count 0 puts
        // the real calls back.
        if (!(window as any).__PI_CAPTURE__) return;
        if (count <= 0) {
          (api as any).listMcpServers = originalListMcpServers;
          (api as any).listUserSkills = originalListUserSkills;
          (api as any).listUserSubagents = originalListUserSubagents;
          (api as any).subagentCatalog = originalSubagentCatalog;
          (api as any).listProjects = originalListProjects;
          return;
        }
        const projects: ProjectRecord[] = [
          {
            id: 1,
            path: "/Users/pi/work/api",
            name: "api",
            pinned: true,
            createdAt: 0,
            lastOpenedAt: 0,
          },
          {
            id: 2,
            path: "/Users/pi/work/web",
            name: "web",
            pinned: false,
            createdAt: 0,
            lastOpenedAt: 0,
          },
          {
            id: 3,
            path: "/Users/pi/personal/site",
            name: "site",
            pinned: false,
            createdAt: 0,
            lastOpenedAt: 0,
          },
        ];
        // One server per connection state, so the row glyph's whole colour range
        // is exercised, and one per activation state.
        const stamp = "2026-08-04T09:00:00.000Z";
        const servers: McpServerRecord[] = (
          [
          {
            id: "context7",
            label: "Context7",
            level: "global",
            description: "Up-to-date library documentation.",
            transport: "stdio",
            command: "npx",
            args: ["-y", "@upstash/context7-mcp"],
            env: {},
            enabled: true,
            scope: { mode: "global", projects: [] },
          },
          {
            id: "linear",
            label: "Linear",
            level: "global",
            description: "Issues and cycles for the work tracker.",
            transport: "http",
            url: "https://mcp.linear.app/sse",
            headers: { Authorization: "Bearer •••" },
            enabled: true,
            scope: { mode: "projects", projects: ["/Users/pi/work/api"] },
          },
          {
            id: "postgres",
            label: "Postgres",
            level: "project",
            projectPath: "/Users/pi/work/api",
            description: "Runs read-only queries against the dev database.",
            transport: "stdio",
            command: "mcp-server-postgres",
            args: ["postgresql://localhost/dev"],
            env: {},
            enabled: true,
            scope: { mode: "projects", projects: [] },
          },
          {
            id: "figma",
            label: "Figma",
            level: "project",
            projectPath: "/Users/pi/work/api",
            description: "Reads frames and design tokens from a file.",
            transport: "stdio",
            command: "figma-mcp",
            args: [],
            env: {},
            enabled: false,
            scope: { mode: "global", projects: [] },
          },
          ] as Array<Omit<McpServerRecord, "createdAt" | "updatedAt">>
        ).map((server) => ({ ...server, createdAt: stamp, updatedAt: stamp }));
        const statuses: McpServerStatus[] = [
          {
            serverId: "context7",
            state: "ready",
            toolCount: 2,
            toolNames: ["resolve-library-id", "get-library-docs"],
            updatedAt: 0,
          },
          { serverId: "linear", state: "connecting", toolCount: 0, updatedAt: 0 },
          {
            serverId: "postgres",
            state: "failed",
            toolCount: 0,
            message: "spawn mcp-server-postgres ENOENT",
            updatedAt: 0,
          },
          { serverId: "figma", state: "idle", toolCount: 0, updatedAt: 0 },
        ];
        const skills: UserSkillRecord[] = [
          {
            id: "release-notes",
            name: "Release Notes",
            level: "global",
            description:
              "Turn a range of commits into release notes grouped by user-visible change.",
            enabled: true,
            scope: { mode: "global", projects: [] },
            source: "created",
            path: "/Users/pi/.agents/skills/release-notes/SKILL.md",
            sizeBytes: 2_412,
            createdAt: "2026-07-30T10:00:00.000Z",
            updatedAt: "2026-08-04T09:12:00.000Z",
          },
          {
            id: "api-review",
            name: "API Review",
            level: "project",
            projectPath: "/Users/pi/work/api",
            description:
              "Check a handler against the house rules for pagination, errors, and auth.",
            enabled: true,
            scope: { mode: "projects", projects: ["/Users/pi/work/api"] },
            source: "created",
            path: "/Users/pi/.agents/skills/api-review/SKILL.md",
            sizeBytes: 7_940,
            createdAt: "2026-07-12T10:00:00.000Z",
            updatedAt: "2026-08-01T16:30:00.000Z",
          },
          {
            id: "incident-writeup",
            name: "Incident Writeup",
            level: "global",
            description: "Draft a blameless postmortem from a timeline of events.",
            enabled: false,
            scope: { mode: "global", projects: [] },
            source: "imported",
            path: "/Users/pi/.agents/skills/incident-writeup/SKILL.md",
            sizeBytes: 118_400,
            createdAt: "2026-06-02T10:00:00.000Z",
            updatedAt: "2026-06-02T10:00:00.000Z",
          },
        ];
        // One global definition per state the row can report: active, customized,
        // builtin replacement, and turned off.
        const subagents: UserSubagentRecord[] = [
          {
            id: "log-reader",
            name: "log-reader",
            level: "global",
            description:
              "Read a build log end to end and report the first real failure with its file and line.",
            enabled: true,
            scope: { mode: "global", projects: [] },
            tools: ["Read", "Grep", "Bash"],
            maxTurns: 12,
            path: "/Users/pi/.agents/subagents/log-reader.md",
            sizeBytes: 1_840,
            createdAt: "2026-08-05T09:00:00.000Z",
            updatedAt: "2026-08-06T11:20:00.000Z",
          },
          {
            id: "schema-diff",
            name: "schema-diff",
            level: "global",
            description:
              "Compare the migration files on a branch against the committed schema and list what drifted.",
            enabled: true,
            scope: { mode: "global", projects: [] },
            tools: ["Read", "Glob", "Grep"],
            model: "anthropic/claude-haiku-4-5",
            thinkingLevel: "low",
            path: "/Users/pi/.agents/subagents/schema-diff.md",
            sizeBytes: 3_120,
            createdAt: "2026-07-28T09:00:00.000Z",
            updatedAt: "2026-08-02T14:05:00.000Z",
          },
          {
            id: "explorer",
            name: "explorer",
            level: "global",
            description: "My own explorer, with the repository's layout written into the prompt.",
            enabled: true,
            scope: { mode: "global", projects: [] },
            tools: ["Read", "Glob", "Grep"],
            maxTurns: 30,
            path: "/Users/pi/.agents/subagents/explorer.md",
            sizeBytes: 2_260,
            createdAt: "2026-08-01T09:00:00.000Z",
            updatedAt: "2026-08-01T09:00:00.000Z",
          },
          {
            id: "release-drafter",
            name: "release-drafter",
            level: "global",
            description: "Draft the release notes for a tag range, grouped by user-visible change.",
            enabled: false,
            scope: { mode: "global", projects: [] },
            tools: ["Read", "Grep"],
            path: "/Users/pi/.agents/subagents/release-drafter.md",
            sizeBytes: 980,
            createdAt: "2026-06-20T09:00:00.000Z",
            updatedAt: "2026-06-20T09:00:00.000Z",
          },
        ];
        // The effective catalog main would compute: global user documents replace
        // builtins by name, and the other builtins remain available.
        const catalog: SubagentDefinition[] = [
          {
            name: "log-reader",
            description: "A user-owned log reader, tuned for its CI output.",
            prompt: "You are log-reader.\n",
            tools: ["Read", "Grep"],
            maxTurns: 12,
            source: "user",
            filePath: "/Users/pi/.agents/subagents/log-reader.md",
          },
          {
            name: "explorer",
            description: "My own explorer, with the repository's layout written into the prompt.",
            prompt: "You are explorer.\n",
            tools: ["Read", "Glob", "Grep"],
            maxTurns: 30,
            source: "user",
            filePath: "/Users/pi/.agents/subagents/explorer.md",
          },
          {
            name: "code-reviewer",
            description:
              "Review a change for correctness, then report findings ranked by severity.",
            prompt: "You are code-reviewer.\n",
            tools: ["Read", "Glob", "Grep"],
            maxTurns: 24,
            source: "builtin",
          },
          {
            name: "test-runner",
            description: "Run the test suite, then report the first failure that is not flaky.",
            prompt: "You are test-runner.\n",
            tools: ["Read", "Glob", "Grep", "Bash"],
            maxTurns: 24,
            source: "builtin",
          },
        ];
        const rowsForQuery = <T extends { level?: string; projectPath?: string }>(
          rows: readonly T[],
          query: { level?: string; projectPath?: string } = {},
        ) =>
          rows.filter(
            (row) =>
              (!query.level || row.level === query.level) &&
              (!query.projectPath || !row.projectPath || row.projectPath === query.projectPath),
          );
        (api as any).listProjects = async () => ({ projects });
        (api as any).listMcpServers = async (query: { level?: string; projectPath?: string } = {}) => {
          const filtered = rowsForQuery(servers, query);
          return {
            servers: filtered,
            statuses: statuses.filter((status) => filtered.some((server) => server.id === status.serverId)),
          };
        };
        (api as any).listUserSkills = async (query: { level?: string; projectPath?: string } = {}) => ({
          skills: rowsForQuery(skills, query).slice(0, count),
        });
        (api as any).listUserSubagents = async () => ({ subagents });
        (api as any).subagentCatalog = async () => ({
          subagents: catalog,
          diagnostics: [],
          projectPath: "/Users/pi/work/api",
        });
      },
      seedPluginThemes: (count = 2) => {
        // Capture-only theme fixture: plugin themes share the built-in grid on
        // the general settings page, so the rig needs some to render.
        if (!(window as any).__PI_CAPTURE__) return;
        if (count <= 0) {
          useAppStore.setState({ pluginThemes: [] });
          return;
        }
        const samples: PluginTheme[] = [
          {
            id: "plugin:pi.markdown-tools:midnight",
            pluginId: "pi.markdown-tools",
            themeId: "midnight",
            label: "Midnight",
            base: "dark",
            css: "",
          },
          {
            id: "plugin:pi.markdown-tools:parchment",
            pluginId: "pi.markdown-tools",
            themeId: "parchment",
            label: "Parchment",
            base: "light",
            css: "",
          },
        ];
        useAppStore.setState({ pluginThemes: samples.slice(0, count) });
      },
      seedNotifications: (count = 105) => {
        // Capture-only notification fixture; count 0 restores an empty inbox.
        if (!(window as any).__PI_CAPTURE__) return;
        if (count <= 0) {
          useAppStore.setState({
            notifications: [],
            unreadNotificationCount: 0,
            refreshNotifications: originalRefreshNotifications,
          });
          return;
        }
        const now = Date.now();
        const titles = [
          "重新设计设置页面插件板块手机端 UI 布局并验证所有断点",
          "修复 host-core 启动失败并补充错误恢复测试",
          "同步代码",
        ];
        // The inbox lists failures only, so every fixture row is a failure.
        const notifications = Array.from({ length: count }, (_, index) => ({
          id: `capture-notification-${index}`,
          kind: "task.failed" as const,
          sessionId: `capture-session-${index}`,
          sessionTitle: titles[index] ?? `后台任务 ${index + 1}`,
          turnId: `capture-turn-${index}`,
          ...(index % 2 === 1 ? { errorCode: "MODEL_REQUEST_TIMEOUT" } : {}),
          createdAt: new Date(now - (index + 1) * 60_000).toISOString(),
          readAt: index === 2 ? new Date(now - 30_000).toISOString() : null,
        }));
        useAppStore.setState({
          notifications,
          unreadNotificationCount: notifications.reduce(
            (total, notification) => total + (notification.readAt ? 0 : 1),
            0,
          ),
          refreshNotifications: async () => undefined,
        });
      },
      seedSidebarStatuses: () => {
        if (!(window as any).__PI_CAPTURE__) return null;
        const sessions = useAppStore.getState().sessions.slice(0, 4);
        if (sessions.length < 4) return null;
        const [selected, running, completed, failed] = sessions;
        useAppStore.setState({
          page: "chat",
          activeSessionId: selected.id,
          isRunning: false,
          runningSessions: { [running.id]: true },
          sessionOutcomes: {
            [completed.id]: "completed",
            [failed.id]: "failed",
          },
        });
        return {
          selected: selected.id,
          running: running.id,
          completed: completed.id,
          failed: failed.id,
        };
      },
      ensureVisualFixtures: async () => {
        // Destructive fixture seeding is capture-rig only; the rig sets
        // __PI_CAPTURE__ before invoking (see electron/main capture suite).
        if (!(window as any).__PI_CAPTURE__) return;
        // Optical hero title length: short folder basenames under-ink vs Codex gold.
        const ws = useAppStore.getState().workspace;
        if (ws?.path) {
          const base = (ws.name || ws.path.split(/[\/]/).filter(Boolean).pop() || "").trim();
          if (base.length > 0 && base.length < 12) {
            useAppStore.setState({
              workspace: { ...ws, name: "PI-Desktop" },
            });
          }
        }
        // Seed representative session titles for capture residuals (data band).
        try {
          await useAppStore.getState().refreshSessions();
          const englishNoise = new Set([
            "Review open pull requests",
            "Tighten composer elevation",
            "Dark theme night plate",
            "Sidebar recents density",
            "Settings appearance polish",
            "Plugins empty state",
            "Fix TypeScript build errors",
            "Exploring repository structure",
          ]);
          for (const s of useAppStore.getState().sessions || []) {
            if (englishNoise.has((s.title || "").trim())) {
              try {
                await api.deleteSession(s.id);
              } catch {
                // ignore
              }
            }
          }
          await useAppStore.getState().refreshSessions();
          const existing = new Set(
            (useAppStore.getState().sessions || []).map((s) => (s.title || "").trim()),
          );
          const titles = [
            "同步代码",
            "你好",
            "终止进程里面有一个注册机的",
            "加一下",
            "帮我彻底卸载比特浏览器",
            "帮我配置一下这个项目并启动",
            "重新设计设置页面插件板块手机端ui布局",
            "制作台的布局重新设计，需要现代化简",
          ];
          for (const title of titles) {
            if (existing.has(title)) continue;
            if ((useAppStore.getState().sessions?.length ?? 0) >= 14) break;
            await api.createSession({ title });
            existing.add(title);
          }
          await useAppStore.getState().refreshSessions();
          const preferred = useAppStore
            .getState()
            .sessions.find((s) => (s.title || "").trim() === "同步代码");
          if (preferred) {
            try {
              const raw = localStorage.getItem("pi.desktop.pinnedSessions");
              const parsed = raw ? JSON.parse(raw) : [];
              const pins = Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
              if (!pins.includes(preferred.id)) {
                localStorage.setItem(
                  "pi.desktop.pinnedSessions",
                  JSON.stringify([preferred.id, ...pins].slice(0, 40)),
                );
              }
            } catch {
              // ignore
            }
            await useAppStore.getState().selectSession(preferred.id);
          }
        } catch {
          // optional capture-only fixture
        }
      },
    };
    return () => {
      useAppStore.setState({
        refreshNotifications: originalRefreshNotifications,
      });
      try {
        delete (window as any).__PI_DESKTOP__;
      } catch {
        // ignore
      }
    };
  }, []);

  useEffect(() => {
    if (!ready) return;

    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const minMs = reduceMotion ? 0 : 420;
    const exitMs = reduceMotion ? 0 : 280;
    const wait = Math.max(
      0,
      minMs - (performance.now() - splashStartedAt.current),
    );

    let cancelled = false;
    let endTimer: number | undefined;
    const startTimer = window.setTimeout(() => {
      if (cancelled) return;
      if (exitMs === 0) {
        setSplashPhase("done");
        return;
      }
      setSplashPhase("exiting");
      endTimer = window.setTimeout(() => {
        if (!cancelled) setSplashPhase("done");
      }, exitMs);
    }, wait);

    return () => {
      cancelled = true;
      window.clearTimeout(startTimer);
      if (endTimer !== undefined) window.clearTimeout(endTimer);
    };
  }, [ready]);

  const showSplash = splashPhase !== "done";
  const splash = showSplash ? (
    <StartupSplash exiting={splashPhase === "exiting"} />
  ) : null;

  const shortcutPlatform = platform as ShortcutPlatform;
  const toggleSidebarShortcut = KEYBOARD_SHORTCUTS.find(
    (shortcut) => shortcut.id === "toggleSidebar",
  );
  const sidebarToggleShortcut = toggleSidebarShortcut
    ? keybindingDisplayParts(
        resolveKeybinding(
          toggleSidebarShortcut,
          settings?.keybindings,
          shortcutPlatform,
        ),
        shortcutPlatform,
      ).join(shortcutPlatform === "darwin" ? "" : "+")
    : "";

  let shell: ReactNode = null;
  if (ready) {
    if (page === "settings") {
      shell = (
        <>
          <WindowControls />
          <Suspense fallback={<RoutePending />}>
            <SettingsPage />
          </Suspense>
          <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
          <ToastHost />
          <UpdateBanner />
        </>
      );
    } else {
      shell = (
        <>
          {!sidebarCollapsed || sidebarExiting ? (
            <Sidebar
              className={sidebarExiting ? "is-exiting" : undefined}
              onAnimationEnd={handleSidebarAnimationEnd}
              onOpenSearch={() => setSearchOpen(true)}
              onToggleSidebar={toggleSidebar}
              sidebarToggleShortcut={sidebarToggleShortcut}
              sidebarWidth={sidebarWidth}
              onWidthChange={handleSidebarWidthChange}
              onWidthCommit={handleSidebarWidthCommit}
            />
          ) : null}

          <section className="main-pane">
            <WindowControls contained />
            {page === "chat" ? (
              <ConversationTopbar
                sidebarCollapsed={sidebarCollapsed}
                workPanelOpen={presentedWorkPanelOpen}
                onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
                onNewTask={() => void runMenuCommand("newTask")}
                onOpenSearch={() => setSearchOpen(true)}
              />
            ) : (
              <div
                className={cx(
                  "main-titlebar",
                  presentedWorkPanelOpen && "work-panel-open",
                )}
              >
                {sidebarCollapsed && (
                  <div className="main-titlebar-left no-drag">
                    <CollapsedTitlebarActions
                      onToggleSidebar={() => setSidebarCollapsed(false)}
                      onNewTask={() => void runMenuCommand("newTask")}
                      sidebarToggleShortcut={sidebarToggleShortcut}
                    />
                  </div>
                )}
              </div>
            )}
            <UpdateBanner />

            {backendDown && (
              <div
                className={`backend-banner no-drag ${backendDown.fatal ? "fatal" : "warn"}`}
                role="status"
              >
                <span className="backend-dot" aria-hidden />
                <span>
                  {backendDown.fatal ? t("status.fatal") : t("status.restarting")}
                </span>
                {backendDown.fatal && (
                  <button
                    type="button"
                    className="backend-action"
                    onClick={() => void api.openLogs()}
                  >
                    {t("status.openLogs")}
                  </button>
                )}
              </div>
            )}

            <Suspense fallback={<RoutePending />}>
              {page === "pulls" ? (
                <div className="route-surface route-page">
                  <PullRequestsPage />
                </div>
              ) : page === "scheduled" ? (
                <div className="route-surface route-page">
                  <ScheduledPage />
                </div>
              ) : page === "plugins" ? (
                <div className="route-surface route-page">
                  <PluginsPage />
                </div>
              ) : (
                <ChatSurface />
              )}
            </Suspense>
          </section>

          {(presentedWorkPanelOpen || workPanelExiting) && (
            <WorkPanel
              panelBlocked={searchOpen}
              exiting={workPanelExiting}
              onExitAnimationEnd={() =>
                finishWorkPanelExit(workPanelExitGeneration.current)
              }
              onCollapse={() => useAppStore.getState().collapseWorkPanel()}
            />
          )}

          <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
          <ToastHost />
        </>
      );
    }
  }

  return (
    <div
      className={cx(
        "app-shell",
        !ready && "app-shell-boot",
        page === "settings" && ready && "settings-mode",
        sidebarCollapsed && "sidebar-collapsed",
        showSplash && "is-booting",
      )}
      style={{ "--ds-sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      {shell}
      {splash}
    </div>
  );
}


export default function App() {
  return (
    <ErrorBoundary>
      <AppShell />
    </ErrorBoundary>
  );
}

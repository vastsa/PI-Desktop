import {
  type AppMenuCommand,
  isActiveInProject,
  isThemeColorScheme,
  KEYBOARD_SHORTCUTS,
  type KeyboardShortcutId,
  keybindingDisplayParts,
  keybindingMatchesEvent,
  resolveFontScale,
  resolveKeybinding,
  type ShortcutPlatform,
} from "@pi-desktop/shared";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { installRendererApi } from "../../capture/renderer-api";
import { StartupSplash } from "../../components/StartupSplash";
import { api } from "../../lib/api";
import {
  clampSidebarWidth,
  loadSidebarWidth,
  saveSidebarWidth,
} from "../../lib/sidebar-preferences";
import { sidebarWidthBudget } from "../../lib/sidebar-resize";
import { commitWorkPanelPresentation } from "../../lib/work-panel-presentation";
import {
  MAIN_PANE_MIN_WIDTH,
  workPanelWidthForSidebarReopen,
} from "../../lib/work-panel-resize";
import { browserPluginTab } from "../../lib/work-panel-tabs";
import { useAppStore } from "../../stores/app-store";
import { useSidebarTransition } from "./useSidebarTransition";
import { useStartupWatchdog } from "./useStartupWatchdog";
import { useTraySessions } from "./useTraySessions";

const MODIFIER_ONLY_KEYS = new Set([
  "Alt",
  "AltGraph",
  "Control",
  "Meta",
  "Shift",
]);

const PLUGIN_THEME_STYLE_ID = "pi-plugin-theme";

export function useAppShellRuntime() {
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
  const subagentPanel = useAppStore((s) => s.subagentPanel);
  const closeSubagentPanel = useAppStore((s) => s.closeSubagentPanel);
  const workPanelOpen = useAppStore((s) => s.workPanelOpen);
  const workPanelWidth = useAppStore((s) => s.workPanelWidth);
  const subagentPanelOpen = Boolean(
    page === "chat" &&
      subagentPanel &&
      subagentPanel.sessionId === activeSessionId,
  );
  const pluginThemes = useAppStore((s) => s.pluginThemes);
  const refreshPluginThemes = useAppStore((s) => s.refreshPluginThemes);
  const plugins = useAppStore((s) => s.plugins);
  const projectPath = useAppStore((s) => s.workspace?.path ?? null);
  const workPanelVisible = workPanelOpen || subagentPanelOpen;

  const [searchOpen, setSearchOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => loadSidebarWidth());
  const { sidebarEntering, sidebarExiting, handleSidebarAnimationEnd } = useSidebarTransition(
    sidebarCollapsed,
    ready && page !== "settings",
  );
  const [shellWidth, setShellWidth] = useState(0);
  const appShellRef = useRef<HTMLDivElement>(null);
  const sidebarCollapsedRef = useRef(sidebarCollapsed);
  const sidebarWidthRef = useRef(sidebarWidth);
  /**
   * The last width the user actually committed. A drag preview never writes
   * it, so a drag that collapses the sidebar and a later reopen return the
   * preferred column instead of the narrow preview the gesture stopped at.
   */
  const sidebarPreferredWidthRef = useRef(sidebarWidth);
  const shellWidthRef = useRef(shellWidth);
  const workPanelWidthRef = useRef(workPanelWidth);
  const workPanelOpenRef = useRef(workPanelVisible);
  const workPanelMaximizedRef = useRef(false);
  const autoCollapsedSidebarRef = useRef(false);
  sidebarCollapsedRef.current = sidebarCollapsed;
  sidebarWidthRef.current = sidebarWidth;
  shellWidthRef.current = shellWidth;
  workPanelWidthRef.current = workPanelWidth;
  workPanelOpenRef.current = workPanelVisible;

  // The shell is a fixed client area: the three-column budget needs its real
  // measured width, not the native window bounds, because the reservation seam
  // stays at zero.
  useLayoutEffect(() => {
    const shell = appShellRef.current;
    if (!shell) return;
    const update = () => setShellWidth(Math.round(shell.clientWidth));
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);
  const resolveSidebarMax = () =>
    sidebarWidthBudget({
      containerWidth: appShellRef.current?.clientWidth || shellWidthRef.current,
      workPanelOpen: workPanelOpenRef.current,
      workPanelWidth: workPanelWidthRef.current,
      workPanelMaximized: workPanelMaximizedRef.current,
    });
  const handleSidebarWidthChange = useCallback((width: number) => {
    setSidebarWidth(clampSidebarWidth(width, resolveSidebarMax()));
  }, []);
  const handleSidebarWidthCommit = useCallback((width: number) => {
    const nextWidth = clampSidebarWidth(width, resolveSidebarMax());
    sidebarPreferredWidthRef.current = nextWidth;
    setSidebarWidth(nextWidth);
    saveSidebarWidth(nextWidth);
  }, []);
  const handleSidebarResizeCollapse = useCallback(() => {
    autoCollapsedSidebarRef.current = false;
    setSidebarCollapsed(true);
  }, []);
  // Reopening prefers the right column: the work panel gives up width first so
  // MainChat keeps the width it already had, and only a would-be breach of the
  // 450px floor falls back to the 460px reopen target. The column comes back at
  // the user's preferred width, which a collapsing drag never overwrites.
  const reopenSidebar = useCallback(() => {
    if (!sidebarCollapsedRef.current) return;
    const preferredWidth = clampSidebarWidth(sidebarPreferredWidthRef.current);
    if (workPanelOpenRef.current && !workPanelMaximizedRef.current) {
      const currentPanelWidth = workPanelWidthRef.current;
      const width =
        appShellRef.current?.clientWidth ||
        shellWidthRef.current ||
        currentPanelWidth + MAIN_PANE_MIN_WIDTH;
      const nextPanelWidth = workPanelWidthForSidebarReopen({
        containerWidth: width,
        sidebarWidth: preferredWidth,
        currentPanelWidth,
      });
      useAppStore.getState().setWorkPanelWidth(nextPanelWidth);
    }
    autoCollapsedSidebarRef.current = false;
    setSidebarWidth(preferredWidth);
    setSidebarCollapsed(false);
  }, []);
  useTraySessions({ setSearchOpen, reopenSidebar });

  // Stable identity: the keydown and native-menu handlers register once and
  // must never capture a stale `sidebarCollapsed`. Every invocation is a user
  // action, so it clears an automatic-collapse record before toggling.
  const toggleSidebar = useCallback(() => {
    autoCollapsedSidebarRef.current = false;
    if (sidebarCollapsedRef.current) reopenSidebar();
    else setSidebarCollapsed(true);
  }, [reopenSidebar]);

  // The layout, not the user, yields the sidebar when the panel would push
  // MainChat under its floor. The record is remembered only until the panel
  // closes.
  const autoCollapseSidebar = useCallback(() => {
    if (sidebarCollapsedRef.current) return;
    autoCollapsedSidebarRef.current = true;
    setSidebarCollapsed(true);
  }, []);
  const [presentedWorkPanelOpen, setPresentedWorkPanelOpen] = useState(false);
  const [workPanelMaximized, setWorkPanelMaximized] = useState(false);
  const [workPanelExiting, setWorkPanelExiting] = useState(false);
  workPanelMaximizedRef.current = workPanelMaximized;
  const workPanelReservationRequest = useRef(0);
  const workPanelExitGeneration = useRef(0);
  const workPanelExitClosing = useRef(false);
  const presentedWorkPanelRef = useRef(false);
  const workPanelExitingRef = useRef(false);
  const [backendDown, setBackendDown] = useState<
    {
      fatal: boolean;
      component?: string;
      message?: string;
      schema?: { found: number; supported: number };
    } | null
  >(null);
  // Boot-time notice that the build is not native to this CPU (for example
  // the Intel macOS build under Rosetta). It runs, just slower, so this is
  // a dismissible hint rather than a backend outage.
  const [archMismatch, setArchMismatch] = useState<{
    platform: string;
    processArch: string;
    machineArch: string;
  } | null>(null);
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
    if (
      subagentPanel &&
      (page !== "chat" || subagentPanel.sessionId !== activeSessionId)
    ) {
      closeSubagentPanel();
    }
  }, [activeSessionId, closeSubagentPanel, page, subagentPanel]);

  // Destination pages own the center pane. Leaving Chat while previewing must
  // restore that pane before the destination is presented; otherwise the
  // sidebar can change `page` successfully while the route stays unmounted.
  useEffect(() => {
    if (workPanelMaximized && page !== "chat") {
      setWorkPanelMaximized(false);
    }
  }, [page, workPanelMaximized]);

  useEffect(() => {
    workPanelExitingRef.current = workPanelExiting;
  }, [workPanelExiting]);

  // Preview mode: MainChat is not rendered and the panel takes its width as
  // well, so the user can read a wide plugin view or preview. Transient: it is
  // never persisted and it ends with the panel.
  const toggleWorkPanelMaximize = useCallback(() => {
    setWorkPanelMaximized((current) => !current);
  }, []);

  const togglePresentedWorkPanel = useCallback(() => {
    const store = useAppStore.getState();
    if (workPanelExitingRef.current) {
      store.openWorkPanel();
      return;
    }
    // Close a visible subagent dock through the same path as Cmd/Ctrl+J.
    if (store.subagentPanel) {
      store.toggleWorkPanel();
      return;
    }
    // Prefer the visible presentation over a briefly stale session projection:
    // a second click on the same button must always collapse a panel the user
    // can currently see instead of routing through openWorkPanel again.
    if (store.workPanelOpen || presentedWorkPanelRef.current) {
      store.collapseWorkPanel();
      if (presentedWorkPanelRef.current && !workPanelExitingRef.current) {
        workPanelExitGeneration.current += 1;
        workPanelExitingRef.current = true;
        setWorkPanelExiting(true);
      }
      return;
    }
    store.openWorkPanel();
  }, []);

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
        setWorkPanelMaximized(false);
        setWorkPanelExiting(false);
        workPanelExitingRef.current = false;
        workPanelExitClosing.current = false;
        if (autoCollapsedSidebarRef.current) {
          autoCollapsedSidebarRef.current = false;
          setSidebarCollapsed(false);
        }
      },
    }).then((committed) => {
      // Reservation failed or was superseded — allow a later exit retry.
      if (!committed) workPanelExitClosing.current = false;
    });
  }, []);

  useEffect(() => {
    const shouldPresent =
      ready && page !== "settings" && (workPanelOpen || subagentPanelOpen);
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
  }, [page, ready, subagentPanelOpen, workPanelOpen]);

  // Fallback if animationend is skipped (display:none mid-flight, etc.).
  useEffect(() => {
    if (!workPanelExiting) return;
    const generation = workPanelExitGeneration.current;
    const timer = window.setTimeout(() => {
      finishWorkPanelExit(generation);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [workPanelExiting, finishWorkPanelExit]);

  // If the panel disappears without an exit commit (the active session closed
  // it, or the route changed), restore a sidebar this layout mechanism
  // collapsed — but never one the user collapsed manually.
  const previousWorkPanelOpen = useRef(workPanelVisible);
  useEffect(() => {
    if (
      previousWorkPanelOpen.current &&
      !workPanelVisible &&
      !presentedWorkPanelRef.current &&
      autoCollapsedSidebarRef.current
    ) {
      autoCollapsedSidebarRef.current = false;
      setSidebarCollapsed(false);
    }
    if (!workPanelVisible) setWorkPanelMaximized(false);
    previousWorkPanelOpen.current = workPanelVisible;
  }, [workPanelVisible]);

  const runMenuCommand = useCallback(
    async (command: AppMenuCommand) => {
      try {
        const store = useAppStore.getState();
        switch (command) {
          case "newTask":
            if (workPanelMaximizedRef.current) setWorkPanelMaximized(false);
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
    // Runtime `themes.upsert` / `themes.remove` also emit this event.
    return api.onPluginChanged(() => void refreshPluginThemes());
  }, [ready, refreshPluginThemes]);

  useEffect(() => {
    if (!ready) return;
    // Host-originated settings writes (plugin `app.setTheme`) must reach the
    // renderer store or the shell keeps painting the previous preference.
    return api.onSettingsChanged((patch) => {
      if (patch.theme === undefined) return;
      const current = useAppStore.getState().settings;
      if (!current) return;
      useAppStore.setState({
        settings: { ...current, theme: String(patch.theme) as typeof current.theme },
      });
    });
  }, [ready]);

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
      : isThemeColorScheme(preference)
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
      style.textContent = `${pluginTheme.css}\n${pluginTheme.variablesCss ?? ""}`;
      document.documentElement.dataset.pluginTheme = pluginTheme.id;
    } else {
      style?.remove();
      delete document.documentElement.dataset.pluginTheme;
    }

    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const resolvedTheme =
        base === "system" ? (mq.matches ? "light" : "dark") : base;
      document.documentElement.dataset.theme = resolvedTheme;
      // A contributed theme may name the native window background for this
      // palette. Deriving it here (rather than remembering an applied value) is
      // what restores the host default on a switch, a disable, or an uninstall:
      // the plugin theme is gone from the catalog, so there is nothing left to
      // pass and the host colour wins.
      void api
        .setWindowBackgroundColor(resolvedTheme, pluginTheme?.windowBackground?.[resolvedTheme])
        .catch(() => undefined);
    };
    apply();
    if (base !== "system") return;
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

  // Global type scale: Settings persists a multiplier in
  // `AppSettings.fontScale`; the `--text-*` ramp multiplies from `--font-scale`.
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--font-scale",
      String(resolveFontScale(settings ?? {})),
    );
  }, [settings?.fontScale, settings?.fontSize]);

  useEffect(() => {
    if (bootstrapStartedRef.current) return;
    bootstrapStartedRef.current = true;
    // A tray activation must win over bootstrap's initial draft/plan navigation.
    void bootstrap().finally(() => {
      void api.menuRendererReady().catch(() => undefined);
    });
  }, [bootstrap]);

  // The menu/tray acknowledgement also follows `ready`, not only the first
  // attempt's `finally`. A startup the watchdog retried is exactly one whose
  // first attempt never settled, so that `finally` would never run and main
  // would keep gating menu commands and tray activation on a shell that is
  // already on screen. Repeating the call is harmless.
  useEffect(() => {
    if (!ready) return;
    void api.menuRendererReady().catch(() => undefined);
  }, [ready]);

  // The Host owns the prompt queue (D375); mirror it whenever the visible
  // session changes so a reload or a switch shows the durable entries.
  useEffect(() => {
    if (!activeSessionId) return;
    void useAppStore.getState().refreshQueuedPrompts(activeSessionId);
  }, [activeSessionId]);

  useEffect(() => {
    const offEvent = api.onAgentEvent(handleAgentEvent);
    const offQueueChanged = api.onAgentQueueChanged((event) =>
      useAppStore.getState().applyQueueChanged(event),
    );
    const offPlansChanged = api.onPlansChanged(handlePlansChanged);
    // Host-pushed toasts (plugin runtime etc.) are informational.
    const offToast = api.onToast((message) => showToast(message));
    // The first plaintext hop to an endpoint the user typed. The shell owns the
    // wording, and recording `insecureNoticeAcknowledged` keeps it to once; a
    // failed write only means the notice shows again.
    const offInsecureEndpoint = api.onInsecureEndpointNotice(() => {
      showToast(
        `${t("settings.networkInsecureNoticeTitle")} — ${t("settings.networkInsecureNoticeBody")}`,
        { variant: "warning", duration: 12_000 },
      );
      const current = useAppStore.getState().settings;
      if (!current) return;
      void api
        .setSettings({
          ...current,
          networkPolicy: {
            ...(current.networkPolicy ?? {}),
            mode: current.networkPolicy?.mode ?? "relaxed",
            insecureNoticeAcknowledged: true,
          },
        })
        .catch(() => undefined);
    });
    // Agent-driven HTML preview: surface the browser tab when the agent
    // opens a workspace file in the embedded browser (BrowserPreview tool).
    const offBrowserPreview = api.onBrowserPreview((event) => {
      useAppStore
        .getState()
        .openWorkPanelTabForSession(event.sessionId, {
          ...browserPluginTab(event.path ?? event.url),
        });
    });
    const offHostStatus = api.onHostStatus((status) => {
      if (status.archMismatch) setArchMismatch(status.archMismatch);
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
          message: status.message,
          schema: status.schema,
        });
        // A dead sidecar cannot finish the turn; unstick the composer.
        useAppStore.setState({ isRunning: false });
      }
    });
    const offNotificationChanged = api.onNotificationChanged((notification) => {
      const accepted = useAppStore.getState().receiveNotification(notification);
      // A host replay, renderer reload, or post-clear delayed event may refer
      // to a row that is already present/acknowledged. Do not surface a native
      // banner for an event the store intentionally rejected.
      if (!accepted) return;
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
          kind: "task",
          title,
          body,
          createdAt: notification.createdAt,
        })
        .catch(() => undefined);
    });
    const offSessionsChanged = api.onSessionsChanged((event) => {
      const store = useAppStore.getState();
      const revealImportedProjects =
        event.reason === "plugin.session.import" ||
        event.reason === "plugin.session.importBatch";
      void store
        .refreshSessions(
          revealImportedProjects ? { revealImportedProjects: true } : undefined,
        )
        .then(async () => {
          if (event.projectPath) {
            await useAppStore.getState().openProjectPath(event.projectPath);
          } else if (event.projectPath === null && !event.selectSessionId) {
            await useAppStore.getState().clearProject();
          }
          if (event.selectSessionId) {
            await useAppStore.getState().selectSession(event.selectSessionId);
          }
        })
        .catch(() => undefined);
    });
    const offNotificationActivated = api.onNotificationActivated(
      ({ id, sessionId }) => {
        const store = useAppStore.getState();
        const matched = store.notifications.find((item) => item.id === id);
        if (matched) {
          void store.openNotification(id).catch((activationError) =>
            showToast(
              activationError instanceof Error
                ? activationError.message
                : String(activationError),
              { variant: "error" },
            ),
          );
        } else if (sessionId) {
          void store.selectSession(sessionId).catch((activationError) =>
            showToast(
              activationError instanceof Error
                ? activationError.message
                : String(activationError),
              { variant: "error" },
            ),
          );
        }
      },
    );
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
          case "toggleWindow":
            // The same native action the menu item runs (D438): hide the window
            // the user is looking at, or bring it back. The window's own close
            // button stays the only path into the close behaviour.
            void api.nativeMenuAction("toggleMainWindow");
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
      offQueueChanged();
      offPlansChanged();
      offToast();
      offInsecureEndpoint();
      offBrowserPreview();
      offHostStatus();
      offNotificationChanged();
      offSessionsChanged();
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

  useEffect(() => installRendererApi(), []);

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

  const {
    phase: startupPhase,
    waitedMs: startupWaitedMs,
    retry: retryStartup,
    retrying: startupRetrying,
  } = useStartupWatchdog(ready);
  const showSplash = splashPhase !== "done";
  // The splash and the recovery surface answer the same question ("nothing to
  // show yet"), and on macOS the shell hides every child except the splash while
  // it animates. Exactly one of them is mounted, so neither has to fight the
  // other's layering.
  const splash = showSplash && startupPhase === "starting" ? (
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
  const toggleWorkPanelShortcutDefinition = KEYBOARD_SHORTCUTS.find(
    (shortcut) => shortcut.id === "openWorkPanel",
  );
  const workPanelToggleShortcut = toggleWorkPanelShortcutDefinition
    ? keybindingDisplayParts(
        resolveKeybinding(
          toggleWorkPanelShortcutDefinition,
          settings?.keybindings,
          shortcutPlatform,
        ),
        shortcutPlatform,
      ).join(shortcutPlatform === "darwin" ? "" : "+")
    : "";
  const workPanelToggleLabel = t("nav.toggleWorkPanel");
  const workPanelToggleTooltip = workPanelToggleShortcut
    ? `${workPanelToggleLabel} ${workPanelToggleShortcut}`
    : workPanelToggleLabel;


  const sidebarWidthMax = sidebarWidthBudget({
    containerWidth: shellWidth,
    workPanelOpen: workPanelVisible || presentedWorkPanelOpen,
    workPanelWidth,
    workPanelMaximized,
  });

  return {
    t,
    ready,
    page,
    activeSessionId,
    subagentPanel,
    subagentPanelOpen,
    closeSubagentPanel,
    workPanelOpen,
    searchOpen,
    setSearchOpen,
    sidebarCollapsed,
    setSidebarCollapsed,
    sidebarEntering,
    sidebarExiting,
    sidebarWidth,
    sidebarWidthMax,
    handleSidebarWidthChange,
    handleSidebarWidthCommit,
    handleSidebarResizeCollapse,
    toggleSidebar,
    reopenSidebar,
    autoCollapseSidebar,
    appShellRef,
    shellWidth,
    workPanelWidth,
    runMenuCommand,
    handleSidebarAnimationEnd,
    presentedWorkPanelOpen,
    workPanelExiting,
    workPanelExitGeneration,
    finishWorkPanelExit,
    togglePresentedWorkPanel,
    workPanelMaximized,
    toggleWorkPanelMaximize,
    backendDown,
    archMismatch,
    setArchMismatch,
    showSplash,
    splash,
    startupPhase,
    startupWaitedMs,
    retryStartup,
    startupRetrying,
    sidebarToggleShortcut,
    workPanelToggleTooltip,
  };
}

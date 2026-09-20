import { type CSSProperties, lazy, type ReactNode, Suspense } from "react";
import { ChatSurface } from "../../components/ChatSurface";
import { ConversationTopbar } from "../../components/ConversationTopbar";
import { ExtensionPromptHost } from "../../components/ExtensionPromptDialog";
import {
  IconNewSession,
  IconPanel,
  IconPanelOpen,
} from "../../components/icons";
import { ProjectCreateDialog } from "../../components/ProjectCreateDialog";
import { SearchDialog } from "../../components/SearchDialog";
import { Sidebar } from "../../components/Sidebar";
import { ToastHost } from "../../components/Toast";
import { UpdateBanner } from "../../components/UpdateBanner";
import { cx, TooltipButton } from "../../components/ui";
import { WindowControls } from "../../components/WindowControls";
import { WorkPanel } from "../../components/workpanel/WorkPanel";
import { api } from "../../lib/api";
import { CollapsedTitlebarActions, RoutePending } from "./chrome";
import { useAppShellRuntime } from "./useAppShellRuntime";

const SettingsPage = lazy(() =>
  import("../../pages/SettingsPage").then((module) => ({
    default: module.SettingsPage,
  })),
);
const PullRequestsPage = lazy(() =>
  import("../../pages/PullRequestsPage").then((module) => ({
    default: module.PullRequestsPage,
  })),
);
const ScheduledPage = lazy(() =>
  import("../../pages/ScheduledPage").then((module) => ({
    default: module.ScheduledPage,
  })),
);
const PluginsPage = lazy(() =>
  import("../../pages/PluginsPage").then((module) => ({
    default: module.PluginsPage,
  })),
);

export function AppShell() {
  const {
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
    sidebarToggleShortcut,
    workPanelToggleTooltip,
  } = useAppShellRuntime();

  let shell: ReactNode = null;
  if (ready) {
    if (page === "settings") {
      shell = (
        <>
          <Suspense fallback={<RoutePending />}>
            <SettingsPage />
          </Suspense>
          <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
          <ToastHost />
          <ExtensionPromptHost />
          <UpdateBanner />
        </>
      );
    } else {
      shell = (
        <>
          {!sidebarCollapsed || sidebarExiting ? (
            <Sidebar
              className={cx(sidebarEntering && "is-entering", sidebarExiting && "is-exiting")}
              onAnimationEnd={handleSidebarAnimationEnd}
              onToggleSidebar={toggleSidebar}
              sidebarToggleShortcut={sidebarToggleShortcut}
              sidebarWidth={sidebarWidth}
              widthMax={sidebarWidthMax}
              onWidthChange={handleSidebarWidthChange}
              onWidthCommit={handleSidebarWidthCommit}
              onResizeCollapse={handleSidebarResizeCollapse}
            />
          ) : null}

          {workPanelMaximized && (
            /* MainChat is absent; the panel header owns dragging while this
               pass-through row keeps the shell controls available. */
            <div
              className={cx(
                "window-chrome-row",
                !sidebarCollapsed && "sidebar-expanded",
              )}
            >
              {sidebarCollapsed && (
                <CollapsedTitlebarActions
                  onToggleSidebar={toggleSidebar}
                  onNewTask={() => void runMenuCommand("newTask")}
                  sidebarToggleShortcut={sidebarToggleShortcut}
                />
              )}
              {!sidebarCollapsed && (
                <TooltipButton
                  type="button"
                  className="title-nav-btn"
                  tooltip={t("nav.newTask")}
                  ariaLabel={t("nav.newTask")}
                  data-nav="new-task"
                  onClick={() => void runMenuCommand("newTask")}
                >
                  <IconNewSession size={15} />
                </TooltipButton>
              )}
              <div className="window-chrome-drag" aria-hidden />
            </div>
          )}

          {!workPanelMaximized && (
          <section className="main-pane">
            {page === "chat" ? (
              <ConversationTopbar
                sidebarCollapsed={sidebarCollapsed}
                workPanelOpen={presentedWorkPanelOpen}
                onToggleSidebar={toggleSidebar}
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
                      onToggleSidebar={reopenSidebar}
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
                  {backendDown.fatal
                    ? backendDown.message === "GLIBC_UNSUPPORTED"
                      ? t("status.unsupportedGlibc")
                      : backendDown.message === "DB_SCHEMA_TOO_NEW"
                        ? t("status.dbSchemaTooNew", {
                            found: backendDown.schema?.found ?? "?",
                            supported: backendDown.schema?.supported ?? "?",
                          })
                        : t("status.fatal")
                    : t("status.restarting")}
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

            {archMismatch && (
              <div className="backend-banner no-drag warn" role="status">
                <span className="backend-dot" aria-hidden />
                <span>
                  {t("status.archMismatch", {
                    buildArch: t(
                      `status.archNames.${archMismatch.platform}.${archMismatch.processArch}`,
                      { defaultValue: archMismatch.processArch },
                    ),
                    machineArch: t(
                      `status.archNames.${archMismatch.platform}.${archMismatch.machineArch}`,
                      { defaultValue: archMismatch.machineArch },
                    ),
                  })}
                </span>
                <button
                  type="button"
                  className="backend-action"
                  onClick={() => setArchMismatch(null)}
                >
                  {t("status.dismissArchMismatch")}
                </button>
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
          )}

          {(presentedWorkPanelOpen || workPanelExiting) && (
            <WorkPanel
              panelBlocked={searchOpen}
              exiting={workPanelExiting}
              onExitAnimationEnd={() =>
                finishWorkPanelExit(workPanelExitGeneration.current)
              }
              subagentPanel={subagentPanelOpen ? subagentPanel : null}
              onCloseSubagentPanel={closeSubagentPanel}
              containerWidth={shellWidth}
              sidebarWidth={sidebarWidth}
              sidebarCollapsed={sidebarCollapsed}
              sidebarExiting={sidebarExiting}
              onAutoCollapseSidebar={autoCollapseSidebar}
              maximized={workPanelMaximized}
              onToggleMaximize={toggleWorkPanelMaximize}
            />
          )}

          <TooltipButton
            type="button"
            className="app-work-panel-toggle no-drag"
            tooltip={workPanelToggleTooltip}
            ariaLabel={workPanelToggleTooltip}
            aria-pressed={workPanelOpen || presentedWorkPanelOpen}
            disabled={!activeSessionId && !presentedWorkPanelOpen && !workPanelExiting}
            onClick={togglePresentedWorkPanel}
          >
            <span className="app-work-panel-toggle-icon" aria-hidden>
              <IconPanel size={15} />
              <IconPanelOpen size={15} />
            </span>
          </TooltipButton>

          <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
          <ToastHost />
          <ExtensionPromptHost />
        </>
      );
    }
  }

  return (
    <div
      ref={appShellRef}
      className={cx(
        "app-shell",
        !ready && "app-shell-boot",
        page === "settings" && ready && "settings-mode",
        sidebarCollapsed && "sidebar-collapsed",
        workPanelMaximized && "work-panel-maximized",
        showSplash && "is-booting",
      )}
      style={{ "--ds-sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <div className="app-scenic-backdrop" aria-hidden />
      {shell}
      {/* Outside pane stacking; skip splash so the band cannot cover boot chrome. */}
      {ready && !showSplash && <WindowControls />}
      <ProjectCreateDialog />
      {splash}
    </div>
  );
}

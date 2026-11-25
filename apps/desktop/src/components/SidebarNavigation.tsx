import { sidebarModuleVisible } from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";
import { useUpdateState } from "../hooks/use-update-state";
import { api } from "../lib/api";
import { usePluginBrowseState } from "../features/plugins/browse-state";
import { useAppStore } from "../stores/app-store";
import { IconClock, IconNewSession, IconPlug, IconSettings } from "./icons";
import { cx, TooltipButton } from "./ui";

/**
 * The sidebar's primary destinations, above the session lists: start a new
 * task, the Scheduled page and the plugin marketplace. Labelled rows rather
 * than footer icons, so each destination reads without a tooltip.
 */
export function SidebarPrimaryNav({
  onNewTask,
  onBeforeNavigate,
}: {
  onNewTask: () => void;
  /** Dismiss sidebar-owned menus before the destination changes. */
  onBeforeNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);
  const navBack = useAppStore((s) => s.navBack);
  const canNavBack = useAppStore((s) => s.canNavBack);
  const scheduledTasksEnabled = useAppStore(
    (s) => s.settings?.scheduledTasksEnabled !== false,
  );
  const modules = useAppStore((s) => s.settings?.sidebarModules);
  const showNewTask = sidebarModuleVisible(modules, "newTask");
  const showScheduled =
    scheduledTasksEnabled && sidebarModuleVisible(modules, "scheduled");
  const showPluginMarket = sidebarModuleVisible(modules, "pluginMarket");
  const openPluginMarket = () => {
    usePluginBrowseState.getState().setTab("market");
    setPage("plugins");
  };

  if (!showNewTask && !showScheduled && !showPluginMarket) return null;

  return (
    <nav className="sidebar-primary-nav" aria-label={t("nav.primary")}>
      {showNewTask && (
        <button
          type="button"
          className="sidebar-primary-item"
          data-nav="new-task"
          onClick={() => {
            onBeforeNavigate?.();
            onNewTask();
          }}
        >
          <IconNewSession size={15} aria-hidden />
          <span className="sidebar-primary-label">{t("nav.newTask")}</span>
        </button>
      )}
      {showScheduled && (
        <button
          type="button"
          className={cx("sidebar-primary-item", page === "scheduled" && "active")}
          data-nav="scheduled"
          aria-current={page === "scheduled" ? "page" : undefined}
          onClick={() => {
            onBeforeNavigate?.();
            setPage("scheduled");
          }}
        >
          <IconClock size={15} aria-hidden />
          <span className="sidebar-primary-label">{t("scheduled.title")}</span>
        </button>
      )}
      {showPluginMarket && (
        <button
          type="button"
          className={cx("sidebar-primary-item", page === "plugins" && "active")}
          data-nav="plugins"
          aria-current={page === "plugins" ? "page" : undefined}
          onClick={() => {
            onBeforeNavigate?.();
            // A second activation returns to where the user came from.
            if (page === "plugins") {
              if (canNavBack()) navBack();
              else setPage("chat");
              return;
            }
            openPluginMarket();
          }}
        >
          <IconPlug size={15} aria-hidden />
          <span className="sidebar-primary-label">{t("nav.pluginMarket")}</span>
        </button>
      )}
    </nav>
  );
}

/** Footer: Settings on the left, the build/version chip on the right. */
export function SidebarFooter() {
  const { t } = useTranslation();
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const openSettings = useAppStore((s) => s.openSettings);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const setSettingsAnchor = useAppStore((s) => s.setSettingsAnchor);
  const version = useAppStore((s) => s.version);
  const showBuildVersion = useAppStore((s) =>
    sidebarModuleVisible(s.settings?.sidebarModules, "buildVersion"),
  );
  const update = useUpdateState();

  // An update only earns the accent dot once it is actionable — a pending
  // check or a failed one keeps the chip quiet.
  const updateReady =
    update?.status === "available" || update?.status === "downloaded";
  const appVersion = update?.currentVersion || version?.version || "";
  const buildLabel = updateReady
    ? `v${update?.availableVersion ?? appVersion}`
    : update?.status === "checking"
      ? t("updates.checking")
      : appVersion
        ? `v${appVersion}`
        : t("nav.buildUnknown");
  const buildTitle = updateReady
    ? t("updates.available", { version: update?.availableVersion ?? "" })
    : t("nav.checkForUpdates");

  return (
    <div className="sidebar-footer no-drag">
      <button
        type="button"
        className={cx("footer-settings", settingsOpen && "active")}
        data-nav="settings"
        aria-haspopup="dialog"
        aria-expanded={settingsOpen}
        onClick={() => openSettings()}
      >
        <IconSettings size={15} aria-hidden />
        <span>{t("nav.settings")}</span>
      </button>

      {showBuildVersion && (
        <TooltipButton
          type="button"
          className={`footer-build ${updateReady ? "has-update" : ""}`}
          data-nav="build"
          tooltip={buildTitle}
          ariaLabel={buildTitle}
          onClick={() => {
            if (updateReady) {
              setSettingsAnchor("updates.title");
              setSettingsTab("about");
              return;
            }
            void (async () => {
              try {
                await api.updatesCheck();
              } catch { /* ignore */ }
            })();
          }}
        >
          <span className="footer-build-version">{buildLabel}</span>
          {updateReady ? <span className="footer-build-dot" aria-hidden /> : null}
        </TooltipButton>
      )}
    </div>
  );
}

import { useEffect } from "react";
import {
  KEYBOARD_SHORTCUTS,
  keybindingDisplayParts,
  resolveKeybinding,
  type ShortcutPlatform,
} from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../stores/app-store";
import {
  scheduledReturnFor,
  scheduledReturnUsesHistory,
} from "../features/scheduled/scheduled-return";
import {
  IconChevronLeft,
  IconSidebar,
  IconBranch,
  IconNewSession,
  IconSearch,
} from "./icons";
import { TooltipButton } from "./ui";

function projectName(path?: string | null, name?: string | null) {
  if (name) return name;
  if (!path) return null;
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

function isDefaultSessionTitle(title?: string | null) {
  const trimmed = (title || "").trim().toLowerCase();
  if (!trimmed) return true;
  return ["new task", "new chat", "新建任务", "新对话"].includes(trimmed);
}

export function ConversationTopbar({
  sidebarCollapsed,
  workPanelOpen,
  onToggleSidebar,
  onNewTask,
  onOpenSearch,
}: {
  sidebarCollapsed: boolean;
  workPanelOpen: boolean;
  onToggleSidebar: () => void;
  onNewTask: () => void;
  onOpenSearch: () => void;
}) {
  const { t } = useTranslation();
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const sessions = useAppStore((s) => s.sessions);
  const workspace = useAppStore((s) => s.workspace);
  const refreshProject = useAppStore((s) => s.refreshProject);
  const keybindings = useAppStore((s) => s.settings?.keybindings);
  const navStack = useAppStore((s) => s.navStack);
  const navIndex = useAppStore((s) => s.navIndex);
  const navBack = useAppStore((s) => s.navBack);
  const setPage = useAppStore((s) => s.setPage);
  const platform = (
    typeof window === "undefined" ? "darwin" : window.piDesktop?.platform ?? "darwin"
  ) as ShortcutPlatform;
  const newTaskShortcut = KEYBOARD_SHORTCUTS.find(
    (shortcut) => shortcut.id === "newTask",
  );
  const searchShortcut = KEYBOARD_SHORTCUTS.find(
    (shortcut) => shortcut.id === "openSearch",
  );
  const newTaskBinding = newTaskShortcut
    ? resolveKeybinding(newTaskShortcut, keybindings, platform)
    : null;
  const searchBinding = searchShortcut
    ? resolveKeybinding(searchShortcut, keybindings, platform)
    : null;
  const newTaskShortcutLabel = keybindingDisplayParts(newTaskBinding, platform).join(
    platform === "darwin" ? "" : "+",
  );
  const searchShortcutLabel = keybindingDisplayParts(searchBinding, platform).join(
    platform === "darwin" ? "" : "+",
  );
  const newTaskTooltip = newTaskShortcutLabel
    ? t("nav.actionWithShortcut", {
        action: t("nav.newTask"),
        shortcut: newTaskShortcutLabel,
      })
    : t("nav.newTask");
  const searchTooltip = searchShortcutLabel
    ? t("nav.actionWithShortcut", {
        action: t("nav.search"),
        shortcut: searchShortcutLabel,
      })
    : t("nav.search");

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const projectPath = workspace?.path;

  useEffect(() => {
    if (!projectPath) return;
    const refreshBranch = () => {
      void refreshProject(projectPath);
    };
    refreshBranch();
    window.addEventListener("focus", refreshBranch);
    return () => window.removeEventListener("focus", refreshBranch);
  }, [activeSessionId, projectPath, refreshProject]);

  /*
   * A scheduled run's conversation is read from the Scheduled route, and the
   * session list keeps automation transcripts out, so this row is the way
   * back. The remembered origin is what restores the task and run exactly.
   */
  const scheduledSession = activeSession?.scheduledRun === true ? activeSession : null;
  const scheduledReturn = scheduledSession ? scheduledReturnFor(scheduledSession.id) : null;
  const backAction = t("nav.backToScheduledAction");
  const backTooltip = scheduledReturn
    ? t("nav.backToScheduledTask", { title: scheduledReturn.taskTitle })
    : backAction;
  const goBackToScheduled = () => {
    /* History first: it re-enters the route with the reader's own stack. */
    if (scheduledReturnUsesHistory(navStack, navIndex)) navBack();
    else setPage("scheduled");
  };

  const fullTaskTitle = isDefaultSessionTitle(activeSession?.title)
    ? t("chat.untitledTask")
    : activeSession?.title || t("chat.untitledTask");
  const project = projectName(workspace?.path, workspace?.name);
  const branch = workspace?.branch?.trim();

  return (
    <div
      className={`conversation-topbar${sidebarCollapsed ? " ct-collapsed" : ""}${
        workPanelOpen ? " ct-work-panel-open" : ""
      }`}
      role="toolbar"
      aria-label={t("nav.conversation")}
    >
      <div className="ct-left">
        {/*
          Always mounted: the slot animates from 0 to 28px with the dock, so
          unmounting it would reintroduce the first-frame title jump. While the
          sidebar is open the slot is zero-width and hidden from AT.
        */}
        <div className="ct-lead" aria-hidden={!sidebarCollapsed}>
          <TooltipButton
            type="button"
            className="ct-icon-btn"
            tooltip={t("nav.toggleSidebar")}
            ariaLabel={t("nav.toggleSidebar")}
            tabIndex={sidebarCollapsed ? undefined : -1}
            onClick={onToggleSidebar}
          >
            <IconSidebar size={15} />
          </TooltipButton>
        </div>
        {scheduledSession ? (
          <button
            type="button"
            className="ct-back"
            data-nav="back-to-scheduled"
            aria-label={backAction}
            title={backTooltip}
            onClick={goBackToScheduled}
          >
            <IconChevronLeft size={13} aria-hidden />
            <span className="ct-back-label">{t("nav.backToScheduled")}</span>
          </button>
        ) : null}
        <div
          className="ct-title-wrap"
          title={project ? `${project} · ${fullTaskTitle}` : fullTaskTitle}
        >
          <span className="ct-title">{fullTaskTitle}</span>
          {branch ? (
            <span
              className="ct-branch"
              aria-label={t("nav.hoverCardBranchAria", { name: branch })}
              title={branch}
            >
              <IconBranch size={12} aria-hidden />
              <span>{branch}</span>
            </span>
          ) : null}
        </div>
      </div>

      <div className="ct-right">
        <div className="ct-actions">
          <TooltipButton
            type="button"
            className="ct-icon-btn"
            tooltip={newTaskTooltip}
            ariaLabel={t("nav.newTask")}
            onClick={onNewTask}
          >
            <IconNewSession size={15} />
          </TooltipButton>
          <TooltipButton
            type="button"
            className="ct-icon-btn"
            tooltip={searchTooltip}
            ariaLabel={t("nav.search")}
            onClick={onOpenSearch}
          >
            <IconSearch size={15} />
          </TooltipButton>
        </div>
      </div>
    </div>
  );
}

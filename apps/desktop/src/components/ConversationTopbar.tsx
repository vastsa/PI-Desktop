import { useTranslation } from "react-i18next";
import { useAppStore } from "../stores/app-store";
import {
  IconSidebar,
  IconNewSession,
  IconSearch,
} from "./icons";

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

const TOPBAR_TITLE_MAX_LENGTH = 10;

function truncateTopbarTitle(title: string) {
  const characters = Array.from(title);
  return characters.length > TOPBAR_TITLE_MAX_LENGTH
    ? `${characters.slice(0, TOPBAR_TITLE_MAX_LENGTH).join("")}…`
    : title;
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

  const activeSession = sessions.find((session) => session.id === activeSessionId);

  const fullTaskTitle = isDefaultSessionTitle(activeSession?.title)
    ? t("chat.untitledTask")
    : activeSession?.title || t("chat.untitledTask");
  const taskTitle = truncateTopbarTitle(fullTaskTitle);
  const project = projectName(workspace?.path, workspace?.name);

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
          <button
            type="button"
            className="ct-icon-btn"
            title={t("nav.toggleSidebar")}
            aria-label={t("nav.toggleSidebar")}
            tabIndex={sidebarCollapsed ? undefined : -1}
            onClick={onToggleSidebar}
          >
            <IconSidebar size={15} />
          </button>
        </div>
        <div
          className="ct-title-wrap"
          title={project ? `${project} · ${fullTaskTitle}` : fullTaskTitle}
        >
          <span className="ct-title">{taskTitle}</span>
        </div>
      </div>

      <div className="ct-right">
        <div className="ct-actions">
          <button
            type="button"
            className="ct-icon-btn"
            title={t("nav.newTask")}
            aria-label={t("nav.newTask")}
            onClick={onNewTask}
          >
            <IconNewSession size={15} />
          </button>
          <button
            type="button"
            className="ct-icon-btn"
            title={t("nav.search")}
            aria-label={t("nav.search")}
            onClick={onOpenSearch}
          >
            <IconSearch size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

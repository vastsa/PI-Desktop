import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { isRemoteSession } from "../lib/remote-session-safety";
import { normalizeProjectPath } from "../lib/sidebar-session-groups";
import {
  KEYBOARD_SHORTCUTS,
  MAX_SESSION_TITLE_LENGTH,
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
  IconFolder,
  IconSidebar,
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
  const projectMeta = useAppStore((s) => s.projectMeta);
  const renameSession = useAppStore((s) => s.renameSession);
  const showToast = useAppStore((s) => s.showToast);
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

  /*
   * Inline rename. The editor is keyed by the session it belongs to, so a
   * conversation switch can never commit one task's draft onto another; the
   * effect below also drops the key so returning to the first session does not
   * resurrect a closed editor.
   */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  /* Set once an Enter/Escape/blur has resolved the draft; the next blur is the
     same commit, not a second one. */
  const renameSettledRef = useRef(false);

  const remoteSession = isRemoteSession(activeSession);
  /* Scheduled runs and remote transcripts are host-owned: their titles are not
     editable from this desktop. */
  const canRename = Boolean(
    activeSession && !isRemoteSession(activeSession) && !activeSession.scheduledRun,
  );
  const editing = editingId !== null && editingId === activeSession?.id;

  useEffect(() => {
    setEditingId(null);
  }, [activeSessionId]);

  useEffect(() => {
    if (!editing) return;
    /* The input only exists after this render; select-all must follow it. */
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [editing]);

  const beginRename = () => {
    if (!canRename || !activeSession) return;
    renameSettledRef.current = false;
    setDraft(activeSession.title ?? "");
    setEditingId(activeSession.id);
  };

  const cancelRename = () => {
    if (!editing) return;
    renameSettledRef.current = true;
    setEditingId(null);
  };

  const commitRename = () => {
    if (!editing || !activeSession || renameSettledRef.current) return;
    renameSettledRef.current = true;
    const sessionId = activeSession.id;
    const previousTitle = activeSession.title;
    const nextTitle = draft.trim();
    setEditingId(null);
    if (!nextTitle || nextTitle === previousTitle) return;
    void renameSession(sessionId, nextTitle).catch((error) => {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    });
  };

  const onRenameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    /* An IME owns Enter and Escape while a composition is in flight. */
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      commitRename();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      /* Escape belongs to the editor here, not to a window-level dismisser. */
      event.stopPropagation();
      cancelRename();
    }
  };

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
  /*
   * The crumb names the project the conversation lives in, not the workspace
   * the app happens to show: a task can be opened from a project other than
   * the active one. A remote session carries its display-only label; a local
   * one resolves its project path through the sidebar's naming preferences,
   * and a temporary session keeps the plain title. Before the first prompt
   * there is no session yet, so the active workspace names the draft.
   */
  const sessionProjectPath = remoteSession ? null : activeSession?.projectPath;
  const projectKey = sessionProjectPath
    ? normalizeProjectPath(sessionProjectPath)
    : null;
  const project = remoteSession
    ? activeSession?.remoteWorkspaceLabel?.trim() || null
    : projectKey
      ? projectMeta[projectKey]?.name?.trim() || projectName(sessionProjectPath)
      : activeSession
        ? null
        : projectName(workspace?.path, workspace?.name);
  const breadcrumbTitle = project
    ? `${project} · ${fullTaskTitle}`
    : fullTaskTitle;

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
        {/* The hover tooltip would otherwise keep advertising the old title
            and the crumb while the title is an editor. */}
        <div
          className="ct-title-wrap"
          title={editing ? undefined : breadcrumbTitle}
        >
          {project ? (
            <>
              <span className="ct-project">
                <IconFolder size={12} aria-hidden />
                <span className="ct-project-name">{project}</span>
              </span>
              <span className="ct-sep" aria-hidden>
                /
              </span>
            </>
          ) : null}
          {editing ? (
            <input
              ref={inputRef}
              className="ct-title-input"
              value={draft}
              aria-label={t("session.renameLabel")}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              onChange={(event) =>
                setDraft(
                  Array.from(event.target.value)
                    .slice(0, MAX_SESSION_TITLE_LENGTH)
                    .join(""),
                )
              }
              onKeyDown={onRenameKeyDown}
              onBlur={commitRename}
            />
          ) : (
            <h1 className="ct-title">
              {canRename ? (
                <button
                  type="button"
                  className="ct-title-trigger"
                  aria-label={t("session.renameAction", { title: fullTaskTitle })}
                  onClick={beginRename}
                >
                  {fullTaskTitle}
                </button>
              ) : (
                fullTaskTitle
              )}
            </h1>
          )}
          {remoteSession && <span className="thread-item-source">{t("remote:remote")} · {activeSession?.remoteHostLabel}</span>}
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

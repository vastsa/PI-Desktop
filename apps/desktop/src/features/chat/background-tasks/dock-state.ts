import type { BackgroundTaskSummary } from "../../../lib/api";
import type { SessionTodo } from "@pi-desktop/shared";

/**
 * View state for the shared Todo/background-task container.
 *
 * Everything here is renderer memory: never persisted and never sent to the
 * host. The registry stays the source of truth for the processes themselves, so
 * switching a tab or collapsing the container cannot affect them.
 *
 * Reading follows the container's lifetime, not the session's, because the
 * container is one surface the user configures once: the tab choice is
 * remembered per session, while the collapse is one container-wide condition
 * that survives switching sessions. Anything else would reopen a container the
 * user had closed the moment they looked at another session.
 */
export type DockTab = "todo" | "tasks";

export type DockSessionState = {
  /** Tab the user last chose, or `null` while nothing was chosen yet. */
  readonly chosenTab: DockTab | null;
  /** Container-wide collapse; both tabs share it. */
  readonly collapsed: boolean;
};

export type DockViewState = Readonly<{
  /** Per-session entry: the remembered tab choice. */
  sessions: Readonly<Record<string, DockSessionState>>;
  /** Container-wide collapse; independent of whichever session is on screen. */
  collapsed: boolean;
}>;

/** The container starts collapsed: the composer keeps its room by default. */
export const EMPTY_DOCK_VIEW: DockViewState = { sessions: {}, collapsed: true };

export const EMPTY_SESSION_DOCK: DockSessionState = {
  chosenTab: null,
  collapsed: EMPTY_DOCK_VIEW.collapsed,
};

/** The badge value a tab shows; `0` means "no badge". */
export const MAX_BADGE = 9;

export function sessionDockState(
  view: DockViewState,
  sessionId: string | null | undefined,
): DockSessionState {
  if (!sessionId) return EMPTY_SESSION_DOCK;
  const session = view.sessions[sessionId];
  if (!session) return { ...EMPTY_SESSION_DOCK, collapsed: view.collapsed };
  return session.collapsed === view.collapsed
    ? session
    : { ...session, collapsed: view.collapsed };
}

function withSession(
  view: DockViewState,
  sessionId: string,
  patch: Partial<DockSessionState>,
): DockViewState {
  const current = sessionDockState(view, sessionId);
  const session = { ...current, ...patch, collapsed: view.collapsed };
  if (session.chosenTab === current.chosenTab) {
    return view;
  }
  return { ...view, sessions: { ...view.sessions, [sessionId]: session } };
}

/**
 * Which tab the container shows.
 *
 * A remembered choice wins while its side still has content; otherwise the
 * content decides (running work first, then an in-progress todo). A tab whose
 * side is empty is never selected, so the caller never renders an empty panel.
 */
export function resolveDockTab(
  state: DockSessionState,
  hasTodo: boolean,
  hasTasks: boolean,
  runningTasks: number,
  inProgressTodos: number,
): DockTab {
  if (hasTodo && hasTasks) {
    if (state.chosenTab === "todo") return "todo";
    if (state.chosenTab === "tasks") return "tasks";
    if (runningTasks > 0) return "tasks";
    if (inProgressTodos > 0) return "todo";
    return "todo";
  }
  if (hasTasks) return "tasks";
  return "todo";
}

/** Both sides of the container, as the tab rule needs to see them. */
export type DockSides = {
  hasTodo: boolean;
  hasTasks: boolean;
  runningTasks: number;
  inProgressTodos: number;
};

/**
 * Both sides of the container, described the way the tab rule expects.
 *
 * The task side describes the rows the container can render, and the todo side
 * comes from the caller, which owns that read. The render rule and the badge
 * rule consume this one description, so they cannot disagree about which tasks
 * are live in the session.
 */
export function sidesFor(
  rows: readonly BackgroundTaskSummary[],
  todos: readonly SessionTodo[],
): DockSides {
  let runningTasks = 0;
  for (const task of rows) {
    if (task.state === "running") runningTasks += 1;
  }
  return {
    hasTodo: todos.length > 0,
    hasTasks: rows.length > 0,
    runningTasks,
    inProgressTodos: todos.filter((todo) => todo.status === "in_progress").length,
  };
}

export function resolveDockTabFor(state: DockSessionState, sides: DockSides): DockTab {
  return resolveDockTab(
    state,
    sides.hasTodo,
    sides.hasTasks,
    sides.runningTasks,
    sides.inProgressTodos,
  );
}

/**
 * The tab actually on screen.
 *
 * A row being read keeps the tasks panel on screen: the auto tab rule does not
 * switch to Todo underneath an open preview, so the last running task ending
 * mid-read does not pull the panel away. A user tab choice still decides —
 * choosing Todo is what ends a read (#2634).
 */
export function visibleDockTab(
  state: DockSessionState,
  sides: DockSides,
  reading: boolean,
): DockTab {
  if (reading) return "tasks";
  return resolveDockTabFor(state, sides);
}

/**
 * Whether the output preview is on screen: a row is open, the container is
 * expanded, and the panel on screen is Tasks.
 *
 * The resolved panel, not the remembered choice, decides: choosing Todo ends a
 * read only while the Todo side still has content, so clearing every todo —
 * which falls back to Tasks without changing the choice — leaves the read
 * alive (#2634). A tab the container chose on its own never interrupts the
 * read either, because `visibleDockTab` keeps Tasks on screen for it.
 */
export function isReading(
  state: DockSessionState,
  sides: DockSides,
  expandedId: string | null,
): boolean {
  if (expandedId === null || state.collapsed) return false;
  return resolveDockTabFor(state, sides) === "tasks" || state.chosenTab === null;
}

/**
 * The user picked a tab. Only this writes the remembered choice, so a tab the
 * container chose on its own never overwrites what the user wanted.
 */
export function chooseTab(
  view: DockViewState,
  sessionId: string,
  tab: DockTab,
): DockViewState {
  return withSession(view, sessionId, { chosenTab: tab });
}

/**
 * The user clicked a tab in the header.
 *
 * Clicking a tab while collapsed also expands the container — otherwise the
 * click would only swap an invisible panel and appear to do nothing — so this
 * is the one user action that writes both the tab and the collapse.
 */
export function selectTab(
  view: DockViewState,
  sessionId: string,
  tab: DockTab,
): DockViewState {
  return withSession({ ...view, collapsed: false }, sessionId, { chosenTab: tab });
}

/**
 * Flip the container's collapse. It belongs to the container, not to the
 * session on screen, so the answer the user gave is reused everywhere and kept
 * when they switch sessions.
 */
export function toggleCollapsed(view: DockViewState): DockViewState {
  return { ...view, collapsed: !view.collapsed };
}

/** Badge markup value: `0` hides it, and long counts collapse to `9+`. */
export function badgeLabel(count: number): string {
  return count > MAX_BADGE ? `${MAX_BADGE}+` : String(count);
}

/** Drop entries for sessions that no longer exist, so the map cannot grow. */
export function pruneDockView(
  view: DockViewState,
  liveSessionIds: ReadonlySet<string>,
): DockViewState {
  let changed = false;
  const next: Record<string, DockSessionState> = {};
  for (const [id, state] of Object.entries(view.sessions)) {
    if (liveSessionIds.has(id)) {
      next[id] = state;
    } else {
      changed = true;
    }
  }
  return changed ? { ...view, sessions: next } : view;
}

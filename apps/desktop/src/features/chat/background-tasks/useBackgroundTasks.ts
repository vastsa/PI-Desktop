import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type BackgroundTaskOutput, type BackgroundTaskSummary } from "../../../lib/api";
import {
  type BarVisibility,
  EMPTY_VISIBILITY,
  dismissTask,
  nextExpiryAt,
  observeTasks,
  selectVisibleTasks,
} from "./bar-visibility";
import {
  type DockSides,
  EMPTY_DOCK_VIEW,
  type DockTab,
  type DockViewState,
  badgeLabel,
  clearBadge,
  observeSessionTasks,
  pruneDockView,
  resolveDockTabFor,
  selectTab,
  sessionDockState,
  tasksPanelVisible,
  toggleCollapsed,
} from "./dock-state";
import type { SessionTodo } from "@pi-desktop/shared";

const REFRESH_MS = 1_000;
type Failure = "load" | "output" | "stop" | "remove";

/**
 * Both sides of the container, described the way the tab rule expects.
 *
 * The task side describes the rows the container can render, and the todo side
 * comes from the caller, which owns that read. Both the render rule and the
 * badge rule consume this one description, so they cannot disagree about which
 * panel is on screen.
 */
function sidesFor(
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
/**
 * Background tasks for one session, plus the shared container's view state.
 *
 * The host registry is global and stays that way: filtering happens here so the
 * wire contract does not have to grow a session parameter and every consumer
 * keeps seeing the full picture. Switching sessions therefore changes only what
 * is displayed — never whether a task runs.
 */
export function useBackgroundTasks(
  sessionId: string | null | undefined,
  todos: readonly SessionTodo[] = [],
) {
  const [allTasks, setAllTasks] = useState<BackgroundTaskSummary[]>([]);
  // Renderer-local view state: which tasks the container may show. The registry
  // in host-core stays the source of truth for the processes themselves.
  const [visibility, setVisibility] = useState<BarVisibility>(EMPTY_VISIBILITY);
  const [dockView, setDockView] = useState<DockViewState>(EMPTY_DOCK_VIEW);
  const [clock, setClock] = useState(() => Date.now());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [output, setOutput] = useState<BackgroundTaskOutput | null>(null);
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<Failure | null>(null);
  const mounted = useRef(false);
  const pendingStops = useRef(new Set<string>());
  const refreshList = useRef<(() => void) | null>(null);
  // Ids already folded into the badge, per session, so a re-read of the same
  // snapshot cannot count the same task twice.
  const knownIds = useRef(new Map<string, Set<string>>());
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let inFlight = false;
    let queued = false;
    let pollAgain = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      clearTimeout(timer);
      if (inFlight) {
        queued = true;
        return;
      }
      inFlight = true;
      try {
        const result = await api.backgroundTasksList();
        if (disposed) return;
        const observedAt = Date.now();
        setAllTasks(result.tasks);
        setVisibility((current) => observeTasks(current, result.tasks, observedAt));
        setClock(observedAt);

        // Fold the snapshot into the badge for the session on screen. A task is
        // "new" only while the tasks panel is not the one being looked at.
        const currentSession = sessionIdRef.current;
        if (currentSession) {
          const sessionTasks = result.tasks.filter((task) => task.sessionId === currentSession);
          const seen = knownIds.current.get(currentSession) ?? new Set<string>();
          setDockView((current) => {
            const state = sessionDockState(current, currentSession);
            // The same description the render path uses: the rows the container
            // can actually show decide whether its tasks panel is on screen.
            const tasksVisible = tasksPanelVisible(state, sidesRef.current);
            const folded = observeSessionTasks(current, currentSession, sessionTasks, {
              knownIds: seen,
              tasksVisible,
            });
            knownIds.current.set(currentSession, folded.knownIds);
            return folded.view;
          });
        }

        setError((current) => current === "load" ? null : current);
        pollAgain = result.tasks.some((task) => task.state === "running");
      } catch (failure) {
        if (disposed) return;
        console.error("Background task list failed", failure);
        setError("load");
        pollAgain = true;
      } finally {
        inFlight = false;
        if (!disposed) {
          if (queued) {
            queued = false;
            void refresh();
          } else if (pollAgain) {
            timer = setTimeout(() => void refresh(), REFRESH_MS);
          }
        }
      }
    };
    refreshList.current = () => void refresh();
    const unsubscribe = api.onBackgroundTasksChanged(() => void refresh());
    void refresh();
    return () => {
      disposed = true;
      mounted.current = false;
      refreshList.current = null;
      clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  // Only this session's tasks reach the container. A task from another session
  // is not hidden because it ended: it simply belongs elsewhere. Registry
  // history is kept out of the container by the visible-row rule below, not by
  // dropping tasks from this list: removal and output reads still need them.
  const sessionTasks = useMemo(
    () => (sessionId ? allTasks.filter((task) => task.sessionId === sessionId) : []),
    [allTasks, sessionId],
  );

  // Keep the per-session maps bounded as sessions come and go.
  useEffect(() => {
    const live = new Set(allTasks.map((task) => task.sessionId));
    if (sessionId) live.add(sessionId);
    setDockView((current) => pruneDockView(current, live));
    for (const id of knownIds.current.keys()) {
      if (!live.has(id)) knownIds.current.delete(id);
    }
  }, [allTasks, sessionId]);

  // Only what the container should render: running tasks, a finished task during
  // its post-exit grace window, and the row whose output the user is reading.
  const visibleTasks = selectVisibleTasks(visibility, sessionTasks, clock, expandedId);

  useEffect(() => {
    const expiry = nextExpiryAt(visibility, sessionTasks, clock, expandedId);
    if (expiry === null) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.max(0, expiry - clock));
    return () => clearTimeout(timer);
  }, [visibility, sessionTasks, clock, expandedId]);

  const selectedState = sessionTasks.find((task) => task.id === expandedId)?.state;
  useEffect(() => {
    setOutput(null);
    if (!expandedId || !sessionId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sessionAtRequest = sessionId;
    const refresh = async () => {
      try {
        const result = await api.backgroundTasksOutput(expandedId);
        if (disposed) return;
        setOutput(result);
        setError((current) => current === "output" ? null : current);
      } catch (failure) {
        if (disposed) return;
        console.error("Background task output failed", failure);
        setError("output");
      } finally {
        // Only the selected log crosses IPC, with at most one read in flight.
        if (!disposed && selectedState === "running" && sessionIdRef.current === sessionAtRequest) {
          timer = setTimeout(() => void refresh(), REFRESH_MS);
        }
      }
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [expandedId, selectedState, sessionId]);

  const toggleOutput = useCallback((id: string) => {
    setExpandedId((current) => current === id ? null : id);
    setError((current) => current === "output" ? null : current);
  }, []);

  /**
   * Enter the tasks tab: this is the only path that clears the badge.
   *
   * `selectTab` also expands the container, so a click on a tab while collapsed
   * lands on a visible panel instead of appearing to do nothing.
   */
  const openTasksTab = useCallback(() => {
    if (!sessionId) return;
    setDockView((current) => clearBadge(selectTab(current, sessionId, "tasks"), sessionId));
  }, [sessionId]);

  const openTodoTab = useCallback(() => {
    if (!sessionId) return;
    setDockView((current) => selectTab(current, sessionId, "todo"));
  }, [sessionId]);

  // The collapse belongs to the container, so it is written even before a
  // session is on screen and never reset by a session switch.
  const setCollapsed = useCallback((collapsed: boolean) => {
    setDockView((current) => (current.collapsed === collapsed ? current : toggleCollapsed(current)));
  }, []);

  /**
   * Remove a row from the container.
   *
   * The task is looked up here rather than trusting the caller's snapshot: a
   * running task — including one already stopping — is refused with `false` so
   * the UI can say why instead of silently dropping a live process.
   */
  const remove = useCallback((id: string): boolean => {
    const task = sessionTasks.find((candidate) => candidate.id === id);
    if (!task || task.state === "running") {
      setError("remove");
      return false;
    }
    setVisibility((current) => dismissTask(current, task));
    setExpandedId((current) => current === id ? null : current);
    return true;
  }, [sessionTasks]);

  const stop = useCallback(async (id: string) => {
    if (pendingStops.current.has(id)) return;
    pendingStops.current.add(id);
    setStoppingIds(new Set(pendingStops.current));
    setError(null);
    try {
      await api.backgroundTasksStop(id);
      if (mounted.current) refreshList.current?.();
    } catch (failure) {
      if (mounted.current) {
        console.error("Background task stop failed", failure);
        setError("stop");
      }
    } finally {
      pendingStops.current.delete(id);
      if (mounted.current) setStoppingIds(new Set(pendingStops.current));
    }
  }, []);

  const dock = sessionDockState(dockView, sessionId);
  // The tab and badge rules see the rows the container can render, so a task
  // that already left it cannot decide which panel is on screen.
  const sides = sidesFor(visibleTasks, todos);
  const activeTab: DockTab = resolveDockTabFor(dock, sides);
  // The poll loop outlives a render, so it reads the container's description of
  // itself through a ref rather than capturing one snapshot of it.
  const sidesRef = useRef(sides);
  sidesRef.current = sides;

  return {
    /** The session's rows the container may render: live, in grace, or pinned. */
    tasks: visibleTasks,
    activeTab,
    openTasksTab,
    openTodoTab,
    collapsed: dock.collapsed,
    setCollapsed,
    badge: dock.newCount,
    badgeText: badgeLabel(dock.newCount),
    expandedId,
    output,
    stoppingIds,
    error,
    toggleOutput,
    stop,
    remove,
  };
}

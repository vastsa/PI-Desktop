import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type BackgroundTaskOutput, type BackgroundTaskSummary } from "../../../lib/api";
import { selectVisibleTasks } from "./bar-visibility";
import {
  EMPTY_DOCK_VIEW,
  type DockTab,
  type DockViewState,
  badgeLabel,
  isReading,
  pruneDockView,
  selectTab,
  sessionDockState,
  sidesFor,
  toggleCollapsed,
  visibleDockTab,
} from "./dock-state";
import type { SessionTodo } from "@pi-desktop/shared";

const REFRESH_MS = 1_000;
type Failure = "load" | "output" | "stop" | "remove";

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
  const [dockView, setDockView] = useState<DockViewState>(EMPTY_DOCK_VIEW);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [output, setOutput] = useState<BackgroundTaskOutput | null>(null);
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<Failure | null>(null);
  const mounted = useRef(false);
  const pendingStops = useRef(new Set<string>());
  const refreshList = useRef<(() => void) | null>(null);
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
        setAllTasks(result.tasks);

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

  // Keep the per-session view entries bounded as sessions come and go.
  useEffect(() => {
    const live = new Set(allTasks.map((task) => task.sessionId));
    if (sessionId) live.add(sessionId);
    setDockView((current) => pruneDockView(current, live));
  }, [allTasks, sessionId]);

  // Only what the container should render: the session's live tasks, plus the
  // row whose output the user is reading (#2632).
  const visibleTasks = selectVisibleTasks(sessionTasks, expandedId);

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
   * Enter the tasks tab. `selectTab` also expands the container, so a click on
   * a tab while collapsed lands on a visible panel instead of appearing to do
   * nothing. The badge is derived from the rows, so no view action clears it.
   */
  const openTasksTab = useCallback(() => {
    if (!sessionId) return;
    setDockView((current) => selectTab(current, sessionId, "tasks"));
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
   * Close the row the user removed.
   *
   * The task is looked up here rather than trusting the caller's snapshot: a
   * running task — including one already stopping — is refused with `false` so
   * the UI can say why instead of silently dropping a live process.
   */
  const remove = useCallback((id: string): boolean => {
    const task = sessionTasks.find((candidate) => candidate.id === id);
    if (!task || task.state === "running" || task.continuation === "pending") {
      setError("remove");
      return false;
    }
    setExpandedId((current) => current === id ? null : current);
    return true;
  }, [sessionTasks]);

  const cancelContinuation = useCallback(async (id: string) => {
    try {
      await api.backgroundTasksCancelContinuation(id);
      if (mounted.current) refreshList.current?.();
    } catch (failure) {
      console.error("Background continuation cancellation failed", failure);
      if (mounted.current) setError("stop");
    }
  }, []);

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
  // Whether the output preview is on screen. The panel that resolves decides,
  // not the remembered choice: a remembered Todo whose side emptied has
  // already fallen back to Tasks, and a read on that panel is a visible read.
  // A tab the container chose on its own never takes the panel away from an
  // open preview, so a read cannot be cut short by the last running task
  // ending (#2634).
  const reading = isReading(dock, sides, expandedId);
  const activeTab: DockTab = visibleDockTab(dock, sides, reading);
  // The badge mirrors the session's live work: it rises when a task starts and
  // falls as tasks end, and no view action can change it (#2632).
  const badge = sides.runningTasks;

  // The pin on a row being read ends when its preview leaves the screen —
  // collapse, or the panel on screen becoming Todo — so a finished row cannot
  // reappear later with no output on screen (#2634). A running task keeps its
  // preview across the switch: the row itself is live work and stays, so
  // coming back to the tasks tab picks up the same read; if the task ends
  // while hidden, the pin goes with it.
  useEffect(() => {
    if (expandedId === null || reading) return;
    const pinnedTask = sessionTasks.find((task) => task.id === expandedId);
    if (pinnedTask?.state !== "running") setExpandedId(null);
  }, [reading, expandedId, sessionTasks]);

  // A preview belongs to the session it was opened in; a session switch
  // closes it.
  useEffect(() => {
    setExpandedId(null);
  }, [sessionId]);

  return {
    /** The session's rows the container may render: live, or being read. */
    tasks: visibleTasks,
    activeTab,
    openTasksTab,
    openTodoTab,
    collapsed: dock.collapsed,
    setCollapsed,
    badge,
    badgeText: badgeLabel(badge),
    expandedId,
    output,
    stoppingIds,
    error,
    toggleOutput,
    stop,
    cancelContinuation,
    remove,
  };
}

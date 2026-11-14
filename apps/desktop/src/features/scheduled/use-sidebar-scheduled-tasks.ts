import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ScheduledTask, ScheduledTaskRun } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { matchesSidebarSearch } from "../../lib/sidebar-search";

/** Reads only while shortcuts are enabled; search filters the local task list. */
export function useSidebarScheduledTasks(enabled: boolean, searchQuery: string) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [runs, setRuns] = useState<ScheduledTaskRun[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const revision = useRef(0);

  const refresh = useCallback(async () => {
    if (!mounted.current) return;
    const request = ++revision.current;
    try {
      const [taskResult, runResult] = await Promise.all([
        api.listScheduled(),
        api.listScheduledRuns({ latestPerTask: true }),
      ]);
      if (!mounted.current || request !== revision.current) return;
      setTasks(taskResult.tasks);
      setRuns(runResult.runs);
      setLoaded(true);
      setError("");
    } catch (failure) {
      if (mounted.current && request === revision.current) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setTasks([]);
      setRuns([]);
      setLoaded(false);
      setError("");
      return;
    }
    mounted.current = true;
    void refresh();
    // Match the Scheduled page, including task edits made in other windows.
    const timer = setInterval(() => void refresh(), 10_000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      mounted.current = false;
      revision.current++;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, refresh]);

  const matchingTasks = useMemo(
    () => enabled ? tasks.filter((task) => matchesSidebarSearch(task.title, searchQuery)) : [],
    [enabled, tasks, searchQuery],
  );
  return {
    tasks: matchingTasks,
    runs: enabled ? runs : [],
    loaded: enabled && loaded,
    error: enabled ? error : "",
    refresh,
    searching: searchQuery.trim().length > 0,
  };
}

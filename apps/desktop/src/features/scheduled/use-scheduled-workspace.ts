import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectRecord, ScheduledTask, ScheduledTaskRun } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { latestRunByTask, resolveSelectedTaskId, runsForTask, taskIsRunning } from "./scheduled-runs";
import type { ScheduledDraft } from "./ScheduledEditor";
import { peekScheduledReturn } from "./scheduled-return";

/** Same cadence the page always used: the host owns admission, the page only
 * reflects it. */
const REFRESH_INTERVAL_MS = 10_000;
/** What each task row reports: the host answers one newest run per task, so a
 * task idle while others produced runs never reads as never run. */
/** The selected task's own history, which the run panel reads. */
const TASK_RUN_LIMIT = 200;

export type ScheduledWorkspace = {
  tasks: ScheduledTask[];
  projects: ProjectRecord[];
  selectedTask: ScheduledTask | null;
  selectedTaskId: string | null;
  /** The selected task's own runs, newest first. */
  runs: ScheduledTaskRun[];
  /** Newest run per task, for the task column. */
  latestRuns: Map<string, ScheduledTaskRun>;
  selectedRunId: string | null;
  busy: boolean;
  loaded: boolean;
  error: string;
  taskIsRunning: (taskId: string) => boolean;
  selectTask: (taskId: string) => void;
  selectRun: (runId: string) => void;
  refresh: () => Promise<void>;
  saveTask: (taskId: string | null, draft: ScheduledDraft) => Promise<boolean>;
  runTaskNow: (taskId: string) => Promise<void>;
  toggleTask: (taskId: string, enabled: boolean) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;
};

/**
 * Data flow for the Scheduled workspace: one poll for every task row's last
 * outcome, one scoped read for the selected task's history, and the task
 * mutations the page exposes. Reads are revision-guarded so a slow response can
 * never overwrite a newer one, and a change of selection cancels the stale read.
 */
export function useScheduledWorkspace(
  onError: (message: string) => void,
): ScheduledWorkspace {
  // Coming back from a run's conversation restores the same task and run.
  const restored = peekScheduledReturn();
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [latestPerTaskRuns, setLatestPerTaskRuns] = useState<ScheduledTaskRun[]>([]);
  const [taskRuns, setTaskRuns] = useState<ScheduledTaskRun[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(restored?.taskId ?? null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(restored?.runId ?? null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");

  const mounted = useRef(false);
  const revision = useRef(0);
  const runRevision = useRef(0);
  const selectedTaskIdRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);
  useEffect(() => {
    selectedTaskIdRef.current = selectedTaskId;
  }, [selectedTaskId]);

  const refresh = useCallback(async () => {
    const request = ++revision.current;
    try {
      const [taskResult, runResult, projectResult] = await Promise.all([
        api.listScheduled(),
        api.listScheduledRuns({ latestPerTask: true }),
        api.listProjects().catch(() => ({ projects: [] as ProjectRecord[] })),
      ]);
      if (!mounted.current || request !== revision.current) return;
      setTasks(taskResult.tasks);
      setLatestPerTaskRuns(runResult.runs);
      setProjects(projectResult.projects);
      setError("");
      setLoaded(true);
    } catch (failure) {
      if (mounted.current && request === revision.current) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    }
  }, []);

  const readTaskRuns = useCallback(async (taskId: string) => {
    const request = ++runRevision.current;
    try {
      const result = await api.listScheduledRuns({ taskId, limit: TASK_RUN_LIMIT });
      if (!mounted.current || request !== runRevision.current) return;
      setTaskRuns(result.runs);
    } catch {
      // The rail still reports the outcome it read; an empty history with a
      // retryable page error is better than clearing what the user is reading.
      if (mounted.current && request === runRevision.current) setTaskRuns([]);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const id = selectedTaskIdRef.current;
    if (id) void readTaskRuns(id);
    const timer = setInterval(() => {
      void refresh();
      const current = selectedTaskIdRef.current;
      if (current) void readTaskRuns(current);
    }, REFRESH_INTERVAL_MS);
    return () => {
      mounted.current = false;
      revision.current++;
      runRevision.current++;
      clearInterval(timer);
    };
  }, [refresh, readTaskRuns]);

  // Keep one task selected: the first one, or the previous selection while it
  // still exists. A deleted task never leaves the pane pointing at nothing, and
  // a selection restored from a conversation outlives the first, empty read.
  useEffect(() => {
    setSelectedTaskId((current) => resolveSelectedTaskId(tasks, current, loaded));
  }, [tasks, loaded]);

  // A task switch releases the run selection, but the pair restored from a
  // conversation must survive the first mount or the reader loses the row that
  // brought them back.
  const previousTaskRef = useRef<string | null>(restored?.taskId ?? null);
  useEffect(() => {
    if (previousTaskRef.current !== selectedTaskId) {
      previousTaskRef.current = selectedTaskId;
      setSelectedRunId(null);
    }
    if (selectedTaskId) void readTaskRuns(selectedTaskId);
  }, [selectedTaskId, readTaskRuns]);

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? null,
    [tasks, selectedTaskId],
  );
  const runs = useMemo(() => runsForTask(taskRuns, selectedTaskId), [taskRuns, selectedTaskId]);
  const latestRuns = useMemo(() => latestRunByTask(latestPerTaskRuns), [latestPerTaskRuns]);

  const action = useCallback(
    async (work: () => Promise<void>): Promise<boolean> => {
      if (busyRef.current) return false;
      busyRef.current = true;
      setBusy(true);
      try {
        await work();
        await refresh();
        const current = selectedTaskIdRef.current;
        if (current) await readTaskRuns(current);
        return true;
      } catch (failure) {
        onErrorRef.current(failure instanceof Error ? failure.message : String(failure));
        return false;
      } finally {
        busyRef.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [refresh, readTaskRuns],
  );

  const saveTask = useCallback(
    async (taskId: string | null, draft: ScheduledDraft): Promise<boolean> =>
      action(async () => {
        if (taskId) await api.updateScheduled({ id: taskId, ...draft });
        else await api.createScheduled(draft);
      }),
    [action],
  );

  const runTaskNow = useCallback(
    async (taskId: string) => {
      await action(async () => {
        await api.executeScheduled(taskId);
        // Show the run that was just admitted rather than an older selection.
        setSelectedRunId(null);
      });
    },
    [action],
  );

  const toggleTask = useCallback(
    async (taskId: string, enabled: boolean) => {
      await action(async () => {
        await api.updateScheduled({ id: taskId, enabled });
      });
    },
    [action],
  );

  const deleteTask = useCallback(
    async (taskId: string) => {
      await action(async () => {
        await api.deleteScheduled(taskId);
        if (selectedTaskIdRef.current === taskId) setSelectedRunId(null);
      });
    },
    [action],
  );

  const selectTask = useCallback((taskId: string) => setSelectedTaskId(taskId), []);
  const selectRun = useCallback((runId: string) => setSelectedRunId(runId), []);
  const runningFor = useCallback(
    (taskId: string) => taskIsRunning(latestPerTaskRuns, taskId),
    [latestPerTaskRuns],
  );

  return {
    tasks,
    projects,
    selectedTask,
    selectedTaskId,
    runs,
    latestRuns,
    selectedRunId,
    busy,
    loaded,
    error,
    taskIsRunning: runningFor,
    selectTask,
    selectRun,
    refresh,
    saveTask,
    runTaskNow,
    toggleTask,
    deleteTask,
  };
}

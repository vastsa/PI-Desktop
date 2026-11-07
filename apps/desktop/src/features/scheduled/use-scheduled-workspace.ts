import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectRecord, ScheduledTask, ScheduledTaskRun } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { latestRunByTask, resolveSelectedTaskId, runsForTask, taskIsRunning } from "./scheduled-runs";
import type { ScheduledDraft } from "./ScheduledEditor";
import { peekScheduledReturn } from "./scheduled-return";
import { scheduledWorkspaceCache as cache } from "./scheduled-workspace-cache";

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
  latestRunsLoaded: boolean;
  latestRunsError: string;
  runsLoaded: boolean;
  runsError: string;
  projectsLoaded: boolean;
  projectsError: string;
  loadProjects: () => Promise<void>;
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
  const snapshot = cache.snapshot;
  const cachedTaskId = snapshot.selection?.taskId;
  const initialTaskId = restored?.taskId ?? (snapshot.tasks?.some((task) => task.id === cachedTaskId) ? cachedTaskId : snapshot.tasks?.[0]?.id) ?? null;
  const [tasks, setTasks] = useState<ScheduledTask[]>(snapshot.tasks ?? []);
  const [latestPerTaskRuns, setLatestPerTaskRuns] = useState<ScheduledTaskRun[]>(snapshot.latestPerTaskRuns ?? []);
  const [taskRuns, setTaskRuns] = useState<ScheduledTaskRun[]>(snapshot.history?.runs ?? []);
  const [latestRunsLoaded, setLatestRunsLoaded] = useState(snapshot.latestPerTaskRuns !== undefined);
  const [latestRunsError, setLatestRunsError] = useState("");
  const [historyTaskId, setHistoryTaskId] = useState(snapshot.history?.taskId ?? null);
  const [historyLoaded, setHistoryLoaded] = useState(snapshot.history !== undefined);
  const [historyError, setHistoryError] = useState("");
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [projectsError, setProjectsError] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(initialTaskId);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(restored?.runId ?? (snapshot.selection?.taskId === initialTaskId ? snapshot.selection.runId : null));
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(snapshot.tasks !== undefined);
  const [error, setError] = useState("");

  const mounted = useRef(false);
  const revision = useRef(0);
  const runRevision = useRef(0);
  const projectRevision = useRef(0);
  const pendingProjectGeneration = useRef<number | null>(null);
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
    const generation = cache.generation;
    const current = () => mounted.current && request === revision.current && generation === cache.generation;
    await Promise.all([
      api.listScheduled().then((result) => {
        if (!current()) return;
        cache.snapshot.tasks = result.tasks;
        setTasks(result.tasks);
        setError("");
        setLoaded(true);
      }).catch((failure) => {
        if (current()) setError(failure instanceof Error ? failure.message : String(failure));
      }),
      api.listScheduledRuns({ latestPerTask: true }).then((result) => {
        if (!current()) return;
        cache.snapshot.latestPerTaskRuns = result.runs;
        setLatestPerTaskRuns(result.runs);
        setLatestRunsLoaded(true);
        setLatestRunsError("");
      }).catch((failure) => {
        if (current()) setLatestRunsError(failure instanceof Error ? failure.message : String(failure));
      }),
    ]);
  }, []);

  const readTaskRuns = useCallback(async (taskId: string) => {
    const request = ++runRevision.current;
    const generation = cache.generation;
    try {
      const result = await api.listScheduledRuns({ taskId, limit: TASK_RUN_LIMIT });
      if (!mounted.current || request !== runRevision.current || generation !== cache.generation) return;
      cache.snapshot.history = { taskId, runs: result.runs };
      setTaskRuns(result.runs);
      setHistoryTaskId(taskId);
      setHistoryLoaded(true);
      setHistoryError("");
    } catch (failure) {
      if (mounted.current && request === runRevision.current && generation === cache.generation) {
        setHistoryTaskId(taskId);
        setHistoryError(failure instanceof Error ? failure.message : String(failure));
      }
    }
  }, []);

  const loadProjects = useCallback(async () => {
    const request = ++projectRevision.current;
    const generation = cache.generation;
    pendingProjectGeneration.current = generation;
    setProjectsLoaded(false);
    setProjectsError("");
    try {
      const result = await api.listProjects();
      if (!mounted.current || request !== projectRevision.current || generation !== cache.generation) return;
      setProjects(result.projects);
      setProjectsLoaded(true);
    } catch (failure) {
      if (mounted.current && request === projectRevision.current && generation === cache.generation) {
        setProjectsError(failure instanceof Error ? failure.message : String(failure));
      }
    } finally {
      if (request === projectRevision.current && generation === cache.generation) {
        pendingProjectGeneration.current = null;
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => {
      void refresh();
      const current = selectedTaskIdRef.current;
      if (current) void readTaskRuns(current);
      // Replace an invalidated editor read even if the old Host never settles it.
      if (pendingProjectGeneration.current !== null && pendingProjectGeneration.current !== cache.generation) {
        void loadProjects();
      }
    }, REFRESH_INTERVAL_MS);
    return () => {
      mounted.current = false;
      revision.current++;
      runRevision.current++;
      projectRevision.current++;
      clearInterval(timer);
    };
  }, [refresh, readTaskRuns, loadProjects]);

  // Keep one task selected: the first one, or the previous selection while it
  // still exists. A deleted task never leaves the pane pointing at nothing, and
  // a selection restored from a conversation outlives the first, empty read.
  useEffect(() => {
    setSelectedTaskId((current) => resolveSelectedTaskId(tasks, current, loaded));
  }, [tasks, loaded]);

  // A task switch releases the run selection, but the pair restored from a
  // conversation must survive the first mount or the reader loses the row that
  // brought them back.
  const previousTaskRef = useRef<string | null>(initialTaskId);
  useEffect(() => {
    if (previousTaskRef.current !== selectedTaskId) {
      previousTaskRef.current = selectedTaskId;
      setSelectedRunId(null);
      setHistoryLoaded(false);
      setHistoryError("");
    }
    runRevision.current++;
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

  const selectTask = useCallback((taskId: string) => {
    cache.snapshot.selection = { taskId, runId: null };
    setSelectedTaskId(taskId);
  }, []);
  const selectRun = useCallback((runId: string) => {
    const taskId = selectedTaskIdRef.current;
    if (taskId) cache.snapshot.selection = { taskId, runId };
    setSelectedRunId(runId);
  }, []);
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
    latestRunsLoaded,
    latestRunsError,
    runsLoaded: historyTaskId === selectedTaskId && historyLoaded,
    runsError: historyTaskId === selectedTaskId ? historyError : "",
    projectsLoaded,
    projectsError,
    loadProjects,
    taskIsRunning: runningFor,
    selectTask,
    selectRun,
    refresh: async () => {
      const id = selectedTaskIdRef.current;
      await Promise.all([refresh(), ...(id ? [readTaskRuns(id)] : [])]);
    },
    saveTask,
    runTaskNow,
    toggleTask,
    deleteTask,
  };
}

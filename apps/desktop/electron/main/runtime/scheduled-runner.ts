type Host = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };
import type { ScheduledRunChange } from "@pi-desktop/shared";

export type ScheduledLaunch = {
  sessionId: string;
  prompt: string;
  runId: string;
  /** The dispatched task, so a project row can name the run it reports. */
  task?: { title?: string; workspacePath?: string };
};

/**
 * Runs through the same prompt entry point as an interactive desktop turn.
 *
 * The run's transcript stays out of the session list (#1298), so a project row
 * learns about the run from here (issue #1441): `onChanged` announces the run
 * the moment the host accepts it, settlement is announced where the turn ends
 * (`plans.ts`, right after `scheduled.finishRun`), and a dispatch failure
 * announces itself below.
 */
export async function executeScheduledTask(options: {
  host: Host;
  isCurrent: () => boolean;
  id: string;
  automatic: boolean;
  runs: Map<string, string>;
  prompt: (sessionId: string, content: string) => Promise<unknown>;
  onChanged?: (change: ScheduledRunChange) => void;
}): Promise<ScheduledLaunch> {
  const { host, id, automatic, runs, prompt, isCurrent, onChanged } = options;
  const launch = await host.call<ScheduledLaunch>("scheduled.run", { id, automatic });
  // `scheduled.run` answers with the task it dispatched, so the run's identity
  // for the project row costs no further read.
  const task = launch.task;
  const identity: ScheduledRunChange = {
    runId: launch.runId,
    sessionId: launch.sessionId,
    taskId: id,
    ...(task?.title ? { taskTitle: task.title } : {}),
    ...(task?.workspacePath ? { projectPath: task.workspacePath } : {}),
    status: "running",
  };
  onChanged?.(identity);
  try {
    if (!isCurrent()) throw new Error("scheduled runtime stopped");
    runs.set(launch.sessionId, launch.runId);
    await prompt(launch.sessionId, launch.prompt);
    return launch;
  } catch (error) {
    if (runs.get(launch.sessionId) === launch.runId) runs.delete(launch.sessionId);
    onChanged?.({ ...identity, status: "error" });
    try {
      await host.call("scheduled.finishRun", {
        runId: launch.runId,
        status: "error",
        errorCode: "SCHEDULE_DISPATCH_FAILED",
      });
    } catch (persistenceError) {
      throw new AggregateError([error, persistenceError], "Scheduled dispatch and failure recording both failed");
    }
    throw error;
  }
}

export function createScheduledRunner(options: {
  getHost: () => Host | null;
  execute: (id: string) => Promise<unknown>;
  report: (error: unknown) => void;
}) {
  let stopped = false;
  let polling = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const dispatches = new Map<string, { host: Host }>();
  const tick = async () => {
    if (stopped || polling) return;
    const host = options.getHost();
    if (!host) return;
    polling = true;
    try {
      const { ids } = await host.call<{ ids: string[] }>("scheduled.due");
      for (const id of ids) {
        if (stopped || options.getHost() !== host) break;
        if (dispatches.get(id)?.host === host) continue;
        const owner = { host };
        dispatches.set(id, owner);
        // Polling owns admission requests, not the duration of prompt setup.
        // Host remains authoritative for enabled/due/overlap checks. Keep a
        // local owner until setup settles so another poll cannot dispatch the
        // same task while its admission request is still in flight.
        void (async () => {
          try {
            await options.execute(id);
          } catch (error) {
            options.report(error);
          } finally {
            if (dispatches.get(id) === owner) dispatches.delete(id);
          }
        })();
      }
    } catch (error) {
      options.report(error);
    } finally {
      polling = false;
    }
  };
  return {
    tick,
    start() {
      if (timer || stopped) return;
      timer = setInterval(() => void tick(), 30_000);
      timer.unref();
      void tick();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

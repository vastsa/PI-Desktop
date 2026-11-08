import type { ScheduledTask, ScheduledTaskRun } from "@pi-desktop/shared";

type ScheduledSnapshot = {
  tasks?: ScheduledTask[];
  latestPerTaskRuns?: ScheduledTaskRun[];
  history?: { taskId: string; runs: ScheduledTaskRun[] };
  selection?: { taskId: string; runId: string | null };
};

// Renderer-lifetime display data only; Host admission remains authoritative.
export const scheduledWorkspaceCache = {
  generation: 0,
  snapshot: {} as ScheduledSnapshot,
  clear() {
    this.generation++;
    this.snapshot = {};
  },
};

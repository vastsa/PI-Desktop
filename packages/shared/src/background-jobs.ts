/** Model-facing references preserve the execution owner's native identifier. */
export type JobReference = { kind: "bash" | "delegation"; id: string };

export type BackgroundJobSummary = {
  job: JobReference;
  command: string;
  state: "running" | "exited" | "failed" | "stopped";
  elapsedMs: number;
  exitCode: number | null;
  stopRequested: boolean;
};

export type BackgroundJobSnapshot = BackgroundJobSummary & {
  stdout: string;
  stderr: string;
  truncated: boolean;
};

export const BACKGROUND_JOBS_VERSION = 1;

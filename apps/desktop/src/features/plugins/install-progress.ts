/**
 * What the install dialog shows, folded out of the host's progress reports.
 *
 * An install is a single request that answers only once it is over, so
 * everything the dialog draws between the click and that answer comes from
 * `plugin.installProgress` events: the phase, the mirror being tried, the bytes
 * that arrived, and the mirrors a failure tried. Folding them into one job —
 * and the transfer speed, which only exists as a difference between two reports
 * — is pure transformation, so it lives here rather than in the page hook that
 * owns the subscription.
 */
import type { PluginInstallMirror, PluginInstallProgress } from "@pi-desktop/shared";

/** What the dialog asks the host for, and what a retry asks for again. */
export type PluginInstallRequest = {
  id: string;
  name: string;
  version?: string;
  autoUpdate: boolean;
  grantedPermissions: string[];
};

/** One install the dialog follows, from the confirmed click to its outcome. */
export type PluginInstallJob = {
  /** The accepted request, kept whole so a retry repeats it exactly. */
  request: PluginInstallRequest;
  status: "running" | "success" | "failed";
  phase: PluginInstallProgress["phase"];
  source: string | null;
  attempt: number;
  attempts: number;
  receivedBytes: number;
  totalBytes: number;
  /** Bytes per second from successive reports; 0 until two reports arrive. */
  speed: number;
  /** The user asked to stop, and the host has not answered yet. */
  cancelling: boolean;
  error: string | null;
  /** Mirrors the install tried, with what each answered. */
  tried: PluginInstallMirror[];
};

/** The marker a cancelled install ends with. */
const CANCELLED_MARKER = "PLUGIN_CANCELLED";

/**
 * A job that has just been confirmed. The dialog opens on `resolve`, the phase
 * the host starts with, so a slow first step never looks like a frozen window.
 */
export function newInstallJob(request: PluginInstallRequest): PluginInstallJob {
  return {
    request,
    status: "running",
    phase: "resolve",
    source: null,
    attempt: 0,
    attempts: 0,
    receivedBytes: 0,
    totalBytes: 0,
    speed: 0,
    cancelling: false,
    error: null,
    tried: [],
  };
}

/**
 * Whether this install can still be stopped. Only a download can be
 * interrupted, and only once: while the host is answering a cancel, the button
 * that called it is a "cancelling" state instead of a second request.
 */
export function canCancelInstall(job: PluginInstallJob): boolean {
  return (
    job.status === "running" &&
    !job.cancelling &&
    (job.phase === "resolve" || job.phase === "download")
  );
}

/**
 * The user's own cancellation, which is not a failure to report. The host marks
 * it in the JSON-RPC error code and in the message.
 */
export function isInstallCancelled(error: unknown): boolean {
  if (typeof error === "string") return error.includes(CANCELLED_MARKER);
  if (!(error instanceof Error)) return false;
  if (error.message.includes(CANCELLED_MARKER)) return true;
  return (error as { code?: unknown }).code === CANCELLED_MARKER;
}

/** The reading a speed is measured against: the last report, and its mirror. */
export type InstallSample = {
  attempt: number;
  received: number;
  at: number;
  speed: number;
};

/** How much of a new reading replaces the displayed speed. */
const SPEED_SMOOTHING = 0.4;

/**
 * The transfer speed a report implies, and the reading the next one compares
 * to. A mirror change restarts the count at zero, so that report is only a new
 * baseline; the reading is smoothed because a single chunk says very little.
 */
export function nextInstallSample(
  sample: InstallSample | null,
  event: PluginInstallProgress,
  at: number,
): InstallSample {
  const received = event.receivedBytes ?? 0;
  const attempt = event.attempt ?? 0;
  if (!sample || sample.attempt !== attempt || received < sample.received) {
    return { attempt, received, at, speed: 0 };
  }
  const seconds = (at - sample.at) / 1000;
  // Two reports can share a millisecond: keep the old baseline rather than
  // divide by zero, so the next report still measures real elapsed time.
  if (seconds <= 0) return sample;
  const instant = (received - sample.received) / seconds;
  return {
    attempt,
    received,
    at,
    speed: sample.speed > 0 ? sample.speed * (1 - SPEED_SMOOTHING) + instant * SPEED_SMOOTHING : instant,
  };
}

/**
 * Fold one report into the job.
 *
 * A report carries a whole picture rather than a delta, so the job takes what
 * the report knows and keeps what it does not. The report that ends a failed
 * install carries the mirrors it tried, which the request's own rejection
 * cannot: a failure already shown is completed here rather than replaced.
 */
export function withInstallProgress(
  job: PluginInstallJob,
  event: PluginInstallProgress,
  sample: InstallSample,
): PluginInstallJob {
  return {
    ...job,
    status: event.error ? "failed" : job.status,
    phase: event.phase,
    source: event.source ?? null,
    attempt: event.attempt ?? 0,
    attempts: event.attempts ?? 0,
    receivedBytes: event.receivedBytes ?? 0,
    totalBytes: event.totalBytes ?? 0,
    speed: event.phase === "download" ? sample.speed : 0,
    error: event.error ?? job.error,
    tried: event.tried?.length ? event.tried : job.tried,
  };
}

/**
 * A byte count a person can read, for both sizes and rates. Unlike the catalog
 * formatter this has no "unknown" reading: a download that has received nothing
 * is zero bytes, not missing information.
 */
export function formatTransfer(bytes: number): string {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

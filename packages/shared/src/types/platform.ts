/** Shared public types grouped by the owning application domain. */
import type { Mode } from "./common.js";
import type { GlobalPermissionMode } from "./permissions.js";
import type { SessionThinkingLevel } from "./models.js";

export type AppVersionInfo = {
  name: string;
  version: string;
  protocolVersion: number;
  hostProtocolVersion?: number;
  hostVersion?: string;
  platform: string;
  arch: string;
};

export type HostHealth = {
  ok: boolean;
  protocolVersion: number;
  version: string;
  uptimeMs: number;
};

/** Payload of the `hostStatus` push event (backend supervision state). */
export type HostStatusEvent = {
  ok: boolean;
  component?: "host" | "sidecar";
  restarting?: boolean;
  restarted?: boolean;
  fatal?: boolean;
  /** Free text, or a status token such as `GLIBC_UNSUPPORTED` / `DB_SCHEMA_TOO_NEW`. */
  message?: string;
  /** Schema numbers behind `DB_SCHEMA_TOO_NEW`. */
  schema?: { found: number; supported: number };
  /** Set on the boot status when the build is not native to this CPU. */
  archMismatch?: { platform: string; processArch: string; machineArch: string };
};

/** User-selected update behavior; unsupported installers remain manual. */
export type UpdatePreference = "automatic" | "manual";

/**
 * Effective update delivery on this install:
 *  - in-app: electron-updater downloads and installs
 *  - manual: detect versions and link to the releases page
 *  - disabled: development / unpackaged build
 */
export type UpdateMode = "in-app" | "manual" | "disabled";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "up-to-date"
  | "downloading"
  | "downloaded"
  | "error";

/** Snapshot pushed on the `updatesState` event and returned by updates IPC. */
export type UpdateState = {
  mode: UpdateMode;
  preference: UpdatePreference;
  defaultPreference: UpdatePreference;
  automaticSupported: boolean;
  /** Manual-mode banner is shown once for each discovered version. */
  manualReminder?: boolean;
  status: UpdateStatus;
  currentVersion: string;
  availableVersion?: string;
  /**
   * Localized product highlights for `availableVersion` from the shipped-locale
   * in-app changelog. Plain text (bullet lines); absent when the version has
   * no catalog entry. Main selects the locale — the renderer never supplies
   * a feed or remote notes URL (ADR 0022 / D164).
   */
  releaseNotes?: string;
  /** 0-100 while status is "downloading". */
  progressPercent?: number;
  error?: string;
  /** True when the transition came from a user-initiated check. */
  manual?: boolean;
  /**
   * True when the user dismissed the notice for `availableVersion`. Stays
   * dismissed across restarts until a newer version is detected (#1317).
   */
  dismissed?: boolean;
  releasesUrl: string;
};

export type OnboardingState = {
  showChecklist: boolean;
  steps: Array<{
    id: string;
    title: string;
    done: boolean;
    action?: string;
  }>;
};


export type ScheduledTaskCadence = "manual" | "hourly" | "interval" | "daily" | "weekly";
export type ScheduledTaskSchedule = {
  hour: number;
  minute: number;
  /** Legacy single day, Monday = 0. Used when weekdays is absent. */
  weekday: number;
  /** Selected days, Monday = 0. When present, must be nonempty and unique. */
  weekdays?: number[];
  /**
   * Elapsed minutes between runs of an `interval` task. That cadence requires
   * it and no other cadence reads it, so switching back to a calendar keeps
   * the value for the way back. 5–1440, mirroring `INTERVAL_MIN_MINUTES` and
   * `INTERVAL_MAX_MINUTES` in `crates/host-core/src/scheduled/timing.rs`.
   */
  intervalMinutes?: number;
};
export type ScheduledTaskRun = {
  id: string; taskId: string; sessionId: string | null;
  status: "running" | "completed" | "aborted" | "error";
  errorCode: string | null; startedAt: string; endedAt: string | null;
};

/** How a scheduled run relates to the task's conversations. */
export type ScheduledSessionMode = "perRun" | "reuse";

export type ScheduledTask = {
  id: string;
  title: string;
  prompt: string;
  cadence: ScheduledTaskCadence;
  mode: Mode;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  schedule?: ScheduledTaskSchedule | null;
  nextRunAt?: string;
  workspacePath?: string;
  /** Explicit task-owned execution settings. Missing fields preserve legacy behavior. */
  permissionMode?: GlobalPermissionMode;
  thinkingLevel?: SessionThinkingLevel;
  /**
   * Whether each run opens its own conversation (`perRun`, the default) or
   * continues the conversation its previous run used (`reuse`).
   */
  sessionMode?: ScheduledSessionMode;
  providerId?: string;
  modelId?: string;
};

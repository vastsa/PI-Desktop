/** Shared public types grouped by the owning application domain. */
import type { Mode } from "./common.js";

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

/**
 * How app updates are delivered on this install:
 *  - in-app: electron-updater downloads and installs (Windows NSIS, Linux AppImage)
 *  - manual: we only detect new versions and link to the releases page
 *    (unsigned macOS builds, Linux deb)
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


export type ScheduledTaskCadence = "manual" | "hourly" | "daily" | "weekly";

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
};

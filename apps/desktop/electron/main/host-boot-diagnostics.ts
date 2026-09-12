/**
 * Boot failures that no restart can fix and the UI should name outright:
 *
 * - `DB_SCHEMA_TOO_NEW`: a newer PI-Desktop already migrated the local data
 *   directory; this older build's host-core refuses to open it. Looping
 *   restarts only repeats the same stderr line.
 * - `ARCH_MISMATCH`: the installed build is not native to this CPU (typically
 *   the Intel macOS build on Apple Silicon under Rosetta). It runs, but slower,
 *   so the UI points at the matching download instead of staying silent.
 */
import { execFileSync } from "node:child_process";
import { machine as osMachine } from "node:os";

export const DB_SCHEMA_TOO_NEW_STATUS = "DB_SCHEMA_TOO_NEW";
export const ARCH_MISMATCH_STATUS = "ARCH_MISMATCH";

export type SchemaTooNew = { found: number; supported: number };

const SCHEMA_TOO_NEW_RE =
  /database schema version (\d+) is newer than supported (\d+)/;

/** Parse host-core's refusal line from stderr or an error message. */
export function parseSchemaTooNew(text: unknown): SchemaTooNew | null {
  const match = String(text ?? "").match(SCHEMA_TOO_NEW_RE);
  if (!match) return null;
  return { found: Number(match[1]), supported: Number(match[2]) };
}

export class DbSchemaTooNewError extends Error {
  readonly code = DB_SCHEMA_TOO_NEW_STATUS;
  readonly found: number;
  readonly supported: number;

  constructor(schema: SchemaTooNew) {
    super(
      `Local data uses database schema ${schema.found}, but this build supports ${schema.supported}. Install the newer PI-Desktop that last opened this data.`,
    );
    this.name = "DbSchemaTooNewError";
    this.found = schema.found;
    this.supported = schema.supported;
  }
}

export function isDbSchemaTooNewError(error: unknown): boolean {
  return schemaTooNewOf(error) !== null;
}

/** Schema numbers carried by a boot error, if it is the downgrade refusal. */
export function schemaTooNewOf(error: unknown): SchemaTooNew | null {
  if (error instanceof DbSchemaTooNewError) {
    return { found: error.found, supported: error.supported };
  }
  if (error && typeof error === "object") {
    const record = error as { code?: unknown; found?: unknown; supported?: unknown };
    if (
      record.code === DB_SCHEMA_TOO_NEW_STATUS &&
      typeof record.found === "number" &&
      typeof record.supported === "number"
    ) {
      return { found: record.found, supported: record.supported };
    }
  }
  return parseSchemaTooNew(String(error));
}

export type RuntimeArch = {
  platform: string;
  /** Node's `process.arch` for the running build. */
  processArch: string;
  /** Architecture of the CPU actually executing it, when it can be told apart. */
  machineArch: string;
  /** True when the build is not native to the machine. */
  mismatch: boolean;
};

export function normalizeMachineArch(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (value === "x86_64" || value === "amd64" || value === "x64") return "x64";
  if (value === "arm64" || value === "aarch64") return "arm64";
  if (value === "i386" || value === "i686" || value === "x86") return "ia32";
  return value;
}

/** `sysctl.proc_translated` is 1 only for x64 processes under Rosetta 2. */
function readDarwinTranslated(): boolean {
  try {
    const out = execFileSync("/usr/sbin/sysctl", ["-n", "sysctl.proc_translated"], {
      encoding: "utf8",
      timeout: 1_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() === "1";
  } catch {
    return false;
  }
}

export type RuntimeArchProbe = {
  platform?: string;
  processArch?: string;
  machine?: string;
  /** Override for tests; production reads `sysctl.proc_translated`. */
  darwinTranslated?: boolean;
};

export function detectRuntimeArch(probe: RuntimeArchProbe = {}): RuntimeArch {
  const platform = probe.platform ?? process.platform;
  const processArch = probe.processArch ?? process.arch;
  let machineArch = normalizeMachineArch(probe.machine ?? osMachine());
  if (platform === "darwin") {
    // Rosetta reports the emulated uname, so ask the kernel directly.
    const translated = probe.darwinTranslated ?? readDarwinTranslated();
    machineArch = translated ? "arm64" : processArch;
  }
  return {
    platform,
    processArch,
    machineArch,
    mismatch: machineArch !== processArch,
  };
}

/**
 * Linux packaged host-core is built on Ubuntu 22.04 (glibc 2.35). Newer
 * glibc can load that binary; older distros fail with
 * `version 'GLIBC_2.xx' not found`. Detect the floor before spawn so the
 * UI can name supported releases instead of looping restarts.
 */

export const MIN_LINUX_GLIBC = { major: 2, minor: 35 } as const;
export const GLIBC_UNSUPPORTED_STATUS = "GLIBC_UNSUPPORTED";
export const LINUX_GLIBC_DISTROS = "Ubuntu 22.04, Debian 12, Fedora 36+";

export type GlibcVersion = { major: number; minor: number };

export class GlibcUnsupportedError extends Error {
  readonly code = GLIBC_UNSUPPORTED_STATUS;

  constructor(found?: string) {
    super(
      found
        ? `Linux builds need glibc 2.35 or newer (${LINUX_GLIBC_DISTROS}); this system has ${found}.`
        : `Linux builds need glibc 2.35 or newer (${LINUX_GLIBC_DISTROS}).`,
    );
    this.name = "GlibcUnsupportedError";
  }
}

export function parseGlibcVersion(text: string): GlibcVersion | null {
  const match = String(text).match(/\b(\d+)\.(\d+)\b/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

export function formatGlibcVersion(version: GlibcVersion): string {
  return `${version.major}.${version.minor}`;
}

export function glibcAtLeast(version: GlibcVersion, minimum: GlibcVersion): boolean {
  if (version.major !== minimum.major) return version.major > minimum.major;
  return version.minor >= minimum.minor;
}

export function glibcMissingSymbol(text: string): boolean {
  return /GLIBC_\d+\.\d+/.test(text);
}

/** Highest `GLIBC_*` version needed by a binary's dynamic symbols. */
export function maxNeededGlibc(text: string): GlibcVersion | null {
  let max: GlibcVersion | null = null;
  for (const match of String(text).matchAll(/GLIBC_(\d+)\.(\d+)/g)) {
    const version = { major: Number(match[1]), minor: Number(match[2]) };
    if (!max || glibcAtLeast(version, max)) max = version;
  }
  return max;
}

/**
 * True when a packaged host-core's needed glibc is at or below the floor
 * we advertise. A 2.39 symbol on a 2.35 floor means the Linux runner was too new.
 */
export function hostGlibcWithinFloor(needed: GlibcVersion | null): boolean {
  if (!needed) return true;
  return glibcAtLeast(MIN_LINUX_GLIBC, needed);
}

type ProcessReport = { header?: { glibcVersionRuntime?: unknown } };

export function readRuntimeGlibcVersion(
  report?: ProcessReport | null,
): GlibcVersion | null {
  try {
    const source: ProcessReport | null | undefined =
      report ??
      (typeof process.report?.getReport === "function"
        ? (process.report.getReport() as ProcessReport)
        : undefined);
    const raw = source?.header?.glibcVersionRuntime;
    return typeof raw === "string" && raw ? parseGlibcVersion(raw) : null;
  } catch {
    return null;
  }
}

export function isGlibcUnsupportedError(error: unknown): boolean {
  if (error instanceof GlibcUnsupportedError) return true;
  if (error && typeof error === "object" && "code" in error) {
    if ((error as { code?: unknown }).code === GLIBC_UNSUPPORTED_STATUS) {
      return true;
    }
  }
  return glibcMissingSymbol(String(error));
}

/** Throw when this Linux runtime is below the packaged host-core floor. */
export function assertLinuxGlibcSupported(
  report?: { header?: { glibcVersionRuntime?: unknown } } | null,
): void {
  if (process.platform !== "linux") return;
  const version = readRuntimeGlibcVersion(report);
  if (!version) return;
  if (!glibcAtLeast(version, MIN_LINUX_GLIBC)) {
    throw new GlibcUnsupportedError(formatGlibcVersion(version));
  }
}

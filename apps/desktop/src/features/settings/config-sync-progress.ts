/**
 * What the sync card shows while a manual sync runs.
 *
 * `configSync.syncNow` is a single request that answers only once the whole
 * sync is over, so everything the card draws between the click and that answer
 * comes from `configSync.progress` reports: the phase, the units that phase
 * counted, and the bytes it moved. Turning one report into the fraction, the
 * figure line and the text a screen reader reads is pure transformation, so it
 * lives here rather than in the page that owns the subscription.
 */
import type { ConfigSyncPhase, ConfigSyncProgress } from "@pi-desktop/shared";

/** The catalog key naming each phase. */
export const CONFIG_SYNC_PHASE_KEYS: Record<ConfigSyncPhase, string> = {
  capture: "settings.configSync.progress.phase.capture",
  download: "settings.configSync.progress.phase.download",
  merge: "settings.configSync.progress.phase.merge",
  upload: "settings.configSync.progress.phase.upload",
  apply: "settings.configSync.progress.phase.apply",
  cleanup: "settings.configSync.progress.phase.cleanup",
};

/** What the card renders for one report. */
export type ConfigSyncProgressView = {
  /** The catalog key for the phase the host is in. */
  phaseKey: string;
  /** True when the report announced a total, in bytes or in units. */
  determinate: boolean;
  /** 0-100, clamped; 0 while the report announced no total. */
  percent: number;
  /**
   * The fraction read out for `aria-valuenow`, in the same order as the figure
   * line. Null while the report announced no total.
   */
  fraction: string | null;
  /** Bytes moved, when the report announced a byte total. */
  bytes: { done: string; total: string } | null;
  /** Units the phase counted, when the report announced a unit total. */
  objects: { done: number; total: number } | null;
};

/**
 * A byte count a person can read. A sync reports the same value as a running
 * count and as a total, so unlike a catalog size this has no "unknown"
 * reading: a phase that has moved nothing has moved zero bytes.
 */
export function formatBytes(bytes: number): string {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** A report's own count, or 0 when the host sent nothing usable. */
function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function percentOf(done: number, total: number): number {
  return Math.min(100, Math.max(0, Math.round((done / total) * 100)));
}

/**
 * An announced byte total leads the reading, because one large object can
 * dominate a phase whose unit count already looks finished. Otherwise the unit
 * pair leads, and a report that announced neither stays indeterminate: the card
 * then reports activity instead of a fraction it would have to invent.
 */
export function configSyncProgressView(
  progress: ConfigSyncProgress,
): ConfigSyncProgressView {
  const bytesTotal = count(progress.bytesTotal);
  const bytesDone = count(progress.bytesDone);
  const unitTotal = count(progress.total);
  const unitDone = count(progress.done);

  const bytes =
    bytesTotal > 0
      ? { done: formatBytes(bytesDone), total: formatBytes(bytesTotal) }
      : null;
  const objects = unitTotal > 0 ? { done: unitDone, total: unitTotal } : null;
  const percent =
    bytesTotal > 0
      ? percentOf(bytesDone, bytesTotal)
      : unitTotal > 0
        ? percentOf(unitDone, unitTotal)
        : 0;

  return {
    phaseKey: CONFIG_SYNC_PHASE_KEYS[progress.phase],
    determinate: bytes !== null || objects !== null,
    percent,
    fraction: bytes
      ? `${bytes.done} / ${bytes.total}`
      : objects
        ? `${objects.done} / ${objects.total}`
        : null,
    bytes,
    objects,
  };
}

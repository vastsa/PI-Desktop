/**
 * Workspace index status types (`index.status`). These describe the index —
 * a rebuildable acceleration cache — and are deliberately independent of the
 * usage-facts surface, which ships separately.
 */

export type WorkspaceIndexRootStatus =
  | "fresh"
  | "building"
  | "stale"
  | "failed"
  | "partial"
  | "disabled"
  | "skipped_over_limit";

export type WorkspaceIndexRoot = {
  rootId: string;
  rootPath: string;
  status: WorkspaceIndexRootStatus;
  fileCount: number;
  indexedBytes: number;
  errorCount: number;
  lastError: string | null;
  updatedAt: number;
  /** Present while status is "building"; absent otherwise. */
  progress?: { filesDone: number; filesTotal: number };
  /** In-memory fast-path counters; not persisted. */
  metrics?: WorkspaceIndexMetrics;
};

export type WorkspaceIndexMetrics = {
  fastPathServed: number;
  fallbackCount: number;
  fallbackNotLiteral: number;
  fallbackStateGate: number;
  fallbackTooWide: number;
  fallbackVerifyFailed: number;
  candidateRatioAvg: number;
  p50Ms: number;
  p95Ms: number;
};

/**
 * Workspace index status types (`index.status`). These describe the index —
 * a rebuildable local cache.
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
};

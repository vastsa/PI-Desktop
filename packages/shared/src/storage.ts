/** Desktop-owned bootstrap storage preferences; never synchronized between devices. */
export type StorageInfo = {
  dataPath: string;
  browserPath: string;
  managed: boolean;
  cacheBytes: number;
  pendingPath: string | null;
  lastError: string | null;
  backupPaths: string[];
};

export type StorageProgress = {
  stage: "scanning" | "copying" | "verifying" | "relocating" | "cleaning" | "complete" | "failed";
  completedBytes: number;
  totalBytes: number;
  completedFiles: number;
  totalFiles: number;
};

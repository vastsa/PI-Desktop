/**
 * Public contracts for the Host-owned portable configuration synchronizer.
 *
 * These types intentionally contain status and redacted summaries only. Raw
 * WebDAV credentials, vault keys, backup passwords, and portable secret values
 * never cross the Host/Preload boundary.
 */

export const CONFIG_SYNC_CATEGORIES = [
  "application",
  "providers",
  "credentials",
  "mcp",
  "skills",
  "subagents",
  "instructions",
  "projects",
  "plugins",
  "automation",
  "memory",
] as const;

export type ConfigSyncCategory = (typeof CONFIG_SYNC_CATEGORIES)[number];

export type ConfigSyncStatus =
  | "notConfigured"
  | "locked"
  | "upToDate"
  | "localChangesPending"
  | "syncing"
  | "offline"
  | "unsupportedServer"
  | "conflict"
  | "awaitingActivation"
  | "paused"
  | "error";

export type ConfigSyncRemoteMode = "strict" | "appendOnly";

export type ConfigSyncCategorySelection = Record<ConfigSyncCategory, boolean>;

/**
 * The step a run is in. `capture` collects the local snapshot, `download` reads
 * the remote revision's resources, `merge` reconciles both, `upload` writes the
 * merged revision's resources, `apply` writes the result locally, and `cleanup`
 * deletes revisions the retention window no longer keeps.
 */
export type ConfigSyncPhase =
  | "capture"
  | "download"
  | "merge"
  | "upload"
  | "apply"
  | "cleanup";

/**
 * What a running sync is doing, reported while it runs.
 *
 * The sync is a single request, so without these the interface has nothing to
 * show between the click and the answer. `done`/`total` are that phase's units
 * — objects for `download`/`upload` (the device tips being read, in append-only
 * mode) and entities for `capture`/`merge`/`apply`, while `cleanup` reports the
 * phase without counting it — and `total === 0` means the size of the phase is
 * not known in advance. `bytesDone`/`bytesTotal` are a byte pair that only
 * `upload` reports in full — `download` reports `bytesDone` alone, because a
 * remote manifest names resources by id rather than by length — and
 * `bytesTotal === 0` means the byte count is not known.
 */
export type ConfigSyncProgress = {
  phase: ConfigSyncPhase;
  done: number;
  total: number;
  bytesDone: number;
  bytesTotal: number;
};
export type ConfigSyncPreferences = {
  endpoint: string;
  username: string;
  directory: string;
  deviceLabel: string;
  remoteMode?: ConfigSyncRemoteMode;
  categories: ConfigSyncCategorySelection;
  includeSecrets: boolean;
  includeMemory: boolean;
  automaticSync: boolean;
};

export type ConfigSyncPreview = {
  supported: number;
  excluded: number;
  secretBearing: number;
  mappingRequired: number;
  conflicts: number;
  pendingActivation: number;
  categories: Array<{
    category: ConfigSyncCategory;
    supported: number;
    excluded: number;
    secretBearing: number;
    mappingRequired: number;
  }>;
};

export type ConfigSyncPendingApproval = {
  id: string;
  domain: ConfigSyncCategory;
  entityId: string;
  label: string;
  reason: "newDevice" | "securityChange" | "dependency" | "mapping" | "conflict";
  digest: string;
  createdAt: string;
  mappingKey?: string;
};

export type ConfigSyncProjectMapping = {
  logicalId: string;
  path?: string;
  paths?: string[];
};

export type ConfigSyncHistoryEntry = {
  revisionId: string;
  createdAt: string;
  parentRevisionIds: string[];
  entityCount: number;
  resourceCount: number;
  current: boolean;
};

export type ConfigSyncState = {
  configured: boolean;
  enabled: boolean;
  paused: boolean;
  locked: boolean;
  status: ConfigSyncStatus;
  endpoint?: string;
  username?: string;
  directory?: string;
  deviceLabel?: string;
  remoteMode: ConfigSyncRemoteMode;
  categories: ConfigSyncCategorySelection;
  includeSecrets: boolean;
  includeMemory: boolean;
  automaticSync: boolean;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  lastRevisionId?: string;
  pendingApprovals: ConfigSyncPendingApproval[];
  mappings: ConfigSyncProjectMapping[];
  preview?: ConfigSyncPreview;
};

export type ConfigSyncConfigureInput = {
  endpoint: string;
  username: string;
  /** Supplied only when changing the WebDAV credential. */
  appPassword?: string;
  directory: string;
  deviceLabel: string;
  /** Required when creating or unlocking the encrypted vault. */
  backupPassword: string;
  remoteMode?: ConfigSyncRemoteMode;
  categories?: Partial<ConfigSyncCategorySelection>;
  includeSecrets?: boolean;
  includeMemory?: boolean;
  automaticSync?: boolean;
};

export type ConfigSyncApprovalInput = {
  approvalId: string;
  digest: string;
};

export type ConfigSyncMapProjectInput = {
  logicalId: string;
  path?: string;
  paths?: string[];
};

export type ConfigSyncChangePasswordInput = {
  currentPassword: string;
  newPassword: string;
};

export type ConfigSyncRestoreInput = {
  revisionId: string;
  acknowledgePropagation: boolean;
};

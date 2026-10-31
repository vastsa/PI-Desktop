/**
 * Public contracts for the Host-owned portable configuration synchronizer.
 *
 * Responses contain redacted status only. S3 secrets and backup passwords are
 * accepted as transient inputs; vault keys and portable secret values are
 * never returned to the renderer.
 */

export const CONFIG_SYNC_CATEGORIES = [
  "application",
  "providers",
  "credentials",
  "mcp",
  "skills",
  "subagents",
  "instructions",
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

export type ConfigSyncMode = "sync" | "backup";

export type ConfigSyncCategorySelection = Record<ConfigSyncCategory, boolean>;

/**
 * The step a run is in. `capture` collects the local snapshot, `download` reads
 * the remote revision's resources, `merge` reconciles both, `upload` writes the
 * merged revision's resources, and `apply` writes the result locally.
 * Immutable remote objects are retained; there is no physical cleanup phase.
 */
export type ConfigSyncPhase =
  | "capture"
  | "download"
  | "merge"
  | "upload"
  | "apply";

/**
 * What a running sync is doing, reported while it runs.
 *
 * The sync is a single request, so without these the interface has nothing to
 * show between the click and the answer. `done`/`total` are that phase's units
 * — objects for `download`/`upload` and entities for `capture`/`merge`/`apply`.
 * `total === 0` means the size of the phase is not known in advance.
 * `bytesDone`/`bytesTotal` are a byte pair that only
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
export type ConfigSyncConnection = {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  pathStyle: boolean;
};

export type ConfigSyncPreferences = ConfigSyncConnection & {
  deviceLabel: string;
  mode: ConfigSyncMode;
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
  region?: string;
  bucket?: string;
  prefix?: string;
  accessKeyId?: string;
  pathStyle: boolean;
  deviceLabel?: string;
  mode: ConfigSyncMode;
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
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  /** Omitted fields reuse saved credentials only for the same connection. */
  secretAccessKey?: string;
  /** Empty string explicitly clears a saved session token. */
  sessionToken?: string;
  pathStyle?: boolean;
  deviceLabel: string;
  /** Required when creating or unlocking the encrypted vault. */
  backupPassword: string;
  mode?: ConfigSyncMode;
  categories?: Partial<ConfigSyncCategorySelection>;
  includeSecrets?: boolean;
  includeMemory?: boolean;
  automaticSync?: boolean;
};

export type ConfigSyncTestInput = Omit<ConfigSyncConfigureInput, "backupPassword">;
export type ConfigSyncTestResult = { ok: true; conditionalWrites: true };

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

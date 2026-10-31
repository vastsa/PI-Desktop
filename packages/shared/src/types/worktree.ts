/**
 * Isolated sessions in git worktrees (ADR 0329). Host-core owns every
 * worktree path and git command; these shapes carry no filesystem path.
 */

export type WorktreeStatus = "creating" | "active" | "conflict" | "merged" | "missing";

export type WorktreeSetupStatus = "none" | "running" | "ok" | "failed";

/** Badge data attached to `SessionSummary.worktree` for isolated sessions. */
export type SessionWorktreeSummary = {
  branch: string;
  status: WorktreeStatus;
  setupStatus?: WorktreeSetupStatus | null;
};

/** Machine-readable `errorCode` values of `worktree.*` and isolated sessions. */
export const WorktreeErrorCodes = {
  GIT_MISSING: "WORKTREE_GIT_MISSING",
  GIT_TOO_OLD: "WORKTREE_GIT_TOO_OLD",
  GIT_FAILED: "WORKTREE_GIT_FAILED",
  GIT_TIMEOUT: "WORKTREE_GIT_TIMEOUT",
  NOT_GIT: "WORKTREE_NOT_GIT",
  NO_COMMITS: "WORKTREE_NO_COMMITS",
  DETACHED_HEAD: "WORKTREE_DETACHED_HEAD",
  BRANCH_NAMESPACE_TAKEN: "WORKTREE_BRANCH_NAMESPACE_TAKEN",
  NOT_ISOLATED: "WORKTREE_NOT_ISOLATED",
  NOT_READY: "WORKTREE_NOT_READY",
  MISSING: "WORKTREE_MISSING",
  BUSY: "WORKTREE_BUSY",
  CONFLICT: "WORKTREE_CONFLICT",
  CHANGED_SINCE_PREVIEW: "WORKTREE_CHANGED_SINCE_PREVIEW",
  OWNER_BRANCH_CHANGED: "WORKTREE_OWNER_BRANCH_CHANGED",
  /** The session's (or subagent's) worktree no longer has its own branch checked out. */
  SESSION_BRANCH_CHANGED: "WORKTREE_SESSION_BRANCH_CHANGED",
  PROJECT_DIRTY: "WORKTREE_PROJECT_DIRTY",
  MERGE_FAILED: "WORKTREE_MERGE_FAILED",
  COMMIT_FAILED: "WORKTREE_COMMIT_FAILED",
  MOVE_UNSUPPORTED: "WORKTREE_MOVE_UNSUPPORTED",
  PATH_EXISTS: "WORKTREE_PATH_EXISTS",
  /** The project lives on a remote host; isolation needs a local checkout. */
  REMOTE_UNSUPPORTED: "WORKTREE_REMOTE_UNSUPPORTED",
} as const;

export type WorktreeErrorCode = (typeof WorktreeErrorCodes)[keyof typeof WorktreeErrorCodes];

/** `worktree.probe`: whether a project can host isolated sessions. */
export type WorktreeProbeResult =
  | { available: true; uncommittedChanges: boolean }
  | { available: false; errorCode: WorktreeErrorCode | string; message: string };

export type WorktreeIncludeReport = {
  copied: string[];
  skippedLinks: string[];
};

/** Extra result of `session.create` with `isolated: true`. */
export type CreatedSessionWorktree = {
  worktree: SessionWorktreeSummary;
  included: WorktreeIncludeReport;
  projectHadUncommittedChanges: boolean;
};

export type WorktreePreviewCommit = { sha: string; subject: string };

export type WorktreePreviewFile = {
  /** `A`, `M`, `D`, ... for committed changes; `?` for untracked files. */
  status: string;
  path: string;
  /** Committed on the session branch when the merge runs. */
  uncommitted: boolean;
};

/** `worktree.preview`: what "Merge into project" would land. */
export type WorktreeMergePreview = {
  branch: string;
  ownerBranch: string;
  commits: WorktreePreviewCommit[];
  files: WorktreePreviewFile[];
  conflict: boolean;
  previewToken: string;
};

export type WorktreeMergeOutcome =
  | { result: "merged"; commits: number; files: number }
  | { result: "nothingToMerge" };

/** `worktree.sync`: "Sync from project" brings the project's new commits in. */
export type WorktreeSyncOutcome =
  | { result: "synced"; commits: number }
  | { result: "upToDate" };

/** `worktree.behindAll`: the sidebar's behind counts, keyed by session id. */
export type WorktreeBehindCounts = {
  counts: Record<string, number>;
  /** A conflict was found resolved; the session list should be refreshed. */
  statusesChanged: boolean;
};

/** `worktree.pendingWork`: what deleting the session would lose. */
export type WorktreePendingWork = {
  unmergedCommits: number;
  uncommittedChanges: boolean;
};

export type WorktreeSetupLog = {
  setupStatus: WorktreeSetupStatus | null;
  log: string | null;
};

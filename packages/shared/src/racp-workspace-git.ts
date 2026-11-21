/**
 * RACP `workspaceGit` capability contract (D687, decision record
 * `remote-git-workspaces`).
 *
 * An owner-only family of remote-host operations: a paired Host clones a
 * GitHub repository once, gives each desktop session its own git worktree and
 * work branch, and pushes that branch. The names here are consumed by several
 * modules and must not drift.
 *
 * This module is imported by the renderer through `@pi-desktop/shared`, so it
 * must stay free of Node-only imports. The work-branch derivation needs
 * SHA-256 and therefore lives in `pi-host` and host-core, not here.
 */
import Type from "typebox";

type Static<T extends Type.TSchema> = Type.Static<T>;

// ---------------------------------------------------------------------------
// Name rules
// ---------------------------------------------------------------------------
//
// Each rule is one pattern. The validator and the request schema share it, so
// a name that passes `Value.Check` also passes the validator and the two can
// never disagree. Host-core re-implements the same rules in Rust
// (`workspace_git::layout`) with the same accept and reject tables.

/**
 * 1 to 39 characters of `[A-Za-z0-9_-]`, not starting or ending with `-`.
 * The underscore is what Enterprise Managed User logins carry (`mona_acme`).
 */
const GITHUB_OWNER_PATTERN = "^[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,37}[A-Za-z0-9_])?$";

/** 1 to 100 characters of `[A-Za-z0-9._-]`, not `.` or `..`, not ending in `.git`. */
const GITHUB_REPOSITORY_NAME_PATTERN = "^(?!\\.{1,2}$)(?!.*\\.git$)[A-Za-z0-9._-]{1,100}$";

/**
 * git's reference-name rules rather than an allowlist, because GitHub lists
 * branches such as `fix/#123`, `release=1.0`, and non-ASCII names. 1 to 244
 * characters (code points). Refused: ASCII control characters, DEL, and the
 * space; any of `~ ^ : ? * [ \`; a leading `-` or `/`; a trailing `/`, `.`,
 * or `.lock`; any of `..`, `//`, `@{`, `/.`; and the single name `@`.
 * Everything else is accepted.
 *
 * This is safe because a branch name only ever reaches git as an operand
 * after `--` or inside a full reference name, never through a shell, and
 * never becomes part of a directory name.
 *
 * The class also excludes a lone UTF-16 surrogate, which is not a character
 * and cannot be carried to the Host as JSON.
 */
const GIT_BRANCH_NAME_PATTERN =
  "^(?![-/])(?!@$)(?![\\s\\S]*(?:\\.\\.|//|@\\{|/\\.))(?![\\s\\S]*(?:/|\\.|\\.lock)$)"
  + "[^\\u0000-\\u0020\\u007f~^:?*\\[\\\\\\ud800-\\udfff]{1,244}$";

const FORBIDDEN_VARIABLE_NAMES = [
  "PATH", "HOME", "SHELL", "USER", "LOGNAME", "PWD", "OLDPWD", "IFS", "ENV", "BASH_ENV",
  "PROMPT_COMMAND", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE",
] as const;
const FORBIDDEN_VARIABLE_PREFIXES = ["GIT_", "PI_", "LD_", "DYLD_", "BASH_FUNC_"] as const;

/**
 * `[A-Za-z_][A-Za-z0-9_]{0,127}`, minus the names and prefixes that would
 * redirect git, the shell loader, the dynamic linker, or the tool runner.
 */
const ENVIRONMENT_VARIABLE_NAME_PATTERN =
  `^(?!(?:${FORBIDDEN_VARIABLE_NAMES.join("|")})$)(?!${FORBIDDEN_VARIABLE_PREFIXES.join("|")})[A-Za-z_][A-Za-z0-9_]{0,127}$`;

const INSTALLATION_ID_PATTERN = "^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$";

/** No C0 or C1 control character, so the value can never split a header. */
const TOKEN_PATTERN = "^[^\\u0000-\\u001f\\u007f-\\u009f]+$";

const GITHUB_OWNER = new RegExp(GITHUB_OWNER_PATTERN, "u");
const GITHUB_REPOSITORY_NAME = new RegExp(GITHUB_REPOSITORY_NAME_PATTERN, "u");
const GIT_BRANCH_NAME = new RegExp(GIT_BRANCH_NAME_PATTERN, "u");
const ENVIRONMENT_VARIABLE_NAME = new RegExp(ENVIRONMENT_VARIABLE_NAME_PATTERN, "u");

export function isGitHubOwner(value: string): boolean {
  return typeof value === "string" && GITHUB_OWNER.test(value);
}

export function isGitHubRepositoryName(value: string): boolean {
  return typeof value === "string" && GITHUB_REPOSITORY_NAME.test(value);
}

export function isGitBranchName(value: string): boolean {
  return typeof value === "string" && GIT_BRANCH_NAME.test(value);
}

export function isEnvironmentVariableName(value: string): boolean {
  return typeof value === "string" && ENVIRONMENT_VARIABLE_NAME.test(value);
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const WORKSPACE_GIT_MAX_VARIABLES = 64;
export const WORKSPACE_GIT_MAX_VARIABLE_VALUE_LENGTH = 8192;
export const WORKSPACE_GIT_MAX_SETUP_SCRIPT_LENGTH = 65_536;

// ---------------------------------------------------------------------------
// Request schemas (closed objects)
// ---------------------------------------------------------------------------

const InstallationId = () => Type.String({ pattern: INSTALLATION_ID_PATTERN });
const SessionId = () => Type.String({ minLength: 1, maxLength: 256 });

export const WorkspaceGitRepositorySchema = Type.Object({
  owner: Type.String({ pattern: GITHUB_OWNER_PATTERN }),
  name: Type.String({ pattern: GITHUB_REPOSITORY_NAME_PATTERN }),
}, { additionalProperties: false });
export type WorkspaceGitRepository = Static<typeof WorkspaceGitRepositorySchema>;

/** Plain configuration for a worktree's tools and setup script; not for secrets. */
export const WorkspaceGitEnvironmentSchema = Type.Object({
  variables: Type.Array(
    Type.Object({
      name: Type.String({ pattern: ENVIRONMENT_VARIABLE_NAME_PATTERN }),
      value: Type.String({ maxLength: WORKSPACE_GIT_MAX_VARIABLE_VALUE_LENGTH }),
    }, { additionalProperties: false }),
    { maxItems: WORKSPACE_GIT_MAX_VARIABLES },
  ),
  setupScript: Type.Optional(Type.String({ maxLength: WORKSPACE_GIT_MAX_SETUP_SCRIPT_LENGTH })),
}, { additionalProperties: false });
export type WorkspaceGitEnvironment = Static<typeof WorkspaceGitEnvironmentSchema>;

/** The GitHub token for this connection. The Host holds it in memory only. */
export const WorkspaceGitCredentialSetSchema = Type.Object({
  installationId: InstallationId(),
  token: Type.String({ minLength: 1, maxLength: 4096, pattern: TOKEN_PATTERN }),
}, { additionalProperties: false });
export type WorkspaceGitCredentialSet = Static<typeof WorkspaceGitCredentialSetSchema>;

export const WorkspaceGitCredentialClearSchema = Type.Object({}, { additionalProperties: false });

export const WorkspaceGitRepositoryRequestSchema = Type.Object({
  repository: WorkspaceGitRepositorySchema,
}, { additionalProperties: false });
export type WorkspaceGitRepositoryRequest = Static<typeof WorkspaceGitRepositoryRequestSchema>;

export const WorkspaceGitPrepareSchema = Type.Object({
  installationId: InstallationId(),
  sessionId: SessionId(),
  repository: WorkspaceGitRepositorySchema,
  baseBranch: Type.String({ pattern: GIT_BRANCH_NAME_PATTERN }),
  /**
   * Start the worktree at the current head of this session's work branch (same
   * installation, same repository) instead of the remote base branch. It is
   * how a forked session starts from its parent's commits.
   */
  fromSessionId: Type.Optional(SessionId()),
  /** Restore an existing registration without creating a new checkout from the base. */
  restoreOnly: Type.Optional(Type.Boolean()),
  /** Re-run the environment's setup script on an existing worktree without recreating it. */
  rerunSetup: Type.Optional(Type.Boolean()),
  environment: Type.Optional(WorkspaceGitEnvironmentSchema),
}, { additionalProperties: false });
export type WorkspaceGitPrepare = Static<typeof WorkspaceGitPrepareSchema>;

/** `{ installationId, sessionId }`; used by push and status. */
export const WorkspaceGitSessionRefSchema = Type.Object({
  installationId: InstallationId(),
  sessionId: SessionId(),
}, { additionalProperties: false });
export type WorkspaceGitSessionRef = Static<typeof WorkspaceGitSessionRefSchema>;

export const WorkspaceGitRemoveSchema = Type.Object({
  installationId: InstallationId(),
  sessionId: SessionId(),
  force: Type.Boolean(),
}, { additionalProperties: false });
export type WorkspaceGitRemove = Static<typeof WorkspaceGitRemoveSchema>;

export const WorkspaceGitJobRefSchema = Type.Object({
  jobId: Type.String({ minLength: 1, maxLength: 64 }),
}, { additionalProperties: false });
export type WorkspaceGitJobRef = Static<typeof WorkspaceGitJobRefSchema>;

export const WorkspaceGitListSchema = Type.Object({
  installationId: InstallationId(),
}, { additionalProperties: false });
export type WorkspaceGitList = Static<typeof WorkspaceGitListSchema>;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export const WORKSPACE_GIT_SETUP_STATUSES = ["none", "running", "ok", "failed"] as const;
export type WorkspaceGitSetupStatus = (typeof WORKSPACE_GIT_SETUP_STATUSES)[number];

export type WorkspaceGitWorktree = {
  sessionId: string;
  repository: WorkspaceGitRepository;
  baseBranch: string;
  /** `pi-desktop/<id>`; `<id>` is also the worktree directory name. */
  workBranch: string;
  path: string;
  /** Absent on older hosts that do not report checkout presence. */
  checkoutPresent?: boolean;
  /** The repository's main checkout, never edited by sessions. */
  mainPath: string;
  baseCommit: string;
  createdAt: string;
  setup: { status: WorkspaceGitSetupStatus; logTail?: string };
};

export const WORKSPACE_GIT_JOB_KINDS = ["prepare", "push"] as const;
export type WorkspaceGitJobKind = (typeof WORKSPACE_GIT_JOB_KINDS)[number];

export const WORKSPACE_GIT_JOB_STATES = ["running", "succeeded", "failed", "cancelled"] as const;
export type WorkspaceGitJobState = (typeof WORKSPACE_GIT_JOB_STATES)[number];

export const WORKSPACE_GIT_JOB_PHASES = [
  "queued", "cloning", "fetching", "creatingWorktree", "runningSetup", "pushing", "done",
] as const;
export type WorkspaceGitJobPhase = (typeof WORKSPACE_GIT_JOB_PHASES)[number];

/** Long git work is a job the client polls; no request waits on git. */
export type WorkspaceGitJob = {
  jobId: string;
  kind: WorkspaceGitJobKind;
  state: WorkspaceGitJobState;
  phase: WorkspaceGitJobPhase;
  progress?: { percent?: number; detail?: string };
  /** Bounded tail of live setup script output while `phase === "runningSetup"`. */
  setupLogTail?: string;
  /** Prepare, on success. */
  worktree?: WorkspaceGitWorktree;
  /** Push, on success. */
  pushed?: { branch: string; remoteHead: string };
  error?: { code: string; message: string };
};

export type WorkspaceGitStatus = {
  worktree: WorkspaceGitWorktree;
  /** Added by hosts that can compare the work branch against its base. */
  aheadOfBase?: number;
  ahead: number;
  behind: number;
  uncommittedFiles: number;
  unpushedCommits: number;
  pushedOnce: boolean;
};

/** `removed: false` carries the counts that made the Host refuse without `force`. */
export type WorkspaceGitRemoveResult = { removed: boolean; uncommittedFiles: number; unpushedCommits: number };

/** Prefix of every session work branch. */
export const WORKSPACE_GIT_WORK_BRANCH_PREFIX = "pi-desktop/" as const;

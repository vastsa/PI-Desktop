import type { WorkspaceGitEnvironment, WorkspaceGitJob, WorkspaceGitRepository, WorkspaceGitWorktree } from "../racp-workspace-git";

export type RemoteEnvironmentInput = {
  id?: string;
  name: string;
  hostKey: string;
  setupScript?: string;
  variables?: WorkspaceGitEnvironment["variables"];
};

export type RemoteEnvironment = {
  id: string;
  name: string;
  hostKey: string;
  setupScript: string;
  variables: WorkspaceGitEnvironment["variables"];
  isDefault: boolean;
};

export type RepositoryProject = WorkspaceGitRepository & { defaultBranch: string; hostKey: string };

export type SessionRemoteRepository = {
  environmentId: string;
  hostKey: string;
  hostLabel?: string;
  repository: WorkspaceGitRepository;
  baseBranch: string;
  workBranch?: string;
  state: "preparing" | "ready" | "failed" | "removing";
  phase?: WorkspaceGitJob["phase"];
  progress?: WorkspaceGitJob["progress"];
  error?: NonNullable<WorkspaceGitJob["error"]>;
  setup?: WorkspaceGitWorktree["setup"];
  pullRequest?: { number: number; url: string };
};

export type RemoteSessionTarget = {
  environmentId: string;
  repository: WorkspaceGitRepository;
  defaultBranch: string;
};

export type RemoteSessionWorkspaceStart = {
  sessionId: string;
  environmentId: string;
  repository: WorkspaceGitRepository;
  baseBranch: string;
};

export type RemoteSessionGitStatus = {
  reachable: boolean;
  workBranch: string;
  baseBranch: string;
  ahead?: number;
  aheadOfBase?: number;
  behind?: number;
  uncommittedFiles?: number;
  unpushedCommits?: number;
  pushedOnce?: boolean;
};

export type RemoteSessionDeletePreflight =
  | { kind: "none" | "clean" | "unknown" }
  | { kind: "atRisk"; uncommittedFiles: number; unpushedCommits: number };

export type LeftoverWorktree = {
  hostKey: string;
  sessionId: string;
  repository: WorkspaceGitRepository;
  workBranch: string;
  path: string;
  createdAt: string;
  uncommittedFiles: number;
  unpushedCommits: number;
};

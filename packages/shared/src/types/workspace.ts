import type { ProjectMemory } from "./filesystem.js";

/** Shared public types grouped by the owning application domain. */
export type AppNotificationKind = "task.completed" | "task.failed";

export type AppNotification = {
  id: string;
  kind: AppNotificationKind;
  sessionId: string;
  sessionTitle: string;
  turnId: string;
  errorCode?: string;
  createdAt: string;
  readAt?: string | null;
};

export type NotificationListResult = {
  notifications: AppNotification[];
  unreadCount: number;
};

export type ProjectWorkspace = {
  path: string;
  name: string;
  /** Best-effort git branch from .git/HEAD when available. */
  branch?: string;
};

export type ProjectRecord = {
  id: number;
  path: string;
  name: string;
  pinned: boolean;
  createdAt: number;
  lastOpenedAt: number;
};

export type ProjectGroupRoot = {
  path: string;
  name: string;
  position: number;
};

export type ProjectGroupRecord = {
  id: string;
  name: string;
  primaryPath: string;
  roots: ProjectGroupRoot[];
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  lastOpenedAt: number;
  /** True for a compatibility projection of an old single-folder project. */
  legacy?: boolean;
  /** Previously removed roots remain suppressed from legacy projections. */
  detachedPaths?: string[];
};

export type ProjectGroupContext = {
  groupId: string;
  roots: ProjectGroupRoot[];
  instructions: string;
  memory: ProjectMemory;
};

export type PullRequestSummary = {
  number: number;
  title: string;
  url: string;
  author?: string;
  headRefName?: string;
  baseRefName?: string;
  updatedAt?: string;
  isDraft?: boolean;
};

/**
 * `authKind` for a provider row whose credential is a vendor-account OAuth
 * login rather than a pasted API key. Shared so main, the sidecar runtime and
 * the renderer all branch on the same spelling.
 */

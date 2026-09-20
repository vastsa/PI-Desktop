import type { Principal, SessionSummary } from "@pi-desktop/agent-host";
import type {
  FsEntry,
  FsReadResult,
  RacpProjectSummary,
  WorkspaceDiff,
} from "@pi-desktop/shared";

/**
 * Everything the RACP server delegates to the Host besides the Agent Host
 * module: session catalog mutations, projects, workspace reads, terminals.
 * `pi-host` implements these on host-core and its filesystem; a test hands
 * the server fakes. The server itself never touches host-core RPC, a
 * filesystem, or a pty, so the boundary of security §7 holds by construction.
 */
export type SessionCreateInput = {
  title?: string;
  projectId?: string;
  mode?: "agent" | "plan" | "goal";
  providerId?: string;
  modelId?: string;
  thinkingLevel?: string;
  permissionMode?: "ask" | "accept-edits" | "auto";
};

export type SessionConfigureInput = {
  mode?: "agent" | "plan" | "goal";
  providerId?: string;
  modelId?: string;
  thinkingLevel?: string;
  permissionMode?: "ask" | "accept-edits" | "auto";
};

export interface RacpSessionCatalog {
  list(): Promise<SessionSummary[]>;
  create(input: SessionCreateInput, principal: Principal): Promise<SessionSummary>;
  configure(sessionId: string, input: SessionConfigureInput): Promise<SessionSummary>;
  fork(sessionId: string, input: { title?: string; throughMessageId?: string }): Promise<SessionSummary>;
  rename(sessionId: string, title: string): Promise<void>;
  delete(sessionId: string): Promise<void>;
  compact(sessionId: string): Promise<{ accepted: boolean }>;
}

export type ProjectBrowseEntry = { name: string; path: string };

export interface RacpProjectCatalog {
  list(): Promise<RacpProjectSummary[]>;
  /** Canonicalize and validate a Host directory, register it, return its id. */
  register(path: string): Promise<RacpProjectSummary & { path: string }>;
  /** Directories under `path` (or the user's home when omitted), bounded. */
  browse(path?: string): Promise<{ path: string; parent?: string; entries: ProjectBrowseEntry[] }>;
}

export interface RacpWorkspaceAccess {
  list(sessionId: string, path: string): Promise<{ entries: FsEntry[] }>;
  read(sessionId: string, path: string): Promise<FsReadResult>;
  diff(sessionId: string): Promise<WorkspaceDiff>;
}

export type TerminalOpenResult = {
  terminalId: string;
  /** Bounded replay ring, base64 (spec §6.2). */
  replay: string;
  cols: number;
  rows: number;
};

export interface RacpTerminalAccess {
  open(
    sessionId: string,
    options: { cols: number; rows: number },
    sink: { output: (data: string) => void; exit: (code: number | null) => void },
  ): Promise<TerminalOpenResult>;
  input(terminalId: string, data: string): Promise<void>;
  resize(terminalId: string, cols: number, rows: number): Promise<void>;
  close(terminalId: string): Promise<void>;
  /** Re-attach a subscriber after a reconnect; returns the replay ring. */
  attach(terminalId: string, sink: { output: (data: string) => void; exit: (code: number | null) => void }): Promise<TerminalOpenResult | null>;
  detach(terminalId: string): void;
}

export type RacpHostOperations = {
  sessions: RacpSessionCatalog;
  projects: RacpProjectCatalog;
  workspace: RacpWorkspaceAccess;
  terminal?: RacpTerminalAccess;
  /** Owner-only: revoke a paired device (spec `session/revoke`). */
  revokeDevice?: (deviceId: string) => Promise<boolean>;
};

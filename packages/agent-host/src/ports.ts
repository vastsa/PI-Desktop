import type {
  AgentPromptAttachment,
  AskToolResolution,
  RacpItemSummary,
  RacpPermissionMode,
  RacpPlanningState,
  RacpRole,
} from "@pi-desktop/shared";

/** Who is calling. The local desktop uses an `owner` principal with `pairedDevice`. */
export type Principal = {
  subject: string;
  roles: RacpRole[];
  /** The SSH-paired desktop device, exempt from the remote ceiling by default. */
  pairedDevice?: boolean;
  /** Set when Host policy lets approvers use the session's own mode. */
  approverOverride?: boolean;
  connectionId?: string;
};

export interface Clock {
  now(): number;
}

export interface IdSource {
  next(prefix: string): string;
}

/** Rust host-core over the existing stdio JSON-RPC, as seen from the module. */
export interface HostRpcPort {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

export type TurnStartRequest = {
  sessionId: string;
  content: string;
  attachments?: AgentPromptAttachment[];
  effectivePermissionMode: RacpPermissionMode;
  idempotencyKey?: string;
  principal: Principal;
};

/** The pi runtime as the module drives it. Electron Main adapts its prompt,
 * stop, abort, and asktool paths to this port; nothing here knows about IPC. */
export interface RuntimePort {
  prompt(request: TurnStartRequest): Promise<{ turnId: string }>;
  stop(sessionId: string): Promise<{ requested: boolean }>;
  abort(sessionId: string, turnId?: string): Promise<void>;
  respondInput(resolution: AskToolResolution): Promise<void>;
  /** Runtime-side busy state the event stream cannot see, e.g. a manual
   * compaction; a busy session queues instead of starting. */
  isBusy?(sessionId: string): boolean;
}

export type QueuedTurnRecord = {
  id: string;
  sessionId: string;
  principalSubject: string;
  content: string;
  attachments?: AgentPromptAttachment[];
  effectivePermissionMode: RacpPermissionMode;
  idempotencyKey?: string;
  /** Stable hash of the input, so a reused key with different input is a conflict. */
  inputHash: string;
  createdAt: number;
};

/** Durable queue storage. The first implementation is in memory; host-core
 * persists the same records under its own ADR (D375). */
export interface QueueStore {
  listAll(): Promise<QueuedTurnRecord[]>;
  push(record: QueuedTurnRecord): Promise<void>;
  remove(id: string): Promise<boolean>;
  /** Move one entry to the head of its session ("send now"). */
  prioritize?(id: string): Promise<void>;
}

export type SessionSummary = {
  id: string;
  title: string;
  projectId?: string;
  workspaceLabel?: string;
  mode: "agent" | "plan" | "goal";
  permissionMode: RacpPermissionMode;
  planningState?: RacpPlanningState;
  createdAt: string;
  updatedAt: string;
};

/** Session metadata and transcript pages, adapted from host `session.get`. */
export interface SessionPort {
  get(sessionId: string): Promise<SessionSummary | null>;
  history(
    sessionId: string,
    options: { limit: number; beforeItemId?: string },
  ): Promise<{ items: RacpItemSummary[]; hasMore: boolean }>;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

export class RandomIds implements IdSource {
  next(prefix: string): string {
    const random = Math.random().toString(36).slice(2, 12);
    return `${prefix}_${Date.now().toString(36)}${random}`;
  }
}

export class MemoryQueueStore implements QueueStore {
  private readonly records = new Map<string, QueuedTurnRecord>();

  async listAll(): Promise<QueuedTurnRecord[]> {
    return [...this.records.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  async push(record: QueuedTurnRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  async remove(id: string): Promise<boolean> {
    return this.records.delete(id);
  }
}

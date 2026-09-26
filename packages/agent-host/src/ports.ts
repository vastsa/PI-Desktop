import type {
  AgentPromptAttachment,
  AskToolResolution,
  RacpItemSummary,
  RacpPermissionMode,
  RacpPlanningState,
  RacpRole,
  RacpRelayTool,
  RacpToolCancelParams,
  RacpToolExecuteParams,
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
  sessionMessageId?: string;
  /** Client-chosen id for the durable user row (D288); the runtime mints one otherwise. */
  userMessageId?: string;
  attachments?: AgentPromptAttachment[];
  effectivePermissionMode: RacpPermissionMode;
  /** Host-computed per-turn ceiling; absent for principals exempt by policy. */
  permissionCeiling?: RacpPermissionMode;
  idempotencyKey?: string;
  principal: Principal;
};

/**
 * One more user message for a turn that is already running (`send now` keeps
 * promoted messages adjacent, ADR 0265).
 */
export type TurnSteerRequest = {
  sessionId: string;
  /** The runtime id of the running turn that must receive the input. */
  turnId: string;
  content: string;
  sessionMessageId?: string;
  attachments?: AgentPromptAttachment[];
  principal: Principal;
};

/** The pi runtime as the module drives it. Electron Main adapts its prompt,
 * stop, abort, and asktool paths to this port; nothing here knows about IPC. */
export interface RuntimePort {
  /** Inject one more user message into a running turn. Optional: a runtime that
   * cannot steer delivers a promoted block as consecutive turns instead. */
  steer?(request: TurnSteerRequest): Promise<{ accepted: boolean }>;
  prompt(request: TurnStartRequest): Promise<{ turnId: string }>;
  stop(sessionId: string): Promise<{ requested: boolean }>;
  abort(sessionId: string, turnId?: string): Promise<void>;
  respondInput(resolution: AskToolResolution): Promise<void>;
  /** Runtime-side busy state the event stream cannot see, e.g. a manual
   * compaction; a busy session queues instead of starting. */
  isBusy?(sessionId: string): boolean;
}

export type ToolRelayCatalogSnapshot = {
  id: string;
  tools: RacpRelayTool[];
};

export type ToolRelayExecutionResult = {
  ok: boolean;
  content: unknown;
  errorCode?: string;
};

/** Host-owned boundary for tools that execute on one connected owner device. */
export interface ToolRelayPort {
  advertise(input: {
    connectionId: string;
    sessionId: string;
    tools: RacpRelayTool[];
    request: (method: string, params: unknown, timeoutMs: number) => Promise<unknown>;
    /** Optional capability-negotiated cancellation for one in-flight call. */
    cancel?: (params: RacpToolCancelParams) => Promise<unknown>;
  }): void;
  clearConnection(connectionId: string): void;
  captureCatalog(sessionId: string): ToolRelayCatalogSnapshot;
  bindTurn(catalogId: string, sessionId: string, turnId: string): void;
  releaseCatalog(catalogId: string): void;
  releaseTurn(sessionId: string, turnId: string): void;
  execute(input: RacpToolExecuteParams): Promise<ToolRelayExecutionResult>;
}

export type QueuedTurnRecord = {
  id: string;
  sessionId: string;
  principalSubject: string;
  content: string;
  sessionMessageId?: string;
  /** Client-chosen id for the durable user row (D288). */
  userMessageId?: string;
  attachments?: AgentPromptAttachment[];
  effectivePermissionMode: RacpPermissionMode;
  /** Preserved across queue restore so the turn starts under its admitted ceiling. */
  permissionCeiling?: RacpPermissionMode;
  idempotencyKey?: string;
  /** Stable hash of the input, so a reused key with different input is a conflict. */
  inputHash: string;
  /** Set only for promoted entries; the delivery order puts them first, in
   * ascending priority (click order), then the rest in arrival order. */
  priority?: number;
  createdAt: number;
};

/** Direction of one queue reorder step. */
export type QueueReorderDirection = "up" | "down";

/** Durable queue storage. The first implementation is in memory; host-core
 * persists the same records under its own ADR (D375). */
export interface QueueStore {
  listAll(): Promise<QueuedTurnRecord[]>;
  push(record: QueuedTurnRecord): Promise<void>;
  remove(id: string): Promise<boolean>;
  /** Promote one entry to the end of its session's priority block ("send now"). */
  prioritize?(id: string): Promise<void>;
  /** Swap one entry with its adjacent non-prioritized neighbour; `false` when
   * nothing moved. */
  reorder?(id: string, direction: QueueReorderDirection): Promise<boolean>;
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

  /** Delivery order: promoted entries first in click order, then by arrival. */
  async listAll(): Promise<QueuedTurnRecord[]> {
    const records = [...this.records.values()];
    const promoted = records
      .filter((record): record is QueuedTurnRecord & { priority: number } => record.priority !== undefined)
      .sort((a, b) => a.priority - b.priority);
    const rest = records
      .filter((record) => record.priority === undefined)
      .sort((a, b) => a.createdAt - b.createdAt);
    return [...promoted, ...rest];
  }

  async push(record: QueuedTurnRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  async remove(id: string): Promise<boolean> {
    return this.records.delete(id);
  }
}

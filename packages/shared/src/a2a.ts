/**
 * A2A (Agent2Agent) protocol types shared across the renderer, Electron main,
 * the Node agent-runtime sidecar, and the Rust host-core broker (ADR 0146).
 *
 * This module is the **wire contract**. Every field here has an exact mirror
 * in `crates/host-core/src/a2a/types.rs`; the two are hand-mirrored, following
 * the repository's existing protocol convention (there is no codegen). A change
 * here that is not reflected there breaks the broker, and vice versa.
 *
 * The shapes track the public A2A specification (Agent Card, Task, Message,
 * Part, TaskState, streaming update events) so a delegate reasons in real A2A
 * terms. The transport is the repository's own stdio JSON-RPC/NDJSON — the same
 * pipe `plans.*` uses — not HTTP or gRPC. Streaming maps to host→client
 * JSON-RPC notifications, push maps to a host-owned subscription plus a
 * notification, and auth maps to a host-minted capability token. See ADR 0146
 * for why a local substrate hosts the full A2A semantics rather than a network
 * binding.
 */

/**
 * Task lifecycle states (A2A `TaskState`). `submitted` → `working` is the
 * normal path; `input-required`/`auth-required` are interactive pauses;
 * `completed`/`canceled`/`failed`/`rejected` are terminal. The broker enforces
 * the legal transitions — a terminal task never moves again.
 */
export const A2A_TASK_STATES = [
  "submitted",
  "working",
  "input-required",
  "auth-required",
  "completed",
  "canceled",
  "failed",
  "rejected",
] as const;

export type A2ATaskState = (typeof A2A_TASK_STATES)[number];

/** Terminal states never transition again. */
export const A2A_TERMINAL_TASK_STATES: ReadonlySet<A2ATaskState> = new Set([
  "completed",
  "canceled",
  "failed",
  "rejected",
]);

export function isA2ATaskState(value: unknown): value is A2ATaskState {
  return (
    typeof value === "string" &&
    (A2A_TASK_STATES as readonly string[]).includes(value)
  );
}

export function isA2ATerminalState(state: A2ATaskState): boolean {
  return A2A_TERMINAL_TASK_STATES.has(state);
}

/**
 * Legal task-state transitions the broker allows. A `send` to a task in
 * `input-required` resumes it to `working`; the broker rejects any move out of
 * a terminal state or an illegal jump.
 */
export const A2A_TASK_TRANSITIONS: Readonly<Record<A2ATaskState, readonly A2ATaskState[]>> = {
  submitted: ["working", "input-required", "auth-required", "completed", "canceled", "failed", "rejected"],
  working: ["working", "input-required", "auth-required", "completed", "canceled", "failed", "rejected"],
  "input-required": ["working", "canceled", "failed", "rejected"],
  "auth-required": ["working", "canceled", "failed", "rejected"],
  completed: [],
  canceled: [],
  failed: [],
  rejected: [],
};

export function canTransitionA2ATask(from: A2ATaskState, to: A2ATaskState): boolean {
  return A2A_TASK_TRANSITIONS[from].includes(to);
}

/** Message roles (A2A). A worker speaks as `agent`; a request speaks as `user`. */
export type A2ARole = "user" | "agent";

/**
 * A multimodal message part (A2A `Part`). The `kind` discriminator selects the
 * variant, matching the A2A wire form exactly.
 */
export type A2ATextPart = { kind: "text"; text: string };

export type A2AFileContent = {
  name?: string;
  mimeType?: string;
  /** Remote/opaque reference to bytes the recipient can fetch. */
  uri?: string;
  /** Inline base64 bytes; bounded by `A2A_MAX_FILE_BYTES`. */
  bytes?: string;
};

export type A2AFilePart = { kind: "file"; file: A2AFileContent };

export type A2ADataPart = { kind: "data"; data: Record<string, unknown> };

export type A2APart = A2ATextPart | A2AFilePart | A2ADataPart;

export function isA2APart(value: unknown): value is A2APart {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "text") return typeof (value as A2ATextPart).text === "string";
  if (kind === "file") return typeof (value as A2AFilePart).file === "object";
  if (kind === "data") return typeof (value as A2ADataPart).data === "object";
  return false;
}

/**
 * A2A message. `taskId`/`contextId` bind it to an in-flight task and its
 * grouping context; a first message may omit `taskId` to create a new task.
 */
export type A2AMessage = {
  role: A2ARole;
  parts: A2APart[];
  messageId: string;
  taskId?: string;
  contextId?: string;
  /** Peer id of the sender, stamped by the broker (never a model input). */
  from?: string;
  /** Recipient agent name; omitted means the task's owning agent. */
  to?: string;
};

/** A2A artifact: a named, multi-part output a task produces. */
export type A2AArtifact = {
  artifactId: string;
  name?: string;
  description?: string;
  parts: A2APart[];
};

/** A2A task status: the current state plus an optional status message. */
export type A2ATaskStatus = {
  state: A2ATaskState;
  message?: A2AMessage;
  /** ISO-8601 UTC timestamp of the last transition. */
  timestamp: string;
};

/** A2A Task resource. `kind` matches the A2A wire discriminator. */
export type A2ATask = {
  kind: "task";
  id: string;
  contextId: string;
  status: A2ATaskStatus;
  history: A2AMessage[];
  artifacts: A2AArtifact[];
  /** Peer id of the agent that owns/serves this task. */
  agentName: string;
  /** Peer id of the agent that requested this task (sender of the first
   * message). Status/terminal events route to the counterpart of whoever
   * caused them, so the requester receives the worker's completion. */
  requesterName: string;
};

/**
 * A2A skill: one capability a card advertises. Derived from a subagent
 * definition's name/description so discovery is meaningful.
 */
export type A2AAgentSkill = {
  id: string;
  name: string;
  description: string;
  tags: string[];
};

/** A2A agent capabilities block. */
export type A2AAgentCapabilities = {
  streaming: boolean;
  pushNotifications: boolean;
};

/**
 * A2A Agent Card. The discovery document a peer reads to decide whether and how
 * to talk to another agent. In A2A this is served at
 * `/.well-known/agent-card.json`; here the broker holds it in the registry and
 * returns it from `a2a.agents.list`.
 */
export type A2AAgentCard = {
  /** Peer id: unique across the live host registry, the address other agents use. */
  name: string;
  description: string;
  version: string;
  skills: A2AAgentSkill[];
  capabilities: A2AAgentCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  /** Session id this agent registered under. Stamped by the broker. */
  contextId?: string;
  /** Registry role. Default `subagent`. Parents and subagents never mix. */
  kind?: "parent" | "subagent";
};

/** Streaming event: a task changed state (A2A `TaskStatusUpdateEvent`). */
export type A2ATaskStatusUpdateEvent = {
  kind: "status-update";
  taskId: string;
  contextId: string;
  status: A2ATaskStatus;
  /** True when this is the last event for the task (terminal state). */
  final: boolean;
};

/** Streaming event: a task produced/extended an artifact (A2A `TaskArtifactUpdateEvent`). */
export type A2ATaskArtifactUpdateEvent = {
  kind: "artifact-update";
  taskId: string;
  contextId: string;
  artifact: A2AArtifact;
  /** Append to an existing artifact rather than replace it. */
  append?: boolean;
  lastChunk?: boolean;
};

export type A2AStreamEvent =
  | A2ATaskStatusUpdateEvent
  | A2ATaskArtifactUpdateEvent;

/**
 * Push notification configuration (A2A `PushNotificationConfig`). On this local
 * substrate the `url` is optional/unused: the broker emits an `a2a.push`
 * JSON-RPC notification instead of an HTTP webhook. `token` is echoed back on
 * every push so the receiver can authenticate the callback.
 */
export type A2APushNotificationConfig = {
  id: string;
  url?: string;
  token?: string;
};

/**
 * Message-send configuration (A2A `MessageSendConfiguration`). `blocking`
 * decides whether `a2a.message.send` waits for a terminal state or returns the
 * task immediately.
 */
export type A2AMessageSendConfiguration = {
  blocking?: boolean;
  historyLength?: number;
  pushNotificationConfig?: A2APushNotificationConfig;
};

/** Bounds. Mirrors `crates/host-core/src/a2a/types.rs`. */
export const A2A_MAX_TEXT_CHARS = 16_000;
export const A2A_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const A2A_MAX_TASK_HISTORY = 256;
export const A2A_MAX_TASKS_PER_CONTEXT = 128;
export const A2A_MAX_SENDS_PER_RUN = 200;
export const A2A_MAX_STREAM_WAIT_SECONDS = 120;
export const A2A_DEFAULT_STREAM_WAIT_SECONDS = 30;

/** JSON-RPC method names in the `a2a.*` domain (host-core RPC). */
export const A2A_RPC_METHODS = {
  agentsRegister: "a2a.agents.register",
  agentsDeregister: "a2a.agents.deregister",
  agentsList: "a2a.agents.list",
  messageSend: "a2a.message.send",
  messageStream: "a2a.message.stream",
  tasksGet: "a2a.tasks.get",
  tasksStatus: "a2a.tasks.status",
  tasksCancel: "a2a.tasks.cancel",
  tasksResubscribe: "a2a.tasks.resubscribe",
  pushConfigSet: "a2a.tasks.pushNotificationConfig.set",
  pushConfigGet: "a2a.tasks.pushNotificationConfig.get",
} as const;

/** Host→client JSON-RPC notification methods. */
export const A2A_NOTIFICATIONS = {
  /** A streaming task event (status/artifact update). */
  taskEvent: "a2a.task.event",
  /** A push notification for a subscribed task. */
  push: "a2a.push",
} as const;

/** Params/results for the `a2a.*` RPC methods (wire shapes). */
export type A2AAgentsRegisterParams = {
  contextId: string;
  card: A2AAgentCard;
};

export type A2AAgentsRegisterResult = {
  agentId: string;
  /** Capability token; carried on every subsequent a2a call. */
  token: string;
};

export type A2AAgentsDeregisterParams = { token: string };
export type A2AAgentsDeregisterResult = { ok: boolean };

export type A2AAgentsListParams = { token: string };
export type A2AAgentsListResult = { agents: A2AAgentCard[] };

export type A2AMessageSendParams = {
  token: string;
  message: A2AMessage;
  configuration?: A2AMessageSendConfiguration;
};

/** `message/send` returns a Task (or a direct Message for a simple reply). */
export type A2AMessageSendResult = { task: A2ATask } | { message: A2AMessage };

export type A2AMessageStreamParams = {
  token: string;
  message: A2AMessage;
};

export type A2AMessageStreamResult = { task: A2ATask };

export type A2ATasksGetParams = {
  token: string;
  id: string;
  historyLength?: number;
};

export type A2ATasksGetResult = { task: A2ATask };

/**
 * `tasks/status` drives a task to a new state (the completion/failure/
 * interactive-pause path). The broker validates the transition and routes the
 * resulting event to the counterpart of the caller. An optional `message` is
 * stamped and appended to history like any other.
 */
export type A2ATasksStatusParams = {
  token: string;
  id: string;
  state: A2ATaskState;
  message?: A2AMessage;
};

export type A2ATasksStatusResult = { task: A2ATask };

export type A2ATasksCancelParams = { token: string; id: string };
export type A2ATasksCancelResult = { task: A2ATask };

export type A2ATasksResubscribeParams = { token: string; id: string };
export type A2ATasksResubscribeResult = { task: A2ATask };

export type A2APushConfigSetParams = {
  token: string;
  taskId: string;
  config: A2APushNotificationConfig;
};
export type A2APushConfigSetResult = { config: A2APushNotificationConfig };

export type A2APushConfigGetParams = { token: string; taskId: string };
export type A2APushConfigGetResult = {
  config: A2APushNotificationConfig | null;
};

/** Notification envelopes (host→client). */
export type A2ATaskEventNotification = {
  /** Peer id of the client that should receive this event. */
  recipient: string;
  /** Session id of `recipient`; session runtimes drop events not addressed to them. */
  recipientContextId?: string;
  contextId: string;
  event: A2AStreamEvent;
};

export type A2APushNotification = {
  recipient: string;
  /** Session id of `recipient`; session runtimes drop events not addressed to them. */
  recipientContextId?: string;
  contextId: string;
  taskId: string;
  token?: string;
  status: A2ATaskStatus;
};

/** Well-known error codes the broker returns in `AppError.code`. */
export const A2A_ERROR_CODES = {
  unknownToken: "A2A_UNKNOWN_TOKEN",
  unknownAgent: "A2A_UNKNOWN_AGENT",
  unknownTask: "A2A_UNKNOWN_TASK",
  crossContextDenied: "A2A_CROSS_CONTEXT_DENIED",
  invalidTransition: "A2A_INVALID_TRANSITION",
  taskTerminal: "A2A_TASK_TERMINAL",
  sendCap: "A2A_SEND_CAP",
  noPeers: "A2A_NO_PEERS",
  payloadTooLarge: "A2A_PAYLOAD_TOO_LARGE",
} as const;

export type A2AErrorCode =
  (typeof A2A_ERROR_CODES)[keyof typeof A2A_ERROR_CODES];

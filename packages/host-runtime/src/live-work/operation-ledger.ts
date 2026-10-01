import { randomUUID } from "node:crypto";
import type { LiveWorkSelectionOption, SessionSource } from "@pi-desktop/shared";
import type { LiveWorkIntent } from "./intent.js";

export type LiveWorkAdmission =
  | "received"
  | "reviewing"
  | "dispatching"
  | "accepted"
  | "rejected"
  | "unknown"
  | "withdrawn";

export type LiveWorkExecution =
  | "not-started"
  | "queued"
  | "running"
  | "waiting-permission"
  | "waiting-input"
  | "unknown"
  | "completed"
  | "failed"
  | "interrupted"
  | "canceled";

export type LiveWorkFailureCode =
  | "classifier-invalid"
  | "classifier-timeout"
  | "caller-withdrawn"
  | "receipt-undelivered"
  | "scope-changed"
  | "host-rejected"
  | "dispatch-unknown";

export type LiveWorkOperation = {
  operationId: string;
  callId: string;
  workBindingRevision: number;
  workSessionId: string;
  workSessionLabel?: string;
  workSessionSource?: SessionSource;
  providerRequestId: string;
  sequence: number;
  instruction: string;
  admission: LiveWorkAdmission;
  execution: LiveWorkExecution;
  summary?: string;
  failureCode?: LiveWorkFailureCode;
  resultSummary?: string;
  resultSourceMessageId?: string;
  resultState?: "pending" | "available" | "unavailable";
  intent?: LiveWorkIntent;
  userMessageId?: string;
  queueEntryId?: string;
  turnId?: string;
  targetTurnId?: string;
  selections?: LiveWorkSelectionOption[];
};

export type RegisterCandidateResult =
  | { status: "created"; operation: LiveWorkOperation }
  | { status: "replayed"; operation: LiveWorkOperation }
  | { status: "conflict" }
  | { status: "capacity" }
  | { status: "invalid" };

const MAX_OPERATION_IDS = 256;
const MAX_PENDING_ADMISSION = 16;
const MAX_REQUEST_ID_BYTES = 256;
const MAX_INSTRUCTION_BYTES = 8 * 1024;

const terminalExecutions = new Set<LiveWorkExecution>(["completed", "failed", "interrupted", "canceled"]);

/** Merge delayed Host evidence without letting an acknowledgement revive work. */
export function reduceOperationEvidence(
  previous: LiveWorkOperation,
  evidence: Partial<Omit<LiveWorkOperation,
    "callId" | "workBindingRevision" | "workSessionId" | "providerRequestId" | "sequence" | "instruction" | "operationId"
  >>,
): LiveWorkOperation {
  const admission = mergeAdmission(previous.admission, evidence.admission, evidence.execution);
  const execution = mergeExecution(previous.execution, evidence.execution, previous.admission);
  const reduced = { ...previous, ...evidence, admission, execution };
  if (evidence.admission === "accepted" && previous.failureCode === "dispatch-unknown" && evidence.failureCode === undefined) {
    delete reduced.failureCode;
  }
  return reduced;
}

function mergeAdmission(
  current: LiveWorkAdmission,
  incoming: LiveWorkAdmission | undefined,
  execution: LiveWorkExecution | undefined,
): LiveWorkAdmission {
  if (incoming === undefined) return current;
  if (current === "accepted") return "accepted";
  if (current === "rejected" || current === "withdrawn") return current;
  if (incoming === "unknown" && (current === "dispatching" || current === "unknown")) return "unknown";
  if (execution && execution !== "not-started" && execution !== "unknown") return "accepted";
  return incoming;
}

function mergeExecution(
  current: LiveWorkExecution,
  incoming: LiveWorkExecution | undefined,
  admission: LiveWorkAdmission,
): LiveWorkExecution {
  if (incoming === undefined) return current;
  if (admission === "rejected" || admission === "withdrawn") return current;
  if (terminalExecutions.has(current)) return current;
  if (incoming === "not-started" && current !== "not-started") return current;
  if (incoming === "unknown" && current !== "not-started") return current;
  if (current === "running" || current === "waiting-permission" || current === "waiting-input") {
    if (incoming === "queued" || incoming === "not-started") return current;
  }
  if (current === "queued" && (incoming === "not-started" || incoming === "unknown")) return current;
  return incoming;
}

/** Per-call identity ledger. It tracks Host admission; it never replays work. */
export class LiveWorkOperationLedger {
  private readonly operations = new Map<string, LiveWorkOperation>();
  private nextSequence = 1;

  constructor(
    private readonly scope: { callId: string; workBindingRevision: number; workSessionId: string },
    private readonly createOperationId: () => string = randomUUID,
    private readonly createUserMessageId: () => string = randomUUID,
  ) {}

  registerCandidate(providerRequestId: string, instruction: string, workSessionId = this.scope.workSessionId): RegisterCandidateResult {
    if (!this.isValidRequest(providerRequestId, instruction)) return { status: "invalid" };
    const existing = this.operations.get(providerRequestId);
    if (existing) {
      return existing.instruction === instruction
        ? { status: "replayed", operation: { ...existing } }
        : { status: "conflict" };
    }
    if (this.operations.size >= MAX_OPERATION_IDS || this.pendingAdmissionCount() >= MAX_PENDING_ADMISSION) {
      return { status: "capacity" };
    }
    const operation: LiveWorkOperation = {
      ...this.scope,
      workSessionId,
      operationId: this.createOperationId(),
      providerRequestId,
      sequence: this.nextSequence++,
      instruction,
      admission: "received",
      execution: "not-started",
      userMessageId: this.createUserMessageId(),
    };
    this.operations.set(providerRequestId, operation);
    return { status: "created", operation: { ...operation } };
  }

  retarget(providerRequestId: string, workSessionId: string, label: string, source: SessionSource): LiveWorkOperation | undefined {
    const operation = this.operations.get(providerRequestId);
    if (!operation || !workSessionId.trim() || operation.admission === "dispatching") return undefined;
    operation.workSessionId = workSessionId;
    operation.workSessionLabel = label.slice(0, 180);
    operation.workSessionSource = source;
    return { ...operation };
  }

  get(providerRequestId: string): LiveWorkOperation | undefined {
    const operation = this.operations.get(providerRequestId);
    return operation ? { ...operation } : undefined;
  }

  getByOperationId(operationId: string): LiveWorkOperation | undefined {
    const operation = [...this.operations.values()].find((item) => item.operationId === operationId);
    return operation ? { ...operation } : undefined;
  }

  update(providerRequestId: string, update: Partial<Omit<LiveWorkOperation,
    "callId" | "workBindingRevision" | "workSessionId" | "providerRequestId" | "sequence" | "instruction" | "operationId"
  >>): LiveWorkOperation | undefined {
    const operation = this.operations.get(providerRequestId);
    if (!operation) return undefined;
    const reduced = reduceOperationEvidence(operation, update);
    if (reduced.failureCode === undefined) delete operation.failureCode;
    Object.assign(operation, reduced);
    return { ...operation };
  }

  values(): LiveWorkOperation[] {
    return [...this.operations.values()].map((operation) => ({ ...operation }));
  }

  private pendingAdmissionCount(): number {
    return [...this.operations.values()].filter(({ admission }) =>
      admission === "received" || admission === "reviewing" || admission === "dispatching" || admission === "unknown",
    ).length;
  }

  private isValidRequest(providerRequestId: string, instruction: string): boolean {
    if (!providerRequestId.trim() || new TextEncoder().encode(providerRequestId).byteLength > MAX_REQUEST_ID_BYTES) return false;
    if (!instruction.trim() || new TextEncoder().encode(instruction).byteLength > MAX_INSTRUCTION_BYTES) return false;
    return true;
  }
}

import { LiveWorkCoordinator, type LiveWorkCandidate, type LiveWorkCoordinatorOptions, type LiveWorkPort, type WorkSnapshot } from "../src/live-work/coordinator.js";

export function build(input: {
  intent: unknown;
  snapshot?: Partial<WorkSnapshot>;
  hangSnapshot?: boolean;
  onSubmit?: LiveWorkPort["submit"];
  onCancelQueued?: LiveWorkPort["cancelQueued"];
  onRespondInput?: LiveWorkPort["respondInput"];
  lookupAdmission?: LiveWorkPort["lookupAdmission"];
  resolveIntent?: LiveWorkCoordinatorOptions["resolveIntent"];
  selectSession?: LiveWorkPort["selectSession"];
  hasWorkTarget?: boolean;
  classifyTimeoutMs?: number;
}): { coordinator: LiveWorkCoordinator; calls: string[]; snapshot: WorkSnapshot } {
  const calls: string[] = [];
  const snapshot: WorkSnapshot = {
    sessionId: "session-a",
    mode: "agent",
    state: "idle",
    queue: [],
    observedAt: 1,
    ...input.snapshot,
  };
  const workPort: LiveWorkPort = {
    snapshot: async (sessionId) => input.hangSnapshot
      ? new Promise<WorkSnapshot>(() => {})
      : ({ ...snapshot, sessionId }),
    observeTurnTarget: () => snapshot.activeTurnId ?? null,
    lookupAdmission: input.lookupAdmission ?? (async () => ({ kind: "not-found" })),
    submit: async (request) => {
      calls.push(`submit:${request.text}:${request.userMessageId}`);
      if (input.onSubmit) return input.onSubmit(request);
      return { status: "started", turnId: "turn-1" };
    },
    steer: async (request) => {
      calls.push(`steer:${request.expectedTurnId}:${request.text}`);
      return { accepted: true };
    },
    enqueue: async (request) => {
      calls.push(`queue:${request.text}:${request.idempotencyKey}`);
      return { queueEntryId: "queue-1" };
    },
    stop: async (request) => {
      calls.push(`stop:${request.sessionId}:${request.expectedTurnId}:${request.urgency}`);
      return { status: "requested" };
    },
    cancelQueued: async (request) => {
      calls.push(`cancel:${request.sessionId}:${request.queueEntryId}`);
      return input.onCancelQueued ? input.onCancelQueued(request) : { status: "canceled" };
    },
    respondInput: async (request) => {
      const labels = request.answers.map((answer) => answer.options.join("+")).join(",");
      calls.push(`answer:${request.sessionId}:${labels}`);
      return input.onRespondInput
        ? input.onRespondInput(request)
        : { status: "resolved", turnId: "turn-1" };
    },
    listProjects: async (request) => [{ selectionRef: "project-ref", kind: "project", action: request.action, label: "Demo" }],
    listSessions: async () => [{ selectionRef: "session-ref", kind: "session", action: "open", label: "Demo / Chat" }],
    openSelection: async () => ({ status: "opened" }),
    selectSession: input.selectSession ?? (async () => ({ status: "selected", sessionId: "session-b", label: "Demo / Chat" })),
  };
  let next = 0;
  const coordinator = new LiveWorkCoordinator({
    resolveIntent: async (request) => input.resolveIntent
      ? input.resolveIntent(request)
      : typeof input.intent === "function"
        ? (input.intent as (candidate: LiveWorkCandidate) => unknown)(request.candidate)
        : input.intent,
    workPort,
    ...(input.classifyTimeoutMs ? { classifyTimeoutMs: input.classifyTimeoutMs } : {}),
    now: () => ++next,
    onOperation: ({ operation }) => calls.push(`state:${operation.admission}:${operation.execution}`),
  });
  coordinator.openCall({ callId: "call-1", workSessionId: "session-a", workBindingRevision: 2, hasWorkTarget: input.hasWorkTarget });
  return { coordinator, calls, snapshot };
}

export const candidate = {
  callId: "call-1",
  workBindingRevision: 2,
  workSessionId: "session-a",
  providerRequestId: "provider-1",
  instruction: "Inspect the login flow, and only fix a confirmed bug.",
};

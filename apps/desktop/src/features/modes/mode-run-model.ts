import type {
  ModeControlAction,
  ModeControlRequest,
  ModeResolveAction,
  ModeResolveRequest,
  ModeRun,
} from "@pi-desktop/shared";

/**
 * Presentation rules for an open mode run (ADR mode-definitions). host-core
 * owns the state machine; these helpers only decide what the status bar says
 * and which controls it offers for a given run snapshot.
 */

export type ModeRunStateKey =
  | "running"
  | "waitingApproval"
  | "blocked"
  | "waitingInput"
  | "error"
  | "paused"
  | "budgetExhausted";

export function modeRunStateKey(run: Pick<ModeRun, "state" | "waitReason">): ModeRunStateKey {
  switch (run.state) {
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "budget_exhausted":
      return "budgetExhausted";
    case "waiting":
      if (run.waitReason === "approval") return "waitingApproval";
      if (run.waitReason === "retries") return "blocked";
      if (run.waitReason === "error") return "error";
      return "waitingInput";
    default:
      // Closed runs are not shown; keep a total mapping for safety.
      return "waitingInput";
  }
}

export const MODE_RUN_STATE_LABEL_KEYS: Record<ModeRunStateKey, string> = {
  running: "modes.run.states.running",
  waitingApproval: "modes.run.states.waitingApproval",
  blocked: "modes.run.states.blocked",
  waitingInput: "modes.run.states.waitingInput",
  error: "modes.run.states.error",
  paused: "modes.run.states.paused",
  budgetExhausted: "modes.run.states.budgetExhausted",
};

export type ModeRunControls = {
  pause: boolean;
  resume: boolean;
  stop: boolean;
  approve: boolean;
  reject: boolean;
};

export function modeRunControls(run: Pick<ModeRun, "state" | "waitReason">): ModeRunControls {
  const open = run.state === "running" || run.state === "waiting" || run.state === "paused" || run.state === "budget_exhausted";
  const awaitingApproval = run.state === "waiting" && run.waitReason === "approval";
  return {
    pause: run.state === "running" || run.state === "waiting",
    resume: run.state === "paused" || run.state === "budget_exhausted",
    stop: open,
    approve: awaitingApproval,
    reject: awaitingApproval,
  };
}

/** Every request names the revision the user acted on (host CAS). */
export function modeControlRequest(run: ModeRun, action: ModeControlAction): ModeControlRequest {
  return { sessionId: run.sessionId, runId: run.id, expectedRevision: run.revision, action };
}

export function modeResolveRequest(run: ModeRun, action: ModeResolveAction): ModeResolveRequest {
  return { sessionId: run.sessionId, runId: run.id, expectedRevision: run.revision, action };
}

/** `roundsCompleted / maxTurns`, with ∞ for an unlimited budget. */
export function modeRunRounds(run: Pick<ModeRun, "roundsCompleted" | "maxTurns">): { completed: number; max: string } {
  return {
    completed: run.roundsCompleted,
    max: run.maxTurns === null || run.maxTurns === undefined ? "∞" : String(run.maxTurns),
  };
}

const MODE_ERROR_KEYS: Record<string, string> = {
  MODE_RUN_ACTIVE: "modes.errors.runActive",
  MODE_NOT_FOUND: "modes.errors.notFound",
  MODE_DEFINITION_INVALID: "modes.errors.definitionInvalid",
  MODE_ID_RESERVED: "modes.errors.idReserved",
  MODE_ID_INVALID: "modes.errors.idInvalid",
  MODE_REVISION_CONFLICT: "modes.errors.revisionConflict",
  MODE_NOT_AWAITING_APPROVAL: "modes.errors.notAwaitingApproval",
  MODE_REMOTE_UNSUPPORTED: "modes.errors.remoteUnsupported",
};

export const MODE_ERROR_MESSAGE_KEYS: readonly string[] = Object.values(MODE_ERROR_KEYS);

export function modeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { code?: unknown; errorCode?: unknown };
  const code = typeof value.code === "string" ? value.code : value.errorCode;
  return typeof code === "string" ? code : undefined;
}

/**
 * User-facing text for a mode IPC failure: a known `MODE_*` code is named in
 * the user's language; an invalid definition keeps the parser's first error
 * (it names the offending key); anything else keeps its message.
 */
export function modeErrorMessage(t: (key: string) => string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = modeErrorCode(error);
  const key = code ? MODE_ERROR_KEYS[code] : undefined;
  if (!key) return message;
  if (code === "MODE_DEFINITION_INVALID" && message) return `${t(key)} ${message}`;
  return t(key);
}

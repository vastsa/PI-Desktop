/**
 * Wire types for staged mode runs (ADR mode-definitions). host-core owns the
 * run state machine; every other layer only reads these shapes or calls the
 * `modes.*` Host RPCs with them.
 */
import type { ModeDefinition, ModeDiagnostic } from "../mode-definition.js";

export type ModeRunState =
  | "running"
  | "waiting"
  | "paused"
  | "budget_exhausted"
  | "finished"
  | "stopped";

/** Why a `waiting` run waits. */
export type ModeRunWaitReason = "approval" | "retries" | "turn_end" | "error";

/** Who started the turn that holds the claim. `host` turns run at most
 * `accept-edits`; `user` and `approval` turns keep the session permission. */
export type ModeTurnOrigin = "user" | "approval" | "host";

export const MODE_RUN_OPEN_STATES: readonly ModeRunState[] = ["running", "waiting", "paused", "budget_exhausted"];

export function isModeRunOpen(state: ModeRunState): boolean {
  return MODE_RUN_OPEN_STATES.includes(state);
}

export type ModeRun = {
  id: string;
  sessionId: string;
  modeId: string;
  snapshotHash: string;
  /** The user message that started the run (`{{run.input}}`). */
  input: string;
  stageId: string;
  state: ModeRunState;
  waitReason?: ModeRunWaitReason;
  /** Last gate or turn failure shown to the user. */
  lastError?: string;
  revision: number;
  activeTurnId?: string;
  activeOrigin?: ModeTurnOrigin;
  roundsCompleted: number;
  tokensUsed: number;
  maxTurns: number | null;
  maxTokens: number | null;
  /** Workspace-relative artifact paths resolved for this run. */
  artifactPaths: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
};

export type ModeRunResult = { run: ModeRun | null };

/** `modes.start` / `modes.claimTurn` answer. `enteredStage` is true for the
 * first claim after the run entered `run.stageId`. */
export type ModeClaimResult = {
  claimed: boolean;
  run: ModeRun | null;
  enteredStage: boolean;
  /** Snapshot the run executes; the runtime never re-reads the user file. */
  definition?: ModeDefinition;
};

/** Outcome of `modes.completeStage` and `modes.gateResult`. */
export type ModeStageOutcome =
  | { status: "failed"; gateIndex: number; message: string; retriesLeft: number; run: ModeRun }
  | { status: "run"; gateIndex: number; command: string; timeoutMinutes: number; run: ModeRun }
  | { status: "awaiting_approval"; run: ModeRun }
  | { status: "advanced"; nextStageId: string; run: ModeRun }
  | { status: "goto"; nextStageId: string; message: string; run: ModeRun }
  | { status: "blocked"; message: string; run: ModeRun }
  | { status: "finished"; run: ModeRun };

export type ModeSettleResult = { run: ModeRun | null; continue: boolean };

/** `stop` ends the run and interrupts its active turn; `remove` ends the run
 * and lets that turn finish in the mode the session returns to. */
export type ModeControlAction = "pause" | "resume" | "stop" | "remove";

/** A run budget; `null` is unlimited. Same range as a definition budget. */
export type ModeRunBudget = { maxTurns: number | null; maxTokens: number | null };

/** `modes.update`: edit an open run. Both fields apply from the next claim. */
export type ModeUpdateRequest = {
  sessionId: string;
  runId: string;
  expectedRevision: number;
  input?: string;
  budget?: ModeRunBudget;
};
export type ModeResolveAction = "approve" | "reject";

export type ModeControlRequest = {
  sessionId: string;
  runId: string;
  expectedRevision: number;
  action: ModeControlAction;
};

export type ModeResolveRequest = {
  sessionId: string;
  runId: string;
  expectedRevision: number;
  action: ModeResolveAction;
};

/** Trusted per-turn context Electron main hands the sidecar for a run turn. */
export type ModeTurnContext = {
  runId: string;
  stageId: string;
  origin: ModeTurnOrigin;
  enteredStage: boolean;
  input: string;
  artifactPaths: Record<string, string>;
};

/** Renderer-facing catalog entry. Unavailable entries carry diagnostics. */
export type ModeCatalogEntry = {
  id: string;
  label: string;
  description: string;
  source: "builtin" | "user";
  staged: boolean;
  available: boolean;
  /** A user document with a builtin id is reported, not loaded. */
  reserved?: boolean;
  filePath?: string;
};

export type ModeCatalog = {
  modes: ModeCatalogEntry[];
  diagnostics: ModeDiagnostic[];
  /** Global definitions root shown in settings. */
  directory: string;
};

export type ModeDocumentReadResult = { id: string; source: string; filePath?: string; builtin: boolean };

export type ModeDocumentValidation = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

export type ModeDocumentWriteRequest = { id: string; source: string };

export type ModesChangedEvent = { sessionId: string; run: ModeRun | null };

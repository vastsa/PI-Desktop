/**
 * `CompleteStage`: the model's only way to end a stage of a staged mode run
 * (ADR mode-definitions). host-core owns the run state machine; this tool
 * hands it the stage summary and artifacts (`modes.completeStage`), runs each
 * `run` exit gate through the Host Bash path the `Bash` tool uses, and
 * reports the gate verdict back (`modes.gateResult`) until the Host answers
 * with an outcome. The idea of a Host-validated, model-called stage report
 * that ends the turn is ported from PR #2141 by new-Beginner (`UpdateGoal`).
 */
import { randomUUID } from "node:crypto";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  MODE_ID_RE,
  MODE_LIMITS,
  type ModeStageOutcome,
  type ModeTurnContext,
} from "@pi-desktop/shared";
import type { RuntimeHost } from "../host-client.js";

export const COMPLETE_STAGE_TOOL_NAME = "CompleteStage";

/** Ceiling for the stage summary the Host records. */
export const COMPLETE_STAGE_SUMMARY_MAX_BYTES = 16 * 1024;
/** Same ceiling host-core applies to one written artifact. */
export const COMPLETE_STAGE_ARTIFACT_MAX_BYTES = 256 * 1024;

/** Host errors after which the claim is gone; retrying cannot help. */
const TERMINAL_HOST_ERRORS = new Set([
  "MODE_CLAIM_MISMATCH",
  "MODE_RUN_NOT_FOUND",
  "MODE_NOT_STAGED",
]);

const STATUSES = new Set<ModeStageOutcome["status"]>([
  "failed",
  "run",
  "awaiting_approval",
  "advanced",
  "goto",
  "blocked",
  "finished",
]);

export type ModeGateCommand = {
  /** Fresh tool-call id the Host records the exit code under. */
  toolCallId: string;
  modeGate: { runId: string; gateIndex: number };
  /** Exactly the command the Host returned; it compares it to the snapshot. */
  command: string;
  timeoutSeconds: number;
};

export type ModeGateRunResult = { isError: boolean; text: string };

export type CompleteStageToolDeps = {
  host: RuntimeHost;
  sessionId: string;
  /** The claimed run turn, or undefined when this turn holds no claim. */
  context: () => { turnId: string; modeTurn: ModeTurnContext } | undefined;
  /** Run a gate command through the Host `tools.execute` Bash path. */
  runGateCommand: (
    request: ModeGateCommand,
    signal: AbortSignal | undefined,
    onUpdate: Parameters<AgentTool["execute"]>[3],
  ) => Promise<ModeGateRunResult>;
  /** Ask the agent loop to end the turn at the next boundary. */
  endTurn: () => void;
};

type CompleteStageParams = { summary: string; artifacts?: Record<string, string> };

type ToolResult = AgentToolResult<unknown> & { isError?: boolean; terminate?: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textResult(text: string, details: unknown, extra: { isError?: boolean; terminate?: boolean } = {}): ToolResult {
  return { content: [{ type: "text", text }], details, ...extra };
}

/** Why the model's arguments are unusable, or the parsed arguments. */
export function parseCompleteStageParams(value: unknown): CompleteStageParams | string {
  if (!isRecord(value)) return "expected { summary, artifacts? }";
  const unknownKey = Object.keys(value).find((key) => key !== "summary" && key !== "artifacts");
  if (unknownKey) return `unknown argument "${unknownKey}"`;
  if (typeof value.summary !== "string" || !value.summary.trim()) return "summary must be a non-empty string";
  if (Buffer.byteLength(value.summary) > COMPLETE_STAGE_SUMMARY_MAX_BYTES) {
    return `summary is larger than ${COMPLETE_STAGE_SUMMARY_MAX_BYTES / 1024} KiB`;
  }
  if (value.artifacts === undefined) return { summary: value.summary.trim() };
  if (!isRecord(value.artifacts)) return "artifacts must map artifact ids to Markdown strings";
  const entries = Object.entries(value.artifacts);
  if (entries.length > MODE_LIMITS.artifacts) return `at most ${MODE_LIMITS.artifacts} artifacts`;
  const artifacts: Record<string, string> = {};
  for (const [id, markdown] of entries) {
    if (!MODE_ID_RE.test(id)) return `artifact id "${id}" is invalid`;
    if (typeof markdown !== "string") return `artifact "${id}" must be a Markdown string`;
    if (Buffer.byteLength(markdown) > COMPLETE_STAGE_ARTIFACT_MAX_BYTES) {
      return `artifact "${id}" is larger than ${COMPLETE_STAGE_ARTIFACT_MAX_BYTES / 1024} KiB`;
    }
    artifacts[id] = markdown;
  }
  return { summary: value.summary.trim(), artifacts };
}

/** The Host answer, checked before the tool acts on it. */
export function parseModeStageOutcome(value: unknown): ModeStageOutcome {
  const invalid = (): never => {
    throw Object.assign(new Error("Host returned an invalid stage outcome"), { errorCode: "MODE_OUTCOME_INVALID" });
  };
  if (!isRecord(value) || typeof value.status !== "string" || !STATUSES.has(value.status as ModeStageOutcome["status"])) {
    return invalid();
  }
  if (!isRecord(value.run)) return invalid();
  const gateIndexValid = Number.isSafeInteger(value.gateIndex) && (value.gateIndex as number) >= 0;
  switch (value.status) {
    case "run":
      if (!gateIndexValid || typeof value.command !== "string" || !value.command
        || !Number.isSafeInteger(value.timeoutMinutes) || (value.timeoutMinutes as number) < 1) return invalid();
      break;
    case "failed":
      if (!gateIndexValid || typeof value.message !== "string"
        || !Number.isSafeInteger(value.retriesLeft) || (value.retriesLeft as number) < 0) return invalid();
      break;
    case "advanced":
      if (typeof value.nextStageId !== "string") return invalid();
      break;
    case "goto":
      if (typeof value.nextStageId !== "string" || typeof value.message !== "string") return invalid();
      break;
    case "blocked":
      if (typeof value.message !== "string") return invalid();
      break;
    default:
      break;
  }
  return value as ModeStageOutcome;
}

function hostErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const nested = isRecord(error.data) ? error.data.errorCode : undefined;
  if (typeof nested === "string") return nested;
  return typeof error.errorCode === "string" ? error.errorCode : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortedError(): Error {
  return Object.assign(new Error("CompleteStage was aborted"), { errorCode: "TOOL_ABORTED" });
}

/** Model-facing text for a settled outcome. */
export function describeStageOutcome(outcome: Exclude<ModeStageOutcome, { status: "run" }>): string {
  switch (outcome.status) {
    case "failed": {
      const retries = outcome.retriesLeft === 1 ? "1 retry" : `${outcome.retriesLeft} retries`;
      return `Exit check ${outcome.gateIndex + 1} failed: ${outcome.message}\n${retries} left before the stage is blocked. Fix the cause, then call ${COMPLETE_STAGE_TOOL_NAME} again.`;
    }
    case "advanced":
      return `Stage complete. The run advances to stage \`${outcome.nextStageId}\` in a new turn; this turn ends now.`;
    case "goto":
      return `${outcome.message}\nThe run moves to stage \`${outcome.nextStageId}\` in a new turn; this turn ends now.`;
    case "blocked":
      return `The stage is blocked: ${outcome.message}\nThe run waits for the user; this turn ends now.`;
    case "awaiting_approval":
      return "The stage's checks passed and it now awaits the user's approval; this turn ends now.";
    case "finished":
      return "All exit checks passed and the run is finished; this turn ends now.";
  }
}

export function createCompleteStageTool(deps: CompleteStageToolDeps): AgentTool {
  return {
    name: COMPLETE_STAGE_TOOL_NAME,
    label: "Complete stage",
    description:
      "Complete the current stage of the active mode run. Pass a short summary of what the stage produced and, in `artifacts`, the complete Markdown of each run artifact you write, keyed by artifact id. The host saves the artifacts and evaluates the stage's exit checks. A failed check returns its message and the retries left; when the stage advances, finishes, is blocked, or awaits approval, the turn ends. Call it only when the stage's work is done.",
    parameters: Type.Object({
      summary: Type.String({ description: "Short summary of what this stage produced." }),
      artifacts: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: "Complete Markdown of each artifact to write, keyed by artifact id.",
        }),
      ),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, rawParams, signal, onUpdate) => {
      const context = deps.context();
      if (!context) {
        return textResult(`${COMPLETE_STAGE_TOOL_NAME} is available only in a turn of an active mode run.`, { errorCode: "MODE_CLAIM_MISMATCH" }, { isError: true });
      }
      const params = parseCompleteStageParams(rawParams);
      if (typeof params === "string") {
        return textResult(`${COMPLETE_STAGE_TOOL_NAME}: ${params}.`, { errorCode: "INVALID_ARGUMENT" }, { isError: true });
      }
      const { turnId, modeTurn } = context;
      const identity = { sessionId: deps.sessionId, runId: modeTurn.runId, turnId };
      const gates: Array<{ gateIndex: number; command: string; isError: boolean }> = [];
      const hostFailure = (error: unknown, gateText?: string): ToolResult => {
        const errorCode = hostErrorCode(error) ?? "MODE_COMPLETE_STAGE_FAILED";
        const terminal = TERMINAL_HOST_ERRORS.has(errorCode);
        if (terminal) deps.endTurn();
        const lines = [`${COMPLETE_STAGE_TOOL_NAME} failed (${errorCode}): ${errorMessage(error)}`];
        if (gateText) lines.push(`Gate command output:\n${gateText}`);
        if (terminal) lines.push("This turn no longer holds the run; it ends now.");
        return textResult(lines.join("\n"), { errorCode, gates }, { isError: true, ...(terminal ? { terminate: true } : {}) });
      };

      let outcome: ModeStageOutcome;
      try {
        outcome = parseModeStageOutcome(await deps.host.call("modes.completeStage", {
          ...identity,
          summary: params.summary,
          ...(params.artifacts ? { artifacts: params.artifacts } : {}),
        }));
      } catch (error) {
        if (signal?.aborted) throw abortedError();
        return hostFailure(error);
      }

      let previousGate = -1;
      while (outcome.status === "run") {
        if (signal?.aborted) throw abortedError();
        const { gateIndex, command, timeoutMinutes } = outcome;
        // The Host evaluates gates in order; a repeated or backwards index
        // would loop forever.
        if (gateIndex <= previousGate || gates.length >= MODE_LIMITS.gatesPerStage) {
          return hostFailure(Object.assign(new Error(`unexpected gate index ${gateIndex}`), { errorCode: "MODE_OUTCOME_INVALID" }));
        }
        previousGate = gateIndex;
        const gateCallId = `mode-gate-${randomUUID()}`;
        let gate: ModeGateRunResult;
        try {
          gate = await deps.runGateCommand({
            toolCallId: gateCallId,
            modeGate: { runId: modeTurn.runId, gateIndex },
            command,
            timeoutSeconds: timeoutMinutes * 60,
          }, signal, onUpdate);
        } catch (error) {
          if (signal?.aborted) throw abortedError();
          return hostFailure(error);
        }
        gates.push({ gateIndex, command, isError: gate.isError });
        try {
          outcome = parseModeStageOutcome(await deps.host.call("modes.gateResult", {
            ...identity,
            gateIndex,
            toolCallId: gateCallId,
          }));
        } catch (error) {
          if (signal?.aborted) throw abortedError();
          // A denied or unstarted command leaves no exit code to consume; its
          // own output explains why.
          return hostFailure(error, gate.text);
        }
      }

      const text = describeStageOutcome(outcome);
      // A failed check is a failed completion attempt; the turn goes on so
      // the model can fix the cause and call again.
      if (outcome.status === "failed") {
        return textResult(text, { outcome, gates }, { isError: true });
      }
      deps.endTurn();
      return textResult(text, { outcome, gates }, { terminate: true });
    },
  };
}

/**
 * The bounded perceive-decide-act loop (ADR 0340 §9).
 *
 * Electron-independent on purpose: everything the loop needs — observing,
 * acting, asking the bound model, drawing the cursor — arrives as an injected
 * dependency, so the schema, the validation, the step limits, and the stop
 * conditions are testable against scripted model answers without a provider,
 * a window, or a running app.
 *
 * The loop decides nothing about authority. It cannot widen a scope, raise a
 * budget, or retry past a refusal: the host re-checks every action anyway, and
 * a refusal here is final for that step.
 */
import {
  COMPUTER_MAX_STEPS_LIMIT,
  COMPUTER_USE_DEFAULTS,
  type ComputerAction,
  type ComputerActResult,
  type ComputerCursorEvent,
  type ComputerRunOutcome,
  type ComputerRunResult,
  type ComputerStepRecord,
} from "@pi-desktop/shared";

import { parseLoopAnswer, validateAnswerAction, type LoopAnswer } from "./answer.js";
import { buildDecisionRequest, type DecisionRequest, type Observation } from "./prompt.js";

export type ComputerLoopDeps = {
  /** Fresh accessibility tree, grant view, and capture when pixels are allowed. */
  observe: () => Promise<Observation>;
  /** One host action. It throws a coded error when the host refuses. */
  act: (action: ComputerAction, expectedRevision: number) => Promise<ComputerActResult>;
  /** One request to the bound model. Returns raw text; the loop parses it. */
  decide: (request: DecisionRequest) => Promise<string>;
  onStep?: (step: ComputerStepRecord) => void;
  onCursor?: (event: ComputerCursorEvent) => void;
};

export type ComputerLoopInput = {
  instruction: string;
  maxSteps?: number;
  observeOnly?: boolean;
};

/** Consecutive unusable model answers before the loop gives up. */
const MAX_INVALID_ANSWERS = 2;
/** Consecutive identical refusals before the loop stops trying. */
const MAX_REPEATED_REFUSALS = 2;

/** Outcomes a host refusal maps to, so the caller sees why work stopped. */
const TERMINAL_CODES: Record<string, ComputerRunOutcome> = {
  COMPUTER_GRANT_EXPIRED: "expired",
  COMPUTER_NO_GRANT: "revoked",
  COMPUTER_GRANT_IN_USE: "revoked",
  COMPUTER_BUDGET_EXHAUSTED: "budget-exhausted",
  COMPUTER_SELF_TARGET_REFUSED: "failed",
  COMPUTER_SECURE_INPUT_REFUSED: "failed",
  COMPUTER_TARGET_DENYLISTED: "failed",
  COMPUTER_PLATFORM_UNSUPPORTED: "failed",
  COMPUTER_OS_PERMISSION_MISSING: "failed",
  COMPUTER_TARGET_ELEVATED: "failed",
  COMPUTER_SCOPE_VIOLATION: "failed",
};

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.startsWith("COMPUTER_")) return code;
  }
  return "COMPUTER_ACTION_REJECTED";
}

/** A short, value-free description of what a step acted on. */
function describeTarget(action: ComputerAction, label?: string): string | undefined {
  if (label) return label;
  if (action.uid) return `element ${action.uid}`;
  if (action.point) return `point ${Math.round(action.point.x)},${Math.round(action.point.y)}`;
  return undefined;
}

function summarize(
  outcome: ComputerRunOutcome,
  steps: readonly ComputerStepRecord[],
  modelSummary?: string,
  errorCodeValue?: string,
): string {
  const ran = steps.filter((step) => step.action !== "observe");
  const done = ran.filter((step) => step.ok);
  const lines: string[] = [];
  lines.push(
    ran.length === 0
      ? "No action was dispatched."
      : `Dispatched ${done.length} of ${ran.length} action${ran.length === 1 ? "" : "s"}: ${done
          .map((step) => (step.target ? `${step.action} on ${step.target}` : step.action))
          .join("; ") || "none succeeded"}.`,
  );
  switch (outcome) {
    case "done":
      break;
    case "step-limit":
      lines.push("Stopped at the step limit for this call; the task may be unfinished.");
      break;
    case "budget-exhausted":
      lines.push("Stopped because the grant's action budget ran out.");
      break;
    case "revoked":
      lines.push("Stopped because the grant was revoked or is no longer held by this session.");
      break;
    case "expired":
      lines.push("Stopped because the grant expired.");
      break;
    case "needs-user":
      lines.push("Stopped to ask the user a question.");
      break;
    case "failed":
      lines.push(`Stopped after a refusal${errorCodeValue ? ` (${errorCodeValue})` : ""}.`);
      break;
  }
  if (modelSummary) {
    // Labelled, length-bounded, and parsed — never pasted in as the result.
    lines.push(`Model's account: ${modelSummary}`);
  }
  return lines.join(" ");
}

export async function runComputerLoop(
  input: ComputerLoopInput,
  deps: ComputerLoopDeps,
): Promise<ComputerRunResult> {
  const steps: ComputerStepRecord[] = [];
  // The caller's own ceiling, clamped by the shared limit. The grant's action
  // budget is enforced by the host and can cut a run shorter than this.
  const maxSteps = Math.max(
    1,
    Math.min(input.maxSteps ?? COMPUTER_USE_DEFAULTS.maxStepsPerCall, COMPUTER_MAX_STEPS_LIMIT),
  );
  let invalidAnswers = 0;
  let lastRefusal: string | undefined;
  let repeatedRefusals = 0;
  let index = 0;

  const record = (step: ComputerStepRecord) => {
    steps.push(step);
    deps.onStep?.(step);
  };

  let observation: Observation;
  try {
    observation = await deps.observe();
  } catch (error) {
    const code = errorCode(error);
    return {
      outcome: TERMINAL_CODES[code] ?? "failed",
      summary: summarize("failed", steps, undefined, code),
      steps,
      errorCode: code,
    };
  }

  if (input.observeOnly) {
    record({ index: 0, action: "observe", ok: true });
    const elements = observation.inspection.nodes.length;
    return {
      outcome: "done",
      summary: `Observed ${observation.grant.targetLabel}: ${elements} accessible element${
        elements === 1 ? "" : "s"
      }${observation.inspection.truncated ? " (list truncated)" : ""}${
        observation.inspection.fidelity === "partial" ? ", partial accessibility fidelity" : ""
      }.`,
      steps,
    };
  }

  deps.onCursor?.({ kind: "show", grantId: observation.grant.grantId, bounds: observation.grant.bounds });

  try {
    while (index < maxSteps) {
      const request = buildDecisionRequest(input.instruction, observation, steps);
      let answer: LoopAnswer;
      const raw = await deps.decide(request);
      const parsed = parseLoopAnswer(raw);
      if (!parsed.ok) {
        invalidAnswers += 1;
        record({
          index,
          action: "done",
          ok: false,
          errorCode: "COMPUTER_ACTION_REJECTED",
          target: parsed.reason,
        });
        if (invalidAnswers >= MAX_INVALID_ANSWERS) {
          return {
            outcome: "failed",
            summary: summarize("failed", steps, undefined, "COMPUTER_ACTION_REJECTED"),
            steps,
            errorCode: "COMPUTER_ACTION_REJECTED",
          };
        }
        index += 1;
        continue;
      }
      invalidAnswers = 0;
      answer = parsed.answer;

      if (answer.kind === "done") {
        return { outcome: "done", summary: summarize("done", steps, answer.summary), steps };
      }
      if (answer.kind === "ask") {
        record({ index, action: "ask", ok: true, target: answer.question });
        return {
          outcome: "needs-user",
          summary: summarize("needs-user", steps),
          steps,
          question: answer.question,
        };
      }

      const validated = validateAnswerAction(answer.action, observation.inspection);
      if (!validated.ok) {
        record({
          index,
          action: answer.action.kind,
          ok: false,
          errorCode: "COMPUTER_ACTION_REJECTED",
          target: validated.reason,
        });
        repeatedRefusals = validated.reason === lastRefusal ? repeatedRefusals + 1 : 1;
        lastRefusal = validated.reason;
        if (repeatedRefusals >= MAX_REPEATED_REFUSALS) {
          return {
            outcome: "failed",
            summary: summarize("failed", steps, undefined, "COMPUTER_ACTION_REJECTED"),
            steps,
            errorCode: "COMPUTER_ACTION_REJECTED",
          };
        }
        index += 1;
        observation = await deps.observe();
        continue;
      }

      const target = describeTarget(validated.action, validated.node?.label);
      const bounds = validated.node?.bounds;
      if (bounds) {
        deps.onCursor?.({
          kind: "move",
          grantId: observation.grant.grantId,
          x: bounds.x + bounds.width / 2,
          y: bounds.y + bounds.height / 2,
          ...(target ? { label: target } : {}),
        });
      } else if (validated.action.point) {
        deps.onCursor?.({
          kind: "move",
          grantId: observation.grant.grantId,
          x: observation.grant.bounds.x + validated.action.point.x,
          y: observation.grant.bounds.y + validated.action.point.y,
          ...(target ? { label: target } : {}),
        });
      }

      try {
        await deps.act(validated.action, observation.inspection.revision);
        const point = bounds
          ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
          : validated.action.point
            ? {
                x: observation.grant.bounds.x + validated.action.point.x,
                y: observation.grant.bounds.y + validated.action.point.y,
              }
            : undefined;
        if (point) {
          deps.onCursor?.(
            validated.action.kind === "set_value"
              ? {
                  kind: "type",
                  grantId: observation.grant.grantId,
                  x: point.x,
                  y: point.y,
                  chars: validated.action.text?.length ?? 0,
                }
              : {
                  kind: "press",
                  grantId: observation.grant.grantId,
                  x: point.x,
                  y: point.y,
                  action: validated.action.kind,
                },
          );
        }
        record({ index, action: validated.action.kind, ok: true, ...(target ? { target } : {}) });
        repeatedRefusals = 0;
        lastRefusal = undefined;
      } catch (error) {
        const code = errorCode(error);
        record({
          index,
          action: validated.action.kind,
          ok: false,
          errorCode: code,
          ...(target ? { target } : {}),
        });
        const terminal = TERMINAL_CODES[code];
        if (terminal) {
          return {
            outcome: terminal,
            summary: summarize(terminal, steps, undefined, code),
            steps,
            errorCode: code,
          };
        }
        repeatedRefusals = code === lastRefusal ? repeatedRefusals + 1 : 1;
        lastRefusal = code;
        if (repeatedRefusals >= MAX_REPEATED_REFUSALS) {
          return {
            outcome: "failed",
            summary: summarize("failed", steps, undefined, code),
            steps,
            errorCode: code,
          };
        }
      }

      index += 1;
      if (index >= maxSteps) break;
      observation = await deps.observe();
    }

    return { outcome: "step-limit", summary: summarize("step-limit", steps), steps };
  } catch (error) {
    const code = errorCode(error);
    const outcome = TERMINAL_CODES[code] ?? "failed";
    return {
      outcome,
      summary: summarize(outcome, steps, undefined, code),
      steps,
      errorCode: code,
    };
  } finally {
    deps.onCursor?.({ kind: "hide", grantId: observation.grant.grantId });
  }
}

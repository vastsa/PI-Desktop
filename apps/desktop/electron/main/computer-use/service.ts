import { completeOneShot, type RuntimeProviderConfig } from "@pi-desktop/agent-runtime";
import { runComputerLoop, type DecisionRequest, type Observation } from "@pi-desktop/computer-use";
import {
  validateComputerToolArgs,
  type AppSettings,
  type ComputerActResult,
  type ComputerCursorEvent,
  type ComputerGrantView,
  type ComputerInspection,
  type ComputerRunResult,
  type ComputerStepRecord,
} from "@pi-desktop/shared";
import type { Context } from "@earendil-works/pi-ai";
import type { LocalToolHandler, LocalToolResult } from "../agent-sidecar";
import type { HostProcess } from "../host-process";
import { captureGrantedWindow } from "./capture";
import type { ComputerCursorOverlay } from "./cursor-overlay";

/**
 * The `Computer` tool handler (ADR 0342 §1, §2).
 *
 * The loop lives here because it needs two things host-core deliberately does
 * not have: a model provider and Chromium. Everything that can *refuse* stays
 * in host-core, and this handler cannot talk itself past any of it — it holds
 * no grant, mints none, and re-reads the live grant from the host on every
 * observation.
 *
 * The tool is registered as a local tool whose permission evaluation runs in
 * host-core first (`tools.execute`, the `GenerateImages` shape), so reaching
 * this code already means the host authorised the call.
 */

export type ComputerUseLaunchResolver = (
  binding: { providerId: string; modelId: string },
  sessionId: string,
) => Promise<RuntimeProviderConfig | null>;

function failure(errorCode: string, message: string): LocalToolResult {
  return {
    ok: false,
    isError: true,
    errorCode,
    content: { kind: "computer-use-error", errorCode, message },
  };
}

/** Host refusals arrive as `errorCode`; the loop reads `code`. */
function coded(error: unknown): Error & { code: string } {
  const errorCode =
    error && typeof error === "object" && "errorCode" in error
      ? (error as { errorCode?: unknown }).errorCode
      : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return Object.assign(new Error(message), {
    code: typeof errorCode === "string" && errorCode.startsWith("COMPUTER_")
      ? errorCode
      : "COMPUTER_ACTION_REJECTED",
  });
}

/** What the model is sent. Images ride along only under a pixel grant. */
function decisionContext(request: DecisionRequest): Context {
  const text = [
    `Task: ${request.instruction}`,
    "",
    request.observation,
    "",
    "Steps so far:",
    request.history,
    "",
    "Answer with one JSON object.",
  ].join("\n");
  return {
    systemPrompt: request.system,
    messages: [
      {
        role: "user",
        content: request.capture
          ? [
              { type: "text", text },
              { type: "image", data: request.capture.base64, mimeType: request.capture.mimeType },
            ]
          : text,
        timestamp: Date.now(),
      },
    ],
  } as Context;
}

export function createComputerUseTool(options: {
  getHost: () => Pick<HostProcess, "call"> | null;
  /** Builds a provider config for the user's computer-use binding. */
  resolveProvider: ComputerUseLaunchResolver;
  overlay: Pick<ComputerCursorOverlay, "apply">;
  onStep?: (step: ComputerStepRecord & { sessionId: string }) => void;
  onGrant?: (grant: ComputerGrantView | null) => void;
  /** Injected in tests so the loop runs without a provider. */
  complete?: typeof completeOneShot;
  capture?: typeof captureGrantedWindow;
  log?: (message: string, data?: Record<string, unknown>) => void;
}): LocalToolHandler {
  return async ({ sessionId, args, signal }) => {
    let input: ReturnType<typeof validateComputerToolArgs>;
    try {
      input = validateComputerToolArgs(args);
    } catch (error) {
      return failure("INVALID_ARGUMENT", error instanceof Error ? error.message : "Invalid arguments.");
    }

    const host = options.getHost();
    if (!host) return failure("HOST_UNAVAILABLE", "Host unavailable.");

    const settings = await host.call<AppSettings>("settings.get");
    const computerUse = settings.computerUse;
    if (computerUse?.enabled !== true) {
      return failure(
        "COMPUTER_DISABLED",
        "Computer use is off. The user enables it in Settings > Computer use; it cannot be enabled from here.",
      );
    }
    const binding = computerUse.model;
    if (!binding?.providerId || !binding?.modelId) {
      return failure(
        "COMPUTER_NOT_CONFIGURED",
        "Computer use has no model configured. The user picks one in Settings > Computer use. Do not substitute the conversation model.",
      );
    }

    const described = await host.call<{ grant: ComputerGrantView | null }>("computer.grantDescribe", {});
    const grant = described.grant;
    if (!grant || grant.state !== "active") {
      return failure(
        "COMPUTER_NO_GRANT",
        "No application is currently handed over. Ask the user to pick a window in PI-Desktop's computer-use indicator, then try again. You cannot choose the window yourself.",
      );
    }
    if (grant.sessionId !== sessionId) {
      return failure(
        "COMPUTER_GRANT_IN_USE",
        "Another session holds the active computer-use grant.",
      );
    }

    const provider = await options.resolveProvider(
      { providerId: binding.providerId, modelId: binding.modelId },
      sessionId,
    );
    if (!provider) {
      return failure(
        "COMPUTER_NOT_CONFIGURED",
        "The configured computer-use model is unavailable. The user updates it in Settings > Computer use.",
      );
    }

    const complete = options.complete ?? completeOneShot;
    const capture = options.capture ?? captureGrantedWindow;

    const observe = async (): Promise<Observation> => {
      signal.throwIfAborted();
      try {
        const current = await host.call<{ grant: ComputerGrantView | null }>(
          "computer.grantDescribe",
          {},
        );
        const live = current.grant;
        if (!live || live.state !== "active" || live.grantId !== grant.grantId) {
          throw Object.assign(new Error("the grant is no longer active"), {
            code: "COMPUTER_GRANT_EXPIRED",
          });
        }
        const inspection = await host.call<ComputerInspection>("computer.inspect", {
          grantId: live.grantId,
          sessionId,
        });
        const pixels =
          live.capture === "a11y-and-pixels"
            ? await capture({ targetId: live.targetId, bounds: live.bounds, log: options.log })
            : undefined;
        return { grant: live, inspection, ...(pixels ? { capture: pixels } : {}) };
      } catch (error) {
        throw coded(error);
      }
    };

    const act = async (action: Parameters<typeof host.call>[1], expectedRevision: number) => {
      signal.throwIfAborted();
      try {
        return await host.call<ComputerActResult>("computer.act", {
          grantId: grant.grantId,
          sessionId,
          expectedRevision,
          action,
        });
      } catch (error) {
        throw coded(error);
      }
    };

    const decide = async (request: DecisionRequest): Promise<string> => {
      signal.throwIfAborted();
      const result = await complete(provider, decisionContext(request), "off", {
        sessionId,
        signal,
        maxOutputTokens: 1_024,
      });
      return result.text ?? "";
    };

    let result: ComputerRunResult;
    try {
      result = await runComputerLoop(
        {
          instruction: input.instruction,
          ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
          ...(input.observeOnly === undefined ? {} : { observeOnly: input.observeOnly }),
        },
        {
          observe,
          act: (action, expectedRevision) =>
            act(action as Parameters<typeof host.call>[1], expectedRevision),
          decide,
          onStep: (step) => options.onStep?.({ ...step, sessionId }),
          onCursor: (event: ComputerCursorEvent) => options.overlay.apply(event),
        },
      );
    } catch (error) {
      // The loop reports its own refusals; reaching here means the provider or
      // an abort failed, which must not look like a completed task.
      const aborted = signal.aborted;
      options.overlay.apply({ kind: "hide", grantId: grant.grantId });
      return failure(
        aborted ? "TURN_ABORTED" : "COMPUTER_ACTION_REJECTED",
        aborted
          ? "The computer-use run was stopped."
          : `The computer-use model could not be reached: ${
              error instanceof Error ? error.message : String(error)
            }`,
      );
    }

    // Refresh the indicator: a run that spent the budget closes the grant.
    try {
      const after = await host.call<{ grant: ComputerGrantView | null }>("computer.grantDescribe", {});
      options.onGrant?.(after.grant);
    } catch {
      options.onGrant?.(null);
    }

    const lines = [
      result.summary,
      result.question ? `Question for the user: ${result.question}` : undefined,
      result.outcome === "needs-user"
        ? "Relay this question to the user; do not answer it on their behalf."
        : undefined,
      result.outcome === "step-limit"
        ? "Call Computer again only if the user still wants the task finished."
        : undefined,
    ].filter((line): line is string => Boolean(line));

    if (result.outcome === "failed" || result.outcome === "revoked" || result.outcome === "expired") {
      return failure(result.errorCode ?? "COMPUTER_ACTION_REJECTED", lines.join(" "));
    }
    return {
      ok: true,
      content: {
        kind: "computer-use-result",
        outcome: result.outcome,
        summary: lines.join(" "),
        steps: result.steps,
        ...(result.question ? { question: result.question } : {}),
      },
    };
  };
}

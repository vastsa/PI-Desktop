/**
 * Electron main coordination for staged mode runs (ADR mode-definitions).
 *
 * host-core owns the run state machine. Main only maps turns to runs: it
 * claims a run for a durable turn before the sidecar starts it, settles the
 * claim when the turn ends, and starts the Host-requested continuation turn.
 *
 * Continuation authority travels by object identity, as in PR #2141 by
 * new-Beginner: a request object registered here carries the origin, and a
 * JSON/structured-clone copy (renderer, plugin, remote client) never does.
 */
import type {
  MessageUsage,
  ModeClaimResult,
  ModeControlRequest,
  ModeDefinition,
  ModeResolveRequest,
  ModeRunResult,
  ModeSettleResult,
  ModeTurnContext,
  ModeTurnOrigin,
} from "@pi-desktop/shared";
import type { ModeCatalogService } from "./mode-catalog";

type HostCaller = { call<T = unknown>(method: string, params?: unknown): Promise<T> };

/** Model-facing content of a Host-started turn. It is never persisted as a
 * user message; the stage brief in the system prompt carries the details. */
export const MODE_CONTINUATION_CONTENT =
  "Continue the current stage of the active mode run. Follow the stage brief in the system instructions.";

const continuationOrigins = new WeakMap<object, Exclude<ModeTurnOrigin, "user">>();

export function modeContinuationRequest<T extends object>(request: T, origin: Exclude<ModeTurnOrigin, "user">): T {
  continuationOrigins.set(request, origin);
  return request;
}

export function modeContinuationOrigin(request: object): Exclude<ModeTurnOrigin, "user"> | undefined {
  return continuationOrigins.get(request);
}

export type PreparedModeTurn = { modeTurn: ModeTurnContext; definition: ModeDefinition };

export type ModeTurnEnd = { reason: "completed" | "aborted" | "error"; usage?: MessageUsage; errorCode?: string };

function totalTokens(usage: MessageUsage | undefined): number {
  if (!usage) return 0;
  const total = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  return Number.isSafeInteger(total) && total > 0 ? total : 0;
}

export type ModeRunCoordinator = ReturnType<typeof createModeRunCoordinator>;

export function createModeRunCoordinator(deps: {
  getHost: () => HostCaller | null;
  catalog: ModeCatalogService;
  /** Starts a Host-origin turn through the Agent Host admission. */
  startContinuation: (sessionId: string, origin: Exclude<ModeTurnOrigin, "user">, content: string) => Promise<unknown>;
  /** Interrupts the session's active turn (run Stop). */
  abortTurn: (sessionId: string) => Promise<void>;
  logger: { app: (...args: any[]) => void };
  isQuitting: () => boolean;
}) {
  /** Durable turn id → the run it holds a claim on. */
  const turnRuns = new Map<string, { sessionId: string; runId: string }>();
  const pendingContinuations = new Set<string>();

  function host(): HostCaller {
    const current = deps.getHost();
    if (!current) throw Object.assign(new Error("host unavailable"), { errorCode: "HOST_UNAVAILABLE" });
    return current;
  }

  function scheduleContinuation(sessionId: string, origin: Exclude<ModeTurnOrigin, "user">): void {
    if (deps.isQuitting() || pendingContinuations.has(sessionId)) return;
    pendingContinuations.add(sessionId);
    setTimeout(() => {
      pendingContinuations.delete(sessionId);
      if (deps.isQuitting()) return;
      void deps.startContinuation(sessionId, origin, MODE_CONTINUATION_CONTENT).catch((error: unknown) => {
        // A user turn that started first owns the session; the run continues
        // from that turn's settlement instead.
        deps.logger.app("session", "warn", "mode continuation was not started", {
          sessionId,
          data: String((error as { errorCode?: string })?.errorCode ?? error),
        });
      });
    }, 0);
  }

  return {
    async definitionForPrompt(modeId: string): Promise<ModeDefinition | undefined> {
      const definition = await deps.catalog.definition(modeId);
      if (!definition && modeId !== "agent" && modeId !== "plan") {
        throw Object.assign(new Error("Mode is not available"), { errorCode: "MODE_NOT_FOUND" });
      }
      return definition;
    },
    /** A Host-started turn may only open while the run waits for one. */
    async canContinue(sessionId: string): Promise<boolean> {
      const { run } = await host().call<ModeRunResult>("modes.get", { sessionId });
      return Boolean(run && run.state === "running" && !run.activeTurnId);
    },

    /**
     * Claim the session's run for a durable turn. Returns nothing for simple
     * modes, or when a user turn cannot claim (it then runs as a plain turn of
     * the selected mode). A continuation that cannot claim throws, so the
     * caller closes the empty turn instead of running it.
     */
    async prepareTurn(input: {
      sessionId: string;
      turnId: string;
      sessionMode: string;
      content: string;
      origin: ModeTurnOrigin;
    }): Promise<PreparedModeTurn | undefined> {
      const selected = await deps.catalog.definition(input.sessionMode);
      if (!selected || selected.stages.length === 0) {
        if (input.origin !== "user") throw Object.assign(new Error("mode run is not staged"), { errorCode: "MODE_NOT_STAGED" });
        return undefined;
      }
      const hostCaller = host();
      const { run } = await hostCaller.call<ModeRunResult>("modes.get", { sessionId: input.sessionId });
      let claim: ModeClaimResult;
      if (!run) {
        if (input.origin !== "user") throw Object.assign(new Error("no open mode run"), { errorCode: "MODE_RUN_NOT_FOUND" });
        claim = await hostCaller.call<ModeClaimResult>("modes.start", {
          sessionId: input.sessionId,
          input: input.content,
          turnId: input.turnId,
        });
      } else if (run.modeId !== input.sessionMode) {
        if (input.origin !== "user") throw Object.assign(new Error("mode run belongs to another mode"), { errorCode: "MODE_RUN_ACTIVE" });
        return undefined;
      } else {
        claim = await hostCaller.call<ModeClaimResult>("modes.claimTurn", {
          sessionId: input.sessionId,
          runId: run.id,
          expectedRevision: run.revision,
          turnId: input.turnId,
          origin: input.origin,
        });
      }
      if (!claim.claimed || !claim.run) {
        if (input.origin !== "user") throw Object.assign(new Error("mode run claim rejected"), { errorCode: "MODE_CLAIM_REJECTED" });
        return undefined;
      }
      turnRuns.set(input.turnId, { sessionId: input.sessionId, runId: claim.run.id });
      return {
        // The run executes the snapshot it started with; editing the file
        // during a run never changes it.
        definition: claim.definition ?? selected,
        modeTurn: {
          runId: claim.run.id,
          stageId: claim.run.stageId,
          origin: input.origin,
          enteredStage: claim.enteredStage,
          input: claim.run.input,
          artifactPaths: claim.run.artifactPaths,
        },
      };
    },

    /** Release a claim whose turn never reached the sidecar. */
    async abandonTurn(sessionId: string, turnId: string): Promise<void> {
      await this.settleTurn(sessionId, turnId, { reason: "aborted" });
    },

    async settleTurn(sessionId: string, turnId: string, end: ModeTurnEnd): Promise<void> {
      const entry = turnRuns.get(turnId);
      if (!entry || entry.sessionId !== sessionId) return;
      turnRuns.delete(turnId);
      const result = await host().call<ModeSettleResult>("modes.settleTurn", {
        sessionId,
        runId: entry.runId,
        turnId,
        tokens: totalTokens(end.usage),
        outcome: end.reason,
        ...(end.reason === "error" && end.errorCode ? { error: end.errorCode } : {}),
      });
      if (result.continue) scheduleContinuation(sessionId, "host");
    },

    async get(sessionId: string): Promise<ModeRunResult> {
      return host().call<ModeRunResult>("modes.get", { sessionId });
    },

    async control(request: ModeControlRequest): Promise<ModeSettleResult> {
      const active = [...turnRuns.entries()].find(([, entry]) => entry.sessionId === request.sessionId && entry.runId === request.runId);
      const result = await host().call<ModeSettleResult>("modes.control", request);
      if (request.action === "stop" && active) {
        await deps.abortTurn(request.sessionId).catch((error: unknown) => {
          deps.logger.app("session", "warn", "mode run stop could not abort the turn", {
            sessionId: request.sessionId,
            data: String(error),
          });
        });
      }
      if (result.continue) scheduleContinuation(request.sessionId, "approval");
      return result;
    },

    async resolve(request: ModeResolveRequest): Promise<ModeSettleResult> {
      const result = await host().call<ModeSettleResult>("modes.resolve", request);
      if (result.continue) scheduleContinuation(request.sessionId, "approval");
      return result;
    },

    /** Test seam and diagnostics. */
    claimedTurns: (): ReadonlyMap<string, { sessionId: string; runId: string }> => turnRuns,
  };
}

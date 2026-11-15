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
  ModeUpdateRequest,
} from "@pi-desktop/shared";
import type { ModeCatalogService } from "./mode-catalog";
import { goalPromptMode } from "./goal-start";

type HostCaller = { call<T = unknown>(method: string, params?: unknown): Promise<T> };

/** `modes.settleReturn` answer: the return mode still pending, or the one applied. */
type ModeSettleReturnResult = { pending: string | null; applied: string | null };

/** Builtins whose Host semantics need no snapshot. */
function isPlainMode(mode: string): boolean {
  return mode === "agent" || mode === "plan";
}

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

export type PreparedModeTurn = { modeTurn?: ModeTurnContext; definition: ModeDefinition };

export type ModeTurnEnd = { reason: "completed" | "aborted" | "error"; usage?: MessageUsage; errorCode?: string };

function totalTokens(usage: MessageUsage | undefined): number {
  if (!usage) return 0;
  const total = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  return Number.isSafeInteger(total) && total > 0 ? total : 0;
}

/** Sidecar `agent.modeTurnNotice` payload (without session and turn ids). */
export type ModeTurnNotice =
  | { runId: string; action: "closeout" }
  | { runId: string; action: "release"; mode: string; modeDefinition?: ModeDefinition };

export type ModeRunCoordinator = ReturnType<typeof createModeRunCoordinator>;

export function createModeRunCoordinator(deps: {
  getHost: () => HostCaller | null;
  catalog: ModeCatalogService;
  /** Starts a Host-origin turn through the Agent Host admission. */
  startContinuation: (sessionId: string, origin: Exclude<ModeTurnOrigin, "user">, content: string) => Promise<unknown>;
  /** Interrupts the session's active turn (run Stop). */
  abortTurn: (sessionId: string) => Promise<void>;
  /**
   * Tells the runtime running `turnId` that its run changed under it: `closeout`
   * after Pause (wrap up within a few model requests), `release` after Remove
   * (finish as an ordinary turn of the mode the session returned to).
   */
  notifyTurn: (sessionId: string, turnId: string, input: ModeTurnNotice) => Promise<void>;
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
      if (isPlainMode(modeId)) return undefined;
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
     * Claim the session's run for a durable turn, or return a simple mode's
     * definition without a claim. A continuation that cannot claim throws, so the
     * caller closes the empty turn instead of running it.
     */
    async prepareTurn(input: {
      sessionId: string;
      turnId: string;
      sessionMode: string;
      content: string;
      origin: ModeTurnOrigin;
      startGoal?: boolean;
    }): Promise<PreparedModeTurn | undefined> {
      const sessionMode = goalPromptMode(input.sessionMode, input.startGoal);
      const newGoal = input.origin === "user" && (input.startGoal === true || (input.startGoal === undefined && sessionMode === "goal"));
      if (isPlainMode(sessionMode) && input.origin === "user" && !newGoal) return undefined;
      const hostCaller = host();
      const { run } = await hostCaller.call<ModeRunResult>("modes.get", { sessionId: input.sessionId });
      let selected: ModeDefinition | undefined;
      let claim: ModeClaimResult;
      if (newGoal) {
        if (run && run.modeId !== "goal") throw Object.assign(new Error("another staged mode run is active"), { errorCode: "MODE_RUN_ACTIVE" });
        selected = await this.definitionForPrompt("goal");
        if (!selected) throw Object.assign(new Error("Goal is unavailable"), { errorCode: "MODE_NOT_FOUND" });
        if (run) await this.replaceGoal(input.sessionId);
        claim = await hostCaller.call<ModeClaimResult>("modes.startGoal", {
          sessionId: input.sessionId, input: input.content, turnId: input.turnId, modeSnapshot: selected,
        });
      } else if (!run) {
        if (isPlainMode(sessionMode)) throw Object.assign(new Error("no open mode run"), { errorCode: "MODE_RUN_NOT_FOUND" });
        selected = await this.definitionForPrompt(sessionMode);
        if (!selected || selected.stages.length === 0) {
          if (input.origin !== "user") throw Object.assign(new Error("mode run is not staged"), { errorCode: "MODE_NOT_STAGED" });
          return selected ? { definition: selected } : undefined;
        }
        if (input.origin !== "user") throw Object.assign(new Error("no open mode run"), { errorCode: "MODE_RUN_NOT_FOUND" });
        claim = await hostCaller.call<ModeClaimResult>("modes.start", {
          sessionId: input.sessionId,
          input: input.content,
          turnId: input.turnId,
        });
      } else if (run.modeId !== sessionMode && !(run.modeId === "goal" && sessionMode === "agent" && input.origin !== "user")) {
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
      const definition = claim.definition ?? selected;
      if (!definition) {
        await this.abandonTurn(input.sessionId, input.turnId);
        throw Object.assign(new Error("Mode run snapshot is unavailable"), { errorCode: "MODE_NOT_FOUND" });
      }
      return {
        // The run executes the snapshot it started with; editing the file
        // during a run never changes it.
        definition,
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

    /** Accepted input preference is independent from the Goal run's claim. */
    async resetGoalInput(sessionId: string): Promise<void> {
      await host().call("modes.resetGoalInput", { sessionId });
    },

    /** Called only after a new Goal is durable, or at its serialized dispatch. */
    async replaceGoal(sessionId: string): Promise<void> {
      for (let attempt = 0; attempt < 3; attempt++) {
        const { run } = await this.get(sessionId);
        if (!run || run.modeId !== "goal") return;
        try {
          await this.control({ sessionId, runId: run.id, expectedRevision: run.revision, action: "stop" });
          return;
        } catch (error) {
          const code = (error as { errorCode?: string; data?: { errorCode?: string } }).errorCode ??
            (error as { data?: { errorCode?: string } }).data?.errorCode;
          if (code !== "MODE_REVISION_CONFLICT" || attempt === 2) throw error;
        }
      }
    },

    /** Release a claim whose turn never reached the sidecar. */
    async abandonTurn(sessionId: string, turnId: string): Promise<void> {
      await this.settleTurn(sessionId, turnId, { reason: "aborted" });
    },

    async settleTurn(sessionId: string, turnId: string, end: ModeTurnEnd): Promise<void> {
      const entry = turnRuns.get(turnId);
      if (!entry || entry.sessionId !== sessionId) {
        const { run } = await this.get(sessionId);
        if (run?.modeId === "goal" && run.state === "running" && !run.activeTurnId) scheduleContinuation(sessionId, "host");
        return;
      }
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
      const warn = (message: string) => (error: unknown) => {
        deps.logger.app("session", "warn", message, { sessionId: request.sessionId, data: String(error) });
      };
      if (active) {
        const [turnId] = active;
        if (request.action === "stop") {
          await deps.abortTurn(request.sessionId).catch(warn("mode run stop could not abort the turn"));
        } else if (request.action === "pause" && result.run?.state === "paused" && result.run.revision !== request.expectedRevision) {
          // Pause takes effect now: the turn wraps up instead of working on.
          await deps.notifyTurn(request.sessionId, turnId, { runId: request.runId, action: "closeout" })
            .catch(warn("mode run pause could not close out the turn"));
        } else if (request.action === "remove") {
          // The session already returned to its return mode in the Host.
          await (async () => {
            const definition = result.run ? await deps.catalog.definition(result.run.modeId) : undefined;
            const returnTo = definition?.returnTo ?? "agent";
            const returnDefinition = await deps.catalog.definition(returnTo);
            // A deleted return mode falls back to Agent, as settleReturn does.
            const mode = returnDefinition || isPlainMode(returnTo) ? returnTo : "agent";
            const modeDefinition = mode === returnTo ? returnDefinition : undefined;
            await deps.notifyTurn(request.sessionId, turnId, {
              runId: request.runId,
              action: "release",
              mode,
              ...(modeDefinition ? { modeDefinition } : {}),
            });
          })().catch(warn("mode run remove could not release the turn"));
        }
      }
      if (result.continue) scheduleContinuation(request.sessionId, "approval");
      return result;
    },

    /** Edit the objective or budget of an open run; applies from the next claim. */
    async update(request: ModeUpdateRequest): Promise<ModeSettleResult> {
      return host().call<ModeSettleResult>("modes.update", request);
    },

    async resolve(request: ModeResolveRequest): Promise<ModeSettleResult> {
      const result = await host().call<ModeSettleResult>("modes.resolve", request);
      if (result.continue) scheduleContinuation(request.sessionId, "approval");
      return result;
    },

    /**
     * After a run closed, the Host left the session on the run's `returnTo`
     * without a snapshot (#2204). Hand it that mode's current definition, or
     * let it fall back to Agent when the mode no longer exists. Returns
     * whether the session's mode row changed.
     */
    async settleReturn(sessionId: string, run: { id: string; state: string }): Promise<boolean> {
      if (run.state !== "finished" && run.state !== "stopped") return false;
      const hostCaller = host();
      const { pending } = await hostCaller.call<ModeSettleReturnResult>("modes.settleReturn", { sessionId, runId: run.id });
      if (!pending) return false;
      const modeSnapshot = await deps.catalog.definition(pending);
      const { applied } = await hostCaller.call<ModeSettleReturnResult>("modes.settleReturn", {
        sessionId,
        runId: run.id,
        mode: pending,
        ...(modeSnapshot ? { modeSnapshot } : {}),
      });
      if (applied && applied !== pending) {
        deps.logger.app("session", "warn", "mode run return mode no longer exists; session uses agent", {
          sessionId,
          data: pending,
        });
      }
      return Boolean(applied);
    },

    /** Test seam and diagnostics. */
    claimedTurns: (): ReadonlyMap<string, { sessionId: string; runId: string }> => turnRuns,
  };
}

import { randomUUID } from "node:crypto";
import type { GoalPort, HostRpcPort } from "@pi-desktop/agent-host";
import type { GoalBudget, GoalControlRequest, GoalResult, GoalTurnContext, SessionGoal } from "@pi-desktop/shared";

/** Shared by Electron and headless; SQLite remains authoritative in Rust. */
export class GoalCoordinator implements GoalPort {
  private readonly inhibited = new Set<string>();
  private readonly stopVersions = new Map<string, number>();
  constructor(private readonly getHost: () => HostRpcPort | null) {}
  private host(): HostRpcPort {
    const host = this.getHost();
    if (!host) throw new Error("Goal host unavailable");
    return host;
  }
  inhibit(sessionId: string): void {
    this.inhibited.add(sessionId);
    this.stopVersions.set(sessionId, (this.stopVersions.get(sessionId) ?? 0) + 1);
  }
  permit(sessionId: string): void { this.inhibited.delete(sessionId); }
  isInhibited(sessionId: string): boolean { return this.inhibited.has(sessionId); }
  async get(sessionId: string): Promise<SessionGoal | null> {
    return (await this.host().call<GoalResult>("goals.get", { sessionId })).goal;
  }
  async start(sessionId: string, objective: string, budget?: GoalBudget): Promise<SessionGoal> {
    const stopVersion = this.stopVersions.get(sessionId) ?? 0;
    const { goal } = await this.host().call<GoalResult>("goals.start", { sessionId, objective, ...(budget !== undefined ? { budget } : {}) });
    if (!goal) throw new Error("Host did not persist the goal");
    if ((this.stopVersions.get(sessionId) ?? 0) !== stopVersion) {
      const paused = await this.control({ sessionId, goalId: goal.id, expectedRevision: goal.revision, action: "pause" });
      if (!paused.goal) throw new Error("Host did not confirm the interrupted goal startup");
      return paused.goal;
    }
    this.permit(sessionId);
    return goal;
  }
  async control(request: GoalControlRequest): Promise<GoalResult> {
    if (["pause", "stop", "cancel", "delete"].includes(request.action)) this.inhibit(request.sessionId);
    const stopVersion = this.stopVersions.get(request.sessionId) ?? 0;
    const result = await this.host().call<GoalResult>("goals.control", { ...request });
    if (request.action === "resume" && result.goal?.status === "active" &&
        (this.stopVersions.get(request.sessionId) ?? 0) === stopVersion) this.permit(request.sessionId);
    return result;
  }
  async claim(goal: SessionGoal, provenance: GoalTurnContext["provenance"]): Promise<GoalTurnContext | undefined> {
    if (this.isInhibited(goal.sessionId) || goal.status !== "active" || goal.activeTurnId || goal.pauseRequested) return undefined;
    const turnId = randomUUID();
    const result = await this.host().call<GoalResult & { claimed: boolean }>("goals.claimTurn", {
      sessionId: goal.sessionId, goalId: goal.id, expectedRevision: goal.revision, turnId,
    });
    if (!result.claimed) return undefined;
    const context: GoalTurnContext = { goalId: goal.id, turnId, provenance };
    if (this.isInhibited(goal.sessionId)) {
      await this.host().call("goals.settleTurn", { sessionId: goal.sessionId, goalId: goal.id, turnId, tokens: 0, aborted: true });
      return undefined;
    }
    return context;
  }
  async fail(sessionId: string, context: GoalTurnContext, error: unknown): Promise<void> {
    this.inhibit(sessionId);
    await this.host().call("goals.settleTurn", {
      sessionId, goalId: context.goalId, turnId: context.turnId, tokens: 0,
      error: error instanceof Error ? error.message : "Goal dispatch failed",
    });
  }
}

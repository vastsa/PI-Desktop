import { describe, expect, it, vi } from "vitest";
import type { HostRpcPort } from "@pi-desktop/agent-host";
import type { GoalResult, SessionGoal } from "@pi-desktop/shared";
import { GoalCoordinator } from "./goal-coordinator.js";

const goal: SessionGoal = { id: "g", sessionId: "s", revision: 1, status: "active", objective: "test", criteria: ["test"], progressSummary: "", outcomes: [], roundsStarted: 0, tokenUsage: 0, budget: { maxTurns: 20 } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
describe("GoalCoordinator budget ingress", () => {
  it("delegates defaults to Rust, preserves explicit unlimited and never turns invalid null into omission", async () => {
    const calls: unknown[] = [];
    const coordinator = new GoalCoordinator(() => ({
      async call<T>(_method: string, params?: unknown): Promise<T> { calls.push(params); return { goal } as T; },
    }));
    await coordinator.start("s", "test");
    await coordinator.start("s", "test", { maxTurns: null });
    await Reflect.apply(coordinator.start, coordinator, ["s", "test", null]);
    expect(calls).toEqual([
      { sessionId: "s", objective: "test" },
      { sessionId: "s", objective: "test", budget: { maxTurns: null } },
      { sessionId: "s", objective: "test", budget: null },
    ]);
  });
});
describe("GoalCoordinator cancellation fences", () => {
  it("does not clear a stop that arrived while goal creation was pending", async () => {
    const pending = deferred<GoalResult>();
    const calls: string[] = [];
    const host: HostRpcPort = { async call<T>(method: string): Promise<T> {
      calls.push(method);
      if (method === "goals.start") return await pending.promise as T;
      return { goal: { ...goal, status: "paused", revision: 2 } } as T;
    } };
    const coordinator = new GoalCoordinator(() => host);
    const start = coordinator.start("s", "test");
    coordinator.inhibit("s");
    pending.resolve({ goal });
    const result = await start;
    expect(result.status).toBe("paused");
    expect(coordinator.isInhibited("s")).toBe(true);
    expect(calls).toContain("goals.control");
  });
  it("does not clear a newer stop while resume persistence is pending", async () => {
    const pending = deferred<GoalResult>();
    const coordinator = new GoalCoordinator(() => ({ call: vi.fn(() => pending.promise) } as HostRpcPort));
    const resume = coordinator.control({ sessionId: "s", goalId: "g", expectedRevision: 0, action: "resume" });
    coordinator.inhibit("s");
    pending.resolve({ goal });
    await resume;
    expect(coordinator.isInhibited("s")).toBe(true);
  });
  it("settles an unused claim if pause arrives before the claim reply", async () => {
    const pending = deferred<GoalResult & { claimed: boolean }>();
    const calls: Array<{ method: string; params: unknown }> = [];
    const host: HostRpcPort = { async call<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      return (method === "goals.claimTurn" ? await pending.promise : { goal }) as T;
    } };
    const coordinator = new GoalCoordinator(() => host);
    const claim = coordinator.claim(goal, "goal-continuation");
    coordinator.inhibit("s");
    pending.resolve({ goal, claimed: true });
    expect(await claim).toBeUndefined();
    expect(calls[1]).toMatchObject({ method: "goals.settleTurn", params: { aborted: true, tokens: 0 } });
  });
});

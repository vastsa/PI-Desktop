import { describe, expect, it, vi } from "vitest";
import type { GoalBudget, GoalControlRequest, GoalTurnContext, SessionGoal } from "@pi-desktop/shared";
import { AgentHost } from "./agent-host.js";
import { MemoryQueueStore, type GoalPort, type Principal, type RuntimePort, type TurnStartRequest } from "./ports.js";

const owner: Principal = { subject: "desktop", roles: ["owner"], pairedDevice: true };
class Goals implements GoalPort {
  goal: SessionGoal | null = null;
  blocked = false;
  inhibit() { this.blocked = true; }
  permit() { this.blocked = false; }
  isInhibited() { return this.blocked; }
  async get() { return this.goal ? structuredClone(this.goal) : null; }
  async start(sessionId: string, objective: string, budget: GoalBudget = { maxTurns: 20 }) {
    this.permit();
    this.goal = { id: "goal", sessionId, objective, criteria: [objective], revision: 1, status: "active",
      roundsStarted: 0, tokenUsage: 0, budget, progressSummary: "", outcomes: [] };
    return structuredClone(this.goal);
  }
  async control(req: GoalControlRequest) {
    if (!this.goal || req.goalId !== this.goal.id || req.expectedRevision !== this.goal.revision) throw new Error("stale");
    if (req.action === "edit") {
      if (["completed", "cancelled"].includes(this.goal.status)) throw new Error("not editable");
      this.goal.objective = req.objective!;
      this.goal.criteria = [req.objective!];
      this.goal.progressSummary = "";
      this.goal.outcomes = [];
      this.goal.audit = undefined;
    }
    if (req.action === "delete") {
      const { id: goalId, revision } = this.goal;
      this.goal = null;
      return { goal: null, goalId, revision: revision + 1 };
    }
    if (req.action === "pause" && this.goal.activeTurnId) this.goal.pauseRequested = true;
    else if (req.action === "pause" || req.action === "stop") this.goal.status = "paused";
    else if (req.action === "resume") { this.goal.status = "active"; this.goal.pauseRequested = false; }
    else if (req.action === "cancel") this.goal.status = "cancelled";
    else if (req.action === "budget") this.goal.pendingBudget = req.budget;
    this.goal.revision++;
    if (req.action === "resume") this.permit();
    return { goal: structuredClone(this.goal) };
  }
  async claim(goal: SessionGoal, provenance: GoalTurnContext["provenance"]) {
    if (!this.goal || this.blocked || this.goal.status !== "active" || this.goal.activeTurnId || goal.revision !== this.goal.revision) return;
    if (this.goal.budget.maxTurns !== null && this.goal.roundsStarted >= this.goal.budget.maxTurns) { this.goal.status = "budget_exhausted"; return; }
    const turnId = `claim-${++this.goal.roundsStarted}`;
    this.goal.activeTurnId = turnId;
    this.goal.revision++;
    return { goalId: goal.id, turnId, provenance };
  }
  async fail(_sessionId: string, context: GoalTurnContext, _error: unknown) {
    if (this.goal?.id !== context.goalId || this.goal.activeTurnId !== context.turnId) return;
    if (this.goal.status === "active") this.goal.status = "blocked";
    this.goal.activeTurnId = undefined;
    this.goal.revision++;
  }
  settle(status: SessionGoal["status"] = "active") {
    if (!this.goal) throw new Error("missing goal");
    this.goal.activeTurnId = undefined;
    if (this.goal.status === "active") this.goal.status = this.goal.pauseRequested ? "paused" : status;
    this.goal.pauseRequested = false;
    this.goal.revision++;
  }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function harness() {
  const goals = new Goals();
  const prompts: TurnStartRequest[] = [];
  let mode: "agent" | "plan" | "goal" = "goal";
  const store = new MemoryQueueStore();
  const getSession = vi.fn(async (id: string) => ({ id, title: "Test", mode, permissionMode: "ask" as const, createdAt: "", updatedAt: "" }));
  const runtime: RuntimePort = {
    async prompt(req) { prompts.push(req); return { turnId: `runtime-${prompts.length}` }; },
    stop: vi.fn(async () => ({ requested: true })), abort: vi.fn(async () => {}), respondInput: vi.fn(async () => {}),
  };
  const host = new AgentHost({ runtime, goals, queueStore: store, sessions: {
    get: getSession,
    async history() { return { items: [], hasMore: false }; },
  }, approvals: { async resolveTool() {}, async resolveContract() {}, async listPendingTools() { return []; } } });
  return { host, goals, prompts, runtime, store, getSession, setMode(next: typeof mode) { mode = next; } };
}
const start = (host: AgentHost) => host.startGoal(owner, { sessionId: "s", input: { text: "Verify the tests" }, context: { requestId: "start" } });

describe("autonomous Goal session admission", () => {
  it.each(["pause", "cancel"] as const)("fences delayed first dispatch on %s and settles the unused claim", async action => {
    const { host, goals, prompts, runtime, getSession } = harness();
    const entered = deferred();
    const release = deferred();
    const read = getSession.getMockImplementation()!;
    let delayed = false;
    getSession.mockImplementation(async id => {
      if (goals.goal?.activeTurnId === "claim-1" && !delayed) {
        delayed = true;
        entered.resolve();
        await release.promise;
      }
      return read(id);
    });
    const control = vi.spyOn(goals, "control");
    const fail = vi.spyOn(goals, "fail");
    const startup = start(host).catch((error: unknown) => error);
    await entered.promise;
    const request = { sessionId: "s", goalId: "goal", expectedRevision: goals.goal!.revision, action };
    const stopped = host.controlGoal(owner, request).catch((error: unknown) => error);
    expect(goals.isInhibited()).toBe(true);
    expect(runtime.abort).not.toHaveBeenCalled();
    const queued = host.enqueueTurn(owner, { sessionId: "s", input: { text: "Keep this user work" }, context: { requestId: "queued" } });
    release.resolve();
    expect(await startup).toMatchObject({ code: "CONFLICT" });
    // Unused-claim settlement advances the revision; never rewrite the owner's CAS.
    expect(await stopped).toBeInstanceOf(Error);
    expect(control).toHaveBeenCalledExactlyOnceWith(request);
    expect(fail).toHaveBeenCalledWith("s", { goalId: "goal", turnId: "claim-1", provenance: "user-goal" }, expect.any(Error));
    await queued;
    await host.controlGoal(owner, { ...request, expectedRevision: goals.goal!.revision });
    expect(goals.goal?.status).toBe(action === "cancel" ? "cancelled" : "paused");
    expect(goals.goal?.activeTurnId).toBeUndefined();
    if (action === "cancel") expect(runtime.abort).toHaveBeenCalledWith("s");
    else expect(runtime.abort).not.toHaveBeenCalled();
    expect(prompts).toEqual([]);
    expect(host.queueEntries("s").map(entry => entry.content)).toEqual(["Keep this user work"]);
    expect((await host.workSnapshot("s")).state).toBe("idle");
  });

  it.each(["pause", "cancel"] as const)("keeps queued user order when %s arrives before claimed dispatch", async action => {
    const { host, goals, prompts, store } = harness();
    await start(host);
    const first = await host.enqueueTurn(owner, { sessionId: "s", input: { text: "First correction" }, context: { requestId: "first" } });
    const second = await host.enqueueTurn(owner, { sessionId: "s", input: { text: "Second correction" }, context: { requestId: "second" } });
    const before = await store.listAll();
    const entered = deferred();
    const release = deferred();
    const claim = goals.claim.bind(goals);
    vi.spyOn(goals, "claim").mockImplementationOnce(async (goal, provenance) => {
      const context = await claim(goal, provenance);
      entered.resolve();
      await release.promise;
      return context;
    });
    goals.settle();
    host.endTurn("s", "runtime-1", "completed");
    const drained = host.kick("s");
    await entered.promise;
    const stopped = host.controlGoal(owner, { sessionId: "s", goalId: "goal", expectedRevision: goals.goal!.revision, action }).catch((error: unknown) => error);
    release.resolve();
    await drained;
    await stopped;
    expect(prompts).toHaveLength(1);
    expect(goals.goal?.activeTurnId).toBeUndefined();
    expect(host.queueEntries("s").map(entry => entry.content)).toEqual(["First correction", "Second correction"]);
    expect(await store.listAll()).toEqual(before);
    expect(host.getTurn(first.turn.id).status).toBe("queued");
    expect(host.getTurn(second.turn.id).status).toBe("queued");
  });

  it.each(["startTurn", "enqueueTurn"] as const)("rejects idle Goal collaboration at %s before durable execution", async ingress => {
    const { host, goals, prompts, store } = harness();
    await expect(host[ingress](owner, {
      sessionId: "s", admission: "queue", input: { text: "Autonomous collaboration", sessionMessageId: "message-1" }, context: { requestId: "message-1" },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(prompts).toEqual([]);
    expect(await store.listAll()).toEqual([]);
    expect(goals.goal).toBeNull();
    expect((await host.workSnapshot("s")).state).toBe("idle");
    await start(host);
    expect(prompts[0].goalTurn?.provenance).toBe("user-goal");
  });

  it.each(["startTurn", "enqueueTurn"] as const)("rejects busy Goal collaboration at %s without overtaking user corrections", async ingress => {
    const { host, goals, prompts } = harness();
    await start(host);
    await host.enqueueTurn(owner, { sessionId: "s", admission: "queue", input: { text: "User correction" }, context: { requestId: "user" } });
    const before = await goals.get();
    await expect(host[ingress](owner, {
      sessionId: "s", admission: "queue", input: { text: "Autonomous collaboration", sessionMessageId: "message-1" }, context: { requestId: "message-1" },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await goals.get()).toEqual(before);
    expect(host.queueEntries("s").map(entry => entry.content)).toEqual(["User correction"]);
    goals.settle(); host.endTurn("s", "runtime-1", "completed");
    await host.kick("s");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatchObject({ content: "User correction", goalTurn: { provenance: "user-goal" } });
    expect(prompts[1].sessionMessageId).toBeUndefined();
  });

  it("requires explicit Goal ingress and rejects an unpaired autonomous controller's queue input", async () => {
    const { host, prompts } = harness();
    await expect(host.startTurn(owner, { sessionId: "s", input: { text: "No claim" }, context: { requestId: "ordinary" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await start(host);
    await expect(host.enqueueTurn({ subject: "automation", roles: ["controller"] }, {
      sessionId: "s", input: { text: "Not user-authorized" }, context: { requestId: "automation" },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(prompts).toHaveLength(1);
    expect(host.queueEntries("s")).toEqual([]);
  });

  it.each(["agent", "plan"] as const)("preserves idle and busy %s collaboration delivery", async mode => {
    const { host, goals, prompts, setMode } = harness();
    setMode(mode);
    await host.startTurn(owner, { sessionId: "s", admission: "queue", input: { text: "First message", sessionMessageId: "message-1" }, context: { requestId: "message-1" } });
    const queued = await host.startTurn(owner, { sessionId: "s", admission: "queue", input: { text: "Second message", sessionMessageId: "message-2" }, context: { requestId: "message-2" } });
    expect(queued.turn.status).toBe("queued");
    host.endTurn("s", "runtime-1", "completed");
    await host.kick("s");
    expect(prompts.map(prompt => prompt.sessionMessageId)).toEqual(["message-1", "message-2"]);
    expect(prompts.every(prompt => !prompt.goalTurn)).toBe(true);
    expect(goals.goal).toBeNull();
    expect(host.queueEntries("s")).toEqual([]);
  });

  it("does not replay a dispatched Goal queue entry when durable cleanup is retried", async () => {
    const { host, goals, prompts, store } = harness();
    await start(host);
    await host.enqueueTurn(owner, { sessionId: "s", input: { text: "Correction" }, context: { requestId: "correction" } });
    vi.spyOn(store, "remove").mockRejectedValueOnce(new Error("Queue storage unavailable"));
    goals.settle(); host.endTurn("s", "runtime-1", "completed");
    await host.kick("s");
    expect(prompts).toHaveLength(2);
    expect(host.queueEntries("s")).toHaveLength(1);
    goals.settle("completed"); host.endTurn("s", "runtime-2", "completed");
    await host.kick("s");
    expect(prompts).toHaveLength(2);
    expect(host.queueEntries("s")).toEqual([]);
    expect(await store.listAll()).toEqual([]);
  });

  it("holds an existing collaboration queue after switching to unauthorized Goal mode", async () => {
    const { host, goals, prompts, setMode } = harness();
    setMode("agent");
    await host.startTurn(owner, { sessionId: "s", input: { text: "User work" }, context: { requestId: "user" } });
    await host.startTurn(owner, { sessionId: "s", admission: "queue", input: { text: "Collaboration", sessionMessageId: "message-1" }, context: { requestId: "message-1" } });
    setMode("goal");
    host.endTurn("s", "runtime-1", "completed");
    await host.kick("s");
    expect(prompts).toHaveLength(1);
    expect(goals.goal).toBeNull();
    expect(host.queueEntries("s")[0]?.sessionMessageId).toBe("message-1");
  });

  it("starts directly, continues an unfinished turn, and does not start after completion", async () => {
    const { host, goals, prompts } = harness();
    await start(host);
    expect(prompts[0].goalTurn?.provenance).toBe("user-goal");
    expect(goals.goal?.roundsStarted).toBe(1);
    goals.settle();
    host.endTurn("s", "runtime-1", "completed");
    await host.kick("s");
    expect(prompts).toHaveLength(2);
    expect(prompts[1].goalTurn?.provenance).toBe("goal-continuation");
    goals.settle("completed");
    host.endTurn("s", "runtime-2", "completed");
    await host.kick("s");
    expect(prompts).toHaveLength(2);
  });
  it("gives queued user input priority and ignores duplicate old terminal events", async () => {
    const { host, goals, prompts } = harness();
    await start(host);
    await host.startTurn(owner, { sessionId: "s", admission: "queue", input: { text: "User correction" }, context: { requestId: "user" } });
    goals.settle();
    host.endTurn("s", "runtime-1", "completed");
    await host.kick("s");
    expect(prompts[1].content).toBe("User correction");
    expect(prompts[1].goalTurn?.provenance).toBe("user-goal");
    expect(goals.goal?.roundsStarted).toBe(2);
    host.ingest({ sessionId: "s", turnId: "runtime-1", ts: 1, event: { type: "agent_end", messageIds: [] } });
    await host.kick("s");
    expect(prompts).toHaveLength(2);
    expect((await host.workSnapshot("s")).activeTurnId).toBeDefined();
  });
  it("admits an explicit user's queued correction through ordinary input", async () => {
    const { host, goals, prompts } = harness();
    await start(host);
    const queued = await host.enqueueTurn(owner, { sessionId: "s", admission: "queue", input: { text: "Verify edge cases too" }, context: { requestId: "queued" } });
    expect(queued.turn.status).toBe("queued");
    goals.settle(); host.endTurn("s", "runtime-1", "completed");
    await host.kick("s");
    expect(prompts[1].content).toBe("Verify edge cases too");
    expect(goals.goal?.roundsStarted).toBe(2);
  });
  it("blocks the independent goal after a sidecar crash", async () => {
    const { host, goals, prompts } = harness();
    await start(host);
    host.endTurn("s", "runtime-1", "interrupted", { error: { code: "AGENT_SIDECAR_CRASHED", message: "sidecar crashed", retriable: false, traceId: "" } });
    await host.kick("s");
    expect(goals.goal?.status).toBe("blocked");
    expect(goals.goal?.activeTurnId).toBeUndefined();
    expect(prompts).toHaveLength(1);
  });
  it("keeps queued input untouched after cancellation", async () => {
    const { host, goals, prompts } = harness();
    await start(host);
    await host.enqueueTurn(owner, { sessionId: "s", input: { text: "User correction" }, context: { requestId: "user" } });
    await host.controlGoal(owner, { sessionId: "s", goalId: "goal", expectedRevision: goals.goal!.revision, action: "cancel" });
    goals.settle(); host.endTurn("s", "runtime-1", "interrupted");
    await host.kick("s");
    expect(prompts).toHaveLength(1);
    expect(host.queueEntries("s")).toHaveLength(1);
  });
  it("reconciles a repeated start without claiming another round", async () => {
    const { host, goals, prompts } = harness();
    const request = { sessionId: "s", idempotencyKey: "same", input: { text: "Verify tests" }, context: { requestId: "start" } };
    const first = await host.startGoal(owner, request);
    const repeated = await host.startGoal(owner, request);
    expect(repeated.turn.id).toBe(first.turn.id);
    expect(prompts).toHaveLength(1);
    expect(goals.goal?.roundsStarted).toBe(1);
  });
  it("holds queued goal work after pause until explicit resume", async () => {
    const { host, goals, prompts } = harness();
    await start(host);
    await host.enqueueTurn(owner, { sessionId: "s", input: { text: "User correction" }, context: { requestId: "user" } });
    await host.controlGoal(owner, { sessionId: "s", goalId: "goal", expectedRevision: goals.goal!.revision, action: "pause" });
    goals.settle(); host.endTurn("s", "runtime-1", "interrupted");
    await host.kick("s");
    expect(prompts).toHaveLength(1);
    expect(host.queueEntries("s")).toHaveLength(1);
    await host.controlGoal(owner, { sessionId: "s", goalId: "goal", expectedRevision: goals.goal!.revision, action: "resume" });
    expect(prompts).toHaveLength(2);
    expect(prompts[1].goalTurn?.provenance).toBe("user-goal");
  });
  it("persists immediate Stop before cancellation and suppresses late completion", async () => {
    const { host, goals, prompts, runtime } = harness();
    await start(host);
    await host.controlGoal(owner, { sessionId: "s", goalId: "goal", expectedRevision: goals.goal!.revision, action: "stop" });
    expect(goals.goal?.status).toBe("paused");
    expect(runtime.abort).toHaveBeenCalledWith("s");
    goals.settle();
    host.endTurn("s", "runtime-1", "completed");
    await host.kick("s");
    expect(prompts).toHaveLength(1);
    await start(host);
    expect(prompts).toHaveLength(2);
    expect(goals.goal?.status).toBe("active");
  });
  it("never starts solely on mode selection, and requires user authority", async () => {
    const { host, prompts } = harness();
    host.kick("s");
    await host.kick("s");
    expect(prompts).toHaveLength(0);
    await expect(host.startGoal({ subject: "plugin", roles: ["controller"] }, { sessionId: "s", input: { text: "work" }, context: { requestId: "x" } })).rejects.toThrow();
  });
  it("fails closed on a stale pause rather than continuing", async () => {
    const { host, goals, prompts, runtime } = harness();
    await start(host);
    await expect(host.controlGoal(owner, { sessionId: "s", goalId: "goal", expectedRevision: 0, action: "pause" })).rejects.toThrow("stale");
    expect(runtime.abort).not.toHaveBeenCalled();
    goals.settle(); host.endTurn("s", "runtime-1", "completed");
    await host.kick("s");
    expect(prompts).toHaveLength(1);
  });
});

describe("owner Goal editing and logical removal", () => {
  it.each(["edit", "delete"] as const)("rejects non-owner/unpaired %s before fencing or persistence", async action => {
    const { host, goals, runtime } = harness();
    const control = vi.spyOn(goals, "control");
    for (const principal of [
      { subject: "plugin", roles: ["controller"] },
      { subject: "unpaired", roles: ["owner"] },
      { subject: "controller", roles: ["controller"], pairedDevice: true },
    ] satisfies Principal[]) {
      await expect(host.controlGoal(principal, { sessionId: "s", goalId: "goal", expectedRevision: 1, action, ...(action === "edit" ? { objective: "new" } : {}) })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(control).not.toHaveBeenCalled();
    expect(runtime.abort).not.toHaveBeenCalled();
    expect(goals.isInhibited()).toBe(false);
  });

  it("edits settled paused work without aborting or prompting until explicit resume", async () => {
    const { host, goals, prompts, runtime } = harness();
    await start(host);
    await host.controlGoal(owner, { sessionId: "s", goalId: "goal", expectedRevision: goals.goal!.revision, action: "pause" });
    goals.settle(); host.endTurn("s", "runtime-1", "interrupted");
    vi.mocked(runtime.abort).mockClear();
    const result = await host.controlGoal(owner, { sessionId: "s", goalId: "goal", expectedRevision: goals.goal!.revision, action: "edit", objective: "New exact scope" });
    expect(result.goal).toMatchObject({ objective: "New exact scope", criteria: ["New exact scope"], status: "paused", roundsStarted: 1 });
    expect(runtime.abort).not.toHaveBeenCalled();
    await host.kick("s");
    expect(prompts).toHaveLength(1);
    await host.controlGoal(owner, { sessionId: "s", goalId: "goal", expectedRevision: goals.goal!.revision, action: "resume" });
    expect(prompts).toHaveLength(2);
  });

  it("persists active removal before abort, preserves queued work and blocks late continuation", async () => {
    const { host, goals, prompts, runtime } = harness();
    await start(host);
    await host.enqueueTurn(owner, { sessionId: "s", input: { text: "Retain this correction" }, context: { requestId: "queued" } });
    const entered = deferred(); const release = deferred();
    const persist = goals.control.bind(goals);
    vi.spyOn(goals, "control").mockImplementationOnce(async request => {
      entered.resolve(); await release.promise;
      return persist(request);
    });
    vi.mocked(runtime.abort).mockImplementation(async () => { expect(goals.goal).toBeNull(); });
    const removal = host.controlGoal(owner, { sessionId: "s", goalId: "goal", expectedRevision: goals.goal!.revision, action: "delete" });
    await entered.promise;
    expect(goals.isInhibited()).toBe(true);
    expect(runtime.abort).not.toHaveBeenCalled();
    release.resolve();
    expect(await removal).toEqual({ goal: null, goalId: "goal", revision: 3 });
    expect(runtime.abort).toHaveBeenCalledWith("s");
    host.endTurn("s", "runtime-1", "completed"); await host.kick("s");
    expect(prompts).toHaveLength(1);
    expect(host.queueEntries("s").map(entry => entry.content)).toEqual(["Retain this correction"]);
  });
  it("keeps the delete fence when initial dispatch settlement makes the owner's CAS stale", async () => {
    const { host, goals, prompts, runtime, getSession } = harness();
    const entered = deferred(); const release = deferred();
    const read = getSession.getMockImplementation()!;
    let delayed = false;
    getSession.mockImplementation(async id => {
      if (goals.goal?.activeTurnId && !delayed) {
        delayed = true; entered.resolve(); await release.promise;
      }
      return read(id);
    });
    const startup = start(host).catch((error: unknown) => error);
    await entered.promise;
    const request = { sessionId: "s", goalId: "goal", expectedRevision: goals.goal!.revision, action: "delete" as const };
    const removal = host.controlGoal(owner, request).catch((error: unknown) => error);
    expect(goals.isInhibited()).toBe(true);
    expect(runtime.abort).not.toHaveBeenCalled();
    release.resolve();
    expect(await startup).toMatchObject({ code: "CONFLICT" });
    expect(await removal).toBeInstanceOf(Error);
    expect(goals.goal?.activeTurnId).toBeUndefined();
    expect(prompts).toEqual([]);
    await host.controlGoal(owner, { ...request, expectedRevision: goals.goal!.revision });
    expect(goals.goal).toBeNull();
    await host.kick("s");
    expect(prompts).toEqual([]);
  });
});

it("Goal pause finishes the current round; hot edits and budget updates do not inhibit it", async () => {
  const { host, goals, runtime, prompts } = harness(); await start(host);
  const req = () => ({ sessionId: "s", goalId: "goal", expectedRevision: goals.goal!.revision });
  await host.controlGoal(owner, { ...req(), action: "edit", objective: "Revised authorized objective" });
  expect(goals.isInhibited()).toBe(false); expect(goals.goal?.status).toBe("active");
  await host.controlGoal(owner, { ...req(), action: "budget", budget: { maxTurns: null } });
  expect(goals.isInhibited()).toBe(false);
  await host.controlGoal(owner, { ...req(), action: "pause" });
  expect(runtime.abort).not.toHaveBeenCalled(); expect(goals.goal?.status).toBe("active");
  expect(goals.goal?.pauseRequested).toBe(true);
  goals.settle(); host.endTurn("s", "runtime-1", "completed"); await host.kick("s");
  expect(goals.goal?.status).toBe("paused"); expect(prompts).toHaveLength(1);
});


describe("Goal execution independent of Composer preference", () => {
  it.each(["agent", "plan", "goal"] as const)("continues after selecting %s without pausing or aborting", async mode => {
    const { host, goals, prompts, runtime, setMode } = harness();
    await start(host); setMode(mode);
    goals.settle(); host.endTurn("s", "runtime-1", "completed"); await host.kick("s");
    expect(goals.goal?.status).toBe("active");
    expect(prompts[1]?.goalTurn?.provenance).toBe("goal-continuation");
    expect(runtime.abort).not.toHaveBeenCalled();
  });

  it("resumes a paused Goal after ordinary Agent work", async () => {
    const { host, goals, prompts, setMode } = harness();
    await start(host);
    await host.controlGoal(owner, { sessionId: "s", goalId: "goal", expectedRevision: goals.goal!.revision, action: "pause" });
    goals.settle(); host.endTurn("s", "runtime-1", "completed"); await host.kick("s");
    setMode("agent");
    await host.startTurn(owner, { sessionId: "s", input: { text: "An ordinary task" }, context: { requestId: "ordinary" } });
    expect(prompts[1].goalTurn).toBeUndefined();
    host.endTurn("s", "runtime-2", "completed"); await host.kick("s");
    expect(goals.goal?.status).toBe("paused");
    await host.controlGoal(owner, { sessionId: "s", goalId: "goal", expectedRevision: goals.goal!.revision, action: "resume" });
    expect(prompts[2]?.goalTurn?.provenance).toBe("goal-continuation");
    expect(goals.goal?.status).toBe("active");
  });

  it("replaces a paused unfinished Goal with a fresh explicit objective", async () => {
    const { host, goals, prompts } = harness(); await start(host);
    await host.controlGoal(owner, { sessionId: "s", goalId: "goal", expectedRevision: goals.goal!.revision, action: "pause" });
    goals.settle(); host.endTurn("s", "runtime-1", "completed"); await host.kick("s");
    await host.startGoal(owner, { sessionId: "s", input: { text: "A new objective" }, context: { requestId: "replacement" } });
    expect(goals.goal).toMatchObject({ objective: "A new objective", roundsStarted: 1, status: "active" });
    expect(prompts[1]).toMatchObject({ content: "A new objective", goalTurn: { provenance: "user-goal" } });
  });

  it("replaces active work only after abort/drain and retains the explicit new prompt", async () => {
    const { host, goals, prompts, runtime } = harness(); await start(host);
    const replaced = await host.startGoal(owner, { sessionId: "s", admission: "queue", input: { text: "Replacement while running" }, context: { requestId: "replacement" } });
    expect(replaced.turn.status).toBe("queued");
    expect(goals.goal?.objective).toBe("Replacement while running");
    expect(runtime.abort).toHaveBeenCalledWith("s", undefined, "goal-replaced"); expect(prompts).toHaveLength(1);
    host.endTurn("s", "runtime-1", "interrupted"); await host.kick("s");
    expect(prompts[1]).toMatchObject({ content: "Replacement while running", goalTurn: { provenance: "user-goal" } });
    expect(goals.goal?.roundsStarted).toBe(1);
  });
});


it("immediate guidance retains the Goal claim and autonomous continuation in Agent input mode", async () => {
  const { host, goals, runtime, prompts, setMode } = harness();
  const steer = vi.fn(async () => ({ accepted: true })); runtime.steer = steer;
  await start(host); setMode("agent"); const claim = goals.goal!.activeTurnId;
  const queued = await host.enqueueTurn(owner, { sessionId: "s", input: { text: "New guidance" }, context: { requestId: "guidance" } });
  await host.prioritizeTurn(owner, queued.turn.id);
  expect(steer).toHaveBeenCalledWith(expect.objectContaining({ content: "New guidance", turnId: "runtime-1" }));
  expect(goals.goal).toMatchObject({ activeTurnId: claim, status: "active", roundsStarted: 1 });
  expect(runtime.abort).not.toHaveBeenCalled(); expect(host.queueEntries("s")).toEqual([]);
  goals.settle(); host.endTurn("s", "runtime-1", "completed"); await host.kick("s");
  expect(prompts[1].goalTurn?.provenance).toBe("goal-continuation");
});

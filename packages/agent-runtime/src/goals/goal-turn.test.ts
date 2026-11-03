import { describe, expect, it } from "vitest";
import { rpcErrorFromWire, type GoalAudit, type GoalReport, type GoalTurnContext, type SessionGoal } from "@pi-desktop/shared";
import type { RuntimeHost } from "../host-client.js";
import { isRecord } from "../agent-messages.js";
import { GoalTurn, goalTools } from "./goal-turn.js";

const objective = "Repair checkout and verify every supported flow using the referenced design.";
const audit: GoalAudit = { version: 1, objective, items: [
  { requirement: "Repair checkout", outcome: "met", evidence: "Current checkout implementation and regression test inspected" },
  { requirement: "Verify every supported flow using the referenced design", outcome: "met", evidence: "All supported fixture flows exercised against the referenced design" },
], remainingWork: [] };
const completed: GoalReport = { progressSummary: "Verified current state", status: "completed",
  outcomes: [{ criterion: "Checkout passes", outcome: "met", evidence: "Current fixture regression suite passes" }], audit };
const withoutAudit = { progressSummary: completed.progressSummary, status: completed.status, outcomes: completed.outcomes };

function fixture(provenance: GoalTurnContext["provenance"] = "user-goal") {
  let goal: SessionGoal = { id: "goal", sessionId: "session", revision: 1, status: "active", objective,
    criteria: ["Checkout passes"], budget: { maxTurns: null }, progressSummary: "", outcomes: [],
    roundsStarted: 1, tokenUsage: 0, activeTurnId: "turn" };
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let reportError: unknown;
  let validationError: unknown;
  let mismatchedResponse = false;
  const host: RuntimeHost = { call: async <T>(method: string, value?: unknown): Promise<T> => {
    const params = isRecord(value) ? value : {};
    calls.push({ method, params });
    if (method === "goals.validateTurn" && validationError) throw validationError;
    if (method === "goals.report") {
      if (reportError) { const error = reportError; reportError = undefined; throw error; }
      goal = { ...goal, ...params, revision: goal.revision + 1 } as SessionGoal;
    }
    if (method === "goals.settleTurn") goal = { ...goal, activeTurnId: undefined };
    return { goal: mismatchedResponse && method === "goals.report" ? { ...goal, status: "paused" } : structuredClone(goal) } as T;
  } };
  const turn = new GoalTurn(host, "session", { goalId: "goal", turnId: "turn", provenance });
  return { turn, calls, host, get goal() { return goal; },
    rejectReport: (error: unknown) => { reportError = error; },
    rejectValidation: (error: unknown) => { validationError = error; },
    mismatch: () => { mismatchedResponse = true; } };
}

const invalidAudits: Array<[string, unknown]> = [
  ["missing audit", undefined],
  ["null audit", null],
  ["empty items", { ...audit, items: [] }],
  ["too many items", { ...audit, items: Array.from({ length: 101 }, (_, i) => ({ ...audit.items[0], requirement: String(i) })) }],
  ["UTF8 audit byte limit", { ...audit, items: [{ ...audit.items[0], evidence: "é".repeat(50001) }] }],
  ["duplicate trimmed requirement", { ...audit, items: [audit.items[0], { ...audit.items[0], requirement: " Repair checkout " }] }],
  ["blank requirement", { ...audit, items: [{ ...audit.items[0], requirement: "  " }] }],
  ["duplicate requirement", { ...audit, items: [audit.items[0], audit.items[0]] }],
  ["unverified requirement", { ...audit, items: [{ ...audit.items[0], outcome: "unverified" }] }],
  ["unmet requirement", { ...audit, items: [{ ...audit.items[0], outcome: "unmet" }] }],
  ["missing evidence", { ...audit, items: [{ requirement: "Repair checkout", outcome: "met" }] }],
  ["blank evidence", { ...audit, items: [{ ...audit.items[0], evidence: " \n " }] }],
  ["remaining work", { ...audit, remainingWork: ["Verify mobile checkout"] }],
  ["changed objective", { ...audit, objective: "Repair checkout" }],
  ["trimmed objective", { ...audit, objective: objective + " " }],
  ["wrong version", { ...audit, version: 2 }],
  ["unknown audit field", { ...audit, scope: "narrower" }],
  ["unknown item field", { ...audit, items: [{ ...audit.items[0], verified: true }] }],
  ["malformed remaining work", { ...audit, remainingWork: [true] }],
];

describe("Goal completion audit", () => {
  it.each(invalidAudits)("rejects %s recoverably and accepts a corrected report in the same turn", async (_name, invalidAudit) => {
    const f = fixture();
    const report = invalidAudit === undefined ? withoutAudit : { ...completed, audit: invalidAudit };
    await expect(f.turn.report(report)).rejects.toThrow(/audit/i);
    expect(f.turn.isStopped).toBe(false);
    expect(f.calls.some(call => call.method === "goals.report")).toBe(false);
    await f.turn.beforeTool("Write");
    await expect(f.turn.report(completed)).resolves.toMatchObject({ status: "completed", audit });
    await f.turn.settle(undefined, false, false);
    expect(f.calls.find(call => call.method === "goals.settleTurn")?.params).not.toHaveProperty("error");
  });

  it.each([
    ["missing criteria", { ...completed, outcomes: [] }],
    ["unverified criterion", { ...completed, outcomes: [{ ...completed.outcomes[0], outcome: "unverified" }] }],
    ["unmet criterion", { ...completed, outcomes: [{ ...completed.outcomes[0], outcome: "unmet" }] }],
    ["empty criterion evidence", { ...completed, outcomes: [{ ...completed.outcomes[0], evidence: " " }] }],
    ["duplicate criteria", { ...completed, outcomes: [completed.outcomes[0], completed.outcomes[0]] }],
    ["unknown criterion", { ...completed, outcomes: [{ ...completed.outcomes[0], criterion: "Narrower success" }] }],
    ["scope", { ...completed, scope: "narrower" }],
    ["identity", { ...completed, goalId: "other-goal" }],
    ["session identity", { ...completed, sessionId: "other-session" }],
    ["turn identity", { ...completed, turnId: "other-turn" }],
    ["budget", { ...completed, budget: { maxTurns: null } }],
    ["objective", { ...completed, objective: "narrower" }],
    ["criteria", { ...completed, criteria: ["Narrower success"] }],
  ])("rejects invalid report %s without ending autonomy", async (_name, report) => {
    const f = fixture();
    await expect(f.turn.report(report)).rejects.toThrow();
    expect(f.turn.isStopped).toBe(false);
    expect(f.calls.some(call => call.method === "goals.report")).toBe(false);
    await expect(f.turn.report(completed)).resolves.toMatchObject({ status: "completed" });
  });

  it("passes a valid audit unchanged to the Host, then blocks substantive tools", async () => {
    const f = fixture();
    await f.turn.report(completed);
    expect(f.calls.find(call => call.method === "goals.report")?.params).toEqual({ ...completed, sessionId: "session", goalId: "goal", turnId: "turn" });
    expect(f.turn.isStopped).toBe(true);
    await expect(f.turn.beforeTool("Write")).rejects.toThrow("stopped");
    await expect(f.turn.beforeTool("GetGoal")).resolves.toBeUndefined();
  });

  it("allows legacy goals and active/blocked reports without an audit", async () => {
    const f = fixture();
    await expect(f.turn.report({ status: "active", progressSummary: "Implementation progressing", outcomes: [] })).resolves.toMatchObject({ status: "active" });
    expect(f.turn.instructions()).toContain('"maxTurns":null');
    await expect(f.turn.report({ status: "blocked", progressSummary: "Needs user authorization", outcomes: [] })).resolves.toMatchObject({ status: "blocked" });
    expect(f.turn.isStopped).toBe(true);
  });

  it.each([
    { ...audit, items: [] },
    { ...audit, items: [{ ...audit.items[0], outcome: "unverified", evidence: "" }], remainingWork: ["Run the current regression suite"] },
  ])("allows an incomplete audit for progress, never completion: %j", async progressAudit => {
    const f = fixture();
    await expect(f.turn.report({ ...completed, status: "active", audit: progressAudit })).resolves.toMatchObject({ status: "active", audit: progressAudit });
    expect(f.turn.isStopped).toBe(false);
    await expect(f.turn.report({ ...completed, audit: progressAudit })).rejects.toThrow(/audit/i);
    expect(f.turn.isStopped).toBe(false);
  });

  it.each([
    { ...audit, remainingWork: [" "] },
    { ...audit, remainingWork: Array.from({ length: 101 }, () => "Verify current files") },
  ])("rejects invalid progress audit bounds/remainingWork recoverably: %j", async progressAudit => {
    const f = fixture();
    await expect(f.turn.report({ ...completed, status: "active", audit: progressAudit })).rejects.toThrow(/audit/i);
    expect(f.turn.isStopped).toBe(false);
    expect(f.calls.some(call => call.method === "goals.report")).toBe(false);
  });

  it("declares the structured audit in UpdateGoal's tool schema and description", () => {
    const f = fixture();
    const tool = goalTools(f.host, "session", () => f.turn).find(tool => tool.name === "UpdateGoal")!;
    expect(tool.parameters).toHaveProperty("properties.audit");
    expect(tool.description).toContain("original objective");
    expect(tool.description).toContain("audit");
  });
});

describe("Host report errors", () => {
  it.each(["INVALID_PARAMS", "GOAL_INVALID_TEXT", "GOAL_INVALID_OUTCOMES", "GOAL_COMPLETION_UNVERIFIED", "GOAL_INVALID_AUDIT"])("recovers only from stable report validation code %s", async errorCode => {
    const f = fixture();
    f.rejectReport(rpcErrorFromWire({ code: 1002, message: "Rejected model report", data: { errorCode } }));
    await expect(f.turn.report(completed)).rejects.toThrow("Rejected model report");
    expect(f.turn.isStopped).toBe(false);
    await f.turn.beforeTool("Read");
    await expect(f.turn.report(completed)).resolves.toMatchObject({ status: "completed" });
    await f.turn.settle(undefined, false, false);
    expect(f.calls.find(call => call.method === "goals.settleTurn")?.params).not.toHaveProperty("error");
  });

  it.each([
    rpcErrorFromWire({ code: 1002, message: "Rejected audit", errorCode: "GOAL_INVALID_AUDIT" }),
    rpcErrorFromWire({ code: 1002, message: "Rejected audit", data: {}, errorCode: "GOAL_INVALID_AUDIT" }),
  ])("preserves supported wire error-code locations: %s", async error => {
    const f = fixture();
    f.rejectReport(error);
    await expect(f.turn.report(completed)).rejects.toThrow("Rejected audit");
    expect(f.turn.isStopped).toBe(false);
    await expect(f.turn.report(completed)).resolves.toMatchObject({ status: "completed" });
  });

  it("fails closed if a pause races a recoverable report rejection", async () => {
    const f = fixture();
    const original = f.host.call.bind(f.host);
    f.host.call = async (method, params, timeout) => {
      if (method === "goals.report") f.rejectValidation(rpcErrorFromWire({ code: 1002, message: "User paused", data: { errorCode: "GOAL_TURN_STALE" } }));
      return original(method, params, timeout);
    };
    f.rejectReport(rpcErrorFromWire({ code: 1002, message: "Rejected audit", data: { errorCode: "GOAL_INVALID_AUDIT" } }));
    await expect(f.turn.report(completed)).rejects.toThrow("User paused");
    expect(f.turn.isStopped).toBe(true);
    await expect(f.turn.beforeTool("Write")).rejects.toThrow("stopped");
  });

  it.each([
    rpcErrorFromWire({ code: 1000, message: "Transport error", data: { errorCode: "GOAL_INVALID_AUDIT" } }),
    rpcErrorFromWire({ code: 1002, message: "Paused or stale claim", data: { errorCode: "GOAL_TURN_STALE" } }),
    rpcErrorFromWire({ code: 1002, message: "Paused", data: { errorCode: "GOAL_NOT_ACTIVE" } }),
    rpcErrorFromWire({ code: 1002, message: "Invalid ownership", data: { errorCode: "GOAL_NOT_FOUND" } }),
    rpcErrorFromWire({ code: 1000, message: "GOAL_INVALID_AUDIT", data: { errorCode: "INTERNAL" } }),
    rpcErrorFromWire({ code: 1002, message: "Unknown error", data: { errorCode: "GOAL_FUTURE_VALIDATION" } }),
    new Error("GOAL_INVALID_AUDIT"),
    new Error("Host transport disconnected"),
    new Error("Persistence unavailable"),
  ])("fails closed for non-validation rejection: %s", async error => {
    const f = fixture();
    f.rejectReport(error);
    await expect(f.turn.report(completed)).rejects.toThrow(error.message);
    expect(f.turn.isStopped).toBe(true);
    await expect(f.turn.beforeTool("Write")).rejects.toThrow("stopped");
    await f.turn.settle(undefined, false, false);
    expect(f.calls.find(call => call.method === "goals.settleTurn")?.params.error).toBe(error.message);
  });

  it("never treats a validation-call rejection as a recoverable report error", async () => {
    const f = fixture();
    f.rejectValidation(rpcErrorFromWire({ code: 1002, message: "Invalid claim", data: { errorCode: "INVALID_PARAMS" } }));
    await expect(f.turn.report(completed)).rejects.toThrow("Invalid claim");
    expect(f.turn.isStopped).toBe(true);
  });

  it("fails closed when the Host returns an unaccepted status", async () => {
    const f = fixture();
    f.mismatch();
    await expect(f.turn.report(completed)).rejects.toThrow("not accepted");
    expect(f.turn.isStopped).toBe(true);
  });
});

describe("Goal removal settlement", () => {
  it("accepts an identity-bound committed removal tombstone", async () => {
    const f = fixture();
    const original = f.host.call.bind(f.host);
    f.host.call = async <T>(method: string, params?: unknown): Promise<T> => method === "goals.settleTurn"
      ? { goal: null, goalId: "goal", revision: 3 } as T : original<T>(method, params);
    await f.turn.validate();
    await expect(f.turn.settle(undefined, true, false)).resolves.toBeUndefined();
  });

  it.each([
    { goal: null },
    { goal: null, goalId: "other", revision: 3 },
    { goal: null, goalId: "goal" },
    { goal: null, goalId: "goal", revision: 0 },
    { goal: null, goalId: "goal", revision: 1 },
    { goal: null, goalId: "goal", revision: 2.5 },
    { goal: null, goalId: "goal", revision: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects unconfirmed or stale removal settlement %j", async (result) => {
    const f = fixture();
    const original = f.host.call.bind(f.host);
    f.host.call = async <T>(method: string, params?: unknown): Promise<T> => method === "goals.settleTurn"
      ? result as T : original<T>(method, params);
    await f.turn.validate();
    await expect(f.turn.settle(undefined, true, false)).rejects.toThrow("Host did not confirm goal turn settlement");
  });
});

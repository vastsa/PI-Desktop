import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
async function load(file) {
  const result = await build({ entryPoints: [path.join(root, file)], bundle: true, write: false, platform: "node", format: "esm",
    nodePaths: [path.join(root, "apps/desktop/node_modules")], alias: { "@pi-desktop/shared": path.join(root, "packages/shared/src/index.ts") } });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const { createSessionGoalService } = await load("apps/desktop/src/features/goals/session-goal-service.ts");
const { parseGoalBudget, budgetToDraft, budgetAllowsResume } = await load("apps/desktop/src/features/goals/goal-budget.ts");
const { submitUserPrompt } = await load("apps/desktop/src/features/goals/submit-user-prompt.ts");
const goal = (revision = 1, status = "active") => ({ id: "g", sessionId: "s", revision, status, objective: "Export citations", criteria: ["Source links"], progressSummary: "", roundsStarted: 1, tokenUsage: 100, budget: { maxTurns: 20 }, outcomes: [] });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("budget inputs normalize invalid dimensions to unlimited without changing valid finite caps", () => {
  assert.deepEqual(budgetToDraft(), { turns: "20", tokens: "" });
  assert.deepEqual(parseGoalBudget(budgetToDraft()), { maxTurns: 20 });
  for (const budget of [{ maxTurns: 20 }, { maxTurns: null }, { maxTurns: 42, maxTokens: 50000 }, { maxTurns: null, maxTokens: 50000 }]) {
    assert.deepEqual(parseGoalBudget(budgetToDraft(budget)), budget);
  }
  const finite = { turns: "20", tokens: "1" };
  for (const turns of ["-1", "1.5", "10001", "Infinity", "1e2", "e", "9007199254740992"]) assert.deepEqual(parseGoalBudget({ ...finite, turns }), { maxTurns: null, maxTokens: 1 });
  for (const tokens of ["-2", "1.2", "9007199254740992", "Infinity", "e"]) assert.deepEqual(parseGoalBudget({ ...finite, tokens }), { maxTurns: 20 });
  assert.deepEqual(parseGoalBudget({ turns: "  ", tokens: "\t" }), { maxTurns: null });
  for (const turns of ["0", "00", " 0 ", ""]) for (const tokens of ["0", "00", " 0 ", ""]) {
    assert.deepEqual(parseGoalBudget({ turns, tokens }), { maxTurns: null });
  }
  assert.deepEqual(parseGoalBudget({ turns: "10000", tokens: "9007199254740991" }), { maxTurns: 10000, maxTokens: Number.MAX_SAFE_INTEGER });
  assert.equal(budgetAllowsResume({ maxTurns: 20 }, 20, 1), false);
  assert.equal(budgetAllowsResume({ maxTurns: null, maxTokens: 200 }, 20, 200), false);
  assert.equal(budgetAllowsResume({ maxTurns: 21, maxTokens: 201 }, 20, 200), true);
  assert.equal(budgetAllowsResume({ maxTurns: null }, 20000, 900000), true);
});

test("only explicit local Goal submission starts autonomy and omits budget for host defaults", async () => {
  const calls = [];
  const api = { prompt: async (request) => calls.push(["prompt", request]), startGoal: async (request) => calls.push(["goal", request]) };
  const request = { sessionId: "s", content: "Export citations", messageId: "m" };
  await submitUserPrompt(api, { mode: "goal", source: "desktop", id: "s" }, request);
  assert.deepEqual(calls.pop(), ["goal", request]);
  for (const mode of ["agent", "plan"]) { await submitUserPrompt(api, { mode, id: "s" }, request); assert.equal(calls.pop()[0], "prompt"); }
  for (const source of ["remote", "pi-native"]) assert.throws(() => submitUserPrompt(api, { mode: "goal", id: "s", source }, request));
  assert.equal(calls.length, 0);
});

test("subscribe before reload; newer events beat stale reads, duplicate revisions and old sessions", async () => {
  const initial = deferred(); let event; let unsubscribed = 0;
  const service = createSessionGoalService("s", { onGoalChanged(listener) { event = listener; return () => unsubscribed++; }, getGoal() { assert.ok(event); return initial.promise; }, controlGoal: assert.fail });
  const stop = service.start();
  event({ sessionId: "s", goal: goal(4, "paused") });
  event({ sessionId: "s", goal: goal(3) });
  event({ sessionId: "other", goal: { ...goal(9), sessionId: "other" } });
  initial.resolve({ goal: goal(1) }); await flush();
  assert.equal(service.getSnapshot().goal.revision, 4);
  assert.equal(service.getSnapshot().loading, false);
  stop(); event({ sessionId: "s", goal: goal(10) });
  assert.equal(service.getSnapshot().goal.revision, 4); assert.equal(unsubscribed, 1);
});

test("pause → pending → host update → edited-budget resume → cancel uses current revision", async () => {
  let event; const requests = []; let next = deferred();
  const service = createSessionGoalService("s", { getGoal: async () => ({ goal: goal() }), onGoalChanged(listener) { event = listener; return () => {}; }, controlGoal(request) { requests.push(request); return next.promise; } });
  const stop = service.start(); await flush();
  const pausing = service.control("pause"); assert.equal(service.getSnapshot().pending, "pause");
  await service.control("pause"); assert.equal(requests.length, 1);
  event({ sessionId: "s", goal: goal(3, "paused") }); next.resolve({ goal: goal(2, "paused") }); await pausing;
  assert.equal(service.getSnapshot().goal.revision, 3);
  next = deferred(); const resuming = service.control("resume", { maxTurns: 40, maxTokens: 8000 });
  assert.deepEqual(requests[1], { sessionId: "s", goalId: "g", expectedRevision: 3, action: "resume", budget: { maxTurns: 40, maxTokens: 8000 } });
  next.resolve({ goal: { ...goal(4), budget: requests[1].budget } }); await resuming;
  next = deferred(); const cancelling = service.control("cancel"); next.resolve({ goal: goal(5, "cancelled") }); await cancelling;
  await service.control("resume"); assert.equal(requests.length, 3); stop();
});

test("in-flight turn prevents resume; failures are visible and reload recovers", async () => {
  let read = { ...goal(1, "paused"), activeTurnId: "turn" }; let calls = 0;
  const service = createSessionGoalService("s", { getGoal: async () => ({ goal: read }), onGoalChanged: () => () => {}, controlGoal: async () => { calls++; throw new Error("revision conflict"); } });
  const stop = service.start(); await flush(); await service.control("resume"); assert.equal(calls, 0);
  read = goal(2, "paused"); await service.reload(); await service.control("resume");
  assert.equal(service.getSnapshot().pending, null); assert.match(service.getSnapshot().error, /revision conflict/);
  await service.reload(); assert.equal(service.getSnapshot().error, null); stop();
});

test("disposed reads/control cannot mutate a remounted service; retired goal cannot return", async () => {
  let event; const read = deferred(); const service = createSessionGoalService("s", { getGoal: () => read.promise, onGoalChanged(listener) { event = listener; return () => {}; }, controlGoal: assert.fail });
  const stop = service.start(); stop(); read.resolve({ goal: goal(9) }); await flush(); assert.equal(service.getSnapshot().goal, null);
  const stopAgain = service.start(); await flush();
  event({ sessionId: "s", goal: { ...goal(1), id: "new" } }); event({ sessionId: "s", goal: goal(99) });
  assert.equal(service.getSnapshot().goal.id, "new"); stopAgain();
});

test("newer reloads and host events suppress obsolete read failures", async () => {
  const older = deferred(); const newer = deferred(); let calls = 0; let event;
  const service = createSessionGoalService("s", { getGoal: () => ++calls === 1 ? older.promise : newer.promise, onGoalChanged(listener) { event = listener; return () => {}; }, controlGoal: assert.fail });
  const stop = service.start();
  const reload = service.reload(); newer.resolve({ goal: goal(3, "paused") }); await reload;
  older.reject(new Error("obsolete failure")); await flush();
  assert.equal(service.getSnapshot().error, null); assert.equal(service.getSnapshot().goal.revision, 3);
  event({ sessionId: "s", goal: goal(4) });
  assert.equal(service.getSnapshot().goal.revision, 4); stop();
});

test("ordinary resume omits budget; replaced goal suppresses stale control failures", async () => {
  let event; const next = deferred(); const requests = [];
  const service = createSessionGoalService("s", { getGoal: async () => ({ goal: goal(1, "paused") }), onGoalChanged(listener) { event = listener; return () => {}; }, controlGoal(request) { requests.push(request); return next.promise; } });
  const stop = service.start(); await flush();
  const resuming = service.control("resume");
  assert.equal(Object.hasOwn(requests[0], "budget"), false);
  event({ sessionId: "s", goal: { ...goal(1, "paused"), id: "new" } });
  assert.equal(service.getSnapshot().pending, null);
  next.reject(new Error("old goal failed")); await resuming;
  assert.equal(service.getSnapshot().goal.id, "new");
  assert.equal(service.getSnapshot().error, null);
  stop(); await service.control("resume"); assert.equal(requests.length, 1);
});

test("edit requires a settled goal and only sends objective with current CAS", async () => {
  let event; const requests = [];
  const original = { ...goal(), activeTurnId: "turn", audit: { version: 1 } };
  const service = createSessionGoalService("s", { getGoal: async () => ({ goal: original }), onGoalChanged(listener) { event = listener; return () => {}; }, async controlGoal(request) {
    requests.push(request);
    return { goal: { ...goal(4, "paused"), objective: request.objective, criteria: [], outcomes: [], audit: undefined } };
  } });
  const stop = service.start(); await flush();
  await service.control("edit", undefined, "Revised objective"); assert.equal(requests.length, 0);
  event({ sessionId: "s", goal: { ...original, revision: 2, status: "paused" } });
  await service.control("edit", undefined, "Revised objective"); assert.equal(requests.length, 0);
  event({ sessionId: "s", goal: { ...goal(3, "paused"), activeTurnId: undefined } });
  assert.equal(await service.control("edit", undefined, "  Revised objective  "), true);
  assert.deepEqual(requests[0], { sessionId: "s", goalId: "g", expectedRevision: 3, action: "edit", objective: "Revised objective" });
  assert.equal(service.getSnapshot().goal.status, "paused"); assert.deepEqual(service.getSnapshot().goal.budget, original.budget);
  assert.deepEqual(service.getSnapshot().goal.criteria, []); assert.equal(service.getSnapshot().goal.audit, undefined); stop();
});

test("terminal delete accepts matching tombstone; late reads, events and replies cannot resurrect", async () => {
  let event; let result = { goal: goal(3, "completed") }; const next = deferred();
  const service = createSessionGoalService("s", { getGoal: async () => result, onGoalChanged(listener) { event = listener; return () => {}; }, controlGoal: () => next.promise });
  const stop = service.start(); await flush();
  const removing = service.control("delete");
  assert.equal(service.getSnapshot().pending, "delete");
  event({ sessionId: "s", goal: null, goalId: "g", revision: 2 });
  assert.equal(service.getSnapshot().goal.revision, 3, "stale tombstone must not remove a newer revision");
  event({ sessionId: "s", goal: null, goalId: "other", revision: 99 });
  assert.equal(service.getSnapshot().goal.id, "g", "unrelated tombstone must not remove current goal");
  next.resolve({ goal: null, goalId: "g", revision: 4 });
  assert.equal(await removing, true); assert.equal(service.getSnapshot().goal, null);
  event({ sessionId: "s", goal: goal(99) }); result = { goal: goal(100) }; await service.reload();
  assert.equal(service.getSnapshot().goal, null);
  event({ sessionId: "s", goal: { ...goal(), id: "new" } });
  event({ sessionId: "s", goal: null, goalId: "g", revision: 999 });
  assert.equal(service.getSnapshot().goal.id, "new"); stop();
});

test("delete response cannot erase a replacement goal or mutate a disposed owner", async () => {
  let event; const next = deferred();
  const service = createSessionGoalService("s", { getGoal: async () => ({ goal: goal() }), onGoalChanged(listener) { event = listener; return () => {}; }, controlGoal: () => next.promise });
  const stop = service.start(); await flush(); const removing = service.control("delete");
  event({ sessionId: "s", goal: { ...goal(), id: "new" } });
  next.resolve({ goal: null, goalId: "g", revision: 2 }); await removing;
  assert.equal(service.getSnapshot().goal.id, "new"); stop();
});

test("unrelated tombstone cannot reveal tasks early or suppress the authoritative initial read", async () => {
  let event; const read = deferred();
  const service = createSessionGoalService("s", { getGoal: () => read.promise, onGoalChanged(listener) { event = listener; return () => {}; }, controlGoal: assert.fail });
  const stop = service.start(); event({ sessionId: "s", goal: null, goalId: "retired", revision: 9 });
  assert.equal(service.getSnapshot().loading, true);
  read.resolve({ goal: goal() }); await flush(); assert.equal(service.getSnapshot().goal.id, "g"); stop();
});

test("delete event releases old pending ownership before a replacement goal arrives", async () => {
  let event; const next = deferred();
  const service = createSessionGoalService("s", { getGoal: async () => ({ goal: goal() }), onGoalChanged(listener) { event = listener; return () => {}; }, controlGoal: () => next.promise });
  const stop = service.start(); await flush(); const deleting = service.control("delete");
  event({ sessionId: "s", goal: null, goalId: "g", revision: 2 });
  event({ sessionId: "s", goal: { ...goal(), id: "new" } });
  assert.equal(service.getSnapshot().pending, null);
  next.resolve({ goal: goal(99) }); await deleting;
  assert.equal(service.getSnapshot().goal.id, "new"); stop();
});

test("authoritative empty reload recovers missed deletion and retires its old goal", async () => {
  let event; let result = { goal: goal() };
  const service = createSessionGoalService("s", { getGoal: async () => result, controlGoal: assert.fail,
    onGoalChanged(listener) { event = listener; return () => {}; } });
  let stop = service.start(); await flush();
  result = { goal: null }; await service.reload();
  assert.equal(service.getSnapshot().goal, null);
  event({ sessionId: "s", goal: goal(99) });
  assert.equal(service.getSnapshot().goal, null, "missed deletion must retire old identity");
  event({ sessionId: "s", goal: { ...goal(), id: "replacement" } });
  assert.equal(service.getSnapshot().goal.id, "replacement");
  stop(); stop = service.start(); await flush();
  assert.equal(service.getSnapshot().goal, null, "resubscription must reconcile current absence");
  stop();
});

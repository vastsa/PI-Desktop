import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import ts from "typescript";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const returns = await import("../src/features/scheduled/scheduled-return.ts");
const runs = await import("../src/features/scheduled/scheduled-runs.ts");
const { scheduledWorkspaceCache: cache } = await import("../src/features/scheduled/scheduled-workspace-cache.ts");
const code = ts.transpileModule(readFileSync(new URL("../src/features/scheduled/use-scheduled-workspace.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};

// Exercise the production hook with controlled API promises and poll ticks.
function harness(api, requestedTaskId) {
  const slots = [], effects = [], timers = new Set();
  let cursor = 0, dirty = true, output;
  const equal = (a, b) => a?.length === b?.length && a?.every((value, index) => value === b[index]);
  const memo = (work, deps) => {
    const index = cursor++, old = slots[index];
    if (!old || !equal(old.deps, deps)) slots[index] = { deps, value: work() };
    return slots[index].value;
  };
  const react = {
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, next => {
        const value = typeof next === "function" ? next(slots[index].value) : next;
        if (value !== slots[index].value) { slots[index].value = value; dirty = true; }
      }];
    },
    useRef(initial) { const index = cursor++; slots[index] ??= { value: { current: initial } }; return slots[index].value; },
    useMemo: memo,
    useCallback: (work, deps) => memo(() => work, deps),
    useEffect(work, deps) {
      const index = cursor++, old = slots[index];
      if (!old || !equal(old.deps, deps)) {
        slots[index] = { deps, cleanup: old?.cleanup };
        effects.push(() => { slots[index].cleanup?.(); slots[index].cleanup = work(); });
      }
    },
  };
  const exports = {};
  new Function("exports", "require", "setInterval", "clearInterval", code)(exports, id => {
    if (id === "react") return react;
    if (id === "../../lib/api") return { api };
    if (id === "./scheduled-return") return returns;
    if (id === "./scheduled-workspace-cache") return { scheduledWorkspaceCache: cache };
    if (id === "./scheduled-runs") return runs;
    throw new Error(`Unexpected import: ${id}`);
  }, callback => { timers.add(callback); return callback; }, callback => timers.delete(callback));
  return {
    get output() { return output; },
    async settle() {
      for (let round = 0; round < 30; round++) {
        if (dirty) { dirty = false; cursor = 0; output = exports.useScheduledWorkspace(() => {}, requestedTaskId); }
        while (effects.length) effects.shift()();
        await Promise.resolve();
      }
    },
    tick() { for (const callback of timers) callback(); },
    close() { for (const slot of slots) slot.cleanup?.(); },
  };
}
const task = id => ({ id, title: id });
const run = (id, taskId) => ({ id, taskId, status: "completed", startedAt: "2026-01-01T00:00:00Z" });
const api = (overrides = {}) => ({
  listScheduled: async () => ({ tasks: [task("a"), task("b")] }),
  listScheduledRuns: async () => ({ runs: [] }),
  listProjects: async () => ({ projects: [] }),
  ...overrides,
});
test.beforeEach(() => cache.clear());

test("task definitions display before held outcomes; project options load only for editing", async t => {
  const outcomes = deferred(), projects = deferred();
  let projectsRequested = false;
  const h = harness(api({
    listScheduledRuns: input => input.latestPerTask ? outcomes.promise : Promise.resolve({ runs: [] }),
    listProjects: () => { projectsRequested = true; return projects.promise; },
  }));
  t.after(() => h.close());
  await h.settle();
  assert.equal(h.output.loaded, true);
  assert.equal(h.output.tasks.length, 2);
  assert.equal(h.output.latestRunsLoaded, false);
  assert.equal(projectsRequested, false);
  h.output.loadProjects(); await h.settle();
  assert.equal(projectsRequested, true);
  assert.equal(h.output.projectsLoaded, false);
  assert.equal(h.output.tasks.length, 2);
  projects.resolve({ projects: [{ id: 1, path: "/synthetic/project" }] });
  outcomes.resolve({ runs: [] }); await h.settle();
  assert.equal(h.output.projectsLoaded, true);
  assert.equal(h.output.latestRunsLoaded, true);
});

test("route return displays cached definitions and outcomes while refreshing", async t => {
  const first = harness(api({ listScheduledRuns: async () => ({ runs: [run("first", "a")] }) }));
  await first.settle(); first.close();
  const refresh = deferred();
  const second = harness(api({ listScheduled: () => refresh.promise, listScheduledRuns: () => new Promise(() => {}) }));
  t.after(() => second.close()); await second.settle();
  assert.equal(second.output.loaded, true);
  assert.equal(second.output.tasks[0].id, "a");
  assert.equal(second.output.latestRuns.get("a").id, "first");
  refresh.resolve({ tasks: [task("b")] }); await second.settle();
  assert.deepEqual(second.output.tasks.map(value => value.id), ["b"]);
});

test("return restores the selected task, run and bounded history", async t => {
  const record = run("selected-b", "b");
  const first = harness(api({ listScheduledRuns: async input => ({ runs: input.taskId === "b" ? [record] : [] }) }));
  await first.settle(); first.output.selectTask("b"); await first.settle();
  first.output.selectRun(record.id); await first.settle(); first.close();
  const next = harness(api({ listScheduled: () => new Promise(() => {}), listScheduledRuns: () => new Promise(() => {}) }));
  t.after(() => next.close()); await next.settle();
  assert.equal(next.output.selectedTaskId, "b");
  assert.equal(next.output.selectedRunId, record.id);
  assert.equal(next.output.runsLoaded, true);
  assert.deepEqual(next.output.runs, [record]);
});

test("explicit sidebar task overrides cached selection and conversation return without reusing their run", async t => {
  cache.snapshot.tasks = [task("a"), task("b")];
  cache.snapshot.selection = { taskId: "a", runId: "cached-a" };
  cache.snapshot.history = { taskId: "a", runs: [run("cached-a", "a")] };
  returns.rememberScheduledReturn({ taskId: "a", taskTitle: "a", runId: "returned-a", sessionId: "synthetic" });
  const h = harness(api({ listScheduled: () => new Promise(() => {}), listScheduledRuns: () => new Promise(() => {}) }), "b");
  t.after(() => h.close()); await h.settle();
  assert.equal(h.output.loaded, true);
  assert.equal(h.output.selectedTaskId, "b");
  assert.equal(h.output.selectedRunId, null);
  assert.equal(h.output.runsLoaded, false);
  assert.deepEqual(h.output.runs, []);
  h.output.selectRun("selected-b"); await h.settle();
  h.output.selectTask("b"); await h.settle();
  assert.equal(h.output.selectedRunId, null, "revisiting the same task clears its run selection");
});

test("failed summaries and task histories stay distinguishable from successful empty results", async t => {
  const h = harness(api({ listScheduledRuns: async () => { throw new Error("Synthetic read failure"); } }));
  t.after(() => h.close()); await h.settle();
  assert.equal(h.output.loaded, true);
  assert.equal(h.output.latestRunsLoaded, false);
  assert.match(h.output.latestRunsError, /Synthetic read failure/);
  assert.match(h.output.runsError, /Synthetic read failure/);
  assert.equal(h.output.runsLoaded, false);
});

for (const stillExists of [true, false]) {
  test(`sidebar task absent from stale cached definitions waits for refresh (exists=${stillExists})`, async t => {
    cache.snapshot.tasks = [task("a")];
    const refresh = deferred();
    const h = harness(api({ listScheduled: () => refresh.promise }), "b");
    t.after(() => h.close()); await h.settle();
    assert.equal(h.output.selectedTaskId, "b", "cached definitions must not discard explicit navigation");
    refresh.resolve({ tasks: stillExists ? [task("a"), task("b")] : [task("a")] });
    await h.settle();
    assert.equal(h.output.selectedTaskId, stillExists ? "b" : "a", "fresh definitions decide deletion fallback");
  });
}

test("late histories cannot replace the selected task and failures retain known history", async t => {
  const old = deferred(), newest = run("b-result", "b"); let fail = false;
  const h = harness(api({ listScheduledRuns: input => input.latestPerTask ? Promise.resolve({ runs: [] })
    : input.taskId === "a" ? old.promise : fail ? Promise.reject(new Error("Unavailable")) : Promise.resolve({ runs: [newest] }) }));
  t.after(() => h.close()); await h.settle();
  h.output.selectTask("b"); await h.settle();
  old.resolve({ runs: [run("late-a", "a")] }); await h.settle();
  assert.deepEqual(h.output.runs, [newest]);
  fail = true; h.tick(); await h.settle();
  assert.deepEqual(h.output.runs, [newest]);
  assert.match(h.output.runsError, /Unavailable/);
});

test("invalidated lifecycle rejects late reads and does not repopulate the next page", async t => {
  const held = deferred();
  const first = harness(api({ listScheduled: () => held.promise }));
  await first.settle(); cache.clear();
  held.resolve({ tasks: [task("old-host")] }); await first.settle(); first.close();
  assert.equal(cache.snapshot.tasks, undefined);
  const next = harness(api({ listScheduled: () => new Promise(() => {}) }));
  t.after(() => next.close()); await next.settle();
  assert.equal(next.output.loaded, false);
  assert.deepEqual(next.output.tasks, []);
});

for (const oldOutcome of ["resolved", "rejected", "pending"]) {
  test(`mounted editor recovers after Host invalidation with an old ${oldOutcome} project read`, async t => {
    const old = deferred(), replacement = deferred(); let projectReads = 0;
    const h = harness(api({ listProjects: () => ++projectReads === 1 ? old.promise : replacement.promise }));
    t.after(() => h.close()); await h.settle();
    void h.output.loadProjects(); await h.settle();
    cache.clear();
    if (oldOutcome === "resolved") old.resolve({ projects: [{ id: 1, path: "/old-host" }] });
    if (oldOutcome === "rejected") old.reject(new Error("Old Host unavailable"));
    await h.settle(); h.tick(); await h.settle();
    assert.equal(projectReads, 2, "normal polling replaces the invalidated editor read without reopening");
    assert.equal(h.output.projectsLoaded, false);
    assert.equal(h.output.projectsError, "");
    const projects = [{ id: 2, path: "/new-host" }];
    replacement.resolve({ projects }); await h.settle();
    assert.equal(h.output.projectsLoaded, true);
    assert.deepEqual(h.output.projects, projects);
    if (oldOutcome === "pending") {
      old.resolve({ projects: [{ id: 1, path: "/old-host" }] }); await h.settle();
      assert.deepEqual(h.output.projects, projects, "a late old response cannot replace recovered options");
    }
    h.tick(); await h.settle();
    assert.equal(projectReads, 2, "successful options do not become an extra project query on every poll");
  });
}

test("a failed replacement project read exposes retry and recovers in the same editor", async t => {
  const old = deferred(); let projectReads = 0;
  const projects = [{ id: 3, path: "/recovered-host" }];
  const h = harness(api({ listProjects: () => {
    projectReads++;
    if (projectReads === 1) return old.promise;
    if (projectReads === 2) return Promise.reject(new Error("Synthetic Host unavailable"));
    return Promise.resolve({ projects });
  } }));
  t.after(() => h.close()); await h.settle();
  void h.output.loadProjects(); await h.settle(); cache.clear();
  h.tick(); await h.settle();
  assert.match(h.output.projectsError, /Synthetic Host unavailable/);
  assert.equal(h.output.projectsLoaded, false);
  await h.output.loadProjects(); await h.settle();
  assert.equal(h.output.projectsLoaded, true);
  assert.equal(h.output.projectsError, "");
  assert.deepEqual(h.output.projects, projects);
  old.reject(new Error("Old Host closed")); await h.settle();
  assert.equal(h.output.projectsError, "");
});

test("conversation return takes precedence over the cached task during initial loading", async t => {
  returns.rememberScheduledReturn({ taskId: "b", taskTitle: "Synthetic B", runId: "restored-b", sessionId: "synthetic-session" });
  const held = deferred();
  const h = harness(api({ listScheduled: () => held.promise }));
  t.after(() => h.close()); await h.settle();
  assert.equal(h.output.selectedTaskId, "b");
  assert.equal(h.output.selectedRunId, "restored-b");
  held.resolve({ tasks: [task("a"), task("b")] }); await h.settle();
  assert.equal(h.output.selectedTaskId, "b");
  assert.equal(h.output.selectedRunId, "restored-b");
});

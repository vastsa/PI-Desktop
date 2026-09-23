// Real Host admission and persistence; inference is held at the prompt boundary.
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { createScheduledRunner, executeScheduledTask } from "../apps/desktop/electron/main/runtime/scheduled-runner.ts";

const root = await mkdtemp(join(tmpdir(), "pi-scheduled-dispatch-"));
const project = join(root, "project");
await mkdir(project);
const host = new Host(resolveHostBinary(), join(root, "data"));
const held = Promise.withResolvers();
const bothStarted = Promise.withResolvers();
const launches = [], executions = [], errors = [];
let runner;
let deadline;
try {
  await host.start();
  await host.call("workspace.set", { path: project });
  const tasks = [];
  for (const title of ["First", "Second"]) {
    const { task } = await host.call("scheduled.create", {
      title, prompt: "Reply OK", cadence: "hourly",
      schedule: { hour: 0, minute: 0, weekday: 0 },
    });
    // Controlled due instant in an isolated profile, without wall-clock sleeps.
    await host.call("scheduled.update", { id: task.id, configJson: { nextRunAt: Date.now() } });
    tasks.push(task);
  }
  runner = createScheduledRunner({
    getHost: () => host,
    report: error => errors.push(error),
    execute: id => {
      const execution = executeScheduledTask({
        host, id, automatic: true, runs: new Map(), isCurrent: () => true,
        prompt: async sessionId => {
          launches.push({ id, sessionId });
          if (launches.length === 2) bothStarted.resolve();
          if (launches.length === 1) await held.promise;
        },
      });
      executions.push(execution);
      return execution;
    },
  });
  const tick = runner.tick();
  await Promise.race([
    bothStarted.promise,
    new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("Second task blocked by first prompt setup")), 5000); }),
  ]);
  clearTimeout(deadline);
  await tick;
  await runner.tick();
  assert.equal(launches.length, 2);
  for (const task of tasks) {
    assert.equal((await host.call("scheduled.listRuns", { taskId: task.id })).runs.length, 1);
  }
  held.resolve();
  for (const run of await Promise.all(executions)) {
    await host.call("scheduled.finishRun", { runId: run.runId, status: "completed" });
  }
  runner.stop();
  assert.deepEqual(errors, []);
  await host.restart();
  for (const task of tasks) {
    assert.equal((await host.call("scheduled.listRuns", { taskId: task.id })).runs[0].status, "completed");
  }
  console.log("PASS independent admission, overlap prevention, stop, durable completed runs after restart");
} finally {
  clearTimeout(deadline);
  runner?.stop();
  held.resolve();
  await Promise.allSettled(executions);
  await host.stop();
}

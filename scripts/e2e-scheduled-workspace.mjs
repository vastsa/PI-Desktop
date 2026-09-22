#!/usr/bin/env node
// Real Electron dispatch service, Rust host, stdio and SQLite; inference is observed only.
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { executeScheduledTask } from "../apps/desktop/electron/main/runtime/scheduled-runner.ts";

const root = await mkdtemp(join(tmpdir(), "pi-scheduled-workspace-"));
const projectA = join(root, "a");
const projectB = join(root, "b");
await Promise.all([mkdir(projectA), mkdir(projectB)]);
const host = new Host(resolveHostBinary(), join(root, "data"));
async function dispatch(task, expected) {
  const launch = await executeScheduledTask({
    host, id: task.id, automatic: false, runs: new Map(), isCurrent: () => true,
    prompt: async (sessionId, content) => {
      assert.equal(content, "Reply OK");
      const { session } = await host.call("session.get", { id: sessionId });
      assert.equal(session.projectPath ?? null, expected ?? null);
    },
  });
  await host.call("scheduled.finishRun", { runId: launch.runId, status: "completed" });
}
try {
  await host.start();
  for (const cadence of ["manual", "hourly"]) {
    for (const bound of [true, false]) {
      await host.call(bound ? "workspace.set" : "workspace.clear", bound ? { path: projectA } : {});
      const input = { title: "Workspace regression", prompt: "Reply OK", cadence,
        schedule: cadence === "manual" ? null : { hour: 9, minute: 0, weekday: 0 } };
      const { task } = await host.call("scheduled.create", input);
      await host.stop();
      await host.start();
      await host.call("workspace.set", { path: projectB });
      await dispatch(task, task.workspacePath);
      const { task: renamed } = await host.call("scheduled.update", { ...input, id: task.id, title: "Renamed" });
      assert.equal(renamed.workspacePath, task.workspacePath);
      await dispatch(renamed, task.workspacePath);
      console.log(`PASS ${cadence}: ${bound ? "project" : "temporary"} binding survives restart, run and edit`);
    }
  }
} finally {
  await host.stop();
}

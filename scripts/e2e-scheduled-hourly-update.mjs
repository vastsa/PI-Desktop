#!/usr/bin/env node
// Exercise the public tool path through a real host and SQLite, without a model.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

const host = new Host(resolveHostBinary(), await mkdtemp(join(tmpdir(), "pi-hourly-update-")));
try {
  await host.start();
  await host.call("settings.set", { defaultPermissionMode: "auto" });
  const { session } = await host.call("session.create", { mode: "agent", title: "Hourly update" });
  const tool = (toolName, args) => host.call("tools.execute", {
    sessionId: session.id, toolCallId: randomUUID(), toolName, args, mode: "agent",
  });
  const created = await tool("ScheduledTaskCreate", {
    title: "Review", prompt: "Reply OK", cadence: "manual", enabled: false,
  });
  assert.equal(created.ok, true);
  const id = created.content.task.id;
  console.log("Created a paused Manual task.");
  const before = Date.now();
  const updated = await tool("ScheduledTaskUpdate", { id, cadence: "hourly" });
  console.log("Update with only cadence=hourly:", JSON.stringify(updated.content));
  assert.equal(updated.ok, true);
  const task = updated.content.task;
  assert.equal(task.enabled, false);
  assert.equal(task.cadence, "hourly");
  assert.equal(task.prompt, "Reply OK");
  assert.ok(Date.parse(task.nextRunAt) >= before + 3_600_000);
  assert.ok(Date.parse(task.nextRunAt) <= Date.now() + 3_600_000);
  const renamed = await tool("ScheduledTaskUpdate", { id, title: "Renamed" });
  assert.equal(renamed.content.task.nextRunAt, task.nextRunAt);
  await host.stop();
  await host.start();
  const listed = await tool("ScheduledTaskList", {});
  const restored = listed.content.tasks.find((item) => item.id === id);
  assert.equal(restored.cadence, "hourly");
  assert.equal(restored.enabled, false);
  assert.equal(restored.title, "Renamed");
  console.log("PASS: hourly conversion, one-hour interval, pause preservation, rename and restart.");
} finally {
  await host.stop();
}

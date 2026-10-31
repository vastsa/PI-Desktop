#!/usr/bin/env node
/** Plugin command -> isolated plugin process -> real Host RPC and durable projects. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadProjectPicker } from "../apps/desktop/test/helpers/plugin-projects.mjs";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

const { createPluginProjectLister } = await import(
  "../apps/desktop/electron/main/services/plugin-projects.ts"
);

test("plugin project picker enumerates durable projects without selecting a workspace", { timeout: 60_000 }, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "pi-projects-e2e-"));
  const host = new Host(resolveHostBinary(), join(temp, "data"));
  t.after(async () => { await host.stop(); await rm(temp, { recursive: true, force: true }); });
  await host.start();
  const paths = ["solo", "primary", "extra"].map((name) => join(temp, name));
  for (const path of paths) await mkdir(path);
  await host.call("projects.create", { path: paths[0] });
  const { group } = await host.call("project.group.create", { name: "Two folders", folders: paths.slice(1) });
  await host.call("session.create", { title: "No project", mode: "agent" });
  const before = await host.call("workspace.get");
  assert.equal(before.workspace, null);
  const adapter = { isAvailable: () => Boolean(host.child) && !host.exited,
    call: (...args) => host.call(...args) };
  const failures = [];
  const runtime = await loadProjectPicker(t, {
    listProjects: createPluginProjectLister(() => adapter, (op) => failures.push(op)),
  });
  async function readPicker() {
    await runtime.getCommands().find((command) => command.id === "pick-project").run();
    return JSON.parse(runtime.drainToasts()[0]).projects;
  }
  const projects = await readPicker();
  const { projects: rows } = await host.call("projects.list");
  assert.equal(projects.length, rows.length);
  assert.deepEqual(projects.map((project) => project.projectId).sort(), rows.map((row) => String(row.id)).sort());
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const opened = projects.map((project) => byId.get(project.projectId).lastOpenedAt);
  assert.deepEqual(opened, [...opened].sort((left, right) => right - left));
  assert.ok(projects.every((project) => project.roots[0].path === project.primaryPath && project.roots[0].primary));
  const multi = projects.find((project) => project.primaryPath === group.primaryPath);
  assert.equal(multi.name, "Two folders");
  assert.deepEqual(multi.roots.map((root) => root.path), group.roots.map((root) => root.path));
  assert.deepEqual(await runtime.invokePanelBridge("demo.projects", "projects.list", {}), projects);
  assert.deepEqual(await host.call("workspace.get"), before);
  await host.restart();
  assert.deepEqual(await readPicker(), projects);
  await host.stop();
  assert.deepEqual(await readPicker(), []);
  assert.deepEqual(failures, []);
});

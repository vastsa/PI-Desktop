#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { loadSubagentDefinitions } from "../packages/agent-runtime/dist/subagent-definitions.js";

const root = await mkdtemp(join(tmpdir(), "pi-subagent-scope-"));
const previous = process.env.PI_DESKTOP_AGENTS_DIR;
process.env.PI_DESKTOP_AGENTS_DIR = join(root, "agents");
const host = new Host(resolveHostBinary(), join(root, "data"));
const projectA = join(root, "a");
const projectB = join(root, "b");
const active = async (projectPath) => (await host.call("agents.active", { projectPath })).subagents;
const names = async (projectPath) => (await active(projectPath)).map((record) => record.id);
try {
  await Promise.all([projectA, projectB].map((path) => mkdir(path, { recursive: true })));
  await host.start();
  await host.call("agents.create", { name: "scoped-reviewer", description: "Scoped fixture", body: "Review only.", scope: { mode: "projects", projects: [projectA] } });
  await host.call("agents.create", { name: "global-reviewer", description: "Legacy fixture", body: "Review." });
  assert.deepEqual(await names(projectA), ["global-reviewer", "scoped-reviewer"]);
  assert.deepEqual(await names(projectB), ["global-reviewer"]);
  assert.deepEqual(await names(null), ["global-reviewer"]);
  const documents = await Promise.all((await active(projectB)).map(async (record) => ({ id: record.id, document: await readFile(record.path, "utf8") })));
  const { definitions: catalog } = await loadSubagentDefinitions(projectB, { userDocuments: documents });
  assert(!catalog.some((definition) => definition.name === "scoped-reviewer"));
  assert(catalog.some((definition) => definition.name === "global-reviewer"));
  await host.stop();
  await host.start();
  assert.deepEqual(await names(projectB), ["global-reviewer"]);
  await host.call("agents.update", { id: "scoped-reviewer", name: "renamed-reviewer" });
  assert.deepEqual(await names(projectB), ["global-reviewer"]);
  await host.call("agents.setEnabled", { id: "renamed-reviewer", enabled: false });
  assert.deepEqual(await names(projectA), ["global-reviewer"]);
  await host.call("agents.setEnabled", { id: "renamed-reviewer", enabled: true });
  await host.call("agents.setScope", { id: "renamed-reviewer", scope: { mode: "projects", projects: [projectB] } });
  assert.deepEqual(await names(projectA), ["global-reviewer"]);
  assert.deepEqual(await names(projectB), ["global-reviewer", "renamed-reviewer"]);
  await host.call("agents.setScope", { id: "renamed-reviewer", scope: { mode: "global", projects: [projectB] } });
  assert.deepEqual(await names(null), ["global-reviewer", "renamed-reviewer"]);
  await host.call("agents.remove", { id: "renamed-reviewer" });
  await host.call("agents.create", { name: "renamed-reviewer", description: "Recreated", body: "Review." });
  assert.deepEqual(await names(null), ["global-reviewer", "renamed-reviewer"]);
  console.log("PASS: real Host create/edit/restart/rename/disable/remove and project A/B/projectless runtime catalog isolation");
} finally {
  await host.stop();
  if (previous === undefined) delete process.env.PI_DESKTOP_AGENTS_DIR;
  else process.env.PI_DESKTOP_AGENTS_DIR = previous;
  await rm(root, { recursive: true, force: true });
}

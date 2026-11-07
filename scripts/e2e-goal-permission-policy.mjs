#!/usr/bin/env node
// Real Host permission ingress; no model requests, sidecar or desktop interaction.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { HostProcess } from "../packages/host-runtime/dist/index.js";

assert(process.env.PI_HOST_CORE_BINARY && process.env.PI_SCRATCH_DIR);
// This selects the assertion for the dependent feature, not a Host capability.
const autonomous = process.argv.includes("--autonomous-goal-policy");
const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR, "goal-permission-policy-"));
const data = join(root, "data"), home = join(root, "home"), workspace = join(root, "workspace"), agents = join(root, "agents");
for (const directory of [data, home, workspace, agents]) await mkdir(directory, { recursive: true });
const host = new HostProcess({ binaryPath: resolve(process.env.PI_HOST_CORE_BINARY), dataDir: data,
  env: { HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData"), PI_DESKTOP_AGENTS_DIR: agents }, onStderr() {} });
try {
  await host.handshake();
  await host.call("workspace.set", { path: workspace });
  for (const mode of ["agent", "plan", "goal"]) {
    const { session } = await host.call("session.create", { title: `Permission ${mode}`, mode, projectPath: workspace });
    await host.call("session.configure", { id: session.id, mode, permissionMode: "auto" });
    const allowed = mode === "agent" || (mode === "goal" && autonomous);
    const path = `${mode}.txt`;
    const result = await host.call("tools.execute", { sessionId: session.id, toolCallId: randomUUID(), toolName: "Write",
      args: { path, content: "isolated policy fixture" }, mode: mode === "agent" ? "goal" : "agent" });
    assert.equal(result.ok, allowed, JSON.stringify({ mode, result }));
    if (allowed) assert.equal(await readFile(join(workspace, path), "utf8"), "isolated policy fixture");
    else {
      assert.equal(result.errorCode, "WRITE_DISABLED_IN_PLAN");
      await assert.rejects(readFile(join(workspace, path)), { code: "ENOENT" });
    }
  }
  console.log(JSON.stringify({ result: "PASS", agentAutoWrite: true, planAutoDenied: true,
    legacyGoalAutoDenied: !autonomous, autonomousGoalUsesAgentPolicy: autonomous,
    callerModeCannotSelectPolicy: true, modelRequests: 0 }, null, 2));
} finally {
  await host.dispose();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

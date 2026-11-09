#!/usr/bin/env node
/** Offline staged-mode acceptance against a real isolated Host process. */
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveHostBinary } from "./e2e/host.mjs";
import { withScenario } from "./e2e/fixture.mjs";
import { beginTurn, createSession, endTurn } from "./e2e/session.mjs";

const root = process.env.PI_SCRATCH_DIR;
assert.ok(root, "PI_SCRATCH_DIR is required for isolated test state");
const temp = join(root, "mode-e2e");
await mkdir(temp, { recursive: true });
await withScenario("mode-workflow", async ({ host, workspace }) => {
  const session = await createSession(host, workspace, "Mode acceptance");
  const sessionId = session.id;
  const definition = {
    version: 1, id: "acceptance", label: "Acceptance", description: "Offline test",
    source: "user", permission: "agent", prompt: "Verify the requested change.",
    artifacts: [{ id: "spec", path: ".pi/runs/{{run.id}}/spec.md", requiredHeadings: ["Goal", "Evidence"] }],
    budget: { maxTurns: 20, maxTokens: null }, returnTo: "agent",
    stages: [
      { id: "draft", permission: "contract", prompt: "Draft the spec.", loop: false,
        onEnter: [], onCompaction: [], next: "verify",
        exit: [{ kind: "require", artifact: "spec", onFail: { retries: 2 } }, { kind: "ask" }] },
      { id: "verify", permission: "agent", prompt: "Verify.", loop: true,
        onEnter: [], onCompaction: [],
        exit: [{ kind: "run", command: "echo mode-gate-ok", timeoutMinutes: 1, onFail: { retries: 0 } }] },
    ],
  };
  await host.call("session.configure", { id: sessionId, mode: definition.id, modeSnapshot: definition, permissionMode: "auto" });
  const turnId = await beginTurn(host, sessionId);
  const claim = await host.call("modes.start", { sessionId, turnId, input: "Produce and verify a spec" });
  assert.equal(claim.claimed, true);
  const runId = claim.run.id;
  const failed = await host.call("modes.completeStage", { sessionId, runId, turnId, summary: "Not ready" });
  assert.equal(failed.status, "failed");
  const markdown = "# Goal\nProduce a spec.\n# Evidence\nValidated offline.\n";
  const approval = await host.call("modes.completeStage", { sessionId, runId, turnId, summary: "Ready", artifacts: { spec: markdown } });
  assert.equal(approval.status, "awaiting_approval");
  assert.equal(await readFile(join(workspace, claim.run.artifactPaths.spec), "utf8"), markdown);
  await endTurn(host, turnId);
  const settled = await host.call("modes.settleTurn", { sessionId, runId, turnId, tokens: 12, outcome: "completed" });
  assert.equal(settled.continue, false);
  const resolved = await host.call("modes.resolve", { sessionId, runId, expectedRevision: settled.run.revision, action: "approve" });
  assert.equal(resolved.continue, true);
  const secondTurn = await beginTurn(host, sessionId);
  const secondClaim = await host.call("modes.claimTurn", {
    sessionId, runId, expectedRevision: resolved.run.revision, turnId: secondTurn, origin: "approval",
  });
  assert.equal(secondClaim.run.stageId, "verify");
  const gate = await host.call("modes.completeStage", { sessionId, runId, turnId: secondTurn, summary: "Verify" });
  assert.equal(gate.status, "run");
  const shell = (await host.call("commandShells.list")).effective;
  const toolCallId = "mode-verify-command";
  await assert.rejects(host.call("tools.execute", {
    sessionId, turnId: secondTurn, toolCallId: "wrong-command", toolName: "Bash", mode: "agent",
    args: { command: "echo wrong" }, modeGate: { runId, gateIndex: gate.gateIndex },
    expectedCommandShellId: shell.id, expectedCommandShellDialect: shell.dialect,
  }), (error) => error.errorCode === "MODE_GATE_MISMATCH");
  const executed = await host.call("tools.execute", {
    sessionId, turnId: secondTurn, toolCallId, toolName: "Bash", mode: "agent",
    args: { command: gate.command }, modeGate: { runId, gateIndex: gate.gateIndex },
    expectedCommandShellId: shell.id, expectedCommandShellDialect: shell.dialect,
  });
  assert.equal(executed.ok, true);
  const finished = await host.call("modes.gateResult", { sessionId, runId, turnId: secondTurn, gateIndex: gate.gateIndex, toolCallId });
  assert.equal(finished.status, "finished");
  await endTurn(host, secondTurn);
  await host.call("modes.settleTurn", { sessionId, runId, turnId: secondTurn, tokens: 3, outcome: "completed" });
  assert.equal((await host.call("session.get", { id: sessionId, messageLimit: 1 })).session.mode, "agent");
  assert.equal((await host.call("modes.get", { sessionId })).run, null);
  console.log("PASS mode snapshot -> artifact checks -> approval -> command gate -> completion -> Agent");
}, resolveHostBinary(), temp);

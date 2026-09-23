#!/usr/bin/env node
/** Real host process + review coordinator + Pi HTTP adapter; all data and model traffic are local. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewPermissionAction } from "../packages/agent-runtime/dist/permission-review.js";
import { PermissionReviewCoordinator } from "../packages/host-runtime/dist/permission-review-coordinator.js";
import { DEFAULT_PERMISSION_REVIEW_POLICY } from "../packages/shared/dist/index.js";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { waitFor } from "./e2e/wait.mjs";

const scratch = await mkdtemp(join(tmpdir(), "pi-review-e2e-"));
const workspace = join(scratch, "workspace");
await mkdir(workspace);
const host = new Host(resolveHostBinary(), join(scratch, "data"));
const modelInputs = [];
let modelReply = JSON.stringify({ decision: "allow_once", risk: "low", authorization: "explicit", reason: "The user requested this fixture file." });
const server = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    modelInputs.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "text/event-stream" });
    const frame = (delta, finish_reason) => `data: ${JSON.stringify({ id: "review-fixture", object: "chat.completion.chunk", created: 1, model: "reviewer", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    response.write(frame({ role: "assistant", content: modelReply }, null));
    response.write(frame({}, "stop"));
    response.write(`data: ${JSON.stringify({ id: "review-fixture", object: "chat.completion.chunk", created: 1, model: "reviewer", choices: [], usage: { prompt_tokens: 24, completion_tokens: 12, total_tokens: 36 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  } catch { response.writeHead(500); response.end("Invalid fixture request"); }
});
await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
const provider = {
  id: "fixture-reviewer", name: "Local review fixture", modelId: "reviewer",
  baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "fixture-only",
  apiStyle: "chat_completions", supportsReasoning: false, supportedThinkingLevels: ["off"],
};
const reviews = [];
const diagnostics = [];
const resolveReview = async (requestId, token, fingerprint, result) => {
  const outcome = await host.call("permissions.resolveReview", { requestId, token, fingerprint, result });
  reviews.push({ requestId, result, outcome });
};
const coordinator = new PermissionReviewCoordinator({
  claim: (requestId) => host.call("permissions.claimReview", { requestId }),
  settle: resolveReview, fallback: resolveReview,
}, (action, signal) => reviewPermissionAction(provider, action, "off", { signal }), Date.now,
  (code) => diagnostics.push(code));
const cases = [];
const customPolicy = "Approve only the user's explicitly requested fixture file writes. Send any dependency installation to a human.";
let sessionId;
let turnId;
const permissionFor = (toolCallId) => host.notifications.find((note) => note.method === "permissions.request" && note.params.toolCallId === toolCallId)?.params;
async function pendingCall(toolName, args, actorId = "agent") {
  const toolCallId = randomUUID();
  const completion = host.call("tools.execute", { sessionId, turnId, toolCallId, toolName, args, actorId, mode: "agent" }, 15_000);
  // Attach immediately so a fixture failure cannot create an unhandled rejection during cleanup.
  completion.catch(() => {});
  await waitFor(() => permissionFor(toolCallId), 5000, "permission request");
  return { completion, permission: permissionFor(toolCallId), toolCallId };
}
async function approve(call, decision = "allow-once") {
  await host.call("permissions.resolve", { requestId: call.permission.requestId, decision });
  return call.completion;
}
function enqueue(call) {
  const requestedAt = Date.parse(call.permission.createdAt);
  assert(Number.isFinite(requestedAt), "Host must supply the original permission timestamp");
  coordinator.enqueue({ requestId: call.permission.requestId, sessionId, requestedAt });
}
try {
  await host.start();
  await host.call("permissions.setReviewCapability", { available: true });
  await host.call("workspace.set", { path: workspace });
  await host.call("settings.set", { approvalReviewer: "auto_review", defaultPermissionMode: "ask",
    autoReview: { policyPrompt: customPolicy } });
  const created = await host.call("session.create", { title: "Permission review fixture", mode: "agent", projectPath: workspace });
  sessionId = created.session.id;
  await host.call("session.appendMessage", { sessionId, message: {
    id: randomUUID(), role: "user", content: "Create result.txt with the text approved and fallback.txt with the text manual.",
    createdAt: new Date().toISOString(), status: "complete",
  } });
  ({ turnId } = await host.call("session.beginTurn", { sessionId }));
  const allowed = await pendingCall("Write", { path: "result.txt", content: "approved" });
  enqueue(allowed);
  assert.equal((await allowed.completion).ok, true);
  assert.equal(await readFile(join(workspace, "result.txt"), "utf8"), "approved");
  assert.equal(modelInputs.length, 1);
  assert.equal(modelInputs[0].tools?.length ?? 0, 0);
  const customSystemPrompt = modelInputs[0].messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
  assert(customSystemPrompt.includes(customPolicy), "Host-saved policy must reach the real review model");
  assert(!customSystemPrompt.includes(DEFAULT_PERMISSION_REVIEW_POLICY),
    "Custom policy replaces, rather than appends to, the default policy");
  assert.equal((await host.call("permissions.listSessionGrants", { sessionId })).grants.length, 0);
  cases.push("automatic one-shot approval through real HTTP adapter; no grant created");
  cases.push("saved custom policy reaches the model without a hidden default-policy overlay");
  await host.call("settings.set", { autoReview: {} });
  assert.equal((await host.call("settings.get")).autoReview?.policyPrompt, undefined);

  for (const content of ["api_key=fixture-only-not-a-real-secret", JSON.stringify({ access_token: "fixture-only-value" })]) {
    const sensitive = await pendingCall("Write", { path: "sensitive-context.txt", content });
    enqueue(sensitive);
    await waitFor(() => reviews.some((review) => review.requestId === sensitive.permission.requestId), 5000, "sensitive context fallback");
    assert.equal(modelInputs.length, 1, "Sensitive action context must not reach the model endpoint");
    assert.equal((await approve(sensitive, "deny")).ok, false);
    await assert.rejects(readFile(join(workspace, "sensitive-context.txt")), { code: "ENOENT" });
  }
  cases.push("sensitive decision context falls back to a human without contacting the reviewer model");

  modelReply = "not a JSON decision";
  const fallback = await pendingCall("Write", { path: "fallback.txt", content: "manual" });
  enqueue(fallback);
  await waitFor(() => reviews.some((review) => review.requestId === fallback.permission.requestId), 5000, "manual fallback");
  const restoredSystemPrompt = modelInputs.at(-1).messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
  assert(restoredSystemPrompt.includes(DEFAULT_PERMISSION_REVIEW_POLICY), "Reset must restore the actual built-in policy");
  assert(!restoredSystemPrompt.includes(customPolicy), "Reset must not retain custom instructions");
  await assert.rejects(readFile(join(workspace, "fallback.txt")), { code: "ENOENT" });
  assert.equal((await approve(fallback)).ok, true);
  assert.equal(await readFile(join(workspace, "fallback.txt"), "utf8"), "manual");
  cases.push("malformed model response does not execute before manual approval");
  cases.push("restoring the default policy changes the next actual model request");

  const oldPolicy = await pendingCall("Write", { path: "old-policy.txt", content: "must-not-execute" });
  const oldPolicyClaim = await host.call("permissions.claimReview", { requestId: oldPolicy.permission.requestId });
  await host.call("settings.set", { autoReview: { policyPrompt: customPolicy } });
  await assert.rejects(host.call("permissions.resolveReview", {
    requestId: oldPolicy.permission.requestId, token: oldPolicyClaim.token, fingerprint: oldPolicyClaim.fingerprint,
    result: { decision: "allow_once", risk: "low", authorization: "explicit", reason: "Stale policy answer", policyVersion: "1" },
  }));
  assert.equal((await oldPolicy.completion).ok, false);
  await assert.rejects(readFile(join(workspace, "old-policy.txt")), { code: "ENOENT" });
  await host.call("settings.set", { autoReview: {} });
  cases.push("policy changes reject late old-policy approvals without creating the target file");

  const takeover = await pendingCall("Write", { path: "canceled.txt", content: "must-not-execute" });
  const claimed = await host.call("permissions.claimReview", { requestId: takeover.permission.requestId });
  await host.call("permissions.takeoverReview", { requestId: takeover.permission.requestId });
  await assert.rejects(host.call("permissions.resolveReview", {
    requestId: takeover.permission.requestId, token: claimed.token, fingerprint: claimed.fingerprint,
    result: { decision: "allow_once", risk: "low", authorization: "explicit", reason: "Late fixture answer", policyVersion: "1" },
  }));
  assert.equal((await approve(takeover, "deny")).ok, false);
  await assert.rejects(readFile(join(workspace, "canceled.txt")), { code: "ENOENT" });
  cases.push("takeover invalidates a late automated approval");

  const invalid = await pendingCall("Write", { path: "invalid-review.txt", content: "must-not-execute" });
  const invalidClaim = await host.call("permissions.claimReview", { requestId: invalid.permission.requestId });
  const invalidResult = await host.call("permissions.resolveReview", {
    requestId: invalid.permission.requestId, token: invalidClaim.token, fingerprint: invalidClaim.fingerprint,
    result: { decision: "allow_once", risk: "invalid-risk", authorization: "explicit", reason: "Malformed fixture result", policyVersion: "1" },
  });
  assert.equal(invalidResult.decision, "needs_user");
  await assert.rejects(readFile(join(workspace, "invalid-review.txt")), { code: "ENOENT" });
  assert.equal((await approve(invalid, "deny")).ok, false);
  cases.push("Host rejects malformed review enums even when runtime validation is bypassed");

  await host.call("session.endTurn", { turnId, status: "completed", createNotification: false });
  await host.call("settings.set", { approvalReviewer: "user" });
  ({ turnId } = await host.call("session.beginTurn", { sessionId }));
  const grant = await pendingCall("Write", { path: "scoped.txt", content: "first" });
  assert.equal((await approve(grant, "allow-session")).ok, true);
  const grants = (await host.call("permissions.listSessionGrants", { sessionId })).grants;
  assert.equal(grants.length, 1);
  const repeatedCallId = randomUUID();
  const repeated = await host.call("tools.execute", {
    sessionId, turnId, toolCallId: repeatedCallId, toolName: "Write", actorId: "agent", mode: "agent",
    args: { path: "scoped.txt", content: "same-scope" },
  });
  assert.equal(repeated.ok, true);
  assert.equal(permissionFor(repeatedCallId), undefined);
  const differentPath = await pendingCall("Write", { path: "other.txt", content: "not-approved" });
  assert.equal((await approve(differentPath, "deny")).ok, false);
  const delegate = await pendingCall("Write", { path: "scoped.txt", content: "delegate" }, "delegate-fixture");
  assert.equal((await approve(delegate, "deny")).ok, false);
  await host.call("permissions.revokeSessionGrant", { sessionId, grantId: grants[0].id });
  const revoked = await pendingCall("Write", { path: "scoped.txt", content: "second" });
  assert.equal((await approve(revoked, "deny")).ok, false);
  assert.equal(await readFile(join(workspace, "scoped.txt"), "utf8"), "same-scope");
  cases.push("manual grant is reusable only within its scope, does not cross paths or actors, and can be revoked");

  const mcp = await pendingCall("mcp_fixture_delete", { target: "fixture-only" });
  const other = await host.call("session.create", { title: "Independent settings fixture", mode: "agent", projectPath: workspace });
  await host.call("session.configure", { id: other.session.id, mode: "agent", permissionMode: "auto" });
  assert((await host.call("permissions.pending", { sessionId })).requests.some((request) => request.requestId === mcp.permission.requestId),
    "Changing another session must not cancel this permission request");
  assert.equal((await approve(mcp, "deny")).ok, false);
  assert.equal(host.notifications.some((note) => note.method === "plugins.execute" && note.params.toolCallId === mcp.toolCallId), false);
  cases.push("MCP requires Ask approval before external dispatch");
  cases.push("unrelated session configuration leaves an existing permission request intact");
  await host.call("session.configure", { id: other.session.id, mode: "agent", approvalReviewer: "auto_review" });
  const requestsBeforeAuto = modelInputs.length;
  const autoCallId = randomUUID();
  const auto = await host.call("tools.execute", {
    sessionId: other.session.id, toolCallId: autoCallId, toolName: "Write", mode: "agent",
    args: { path: "auto.txt", content: "explicit-auto" },
  });
  assert.equal(auto.ok, true);
  assert.equal(await readFile(join(workspace, "auto.txt"), "utf8"), "explicit-auto");
  assert.equal(permissionFor(autoCallId), undefined);
  assert.equal(modelInputs.length, requestsBeforeAuto);
  cases.push("explicit Auto retains bypass semantics without an extra model request");
  const localAction = { sessionId: other.session.id, toolCallId: randomUUID(),
    toolName: "GenerateImages", args: { items: [{ prompt: "fixture only", count: 1 }] }, mode: "agent" };
  const localGate = await host.call("permissions.authorizeLocalTool", localAction);
  assert.equal(localGate.ok, true);
  assert.equal(typeof localGate.executionPermit, "string");
  const localExecution = { ...localAction, executionPermit: localGate.executionPermit };
  assert.equal((await host.call("permissions.consumeLocalPermit", localExecution)).ok, true);
  await assert.rejects(host.call("permissions.consumeLocalPermit", localExecution));
  cases.push("host-local execution permit is consumed exactly once without running a paid tool");
  await host.call("session.configure", { id: sessionId, mode: "agent", approvalReviewer: "auto_review" });
  const stopped = await pendingCall("Write", { path: "stopped.txt", content: "must-not-execute" });
  const stoppedClaim = await host.call("permissions.claimReview", { requestId: stopped.permission.requestId });
  await host.call("session.endTurn", { turnId, status: "aborted", createNotification: false });
  await assert.rejects(host.call("permissions.resolveReview", {
    requestId: stopped.permission.requestId, token: stoppedClaim.token, fingerprint: stoppedClaim.fingerprint,
    result: { decision: "allow_once", risk: "low", authorization: "explicit", reason: "Late after Stop", policyVersion: "1" },
  }));
  assert.equal((await stopped.completion).ok, false);
  await assert.rejects(readFile(join(workspace, "stopped.txt")), { code: "ENOENT" });
  cases.push("turn cancellation rejects a late approval and never executes the pending tool");
  const history = await host.call("permissions.listReviewHistory", { sessionId });
  const approvedReview = history.entries.find((entry) => entry.requestId === allowed.permission.requestId);
  assert.equal(approvedReview?.decision, "allow_once");
  assert.equal(approvedReview?.usage?.totalTokens, 36);
  assert.equal(history.entries.filter((entry) => entry.requestId === allowed.permission.requestId).length, 1);
  await host.call("session.configure", { id: sessionId, mode: "agent", approvalReviewer: "user" });
  ({ turnId } = await host.call("session.beginTurn", { sessionId }));
  const transientGrant = await pendingCall("Write", { path: "restart-grant.txt", content: "before-restart" });
  assert.equal((await approve(transientGrant, "allow-session")).ok, true);
  assert.equal((await host.call("permissions.listSessionGrants", { sessionId })).grants.length, 1);
  await host.call("session.endTurn", { turnId, status: "completed", createNotification: false });
  await host.stop();
  await host.start();
  assert.equal((await host.call("permissions.listSessionGrants", { sessionId })).grants.length, 0);
  const restoredHistory = await host.call("permissions.listReviewHistory", { sessionId });
  assert.equal(restoredHistory.entries.find((entry) => entry.requestId === allowed.permission.requestId)?.usage?.totalTokens, 36);
  cases.push("review outcome and separate usage survive Host restart while grants do not");
  assert.deepEqual(diagnostics, []);
  console.log(JSON.stringify({ ok: true, cases, modelRequests: modelInputs.length, environment: "isolated Rust host + local HTTP model fixture" }));
} finally {
  coordinator.dispose();
  await host.stop();
  await new Promise((done) => server.close(done));
  await rm(scratch, { recursive: true, force: true });
}

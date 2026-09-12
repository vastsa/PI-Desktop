import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { assert, shortJson } from "./assert.mjs";

export async function enterPlan(host, sessionId, turnId, toolCallId) {
  const response = await host.call("plans.enter", {
    sessionId,
    turnId,
    toolCallId,
    requestedMode: "agent",
  });
  assert(response?.state === "planning", "plans.enter failed: " + shortJson(response));
  return response;
}

export async function submitPlan(
  host,
  sessionId,
  turnId,
  toolCallId,
  title,
  markdown,
  question,
) {
  const response = await host.call("plans.submit", {
    sessionId,
    turnId,
    toolCallId,
    title,
    markdown,
    question,
  });
  assert(response?.status === "pending", "plans.submit failed: " + shortJson(response));
  assert(
    response?.proposal?.id,
    "plans.submit returned no proposal: " + shortJson(response),
  );
  return response.proposal;
}

export function resolveParams(proposal, action, targetPermissionMode) {
  const params = {
    proposalId: proposal.id,
    sessionId: proposal.sessionId,
    turnId: proposal.turnId,
    toolCallId: proposal.toolCallId,
    version: proposal.version,
    action,
  };
  if (targetPermissionMode !== undefined) {
    params.targetPermissionMode = targetPermissionMode;
  }
  return params;
}

export async function resolvePlan(host, proposal, action, targetPermissionMode) {
  return host.call(
    "plans.resolve",
    resolveParams(proposal, action, targetPermissionMode),
  );
}

export async function verifyArtifact(ctx, proposal, markdown, title, question) {
  const artifact = proposal.artifact;
  assert(artifact, "proposal has no artifact: " + shortJson(proposal));
  assert(
    /^\.pi\/plan\/[^/\\]+\.md$/.test(artifact.relativePath),
    "unsafe/unexpected artifact path: " + artifact.relativePath,
  );
  const path = join(ctx.workspace, ...artifact.relativePath.split("/"));
  const bytes = await readFile(path);
  const expectedBytes = Buffer.from(markdown, "utf8");
  assert(bytes.equals(expectedBytes), "artifact bytes changed at " + artifact.relativePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  assert(artifact.sha256 === sha256, "artifact hash mismatch: " + shortJson(artifact));
  assert(
    artifact.sizeBytes === bytes.length,
    "artifact size mismatch: " + shortJson(artifact),
  );
  assert(proposal.markdown === markdown, "proposal Markdown is not byte-identical");
  assert(proposal.plan === markdown, "proposal plan snapshot is not byte-identical");
  assert(
    proposal.title === title.trim(),
    "structured title mismatch: " + shortJson(proposal),
  );
  assert(
    proposal.question === question.trim(),
    "structured question mismatch: " + shortJson(proposal),
  );
  return { path, bytes, sha256, sizeBytes: bytes.length };
}

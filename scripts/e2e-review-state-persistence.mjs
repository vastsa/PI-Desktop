#!/usr/bin/env node
/** Real Host rollback and restart, with an isolated synthetic large transcript. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { configureSession, createSession } from "./e2e/session.mjs";

const temp = await mkdtemp(join(tmpdir(), "pi-review-state-e2e-"));
const workspace = join(temp, "workspace");
const dataDir = join(temp, "data");
const host = new Host(resolveHostBinary(), dataDir);
const createdAt = "2026-10-28T00:00:00Z";
const historyMiB = process.argv.includes("--large") ? 384 : 16;

async function prefixHash(path, length) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { start: 0, end: length - 1 })) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function suffix(path, start) {
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc((await file.stat()).size - start);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, start);
    assert.equal(bytesRead, bytes.length);
    return bytes.toString("utf8");
  } finally {
    await file.close();
  }
}

try {
  await mkdir(workspace);
  await writeFile(join(workspace, "review.txt"), "before\n");
  await host.start();
  const session = await createSession(host, workspace, "Large review rollback");
  await configureSession(host, session, "agent", "auto");
  const written = await host.call("tools.execute", {
    sessionId: session.id,
    toolCallId: "review-write",
    toolName: "Write",
    args: { path: "review.txt", content: "after\n" },
    mode: "agent",
  });
  assert.equal(written.ok, true);
  const review = written.content.review;
  assert.equal(review.state, "active");
  const append = (message) => host.call("session.appendMessage", { sessionId: session.id, message });
  await append({
    id: review.messageId,
    role: "tool",
    toolCallId: "review-write",
    toolName: "Write",
    toolResult: { details: written.content },
    toolStatus: "success",
    content: "Wrote review.txt",
    createdAt,
  });
  const body = "x".repeat(1024 * 1024);
  for (let index = 0; index < historyMiB; index++) {
    await append({
      id: `history-${index}`, role: "tool", toolName: "Read",
      toolCallId: `history-${index}`, toolStatus: "success",
      toolResult: { content: body }, content: "Retained tool output", createdAt,
    });
  }
  const path = join(dataDir, "sessions", `${session.id}.jsonl`);
  // Opening the conversation builds its derived layout once. The rollback
  // must then locate a historical card without re-reading retained bodies.
  const openingStarted = performance.now();
  await host.call("session.get", { id: session.id, messageLimit: 1, contentLimit: 100 });
  const coldOpenMs = performance.now() - openingStarted;
  const before = await stat(path);
  const hash = await prefixHash(path, before.size);
  const started = performance.now();
  const outcome = await host.call("review.rollback", { sessionId: session.id, snapshotId: review.snapshotId });
  const elapsedMs = performance.now() - started;
  assert.equal(outcome.status, "rolledBack");
  assert.equal(await readFile(join(workspace, "review.txt"), "utf8"), "before\n");
  const after = await stat(path);
  const appendedBytes = after.size - before.size;
  assert.ok(appendedBytes > 0 && appendedBytes < 256);
  assert.equal(await prefixHash(path, before.size), hash, "retained transcript bytes must be untouched");
  const update = JSON.parse(await suffix(path, before.size));
  assert.deepEqual(update, {
    type: "tool_review_state", messageId: review.messageId,
    snapshotId: review.snapshotId, state: "rolledBack",
  });

  async function verify() {
    const { session: page } = await host.call("session.get", {
      id: session.id, messageAround: review.messageId, messageLimit: 1,
    });
    assert.equal(page.messages[0].id, review.messageId);
    assert.equal(page.messages[0].toolResult.details.review.state, "rolledBack");
    assert.equal(page.messageCount, historyMiB + 1);
    const { session: tail } = await host.call("session.get", { id: session.id, messageLimit: 1, contentLimit: 100 });
    assert.equal(tail.messages[0].id, `history-${historyMiB - 1}`);
  }
  await verify();
  await host.restart();
  await verify();
  const repeated = await host.call("review.rollback", { sessionId: session.id, snapshotId: review.snapshotId });
  assert.equal(repeated.status, "alreadyRolledBack");
  assert.equal((await stat(path)).size, after.size, "retries must not append duplicate state");
  console.log(JSON.stringify({
    scenario: "review-state-persistence", transcriptBytes: before.size,
    appendedBytes, coldOpenMs: Math.round(coldOpenMs), elapsedMs: Math.round(elapsedMs),
    restart: "pass", result: "pass",
  }));
} finally {
  await host.stop();
  await rm(temp, { recursive: true, force: true });
}

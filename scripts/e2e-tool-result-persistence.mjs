#!/usr/bin/env node
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HostProcess } from "../packages/host-runtime/dist/host-process.js";
import { MAX_HOST_STDIN_LINE_BYTES } from "../packages/shared/dist/index.js";
import { toolResultFromUi } from "../packages/agent-runtime/dist/runtime.js";
import { transcriptRewriteHarness } from "../apps/desktop/test/helpers/transcript-rewrite-harness.mjs";

// Valid, deterministic PNGs with incompressible pixels approximate the reported
// 35 screenshots / 25 MB of distinct base64 without private screenshots or APIs.
function screenshot(seed) {
  const side = 420;
  const pixels = Buffer.alloc((side * 3 + 1) * side);
  let state = seed;
  for (let y = 0; y < side; y++) {
    for (let x = 1; x <= side * 3; x++) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      pixels[y * (side * 3 + 1) + x] = state & 255;
    }
  }
  function chunk(name, bytes) {
    const body = Buffer.concat([Buffer.from(name), bytes]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, body, checksum]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side); header.writeUInt32BE(side, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

const binaryPath = process.env.PI_DESKTOP_HOST_BIN;
assert.ok(binaryPath, "PI_DESKTOP_HOST_BIN must name the candidate's built Host binary");
const dataDir = await mkdtemp(join(tmpdir(), "pi-tool-image-e2e-"));
const createdAt = "2026-10-24T19:00:00.000Z";
let host;
let movedDataDir;
let largestMutationBytes = 0;
function start(directory = dataDir) {
  const childHost = new HostProcess({ binaryPath, dataDir: directory, onStderr: (text) => process.stderr.write(text) });
  const call = childHost.call.bind(childHost);
  childHost.call = (method, params, ...rest) => {
    if (["session.deleteMessage", "session.retractPendingPrompt", "session.activateRevision"].includes(method)) {
      const bytes = Buffer.byteLength(JSON.stringify({ method, params }));
      largestMutationBytes = Math.max(largestMutationBytes, bytes);
      assert.ok(bytes < 512, "existing-history operations must contain IDs, never image history");
    }
    return call(method, params, ...rest);
  };
  return childHost;
}
function row(index) {
  const image = { type: "image", data: screenshot(index + 1), mimeType: "image/png" };
  const content = [{ type: "text", text: `Screenshot ${index + 1}` }, image];
  const result = { content, details: { content, imageCount: 1, label: "保留 metadata" } };
  return { id: `call-${index}`, role: "tool", toolCallId: `call-${index}`, toolName: "mcp_windows_mcp_Snapshot", toolStatus: "success", content: JSON.stringify(result, null, 2), toolResult: result, createdAt };
}
function nestedRow(path) {
  const image = { type: "image", data: screenshot(9000), mimeType: "image/png" };
  let result = { content: [image], details: { path } };
  for (let level = 0; level < 3; level++) {
    const text = JSON.stringify(result, null, 2);
    result = { content: [image], source: `层${level}😀`, nested: { result, text } };
  }
  return { id: "nested-result", role: "tool", toolCallId: "nested-result", toolName: "Snapshot", toolStatus: "success", content: JSON.stringify(result, null, 2), toolResult: result, createdAt };
}
async function session(title) { return (await host.call("session.create", { title, mode: "agent" })).session.id; }
async function append(sessionId, message, turnId) { await host.call("session.appendMessage", { sessionId, message, ...(turnId ? { turnId } : {}) }); }
async function verifyPages(sessionId, expected, images, forked = false) {
  for (let start = 0; start < expected.length; start += 10) {
    const page = (await host.call("session.get", { id: sessionId, messageBefore: Math.min(expected.length, start + 10), messageLimit: Math.min(10, expected.length-start) })).session;
    if (!forked) assert.deepEqual(page.messages.map((m) => m.id), expected.slice(start, start+10).map((m) => m.id));
    for (const [offset, actual] of page.messages.entries()) {
      const expectedRow = expected[start + offset];
      assert.equal(actual.content, expectedRow.content);
      const original = images.get(expectedRow.id);
      if (!original) continue;
      assert.equal(actual.content, original.content, "mirror spelling must survive restart exactly");
      assert.deepEqual(actual.toolResult, original.toolResult, "plugins must receive the complete original result");
      const restored = toolResultFromUi(actual, 1);
      assert.deepEqual(restored.content, original.toolResult.content);
      assert.deepEqual(restored.details, original.toolResult.details);
    }
  }
}
try {
  host = start(); await host.handshake();
  const smallId = await session("35 screenshots / 548 messages");
  const small = [{ id: "root-user", role: "user", content: "Keep screenshot history", createdAt }];
  const originals = new Map();
  for (let index = 0; index < 35; index++) { const message = row(index); small.push(message); originals.set(message.id, message); }
  while (small.length < 548) small.push({ id: `text-${small.length}`, role: "assistant", content: `Retained ${small.length}`, createdAt });
  const oldBytes = Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: "baseline", method: "session.replaceMessages", params: { sessionId: smallId, messages: small } }) + "\n");
  assert.ok(oldBytes > MAX_HOST_STDIN_LINE_BYTES);
  await assert.rejects(host.call("session.replaceMessages", { sessionId: smallId, messages: small }), { errorCode: "LIMIT_EXCEEDED", code: 1002 });
  for (const message of small) await append(smallId, message);
  const raw = await readFile(join(dataDir, "sessions", `${smallId}.jsonl`), "utf8");
  for (const original of originals.values()) assert.equal(raw.split(original.toolResult.content[1].data).length - 1, 1);
  const { decodeBinaryStorage } = await import("../packages/host-runtime/dist/binary-storage.js");
  const encodedRow = raw.split("\n").filter(Boolean).map(JSON.parse).find((m) => m.id === "call-0");
  const crossLanguage = decodeBinaryStorage(encodedRow);
  assert.deepEqual(crossLanguage.blocks[0].result, originals.get("call-0").toolResult);
  assert.equal(crossLanguage.blocks[0].text, originals.get("call-0").content);
  await host.dispose(); host = start(); await host.handshake();
  await verifyPages(smallId, small, originals);
  const harness = transcriptRewriteHarness(host, dataDir);
  const deletion = await harness.deleteMessage({ sessionId: smallId, messageId: "text-547" });
  assert.equal(deletion.deleted, true); small.pop();
  assert.equal((await harness.deleteMessage({ sessionId: smallId, messageId: "text-547" })).deleted, false);
  await verifyPages(smallId, small, originals);
  console.log(JSON.stringify({ phase: "35-screenshot-history", screenshots: 35, oldRequestBytes: oldBytes, storedBytes: Buffer.byteLength(raw), retainedMessages: small.length }));

  // Unique bytes alone cross 64 MiB. Build through legal individual requests,
  // so success cannot be a fortuitous 99 MB -> 49 MB boundary crossing.
  const largeId = await session("Unique images exceed 64 MiB");
  const root = { id: "large-root", role: "user", content: "Keep large history", createdAt };
  const expected = [root]; let uniqueBytes = 0;
  await append(largeId, root);
  for (let index = 0; uniqueBytes <= MAX_HOST_STDIN_LINE_BYTES; index++) {
    const message = row(index + 1000); uniqueBytes += message.toolResult.content[1].data.length;
    await append(largeId, message); expected.push(message);
  }
  const largeCount = expected.length;
  console.log(JSON.stringify({ phase: "large-history-built", uniqueBytes, images: largeCount - 1 }));
  await host.call("session.saveActiveRevision", { sessionId: largeId });
  const tip = { id: "delete-tip", role: "assistant", content: "Delete only this row", createdAt };
  await append(largeId, tip);
  assert.equal((await harness.deleteMessage({ sessionId: largeId, messageId: tip.id })).deletedCount, 1);
  const { turnId } = await host.call("session.beginTurn", { sessionId: largeId });
  const pending = { id: "pending-user", role: "user", content: "Restore my draft", createdAt };
  await append(largeId, pending, turnId);
  await host.call("session.endTurn", { turnId, status: "aborted", createNotification: false });
  assert.equal((await harness.retractPendingPrompt({ sessionId: largeId, userMessageId: pending.id, turnId })).retracted, true);
  assert.equal((await harness.retractPendingPrompt({ sessionId: largeId, userMessageId: pending.id, turnId })).retracted, false);
  // A late user turn has a small branch but a >64 MiB image prefix. Switch
  // its revisions without uploading that prefix, then remove only that turn.
  const branchUser = { id: "branch-user", role: "user", content: "Regenerate this turn", createdAt };
  const branchAnswer = { id: "branch-answer", role: "assistant", content: "original answer", createdAt };
  await append(largeId, branchUser); await append(largeId, branchAnswer);
  const archived = await host.call("session.truncateFrom", { sessionId: largeId, fromMessageId: branchUser.id });
  assert.ok(archived.revision, "regenerate must archive the removed branch");
  await append(largeId, { ...branchUser, id: "new-branch-user", revisionRootId: branchUser.id, revisionCount: archived.revision.revisionCount, activeRevision: archived.revision.activeRevision });
  await append(largeId, { ...branchAnswer, id: "new-branch-answer", content: "new answer" });
  const saved = await host.call("session.saveActiveRevision", { sessionId: largeId });
  assert.ok(saved.saved, "automatic archival remains Host-owned");
  const revisions = await host.call("session.listRevisions", { sessionId: largeId, rootUserId: branchUser.id });
  const selected = await harness.activateRevision({ sessionId: largeId, rootUserId: branchUser.id, revisionIndex: revisions.revisions[0].revisionIndex, requireCanonicalPrefix: true });
  assert.equal(selected.messages.at(-1).content, branchAnswer.content);
  assert.deepEqual(selected.messages.find((m) => m.id === expected[1].id).toolResult, expected[1].toolResult);
  assert.equal((await harness.deleteMessage({ sessionId: largeId, messageId: branchUser.id })).deletedCount, 2);
  await assert.rejects(harness.activateRevision({ sessionId: largeId, rootUserId: "missing-root", revisionIndex: 0, requireCanonicalPrefix: true }));
  const fork = await host.call("session.fork", { sessionId: largeId, throughMessageId: expected.at(-1).id });
  assert.equal(fork.session.messages.length, largeCount);
  await host.dispose(); host = start(); await host.handshake();
  const expectedImages = new Map(expected.filter((m) => m.role === "tool").map((m) => [m.id, m]));
  for (const id of [largeId, fork.session.id]) {
    await verifyPages(id, expected, expectedImages, id !== largeId);
    const last = (await host.call("session.get", { id, messageLimit: 1 })).session;
    if (id === largeId) assert.equal(last.messages[0].id, expected.at(-1).id);
    else assert.notEqual(last.messages[0].id, expected.at(-1).id, "fork must namespace message identities");
    assert.deepEqual(last.messages[0].toolResult, expected.at(-1).toolResult);
  }
  const after = (await host.call("session.get", { id: largeId, messageLimit: 1 })).session;
  assert.equal(after.messages[0].id, expected.at(-1).id);
  console.log(JSON.stringify({ phase: "over-64-MiB-unique-history", uniqueImageBytes: uniqueBytes, images: largeCount-1, largestMutationBytes, result: "pass" }));
  const nestedId = await session("Nested image result survives profile relocation");
  const originalNested = nestedRow(join(dataDir, "scratch", "nested.png"));
  await append(nestedId, originalNested);
  const nestedPath = join("sessions", `${nestedId}.jsonl`);
  const originalNestedRaw = await readFile(join(dataDir, nestedPath), "utf8");
  assert.equal(originalNestedRaw.split(originalNested.toolResult.content[0].data).length - 1, 1);
  const nestedEncoded = originalNestedRaw.split("\n").filter(Boolean).map(JSON.parse).find((row) => row.id === originalNested.id);
  const nestedDecoded = decodeBinaryStorage(nestedEncoded);
  assert.deepEqual(nestedDecoded.blocks[0].result, originalNested.toolResult, "TS decodes nested Rust output");
  assert.equal(nestedDecoded.blocks[0].text, originalNested.content);
  await host.dispose(); host = undefined;
  movedDataDir = await mkdtemp(join(tmpdir(), "pi-tool-image-moved-"));
  await cp(dataDir, movedDataDir, { recursive: true });
  await promisify(execFile)(binaryPath, ["--relocate-data", dataDir, movedDataDir]);
  assert.equal(await readFile(join(dataDir, nestedPath), "utf8"), originalNestedRaw, "relocation leaves source intact");
  host = start(movedDataDir); await host.handshake();
  const movedNested = (await host.call("session.get", { id: nestedId })).session.messages[0];
  const expectedNested = nestedRow(join(movedDataDir, "scratch", "nested.png"));
  assert.deepEqual(movedNested.toolResult, expectedNested.toolResult);
  assert.equal(movedNested.content, expectedNested.content);
  const movedRaw = await readFile(join(movedDataDir, nestedPath), "utf8");
  assert.equal(movedRaw.split(originalNested.toolResult.content[0].data).length - 1, 1);
  assert.deepEqual((await host.call("session.get", { id: largeId, messageLimit: 1 })).session.messages[0].toolResult, expected.at(-1).toolResult);
  console.log(JSON.stringify({ phase: "nested-cross-language-profile-relocation", levels: 3, storedCopies: 1, result: "pass" }));
} finally {
  if (host) await host.dispose();
  await rm(dataDir, { recursive: true, force: true });
  if (movedDataDir) await rm(movedDataDir, { recursive: true, force: true });
}

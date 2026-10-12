#!/usr/bin/env node
/** Transcript layout cache recovery through an isolated real Host process. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

const temp = await mkdtemp(join(tmpdir(), "pi-transcript-layout-"));
const dataDir = join(temp, "data");
const workspace = join(temp, "workspace");
const host = new Host(resolveHostBinary(), dataDir, {
  env: {
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    GOOGLE_API_KEY: "",
    OPENROUTER_API_KEY: "",
    PI_DESKTOP_TEST_API_KEY: "",
    PI_DESKTOP_TEST_BASE_URL: "",
    PI_DESKTOP_TEST_MODEL: "",
  },
});

const createdAt = "2026-10-11T00:00:00.000Z";
const firstBatch = 230;
const totalMessages = 320;
const messages = [];

function bytesAndOffsets(raw) {
  const offsets = { message: [], compaction: [] };
  let offset = 0;
  for (const line of raw.toString("utf8").split(/(?<=\n)/)) {
    if (!line) continue;
    const value = JSON.parse(line);
    if (value.type === "message") offsets.message.push(offset);
    if (value.type === "compaction") offsets.compaction.push(offset);
    offset += Buffer.byteLength(line);
  }
  return { fileLength: offset, offsets };
}

function writeLegacyLayout(fileLength, offsets) {
  const path = join(dataDir, "sessions", `${sessionId}.jsonl.layout`);
  const rows = [
    `0 ${fileLength}`,
    `${offsets.message.length} ${offsets.compaction.length}`,
    offsets.message.join(" "),
    offsets.compaction.join(" "),
  ];
  return writeFile(path, `${rows.join("\n")}\n`, "utf8");
}

function textMessage(index) {
  return {
    id: `message-${String(index).padStart(3, "0")}`,
    role: "user",
    content: `合成会话 ${index} 🙂 `.repeat(800),
    createdAt,
    status: "complete",
  };
}

function taskMessage(result, suffix = "") {
  return {
    id: "task-middle",
    role: "tool",
    content: `Task result ${suffix}`,
    createdAt,
    toolName: "Task",
    toolCallId: "task-middle-call",
    toolArgs: { agent: "explorer" },
    toolResult: result,
    toolStatus: "success",
  };
}

async function append(sessionId, message) {
  await host.call("session.appendMessage", { sessionId, message });
  messages.push(message);
}

async function readLatest(sessionId) {
  const { session } = await host.call("session.get", {
    id: sessionId,
    messageLimit: 100,
    contentLimit: 20_000,
  });
  assert.ok(session);
  return session;
}

let sessionId;
try {
  await mkdir(workspace, { recursive: true });
  await host.start();
  const created = await host.call("session.create", {
    title: "Transcript layout cache regression",
    mode: "agent",
    projectPath: workspace,
  });
  sessionId = created.session.id;

  for (let index = 0; index < firstBatch; index += 1) {
    if (index === 150) {
      await append(sessionId, taskMessage({
        details: { delegationId: "delegate-middle", status: "running" },
      }));
    } else if (index === 151) {
      await append(sessionId, {
        id: "nested-child",
        role: "assistant",
        content: "子任务结果 🙂",
        createdAt,
        parentToolCallId: "task-middle-call",
      });
    } else {
      await append(sessionId, textMessage(index));
    }
  }

  const initial = await readLatest(sessionId);
  assert.equal(initial.messages.length, 100);
  const transcriptPath = join(dataDir, "sessions", `${sessionId}.jsonl`);
  const initialBytes = await readFile(transcriptPath);
  assert.ok(initialBytes.byteLength > 2 * 1024 * 1024, "fixture must cross the disk-cache threshold");
  const initialLayout = bytesAndOffsets(initialBytes);
  const layoutPath = join(dataDir, "sessions", `${sessionId}.jsonl.layout`);
  let hasDiskCache = false;
  try {
    const cache = await readFile(layoutPath, "utf8");
    assert.ok(cache.startsWith("PI-DESKTOP-TRANSCRIPT-LAYOUT 2\n"));
    hasDiskCache = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  for (let index = firstBatch; index < totalMessages; index += 1) {
    await append(sessionId, textMessage(index));
  }
  const appendedSize = (await stat(transcriptPath)).size;
  assert.ok(appendedSize > initialLayout.fileLength, "append should leave the transcript longer than the cached prefix");

  const terminalTask = taskMessage({
    details: {
      delegationId: "delegate-middle",
      status: "completed",
      result: "最终结果 中文🙂 ".repeat(600),
    },
  }, "终态回写 中文🙂 ".repeat(600));
  await host.call("session.appendMessage", { sessionId, message: terminalTask });
  messages[150] = terminalTask;
  const rewrittenSize = (await stat(transcriptPath)).size;
  assert.ok(rewrittenSize > appendedSize, "terminal Task update must grow the rewritten transcript");
  assert.ok(rewrittenSize > initialLayout.fileLength, "rewritten transcript must remain longer than the old cached prefix");

  const latestInProcess = await readLatest(sessionId);
  assert.deepEqual(
    latestInProcess.messages.map((message) => message.id),
    messages.slice(-100).map((message) => message.id),
  );
  const settledTask = await host.call("session.get", {
    id: sessionId,
    messageAround: "task-middle",
    messageLimit: 20,
  });
  assert.equal(
    settledTask.session.messages.find((message) => message.id === "task-middle").toolResult.details.status,
    "completed",
  );

  // A legacy zero-identity cache is deliberately restored to model an older
  // installation leaving its disposable index beside the unchanged JSONL.
  await writeLegacyLayout(initialLayout.fileLength, initialLayout.offsets);
  await host.restart();

  const latestAfterRestart = await readLatest(sessionId);
  assert.deepEqual(
    latestAfterRestart.messages.map((message) => message.id),
    messages.slice(-100).map((message) => message.id),
  );
  const taskAfterRestart = await host.call("session.get", {
    id: sessionId,
    messageAround: "task-middle",
    messageLimit: 20,
  });
  assert.equal(
    taskAfterRestart.session.messages.find((message) => message.id === "task-middle").toolResult.details.status,
    "completed",
  );

  const allIds = [];
  let before;
  while (true) {
    const { session } = await host.call("session.get", {
      id: sessionId,
      messageLimit: 100,
      ...(before === undefined ? {} : { messageBefore: before }),
    });
    const pageIds = session.messages.map((message) => message.id);
    allIds.unshift(...pageIds);
    if (session.messageStart === 0) break;
    assert.equal(session.hasMoreBefore, true);
    before = session.messageStart;
  }
  assert.deepEqual(allIds, messages.map((message) => message.id));

  const around = await host.call("session.get", {
    id: sessionId,
    messageAround: "nested-child",
    messageLimit: 20,
  });
  assert.ok(around.session.messages.some((message) => message.id === "nested-child"));
  assert.equal(around.session.navigationParent?.id, "task-middle");
  assert.equal(around.session.navigationParent?.toolResult?.details?.status, "completed");

  const full = await host.call("session.get", { id: sessionId });
  assert.deepEqual(full.session.messages.map((message) => message.id), messages.map((message) => message.id));
  assert.equal(full.session.messages.find((message) => message.id === "task-middle").toolResult.details.status, "completed");
  for (let index = 0; index < messages.length; index += 1) {
    const expected = messages[index];
    const actual = full.session.messages[index];
    if (expected.id === "task-middle") {
      assert.equal(actual.toolResult.details.result, expected.toolResult.details.result);
    } else {
      assert.equal(actual.content, expected.content, `content changed for ${expected.id}`);
    }
  }

  await host.restart();
  const reused = await readLatest(sessionId);
  assert.deepEqual(
    reused.messages.map((message) => message.id),
    messages.slice(-100).map((message) => message.id),
  );
  let rebuiltCache;
  try {
    rebuiltCache = await readFile(layoutPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (hasDiskCache) {
    assert.ok(rebuiltCache?.startsWith("PI-DESKTOP-TRANSCRIPT-LAYOUT 2\n"));
  }

  console.log("PASS transcript cache: append, middle Task rewrite, legacy cache recovery, paging, message navigation, tool result and Host restart");
} finally {
  await host.stop();
  await rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PersistenceOutbox } from "../electron/main/persistence-outbox.ts";
import { readMainSource } from "./helpers/main-source.mjs";

const silent = () => undefined;

test("session delete drops the outbox for that session (D318)", async () => {
  const main = await readMainSource();
  assert.match(main, /await persistenceOutbox\.dropSession\(id\)/);
});

test("handshake drains the outbox before the renderer can hydrate (D327)", async () => {
  const main = await readMainSource();
  assert.match(main, /await persistenceOutbox\.flush\(\(\) => host\)/);
  assert.doesNotMatch(main, /void persistenceOutbox\.flush\(\(\) => host\)/);
  assert.match(main, /session\.recoverInflightMessages/);
});

test("message_end checkpoints the finished snapshot before settling (D327)", async () => {
  const main = await readMainSource();
  assert.match(
    main,
    /event\.type === "message_end"[\s\S]*inflightCheckpointer\.observe\([\s\S]*settleIf\(sessionId, finalId\)/,
  );
});

test("deleting a session drops its queued outbox entries (D318)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const outbox = new PersistenceOutbox(dir, silent);
  await outbox.enqueue(
    {
      key: "message:keep:a",
      sessionId: "keep",
      message: { id: "a" },
    },
    () => null,
  );
  await outbox.enqueue(
    {
      key: "message:gone:b",
      sessionId: "gone",
      message: { id: "b" },
    },
    () => null,
  );
  assert.equal(outbox.size(), 2);
  await outbox.dropSession("gone");
  assert.equal(outbox.size(), 1);
  const stored = JSON.parse(await readFile(join(dir, "session-message-outbox.json"), "utf8"));
  assert.deepEqual(
    stored.map((entry) => entry.sessionId),
    ["keep"],
  );
});

function mockHost(handler) {
  return {
    isAvailable: () => true,
    call: async (method, params) => handler(method, params),
  };
}

test("duplicate message id does not stall later outbox entries (D444)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const logs = [];
  const outbox = new PersistenceOutbox(dir, (level, message, data) => {
    logs.push({ level, message, data });
  });
  const calls = [];
  const host = mockHost(async (_method, params) => {
    calls.push(params);
    if (params.message.id === "call_421522") {
      throw new Error("UNIQUE constraint failed: messages.id");
    }
  });
  const getHost = () => host;
  await outbox.enqueue(
    {
      key: "message:s1:call_421522",
      sessionId: "s1",
      message: { id: "call_421522" },
    },
    getHost,
  );
  await outbox.enqueue(
    {
      key: "message:s2:assistant-1",
      sessionId: "s2",
      message: { id: "assistant-1" },
    },
    getHost,
  );
  await outbox.flush(getHost);
  assert.equal(outbox.size(), 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].message.id, "assistant-1");
  assert.ok(
    logs.some((row) => row.message === "session persistence flush skipped duplicate message id"),
  );
});

test("a full outbox rejects an entry instead of reporting it enqueued", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-full-"));
  const path = join(dir, "session-message-outbox.json");
  const entries = Array.from({ length: 1024 }, (_, index) => ({
    key: `message:s${index}:m${index}`,
    sessionId: `s${index}`,
    message: { id: `m${index}` },
  }));
  await writeFile(path, JSON.stringify(entries), "utf8");
  const logs = [];
  const outbox = new PersistenceOutbox(dir, (level, message, data) => {
    logs.push({ level, message, data });
  });

  await assert.rejects(
    outbox.enqueue(
      { key: "message:last:missing", sessionId: "last", message: { id: "missing" } },
      () => null,
    ),
    /outbox is full/i,
  );
  assert.equal(outbox.size(), 1024);
  assert.equal(JSON.parse(await readFile(path, "utf8")).length, 1024);
  assert.ok(
    logs.some(
      (entry) =>
        entry.message === "session persistence outbox is full" &&
        entry.data?.key === "message:last:missing",
    ),
  );
});

test("non-unique flush errors still pause the outbox", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const outbox = new PersistenceOutbox(dir, silent);
  const host = mockHost(async () => {
    throw new Error("session not found");
  });
  const getHost = () => host;
  await outbox.enqueue(
    { key: "message:s1:a", sessionId: "s1", message: { id: "a" } },
    getHost,
  );
  await outbox.enqueue(
    { key: "message:s2:b", sessionId: "s2", message: { id: "b" } },
    getHost,
  );
  await outbox.flush(getHost);
  assert.equal(outbox.size(), 2);
});


test("poisoned provenance message does not stall later outbox entries (D597)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const logs = [];
  const outbox = new PersistenceOutbox(dir, (level, message, data) => {
    logs.push({ level, message, data });
  });
  const calls = [];
  const host = mockHost(async (_method, params) => {
    calls.push(params);
    if (params.message.id === "steering-poison") {
      throw new Error("PERMISSION_DENIED: transcript input does not match its session delivery");
    }
  });
  const getHost = () => host;
  await outbox.enqueue(
    {
      key: "message:s1:steering-poison",
      sessionId: "s1",
      message: { id: "steering-poison", role: "user", steering: true },
    },
    getHost,
  );
  await outbox.enqueue(
    {
      key: "message:s2:assistant-1",
      sessionId: "s2",
      message: { id: "assistant-1", role: "assistant" },
    },
    getHost,
  );
  await outbox.flush(getHost);
  assert.equal(outbox.size(), 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].message.id, "assistant-1");
  assert.ok(
    logs.some((row) => row.message === "session persistence flush dropped poisoned message"),
  );
});

test("PLUGIN_PERMISSION_DENIED is not poison and still pauses the outbox (D597)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const outbox = new PersistenceOutbox(dir, silent);
  const host = mockHost(async () => {
    throw new Error("PLUGIN_PERMISSION_DENIED: missing grant for fs.write");
  });
  const getHost = () => host;
  await outbox.enqueue(
    { key: "message:s1:a", sessionId: "s1", message: { id: "a" } },
    getHost,
  );
  await outbox.enqueue(
    { key: "message:s2:b", sessionId: "s2", message: { id: "b" } },
    getHost,
  );
  await outbox.flush(getHost);
  assert.equal(outbox.size(), 2);
});


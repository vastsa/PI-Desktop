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

test("transcript replacement waits for an in-flight append before dropping the session queue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-replace-"));
  const outbox = new PersistenceOutbox(dir, silent);
  let releaseAppend;
  let appendStarted;
  const started = new Promise((resolve) => { appendStarted = resolve; });
  const blockedAppend = new Promise((resolve) => { releaseAppend = resolve; });
  const host = mockHost(async () => {
    appendStarted();
    await blockedAppend;
  });

  await outbox.enqueue(
    {
      key: "message:replace-session:assistant-1",
      sessionId: "replace-session",
      message: { id: "assistant-1", role: "assistant", content: "obsolete" },
    },
    () => host,
  );
  await started;

  let replacementReady = false;
  const preparing = outbox
    .prepareSessionReplacement("replace-session", () => host)
    .then(() => { replacementReady = true; });
  await Promise.resolve();
  assert.equal(replacementReady, false, "replacement must wait for the active append");

  releaseAppend();
  await preparing;
  assert.equal(replacementReady, true);
  assert.equal(outbox.size(), 0);
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


test("FOREIGN KEY constraint failed drops the orphaned entry and keeps draining (#996)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const logs = [];
  const outbox = new PersistenceOutbox(dir, (level, message, data) => {
    logs.push({ level, message, data });
  });
  const calls = [];
  const host = mockHost(async (_method, params) => {
    calls.push(params);
    if (params.message.id === "orphaned-child") {
      throw new Error("Error: FOREIGN KEY constraint failed");
    }
  });
  const getHost = () => host;
  await outbox.enqueue(
    {
      key: "message:s1:orphaned-child",
      sessionId: "s1",
      message: { id: "orphaned-child" },
    },
    getHost,
  );
  await outbox.enqueue(
    {
      key: "message:s2:healthy",
      sessionId: "s2",
      message: { id: "healthy" },
    },
    getHost,
  );
  await outbox.flush(getHost);
  assert.equal(outbox.size(), 0, "both entries should be drained");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].message.id, "healthy");
  assert.ok(
    logs.some((row) => row.message === "session persistence flush dropped orphaned message"),
  );
});

const DEAD_LETTER_FILE = "session-message-outbox.dead-letter.json";

/** Let every pending microtask settle before counting host calls. */
function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Drain with the retry backoff clock advanced past every window, returning the
 * number of appends still queued.
 */
async function drain(outbox, host, now, steps = 12) {
  for (let step = 0; step < steps && outbox.size() > 0; step += 1) {
    now.value += 60_000;
    await outbox.flush(() => host);
  }
  return outbox.size();
}

test("an unclassifiable head failure drains later entries instead of stalling them (#1560)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const now = { value: 0 };
  const logs = [];
  const outbox = new PersistenceOutbox(
    dir,
    (level, message, data) => {
      logs.push({ level, message, data });
    },
    { now: () => now.value },
  );
  const calls = [];
  const host = mockHost(async (_method, params) => {
    calls.push(params);
    if (params.message.id === "torn") {
      throw new Error("Error: stream did not contain valid UTF-8");
    }
  });
  await outbox.enqueue(
    { key: "message:s1:torn", sessionId: "s1", message: { id: "torn" } },
    () => host,
  );
  await outbox.enqueue(
    { key: "message:s2:healthy", sessionId: "s2", message: { id: "healthy" } },
    () => host,
  );
  assert.equal(outbox.size(), 2, "the bad head keeps its retry budget before quarantine");

  const remaining = await drain(outbox, host, now);
  assert.equal(remaining, 0, "the queue drains instead of blocking forever");
  assert.ok(
    calls.some((params) => params.message?.id === "healthy"),
    "a later entry reaches the host despite the bad head",
  );
  assert.ok(
    logs.some(
      (row) =>
        row.message === "session persistence flush quarantined entry" &&
        row.data?.key === "message:s1:torn",
    ),
    "quarantine is observable in the persistence log",
  );
  const dead = JSON.parse(await readFile(join(dir, DEAD_LETTER_FILE), "utf8"));
  assert.deepEqual(
    dead.map((entry) => entry.key),
    ["message:s1:torn"],
  );
  assert.equal(dead[0].sessionId, "s1");
  assert.match(dead[0].reason, /valid UTF-8/);
  assert.equal(dead[0].message.id, "torn", "the quarantined payload is kept verbatim");
  assert.equal(typeof dead[0].quarantinedAt, "string");
});

test("a failing head waits out its backoff before the host is called again (#1560)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const now = { value: 0 };
  const outbox = new PersistenceOutbox(dir, silent, { now: () => now.value });
  const calls = [];
  const host = mockHost(async (_method, params) => {
    calls.push(params);
    throw new Error("host is busy");
  });
  const getHost = () => host;
  await outbox.enqueue({ key: "message:s1:a", sessionId: "s1", message: { id: "a" } }, getHost);
  await outbox.flush(getHost);
  await settle();
  const afterFirstFailure = calls.length;
  assert.ok(afterFirstFailure >= 1);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await outbox.flush(getHost);
  }
  await settle();
  assert.equal(calls.length, afterFirstFailure, "no retry inside the backoff window");

  now.value += 120_000;
  await outbox.flush(getHost);
  await settle();
  assert.equal(calls.length, afterFirstFailure + 1, "the head is retried once its backoff elapses");
  assert.equal(outbox.size(), 1, "an unclassified failure still pauses instead of dropping");
});

test("quarantined appends survive a restart without being replayed (#1560)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const now = { value: 0 };
  const logs = [];
  const log = (level, message, data) => {
    logs.push({ level, message, data });
  };
  const outbox = new PersistenceOutbox(dir, log, { now: () => now.value });
  const calls = [];
  const host = mockHost(async (_method, params) => {
    calls.push(params);
    if (params.message.id === "torn") {
      throw new Error("Error: stream did not contain valid UTF-8");
    }
  });
  await outbox.enqueue(
    { key: "message:s1:torn", sessionId: "s1", message: { id: "torn" } },
    () => host,
  );
  assert.equal(await drain(outbox, host, now), 0);

  const reopened = new PersistenceOutbox(dir, log, { now: () => now.value });
  assert.equal(reopened.size(), 0, "the dead letter is not queued again");
  assert.equal(
    JSON.parse(await readFile(join(dir, "session-message-outbox.json"), "utf8")).length,
    0,
  );
  const before = calls.length;
  await reopened.flush(() => host);
  assert.equal(calls.length, before, "no replay against the host");
  const dead = JSON.parse(await readFile(join(dir, DEAD_LETTER_FILE), "utf8"));
  assert.deepEqual(
    dead.map((entry) => entry.key),
    ["message:s1:torn"],
  );
});

test("the dead-letter file keeps its newest appends at the cap (#1560)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const now = { value: 0 };
  const logs = [];
  const outbox = new PersistenceOutbox(
    dir,
    (level, message, data) => {
      logs.push({ level, message, data });
    },
    { now: () => now.value, maxDeadLetters: 2 },
  );
  const host = mockHost(async (_method, params) => {
    if (["m1", "m2", "m3"].includes(params.message.id)) {
      throw new Error("Error: stream did not contain valid UTF-8");
    }
  });
  for (const id of ["m1", "m2", "m3"]) {
    await outbox.enqueue({ key: `message:s1:${id}`, sessionId: "s1", message: { id } }, () => host);
    assert.equal(await drain(outbox, host, now), 0, `${id} is quarantined and the queue drains`);
  }
  const dead = JSON.parse(await readFile(join(dir, DEAD_LETTER_FILE), "utf8"));
  assert.deepEqual(
    dead.map((entry) => entry.key),
    ["message:s1:m2", "message:s1:m3"],
  );
  assert.ok(
    logs.some(
      (row) =>
        row.message === "session persistence outbox dead letter discarded" &&
        row.data?.key === "message:s1:m1",
    ),
    "a discarded dead letter is observable",
  );
});

test("deleting a session drops its quarantined appends too (#1560)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const now = { value: 0 };
  const outbox = new PersistenceOutbox(dir, silent, { now: () => now.value });
  const host = mockHost(async () => {
    throw new Error("Error: stream did not contain valid UTF-8");
  });
  await outbox.enqueue(
    { key: "message:gone:torn", sessionId: "gone", message: { id: "torn" } },
    () => host,
  );
  assert.equal(await drain(outbox, host, now), 0);
  await outbox.dropSession("gone");
  assert.deepEqual(JSON.parse(await readFile(join(dir, DEAD_LETTER_FILE), "utf8")), []);
});

test("a restarted host retries the paused head without waiting out the backoff (#1560)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const now = { value: 0 };
  const outbox = new PersistenceOutbox(dir, silent, { now: () => now.value });
  const calls = [];
  const failing = mockHost(async (_method, params) => {
    calls.push(params.message.id);
    throw new Error("host is busy");
  });
  await outbox.enqueue({ key: "message:s1:a", sessionId: "s1", message: { id: "a" } }, () => failing);
  await outbox.flush(() => failing);
  await settle();
  const paused = calls.length;
  assert.ok(paused >= 1, "the head was attempted against the failing generation");

  await outbox.flush(() => failing);
  assert.equal(calls.length, paused, "the same generation waits out the backoff");

  const restarted = mockHost(async (_method, params) => {
    calls.push(params.message.id);
  });
  await outbox.flush(() => restarted);
  assert.equal(outbox.size(), 0, "a fresh host generation drains the paused head at once");
  assert.equal(calls.length, paused + 1);
});

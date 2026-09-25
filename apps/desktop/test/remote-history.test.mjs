import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { makeRemoteSessionId } = await import("../electron/main/remote/backend-router.ts");
const { REMOTE_HISTORY_PAGE_MAX, createRemoteHistory } = await import(
  "../electron/main/remote/remote-history.ts"
);

const HOST = { hostKey: "hostA", hostLabel: "Host A" };
const REMOTE_ID = makeRemoteSessionId("hostA", "s1");
const OTHER_REMOTE_ID = makeRemoteSessionId("hostA", "s2");
const FIRST_CURSOR = 2 ** 48;

function session(overrides = {}) {
  return {
    id: "s1",
    title: "S1",
    mode: "agent",
    status: "idle",
    planningState: "inactive",
    permissionMode: "ask",
    queuedTurnIds: [],
    revision: 1,
    createdAt: "2026-09-18T10:00:00.000Z",
    updatedAt: "2026-09-18T10:00:00.000Z",
    ...overrides,
  };
}

function item(n) {
  return {
    id: `i${n}`,
    turnId: "t",
    itemType: "message",
    status: "completed",
    createdAt: "x",
    content: { id: `m${n}`, role: "user", text: `msg ${n}` },
  };
}

const items = (from, to) => Array.from({ length: to - from + 1 }, (_, k) => item(from + k));

function fakeClient(responses) {
  const calls = [];
  return {
    calls,
    request: async (method, params) => {
      calls.push({ method, params });
      const handler = responses[method];
      if (handler === undefined) throw new Error(`no fake for ${method}`);
      return typeof handler === "function" ? handler(params, calls) : handler;
    },
  };
}

function attach(snapshotItems, hasMoreHistory, cursor = { epoch: "e", sequence: 5 }) {
  return () => ({
    session: session(),
    snapshot: { session: session(), items: snapshotItems, hasMoreHistory, cursor },
  });
}

test("a tail read with a limit trims to the newest items and mints a virtual cursor", async () => {
  const client = fakeClient({ "session/attach": attach(items(1, 5), false) });
  const history = createRemoteHistory({ client, host: HOST });
  const read = await history.read(REMOTE_ID, "s1", { messageLimit: 2 });
  assert.deepEqual(client.calls[0], {
    method: "session/attach",
    params: { sessionId: "s1", includeSnapshot: true },
  });
  assert.deepEqual(
    read.session.messages.map((m) => m.id),
    ["m4", "m5"],
  );
  assert.equal(read.session.hasMoreBefore, true);
  assert.equal(read.session.hasMoreAfter, false);
  assert.equal(read.session.messageStart, FIRST_CURSOR);
  assert.equal(read.session.messageCount, 2);
  assert.equal(read.session.id, REMOTE_ID);
  assert.equal(read.session.source, "remote");
  assert.deepEqual(read.cursor, { epoch: "e", sequence: 5 });
});

test("a tail read that fits reports the host's hasMoreHistory and start 0 when complete", async () => {
  const client = fakeClient({ "session/attach": attach(items(1, 3), false) });
  const history = createRemoteHistory({ client, host: HOST });
  const read = await history.read(REMOTE_ID, "s1", { messageLimit: 10 });
  assert.equal(read.session.messages.length, 3);
  assert.equal(read.session.hasMoreBefore, false);
  assert.equal(read.session.messageStart, 0);
});

test("a tail read clamps oversized limits to the maximum history page", async () => {
  const client = fakeClient({
    "session/attach": attach(items(1, REMOTE_HISTORY_PAGE_MAX + 1), false),
  });
  const history = createRemoteHistory({ client, host: HOST });
  const read = await history.read(REMOTE_ID, "s1", { messageLimit: 1000 });

  assert.equal(read.session.messages.length, REMOTE_HISTORY_PAGE_MAX);
  assert.equal(read.session.messages[0]?.id, "m2");
  assert.equal(read.session.messages.at(-1)?.id, `m${REMOTE_HISTORY_PAGE_MAX + 1}`);
  assert.equal(read.session.hasMoreBefore, true);
  assert.equal(read.session.messageStart, FIRST_CURSOR);
});

test("an older page reads session/history before the cursor's item and mints a decreasing cursor", async () => {
  const client = fakeClient({
    "session/attach": attach(items(5, 6), true),
    "session/history": { items: items(3, 4), hasMore: true },
    "session/get": { session: session({ title: "fresh" }) },
  });
  const history = createRemoteHistory({ client, host: HOST });
  const tail = await history.read(REMOTE_ID, "s1", { messageLimit: 2 });
  assert.equal(tail.session.messageStart, FIRST_CURSOR);

  const older = await history.read(REMOTE_ID, "s1", {
    messageBefore: tail.session.messageStart,
    messageLimit: 2,
  });
  const historyCall = client.calls.find((c) => c.method === "session/history");
  assert.deepEqual(historyCall.params, { sessionId: "s1", beforeItemId: "i5", limit: 2 });
  assert.deepEqual(
    older.session.messages.map((m) => m.id),
    ["m3", "m4"],
  );
  assert.equal(older.session.title, "fresh");
  assert.equal(older.session.hasMoreBefore, true);
  assert.ok(older.session.messageStart < tail.session.messageStart);
  assert.equal(older.session.messageStart, FIRST_CURSOR - 1);
  // An older page carries no attach cursor.
  assert.equal(older.cursor, undefined);
});

test("an unknown or foreign cursor is refused with INVALID_ARGUMENT and no host call", async () => {
  const client = fakeClient({ "session/attach": attach(items(5, 6), true) });
  const history = createRemoteHistory({ client, host: HOST });
  const tail = await history.read(REMOTE_ID, "s1", { messageLimit: 1 });
  const before = client.calls.length;
  await assert.rejects(
    history.read(REMOTE_ID, "s1", { messageBefore: 12 }),
    (error) => error.errorCode === "INVALID_ARGUMENT",
  );
  await assert.rejects(
    history.read(OTHER_REMOTE_ID, "s2", { messageBefore: tail.session.messageStart }),
    (error) => error.errorCode === "INVALID_ARGUMENT",
  );
  assert.equal(client.calls.length, before);
});

test("the oldest cursors are forgotten beyond maxCursors", async () => {
  const client = fakeClient({ "session/attach": attach(items(1, 5), true) });
  const history = createRemoteHistory({ client, host: HOST, maxCursors: 1 });
  const first = await history.read(REMOTE_ID, "s1", { messageLimit: 1 });
  await history.read(REMOTE_ID, "s1", { messageLimit: 1 });
  await assert.rejects(
    history.read(REMOTE_ID, "s1", { messageBefore: first.session.messageStart }),
    (error) => error.errorCode === "INVALID_ARGUMENT",
  );
});

test("a full read pages back until the host has no more and stops on an empty page", async () => {
  let page = 0;
  const client = fakeClient({
    "session/attach": attach(items(5, 6), true),
    "session/history": (params) => {
      page += 1;
      if (page === 1) {
        assert.equal(params.beforeItemId, "i5");
        assert.equal(params.limit, REMOTE_HISTORY_PAGE_MAX);
        return { items: items(3, 4), hasMore: true };
      }
      assert.equal(params.beforeItemId, "i3");
      // A misbehaving host claims more but returns nothing.
      return { items: [], hasMore: true };
    },
  });
  const history = createRemoteHistory({ client, host: HOST });
  const read = await history.read(REMOTE_ID, "s1");
  assert.equal(page, 2);
  assert.deepEqual(
    read.session.messages.map((m) => m.id),
    ["m3", "m4", "m5", "m6"],
  );
  assert.equal(read.session.hasMoreBefore, false);
  assert.equal(read.session.messageStart, 0);
});

test("a full read stops at the page cap and reports older history", async () => {
  let n = 1_000_000;
  const client = fakeClient({
    "session/attach": attach(items(n, n), true),
    "session/history": () => {
      n -= 1;
      return { items: [item(n)], hasMore: true };
    },
  });
  const history = createRemoteHistory({ client, host: HOST });
  const read = await history.read(REMOTE_ID, "s1");
  assert.equal(client.calls.filter((c) => c.method === "session/history").length, 50);
  assert.equal(read.session.messages.length, 51);
  assert.equal(read.session.hasMoreBefore, true);
  assert.equal(read.session.messageStart, FIRST_CURSOR);
});

test("an older page clamps its limit to 1..200 and defaults a non-number", async () => {
  const client = fakeClient({
    "session/attach": attach(items(1, 3), true),
    "session/history": { items: [], hasMore: false },
    "session/get": { session: session() },
  });
  const history = createRemoteHistory({ client, host: HOST });
  const limits = [];
  for (const messageLimit of [1000, 0, -5, 2.7, Number.NaN, undefined]) {
    const tail = await history.read(REMOTE_ID, "s1", { messageLimit: 1 });
    await history.read(REMOTE_ID, "s1", {
      messageBefore: tail.session.messageStart,
      ...(messageLimit === undefined ? {} : { messageLimit }),
    });
    limits.push(client.calls.filter((c) => c.method === "session/history").at(-1).params.limit);
  }
  assert.deepEqual(limits, [200, 1, 1, 2, 100, 100]);
});

test("a tail read without a snapshot is INTERNAL", async () => {
  const client = fakeClient({ "session/attach": { session: session() } });
  const history = createRemoteHistory({ client, host: HOST });
  await assert.rejects(
    history.read(REMOTE_ID, "s1"),
    (error) => error.errorCode === "INTERNAL",
  );
});

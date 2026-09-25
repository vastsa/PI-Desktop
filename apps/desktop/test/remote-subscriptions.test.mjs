import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { createRemoteSubscriptions } = await import(
  "../electron/main/remote/remote-subscriptions.ts"
);

/** Records requests; `events/subscribe` mints ids, optionally held open by a gate. */
function fakeClient() {
  const calls = [];
  let next = 0;
  const gates = [];
  const client = {
    calls,
    hold: false,
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "events/subscribe") {
        const id = params.scope === "host" ? `host-${++next}` : `sub-${params.sessionId}-${++next}`;
        if (client.hold) {
          await new Promise((resolve) => gates.push(resolve));
        }
        return { subscriptionId: id };
      }
      return { ok: true };
    },
    release() {
      for (const resolve of gates.splice(0)) resolve();
    },
  };
  return client;
}

const of = (client, method) => client.calls.filter((c) => c.method === method);
const sessionSubscribes = (client) =>
  of(client, "events/subscribe")
    .filter((c) => c.params.scope === "session")
    .map((c) => c.params.sessionId);

function envelope(overrides) {
  return {
    eventId: "e",
    scope: "session",
    epoch: "ep",
    revision: 1,
    kind: "item.delta",
    occurredAt: "2026-09-18T10:00:00.000Z",
    payload: {},
    ...overrides,
  };
}

test("the host scope holds one slot, so session capacity is maxSubscriptions - 1", async () => {
  const client = fakeClient();
  const subs = createRemoteSubscriptions({ client, maxSubscriptions: 3 });
  await subs.openHost();
  assert.deepEqual(of(client, "events/subscribe")[0].params, { scope: "host" });
  await subs.touch("a");
  await subs.touch("b");
  assert.equal(of(client, "events/unsubscribe").length, 0);
  await subs.touch("c");
  // The third session evicts the least recently used one.
  assert.equal(subs.isSubscribed("a"), false);
  assert.equal(subs.isSubscribed("b"), true);
  assert.equal(subs.isSubscribed("c"), true);
  assert.deepEqual(of(client, "events/unsubscribe").map((c) => c.params.subscriptionId), [
    "sub-a-2",
  ]);
});

test("touching an existing session refreshes its LRU stamp without resubscribing", async () => {
  const client = fakeClient();
  const subs = createRemoteSubscriptions({ client, maxSubscriptions: 3 });
  await subs.touch("a");
  await subs.touch("b");
  await subs.touch("a");
  await subs.touch("c");
  assert.deepEqual(sessionSubscribes(client), ["a", "b", "c"]);
  assert.equal(subs.isSubscribed("a"), true);
  assert.equal(subs.isSubscribed("b"), false);
});

test("LRU eviction skips busy sessions and gives up when every slot is busy", async () => {
  const client = fakeClient();
  const warnings = [];
  const subs = createRemoteSubscriptions({
    client,
    maxSubscriptions: 3,
    log: (level, message) => warnings.push(message),
  });
  await subs.touch("a");
  await subs.touch("b");
  subs.noteStatus("a", "running");
  await subs.touch("c");
  assert.equal(subs.isSubscribed("a"), true, "a running session is never evicted");
  assert.equal(subs.isSubscribed("b"), false);

  subs.noteStatus("c", "waiting_permission");
  await subs.touch("d");
  assert.equal(subs.isSubscribed("d"), false);
  assert.ok(warnings.some((m) => /no idle subscription slot/.test(m)));

  // Once a session settles it becomes evictable again.
  subs.noteStatus("a", "idle");
  await subs.touch("d");
  assert.equal(subs.isSubscribed("a"), false);
  assert.equal(subs.isSubscribed("d"), true);
});

test("a session whose subscribe is still pending is not evicted, even when oldest", async () => {
  const client = fakeClient();
  const subs = createRemoteSubscriptions({ client, maxSubscriptions: 3 });
  client.hold = true;
  const pendingB = subs.touch("b");
  client.hold = false;
  await subs.touch("a");
  await subs.touch("c");
  assert.equal(subs.isSubscribed("b"), true);
  assert.equal(subs.isSubscribed("a"), false);
  client.release();
  await pendingB;
  assert.equal(subs.isSubscribed("b"), true);
  assert.equal(of(client, "events/unsubscribe").length, 1);
});

test("touch with an attach cursor resumes the session scope after it", async () => {
  const client = fakeClient();
  const subs = createRemoteSubscriptions({ client });
  await subs.touch("a", { epoch: "ep", sequence: 9 });
  assert.deepEqual(of(client, "events/subscribe")[0].params, {
    scope: "session",
    sessionId: "a",
    after: { epoch: "ep", sequence: 9 },
  });
});

test("reconnect restores the host scope and retained sessions from durable cursors", async () => {
  const client = fakeClient();
  client.cursorForHost = () => ({ epoch: "host-epoch", sequence: 8 });
  client.cursorFor = (sessionId) => ({ epoch: `epoch-${sessionId}`, sequence: 13 });
  const subs = createRemoteSubscriptions({ client });
  await subs.openHost();
  await subs.touch("a");
  await subs.touch("b");

  await subs.reconnect();

  assert.deepEqual(
    of(client, "events/subscribe").slice(3).map((call) => call.params),
    [
      { scope: "host", after: { epoch: "host-epoch", sequence: 8 } },
      {
        scope: "session",
        sessionId: "a",
        after: { epoch: "epoch-a", sequence: 13 },
      },
      {
        scope: "session",
        sessionId: "b",
        after: { epoch: "epoch-b", sequence: 13 },
      },
    ],
  );
  assert.equal(subs.isSubscribed("a"), true);
  assert.equal(subs.isSubscribed("b"), true);
  subs.reset();
});

test("a disconnected session subscribe keeps its slot for reconnect recovery", async () => {
  const client = fakeClient();
  const request = client.request;
  let disconnectOnce = true;
  client.request = async (method, params) => {
    if (method === "events/subscribe" && params.scope === "session" && disconnectOnce) {
      disconnectOnce = false;
      throw Object.assign(new Error("socket closed"), { code: "HOST_DISCONNECTED" });
    }
    return request(method, params);
  };
  const subs = createRemoteSubscriptions({ client });
  await subs.touch("a");
  assert.equal(subs.isSubscribed("a"), true);

  await subs.reconnect();

  assert.equal(subs.isSubscribed("a"), true);
  assert.equal(sessionSubscribes(client).at(-1), "a");
  subs.reset();
});

test("acks are throttled: one ack per ackEvery events", async () => {
  const client = fakeClient();
  const subs = createRemoteSubscriptions({ client, ackEvery: 3, ackDelayMs: 60_000 });
  await subs.touch("a");
  for (let sequence = 1; sequence <= 7; sequence++) {
    subs.observe(envelope({ sessionId: "a", sequence }));
  }
  assert.deepEqual(
    of(client, "events/ack").map((c) => c.params),
    [
      { subscriptionId: "sub-a-1", sequence: 3 },
      { subscriptionId: "sub-a-1", sequence: 6 },
    ],
  );
  subs.reset(); // clears the pending timer for event 7
});

test("a quiet stream is acked once after ackDelayMs", async () => {
  const client = fakeClient();
  const subs = createRemoteSubscriptions({ client, ackEvery: 100, ackDelayMs: 10 });
  await subs.openHost();
  subs.observe(envelope({ scope: "host", sequence: 4 }));
  subs.observe(envelope({ scope: "host", sequence: 5 }));
  // Events without a sequence, or for an unsubscribed session, are ignored.
  subs.observe(envelope({ scope: "host" }));
  subs.observe(envelope({ sessionId: "nobody", sequence: 1 }));
  assert.equal(of(client, "events/ack").length, 0);
  await delay(40);
  assert.deepEqual(
    of(client, "events/ack").map((c) => c.params),
    [{ subscriptionId: "host-1", sequence: 5 }],
  );
});

test("closed() resubscribes a session or the host scope after the last safe cursor", async () => {
  const client = fakeClient();
  const subs = createRemoteSubscriptions({ client });
  await subs.openHost();
  await subs.touch("a");
  const cursor = { epoch: "ep", sequence: 12 };
  subs.closed("sub-a-2", cursor);
  subs.closed("host-1", { epoch: "ep", sequence: 3 });
  subs.closed("unknown-sub", cursor);
  await delay(0);
  const subscribes = of(client, "events/subscribe").map((c) => c.params);
  assert.deepEqual(subscribes.slice(2), [
    { scope: "session", sessionId: "a", after: cursor },
    { scope: "host", after: { epoch: "ep", sequence: 3 } },
  ]);
  assert.equal(subs.isSubscribed("a"), true);
  // The reopened subscription is the one acks now target.
  subs.observe(envelope({ sessionId: "a", sequence: 13 }));
  subs.reset();
});

test("release unsubscribes and frees the slot", async () => {
  const client = fakeClient();
  const subs = createRemoteSubscriptions({ client });
  await subs.touch("a");
  await subs.release("a");
  assert.equal(subs.isSubscribed("a"), false);
  assert.deepEqual(of(client, "events/unsubscribe")[0].params, { subscriptionId: "sub-a-1" });
  await subs.release("missing");
  assert.equal(of(client, "events/unsubscribe").length, 1);
});

test("reset drops state and unsubscribes a subscribe result that lands afterwards", async () => {
  const client = fakeClient();
  const subs = createRemoteSubscriptions({ client });
  client.hold = true;
  const pending = subs.touch("a");
  const pendingHost = subs.openHost();
  await Promise.resolve();
  subs.reset();
  assert.equal(subs.isSubscribed("a"), false);
  client.release();
  await pending;
  await pendingHost;
  // The late session subscription is handed straight back to the host.
  assert.deepEqual(
    of(client, "events/unsubscribe").map((c) => c.params.subscriptionId),
    ["sub-a-1"],
  );
  assert.equal(subs.isSubscribed("a"), false);
  // Nothing acks for the stale host subscription either.
  subs.observe(envelope({ scope: "host", sequence: 1 }));
  await delay(300);
  assert.equal(of(client, "events/ack").length, 0);
});

test("a failed subscribe frees the slot and is logged", async () => {
  const warnings = [];
  const client = {
    request: async (method) => {
      if (method === "events/subscribe") throw new Error("cap reached");
      return {};
    },
  };
  const subs = createRemoteSubscriptions({ client, log: (_l, message) => warnings.push(message) });
  await subs.touch("a");
  assert.equal(subs.isSubscribed("a"), false);
  assert.ok(warnings.some((m) => /events\/subscribe failed/.test(m)));
});

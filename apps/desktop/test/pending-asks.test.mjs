import assert from "node:assert/strict";
import test from "node:test";
import { join, dirname } from "node:path";
import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  MAX_PENDING_ASKS_PER_SESSION,
  MAX_PENDING_ASK_SESSIONS,
  createPendingAsksRegistry,
} = await import("../electron/main/pending-asks.ts");

function ask(sessionId, requestId, toolCallId, ts, question = requestId) {
  return {
    sessionId,
    ts,
    event: {
      type: "asktool_request",
      request: {
        requestId,
        sessionId,
        toolCallId,
        questions: [{ question, options: ["a", "b"] }],
      },
    },
  };
}

function toolEnd(sessionId, toolCallId, ts = 999) {
  return { sessionId, ts, event: { type: "tool_end", toolCallId, result: {} } };
}

function agentEnd(sessionId, ts = 1000) {
  return { sessionId, ts, event: { type: "agent_end", messageIds: [] } };
}

test("pending ask registry dedupes, filters, clones and orders stably", () => {
  const registry = createPendingAsksRegistry();
  registry.ingest(ask("s2", "r2", "t2", 20));
  const trimmed = ask(" s1 ", "r1", "t1", 10);
  trimmed.event.request.sessionId = "s1";
  registry.ingest(trimmed);
  registry.ingest(ask("s1", "r1", "t1", 99, "duplicate must not replace"));

  assert.deepEqual(registry.list().asks.map((entry) => entry.requestId), ["r1", "r2"]);
  assert.deepEqual(registry.list("s1").asks.map((entry) => entry.requestId), ["r1"]);
  assert.equal(registry.list("missing").kind, "none");

  const listed = registry.list("s1");
  listed.asks[0].questions[0].question = "mutated";
  listed.asks[0].questions[0].options.push("mutated");
  assert.equal(registry.list("s1").asks[0].questions[0].question, "r1");
  assert.deepEqual(registry.list("s1").asks[0].questions[0].options, ["a", "b"]);
  assert.equal(registry.list("s1").asks[0].receivedAt, 10);
});

test("malformed question shapes are ignored without throwing", () => {
  const registry = createPendingAsksRegistry();
  for (const questions of [
    [null],
    [{ question: "broken" }],
    [{ question: "broken", options: "not-an-array" }],
    [{ question: "broken", options: ["ok", 2] }],
  ]) {
    const envelope = ask("s1", `bad-${JSON.stringify(questions)}`, "t", 1);
    envelope.event.request.questions = questions;
    assert.doesNotThrow(() => registry.ingest(envelope));
  }
  assert.equal(registry.list().kind, "none");
});

test("tool_end removes one request and agent_end clears the session", () => {
  const registry = createPendingAsksRegistry();
  registry.ingest(ask("s1", "r1", "t1", 1));
  registry.ingest(ask("s1", "r2", "t2", 2));
  registry.ingest(toolEnd("s1", "t1"));
  assert.deepEqual(registry.list("s1").asks.map((entry) => entry.requestId), ["r2"]);
  registry.ingest(agentEnd("s1"));
  assert.deepEqual(registry.list("s1"), { kind: "none", asks: [] });
});

test("identity mismatch is rejected and settlement stays session-scoped", () => {
  const registry = createPendingAsksRegistry();
  const mismatched = ask("envelope-session", "bad", "t0", 0);
  mismatched.event.request.sessionId = "request-session";
  registry.ingest(mismatched);
  assert.equal(registry.list().kind, "none");

  registry.ingest(ask("s1", "same", "t1", 1));
  registry.ingest(ask("s2", "same", "t2", 2));
  registry.settle("s1", "same");
  assert.equal(registry.list("s1").kind, "none");
  assert.equal(registry.list("s2").asks[0].requestId, "same");
  registry.clearSession("s2");
  assert.equal(registry.list().kind, "none");
});

test("per-session queue is bounded and prunes oldest first", () => {
  const registry = createPendingAsksRegistry();
  for (let index = 0; index < MAX_PENDING_ASKS_PER_SESSION + 3; index += 1) {
    registry.ingest(ask("s1", `r${index}`, `t${index}`, index));
  }
  const asks = registry.list("s1").asks;
  assert.equal(asks.length, MAX_PENDING_ASKS_PER_SESSION);
  assert.equal(asks[0].requestId, "r3");
  assert.equal(asks.at(-1).requestId, `r${MAX_PENDING_ASKS_PER_SESSION + 2}`);
});

test("the session-bucket count is bounded and evicts the oldest bucket first", () => {
  const registry = createPendingAsksRegistry();
  const total = MAX_PENDING_ASK_SESSIONS + 5;
  for (let index = 0; index < total; index += 1) {
    registry.ingest(ask(`s${index}`, `r${index}`, `t${index}`, index));
  }

  // The newest bucket survives; the oldest ones are gone.
  assert.equal(registry.list(`s${total - 1}`).kind, "pending");
  assert.equal(registry.list("s0").kind, "none");
  assert.equal(registry.list("s4").kind, "none");
  assert.equal(registry.list("s5").kind, "pending");
  assert.equal(
    registry.list().asks.length,
    MAX_PENDING_ASK_SESSIONS,
    "an unfiltered listing must stay bounded too",
  );
});

test("clearSessionsWithPrefix drops exactly one host's buckets", () => {
  const registry = createPendingAsksRegistry();
  registry.ingest(ask("remote:hostA:s1", "r1", "t1", 1));
  registry.ingest(ask("remote:hostA:s2", "r2", "t2", 2));
  registry.ingest(ask("remote:hostB:s1", "r3", "t3", 3));
  // A session whose id merely shares a prefix with another host's namespace must
  // not be touched by that host's cleanup.
  registry.ingest(ask("local:s1", "r4", "t4", 4));

  assert.equal(registry.clearSessionsWithPrefix("remote:hostA:"), 2);
  assert.equal(registry.list("remote:hostA:s1").kind, "none");
  assert.equal(registry.list("remote:hostA:s2").kind, "none");
  assert.equal(registry.list("remote:hostB:s1").kind, "pending");
  assert.equal(registry.list("local:s1").kind, "pending");
  assert.equal(registry.clearSessionsWithPrefix(""), 0, "an empty prefix clears nothing");
});

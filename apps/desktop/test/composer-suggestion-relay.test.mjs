import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

/*
 * The main-process half of `pi.composer.suggest` (ADR 0333): which offers never
 * reach the window, which one may answer, and what happens to a suggestion when
 * the turn or the plugin behind it ends first.
 */
const { createComposerSuggestionRelay } = await import(
  "../electron/main/services/composer-suggestion.ts"
);
const { IPC } = await import("@pi-desktop/shared");

const SESSION = "session-1";

function makeRelay({ activeSession = SESSION, answerTimeoutMs = 50, now } = {}) {
  const sent = [];
  const relay = createComposerSuggestionRelay({
    sendToRenderer: (channel, payload) => {
      assert.equal(channel, IPC.event.pluginComposerSuggestion);
      sent.push(payload);
    },
    getActiveSession: () => (activeSession ? { sessionId: activeSession } : null),
    answerTimeoutMs,
    now,
  });
  return { relay, sent, select(sessionId) { activeSession = sessionId; relay.noteActiveSessionChanged(); } };
}

function offer(overrides = {}) {
  return {
    pluginId: "demo.suggestion",
    sessionId: SESSION,
    turnId: "turn-1",
    text: "Explain the failing test",
    ttlMs: 60_000,
    ...overrides,
  };
}

test("a suggestion for a session the user left never crosses to the window", async () => {
  const { relay, sent } = makeRelay({ activeSession: "session-2" });
  assert.deepEqual(await relay.offer(offer()), {
    shown: false,
    reason: "session-not-visible",
  });
  assert.equal(sent.length, 0);
});

test("the window's answer is what the plugin is told", async () => {
  const { relay, sent } = makeRelay();
  const pending = relay.offer(offer());

  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "offer");
  assert.equal(sent[0].text, "Explain the failing test");
  assert.equal(sent[0].turnId, "turn-1");
  assert.ok(sent[0].expiresAt > Date.now());

  assert.equal(relay.settle({ requestId: sent[0].requestId, shown: true }), true);
  assert.deepEqual(await pending, { shown: true });

  // A second answer to the same request changes nothing.
  assert.equal(relay.settle({ requestId: sent[0].requestId, shown: true }), false);
});

test("a draft that cannot take the line is reported with its own reason", async () => {
  const { relay, sent } = makeRelay();
  const pending = relay.offer(offer());
  relay.settle({ requestId: sent[0].requestId, shown: false, reason: "draft-not-empty" });
  assert.deepEqual(await pending, { shown: false, reason: "draft-not-empty" });
});

test("a silent window costs the caller a miss, never a hang", async () => {
  const { relay } = makeRelay({ answerTimeoutMs: 20 });
  // The relay deliberately unrefs its timers; keep the test process alive.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    assert.deepEqual(await relay.offer(offer()), { shown: false, reason: "unsupported" });
  } finally {
    clearTimeout(keepAlive);
  }
});

test("one suggestion per session: the newer offer takes the slot", async () => {
  const { relay, sent } = makeRelay();
  const first = relay.offer(offer({ text: "first" }));
  const second = relay.offer(offer({ pluginId: "other.plugin", text: "second" }));

  assert.deepEqual(await first, { shown: false, reason: "replaced" });
  assert.equal(sent.at(-1).text, "second");
  relay.settle({ requestId: sent.at(-1).requestId, shown: true });
  assert.deepEqual(await second, { shown: true });
});

test("a new turn clears the line and refuses a suggestion about the old one", async () => {
  const { relay, sent } = makeRelay();
  const pending = relay.offer(offer());

  relay.noteTurnStarted(SESSION, "turn-2");
  assert.deepEqual(await pending, { shown: false, reason: "stale-turn" });
  assert.deepEqual(sent.at(-1), { kind: "clear", sessionId: SESSION });

  // The turn a plugin answers has been overtaken by the time its text exists.
  assert.deepEqual(await relay.offer(offer({ turnId: "turn-1" })), {
    shown: false,
    reason: "stale-turn",
  });
  // A suggestion for the turn that is running now is still allowed through.
  const current = relay.offer(offer({ turnId: "turn-2" }));
  relay.settle({ requestId: sent.at(-1).requestId, shown: true });
  assert.deepEqual(await current, { shown: true });
});

test("a plugin that stops loses its line, shown or still waiting", async () => {
  const { relay, sent } = makeRelay();
  const pending = relay.offer(offer());

  relay.clearPlugin("demo.suggestion");
  assert.deepEqual(await pending, { shown: false, reason: "unsupported" });
  assert.deepEqual(sent.at(-1), { kind: "clear", pluginId: "demo.suggestion" });

  // Another plugin's waiting offer is untouched by that clear.
  const other = relay.offer(offer({ pluginId: "other.plugin" }));
  const otherOffer = sent.at(-1);
  relay.clearPlugin("demo.suggestion");
  relay.settle({ requestId: otherOffer.requestId, shown: true });
  assert.deepEqual(await other, { shown: true });
});

test("a plugin's own clear names the plugin and, optionally, the session", () => {
  const { relay, sent } = makeRelay();
  relay.clearSuggestion("demo.suggestion", SESSION);
  assert.deepEqual(sent.at(-1), {
    kind: "clear",
    pluginId: "demo.suggestion",
    sessionId: SESSION,
  });
  relay.clearSuggestion("demo.suggestion");
  assert.deepEqual(sent.at(-1), { kind: "clear", pluginId: "demo.suggestion" });
});

test("quitting answers every waiting offer and forgets the turn history", async () => {
  const { relay } = makeRelay();
  const pending = relay.offer(offer());
  relay.dispose();
  assert.deepEqual(await pending, { shown: false, reason: "unsupported" });


  // Nothing is left to answer for, so a late word from the window is ignored.
  assert.equal(relay.settle({ requestId: "gone", shown: true }), false);
});

const OWNER = "demo.suggestion";
const TARGET_INPUT = { sessionId: SESSION, turnId: "turn-1" };
const REVISION = "b1519a2c-64bd-4aa2-9c47-9b0be97bfe2d";

async function getTarget(relay, sent, pluginId = OWNER) {
  const pending = relay.getTarget(pluginId, TARGET_INPUT);
  const request = sent.at(-1);
  assert.deepEqual(request, { kind: "target", requestId: request.requestId, sessionId: SESSION });
  relay.settle({ requestId: request.requestId, shown: true, revision: REVISION });
  const target = await pending;
  assert.ok(target);
  assert.notEqual(target, REVISION);
  return target;
}

test("target probes require a visible session and a known matching turn before reaching the renderer", async () => {
  const { relay, sent } = makeRelay();
  assert.equal(await relay.getTarget(OWNER, TARGET_INPUT), null, "unknown turn");
  relay.noteTurnStarted(SESSION, "turn-1");
  sent.length = 0;
  assert.equal(await relay.getTarget(OWNER, { ...TARGET_INPUT, turnId: "old" }), null);
  assert.equal(await relay.getTarget(OWNER, { ...TARGET_INPUT, sessionId: "elsewhere" }), null);
  assert.equal(sent.length, 0);
  const pending = relay.getTarget(OWNER, TARGET_INPUT);
  relay.settle({ requestId: sent.at(-1).requestId, shown: false, reason: "draft-not-empty" });
  assert.equal(await pending, null);
});

test("a target belongs only to its issuing plugin and normalized candidates cross as one offer", async () => {
  const { relay, sent } = makeRelay();
  relay.noteTurnStarted(SESSION, "turn-1");
  const target = await getTarget(relay, sent);
  const input = { target, candidates: ["Explain\n the test", "Explain the test", "😃".repeat(220)] };
  assert.deepEqual(await relay.offerCandidates("other.plugin", input), { shown: false, reason: "unsupported" });
  assert.equal(sent.at(-1).kind, "target");
  const pending = relay.offerCandidates(OWNER, input);
  const message = sent.at(-1);
  assert.deepEqual(message.candidates, ["Explain the test", "😃".repeat(200)]);
  assert.equal(message.revision, REVISION);
  assert.equal(message.turnId, TARGET_INPUT.turnId);
  assert.equal("target" in message, false);
  relay.settle({ requestId: message.requestId, shown: true });
  assert.deepEqual(await pending, { shown: true });

  await assert.rejects(relay.offerCandidates(OWNER, { target, candidates: [" "] }), { code: "INVALID_PARAMS" });
  await assert.rejects(relay.offerCandidates(OWNER, { target, candidates: ["1", "2", "3", "4"] }), { code: "INVALID_PARAMS" });
  const withEmpty = relay.offerCandidates(OWNER, { target, candidates: ["\n", "one"] });
  assert.deepEqual(sent.at(-1).candidates, ["one"]);
  relay.settle({ requestId: sent.at(-1).requestId, shown: true });
  await withEmpty;
});

test("selection hops, later turns, clear, and unload invalidate issued and still-pending targets", async () => {
  const { relay, sent, select } = makeRelay();
  relay.noteTurnStarted(SESSION, "turn-1");
  const first = await getTarget(relay, sent);
  const pending = relay.getTarget(OWNER, TARGET_INPUT);
  const requestId = sent.at(-1).requestId;
  select("other-session");
  select(SESSION);
  assert.equal(relay.settle({ requestId, shown: true, revision: REVISION }), false);
  assert.equal(await pending, null);
  assert.equal((await relay.offerCandidates(OWNER, { target: first, candidates: ["one"] })).shown, false);

  const ours = await getTarget(relay, sent);
  const theirs = await getTarget(relay, sent, "other.plugin");
  const delayed = relay.getTarget(OWNER, TARGET_INPUT);
  const delayedId = sent.at(-1).requestId;
  relay.clearSuggestion(OWNER, SESSION);
  assert.equal(await delayed, null);
  assert.equal(relay.settle({ requestId: delayedId, shown: true, revision: REVISION }), false);
  assert.equal((await relay.offerCandidates(OWNER, { target: ours, candidates: ["one"] })).shown, false);
  const inFlight = relay.offerCandidates("other.plugin", { target: theirs, candidates: ["one", "two"] });
  const inFlightId = sent.at(-1).requestId;
  relay.clearPlugin("other.plugin");
  assert.equal(relay.settle({ requestId: inFlightId, shown: true }), false);
  assert.equal((await inFlight).shown, false);
  assert.equal((await relay.offerCandidates("other.plugin", { target: theirs, candidates: ["one"] })).shown, false);

  const previousTurn = await getTarget(relay, sent);
  relay.noteTurnStarted(SESSION, "turn-2");
  assert.equal((await relay.offerCandidates(OWNER, { target: previousTurn, candidates: ["one"] })).shown, false);
});

test("expired targets do not reach the renderer", async () => {
  let time = Date.now();
  const { relay, sent } = makeRelay({ now: () => time });
  relay.noteTurnStarted(SESSION, "turn-1");
  const target = await getTarget(relay, sent);
  time += 61_000;
  assert.deepEqual(await relay.offerCandidates(OWNER, { target, candidates: ["one"] }), {
    shown: false, reason: "stale-turn",
  });
  assert.equal(sent.at(-1).kind, "target");
});

test("target storage is bounded and a group cannot outlive its target", async () => {
  let time = Date.now();
  const { relay, sent } = makeRelay({ now: () => time, answerTimeoutMs: 2000 });
  relay.noteTurnStarted(SESSION, "turn-1");
  const oldest = await getTarget(relay, sent);
  let newest;
  for (let i = 0; i < 64; i++) newest = await getTarget(relay, sent);
  assert.equal((await relay.offerCandidates(OWNER, { target: oldest, candidates: ["one"] })).shown, false);
  assert.equal(sent.at(-1).kind, "target");
  const expiry = time + 60_000;
  time += 59_500;
  const pending = relay.offerCandidates(OWNER, { target: newest, candidates: ["one"], ttlMs: 120_000 });
  const message = sent.at(-1);
  assert.equal(message.validUntil, expiry);
  assert.equal(message.expiresAt, expiry);
  relay.settle({ requestId: message.requestId, shown: true });
  assert.deepEqual(await pending, { shown: true });
});

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

/*
 * The main-process half of `pi.composer.suggest` (ADR 0332): which offers never
 * reach the window, which one may answer, and what happens to a suggestion when
 * the turn or the plugin behind it ends first.
 */
const { createComposerSuggestionRelay } = await import(
  "../electron/main/services/composer-suggestion.ts"
);
const { IPC } = await import("@pi-desktop/shared");

const SESSION = "session-1";

function makeRelay({ activeSession = SESSION, answerTimeoutMs = 50 } = {}) {
  const sent = [];
  const relay = createComposerSuggestionRelay({
    sendToRenderer: (channel, payload) => {
      assert.equal(channel, IPC.event.pluginComposerSuggestion);
      sent.push(payload);
    },
    getActiveSession: () => (activeSession ? { sessionId: activeSession } : null),
    answerTimeoutMs,
  });
  return { relay, sent };
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
  assert.deepEqual(await relay.offer(offer()), { shown: false, reason: "unsupported" });
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

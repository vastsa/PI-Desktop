import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

/*
 * The renderer half of `pi.composer.suggest` (ADR 0333): whether an offer can go
 * on screen, what takes it down, and which key acts on it while the completion
 * list still owns Tab and the first Escape.
 */
const { ComposerSuggestionBridge } = await import(
  "../src/features/chat/composer/plugins/suggestion-bridge.ts"
);
const { composerSuggestionKeyAction } = await import(
  "../src/features/chat/composer/plugins/suggestion-keys.ts"
);

const SESSION = "session-1";
const TURN = "turn-1";

/** A composer that takes input, as `usePluginComposerBridge` lends one. */
function makeHandle({
  sessionId = SESSION,
  text = "",
  references = [],
  caret = null,
} = {}) {
  return {
    state: { sessionId, text, references, caret, focused: false },
    read() {
      return {
        draftKey: this.state.sessionId || "home",
        sessionId: this.state.sessionId,
        text: this.state.text,
        references: this.state.references,
      };
    },
    focused() {
      return this.state.focused;
    },
    selection() {
      const end = this.state.caret ?? this.state.text.length;
      return { start: end, end };
    },
    write(nextText, nextReferences, nextCaret, focus) {
      this.state.text = nextText;
      this.state.references = nextReferences;
      this.state.caret = nextCaret;
      if (focus) this.state.focused = true;
    },
    async stage() {
      throw new Error("staging is not part of this test");
    },
  };
}

function offer(overrides = {}) {
  return {
    pluginId: "demo.suggestion",
    sessionId: SESSION,
    turnId: TURN,
    text: "Explain the failing test",
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

test("an offer shows only in the empty draft of the session it names", () => {
  const bridge = new ComposerSuggestionBridge();
  const handle = makeHandle();

  // No composer takes input: the window says so instead of queueing.
  assert.deepEqual(bridge.offer(offer()), { shown: false, reason: "unsupported" });

  const unregister = bridge.register(handle);
  assert.deepEqual(bridge.offer(offer()), { shown: true });
  assert.equal(bridge.get()?.text, "Explain the failing test");
  assert.deepEqual(bridge.offer(offer({ sessionId: "session-2" })), {
    shown: false,
    reason: "session-not-visible",
  });

  handle.state.text = "half a sentence";
  assert.deepEqual(bridge.offer(offer()), { shown: false, reason: "draft-not-empty" });

  // A staged attachment is a draft too, even with no text at all.
  handle.state.text = "";
  handle.state.references = [{ id: "ref-1" }];
  assert.deepEqual(bridge.offer(offer()), { shown: false, reason: "draft-not-empty" });

  unregister();
  assert.equal(bridge.get(), null);
});

test("an offer that is already over never appears", () => {
  const bridge = new ComposerSuggestionBridge();
  bridge.register(makeHandle());
  assert.deepEqual(bridge.offer(offer({ expiresAt: Date.now() - 1 })), {
    shown: false,
    reason: "stale-turn",
  });
  assert.equal(bridge.get(), null);
});

test("Tab writes the suggestion into the draft, keeps references, and ends it", () => {
  const bridge = new ComposerSuggestionBridge();
  const image = { id: "image-1" };
  const handle = makeHandle({ references: [] });
  bridge.register(handle);
  // The draft is empty when the offer lands; an image staged afterwards keeps
  // the suggestion, because a reference is not text.
  assert.deepEqual(bridge.offer(offer({ text: "Explain the failing test" })), { shown: true });
  handle.state.references = [image];

  assert.equal(bridge.accept(), true);
  assert.equal(handle.state.text, "Explain the failing test");
  assert.equal(handle.state.caret, "Explain the failing test".length);
  assert.equal(handle.state.focused, true);
  assert.deepEqual(handle.state.references, [image]);
  assert.equal(bridge.get(), null);
});

test("taking a suggestion the draft no longer fits is refused, not applied", () => {
  const bridge = new ComposerSuggestionBridge();
  const handle = makeHandle();
  bridge.register(handle);
  bridge.offer(offer());
  // The user typed in the same beat; the draft wins.
  handle.state.text = "mine";

  assert.equal(bridge.accept(), false);
  assert.equal(handle.state.text, "mine");
  assert.equal(bridge.get(), null);
});

test("typing, switching session and losing the composer all end the suggestion", () => {
  const bridge = new ComposerSuggestionBridge();
  const handle = makeHandle();
  bridge.register(handle);

  bridge.offer(offer());
  handle.state.text = "x";
  bridge.publish(handle);
  assert.equal(bridge.get(), null, "a first character ends it");

  handle.state.text = "";
  bridge.offer(offer());
  handle.state.sessionId = "session-2";
  bridge.publish(handle);
  assert.equal(bridge.get(), null, "the draft of another session ends it");

  handle.state.sessionId = SESSION;
  bridge.offer(offer());
  handle.state.text = "restored";
  bridge.publish(handle);
  handle.state.text = "";
  bridge.publish(handle);
  assert.equal(bridge.get(), null, "a suggestion never comes back after a change");

  bridge.offer(offer());
  assert.equal(bridge.get()?.text, "Explain the failing test");
});

test("the host's clear names a plugin, a session, or nothing", () => {
  const bridge = new ComposerSuggestionBridge();
  bridge.register(makeHandle());

  bridge.offer(offer());
  bridge.clear({ pluginId: "other.plugin" });
  assert.notEqual(bridge.get(), null, "another plugin's clear is not mine");

  bridge.clear({ pluginId: "demo.suggestion", sessionId: "session-2" });
  assert.notEqual(bridge.get(), null, "another session's clear is not this one");

  bridge.clear({ pluginId: "demo.suggestion" });
  assert.equal(bridge.get(), null);

  bridge.offer(offer());
  bridge.clear();
  assert.equal(bridge.get(), null, "an unfiltered clear drops everything");
});

test("a newer suggestion takes the slot, and the old one expires on its own clock", async () => {
  const bridge = new ComposerSuggestionBridge();
  bridge.register(makeHandle());

  bridge.offer(offer({ text: "first" }));
  bridge.offer(offer({ pluginId: "other.plugin", text: "second" }));
  assert.equal(bridge.get()?.text, "second");
  assert.equal(bridge.get()?.pluginId, "other.plugin");

  bridge.offer(offer({ text: "short-lived", expiresAt: Date.now() + 20 }));
  assert.equal(bridge.get()?.text, "short-lived");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(bridge.get(), null, "a suggestion ends when its lifetime does");
});

test("listeners see every change of the slot", () => {
  const bridge = new ComposerSuggestionBridge();
  bridge.register(makeHandle());
  let changes = 0;
  const off = bridge.subscribe(() => {
    changes += 1;
  });

  bridge.offer(offer());
  bridge.dismiss();
  off();
  bridge.offer(offer());
  assert.equal(changes, 2);
});

test("the completion list keeps Tab, and the first Escape closes it", () => {
  const tab = { key: "Tab" };
  const escape = { key: "Escape" };
  const showing = { suggestion: true, completionItems: false, completionOpen: false };
  const listOpen = { suggestion: true, completionItems: true, completionOpen: true };

  assert.equal(composerSuggestionKeyAction(tab, showing), "accept");
  assert.equal(composerSuggestionKeyAction(escape, showing), "dismiss");
  assert.equal(composerSuggestionKeyAction(tab, listOpen), null, "the list owns Tab");
  assert.equal(
    composerSuggestionKeyAction(escape, { ...listOpen, completionItems: false }),
    null,
    "the first Escape closes the list",
  );
  assert.equal(
    composerSuggestionKeyAction(tab, { ...showing, suggestion: false }),
    null,
    "no suggestion, no key",
  );
  assert.equal(composerSuggestionKeyAction({ key: "Tab", shiftKey: true }, showing), null);
  assert.equal(composerSuggestionKeyAction({ key: "Tab", metaKey: true }, showing), null);
  assert.equal(composerSuggestionKeyAction({ key: "Enter" }, showing), null);
  assert.equal(composerSuggestionKeyAction({ key: "Escape", altKey: true }, showing), null);
});

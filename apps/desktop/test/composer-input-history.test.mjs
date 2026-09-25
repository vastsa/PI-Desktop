import { readComposerModule, readComposerSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPOSER_INPUT_HISTORY_MAX,
  COMPOSER_INPUT_HISTORY_SESSIONS_MAX,
  loadComposerInputHistory,
  rememberComposerInput,
} from "../src/lib/composer-input-history.ts";
import {
  planHistoryNavigation,
  runHistoryStep,
  stepHistoryIndex,
} from "../src/features/chat/composer/input-history.ts";

const KEY = "pi.desktop.composerInputHistory";

function installStorage({ failWrites = false } = {}) {
  const data = new Map();
  const storage = {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      if (failWrites) throw new Error("QuotaExceededError");
      data.set(key, String(value));
    },
    removeItem: (key) => data.delete(key),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
  return data;
}

test.afterEach(() => {
  delete globalThis.localStorage;
});

const snap = (text, fileReferences = []) => ({ text, fileReferences });
const texts = (sessionId) => loadComposerInputHistory(sessionId).map((entry) => entry.text);

/** Drive `runHistoryStep` the way `useComposerInputHistory.navigate` does. */
function createHarness(history, { sessionId = "s1" } = {}) {
  const state = {
    entries: [],
    index: null,
    applied: [],
    consumed: [],
    keptReferences: [],
  };
  const run = (direction, { draftEmpty, edited = false } = {}) => {
    const result = runHistoryStep({
      entries: state.entries,
      index: state.index,
      keptReferences: state.keptReferences,
      direction,
      draftEmpty,
      edited,
      loadHistory: () => (history === "store" ? loadComposerInputHistory(sessionId) : history),
      createReference: (reference) => ({ ...reference, attached: true }),
      effects: {
        applyDraft: (text, references, caret) => state.applied.push({ text, references, caret }),
      },
    });
    state.entries = result.entries;
    state.index = result.index;
    state.consumed.push(result.consumed);
    return result;
  };
  return { state, run };
}

test("records per conversation, newest-first, collapsing consecutive duplicates (AC1)", () => {
  installStorage();
  rememberComposerInput("s1", snap("a"));
  rememberComposerInput("s1", snap("b"));
  rememberComposerInput("s1", snap("b"));
  assert.deepEqual(texts("s1"), ["b", "a"]);
});

test("a conversation never recalls another conversation's prompts (AC1)", () => {
  installStorage();
  rememberComposerInput("s1", snap("from A"));
  rememberComposerInput("s2", snap("from B", [{ path: "C:\\w\\b.ts", name: "b.ts" }]));
  assert.deepEqual(texts("s1"), ["from A"]);
  assert.deepEqual(texts("s2"), ["from B"]);
  assert.deepEqual(texts("s3"), []);
  assert.deepEqual(texts(""), []);
  // The same text in another conversation is its own entry, not a duplicate.
  rememberComposerInput("s2", snap("from A"));
  assert.deepEqual(texts("s2"), ["from A", "from B"]);
});

test("skips empty submissions and caps one conversation's history (AC1)", () => {
  installStorage();
  rememberComposerInput("s1", snap("   "));
  assert.equal(loadComposerInputHistory("s1").length, 0);
  for (let i = 0; i < COMPOSER_INPUT_HISTORY_MAX + 5; i += 1) {
    rememberComposerInput("s1", snap(`m${i}`));
  }
  const history = loadComposerInputHistory("s1");
  assert.equal(history.length, COMPOSER_INPUT_HISTORY_MAX);
  assert.equal(history[0].text, `m${COMPOSER_INPUT_HISTORY_MAX + 4}`);
});

test("keeps a bounded number of conversations, newest written first (AC7)", () => {
  installStorage();
  for (let i = 0; i < COMPOSER_INPUT_HISTORY_SESSIONS_MAX; i += 1) {
    rememberComposerInput(`s${i}`, snap(`m${i}`));
  }
  // Re-writing the oldest conversation moves it to the front of the retention
  // order, so `s1` survives and the last-written conversation is dropped.
  rememberComposerInput("s0", snap("again"));
  rememberComposerInput(`s${COMPOSER_INPUT_HISTORY_SESSIONS_MAX}`, snap("newest session"));
  assert.deepEqual(texts("s0"), ["again", "m0"]);
  assert.deepEqual(texts("s1"), []);
  assert.deepEqual(texts(`s${COMPOSER_INPUT_HISTORY_SESSIONS_MAX}`), ["newest session"]);
});

test("corrupted or blocked storage yields an empty history (AC7)", () => {
  const data = installStorage();
  data.set(KEY, "{not json");
  assert.deepEqual(loadComposerInputHistory("s1"), []);
  data.set(KEY, JSON.stringify({ sessions: "nope" }));
  assert.deepEqual(loadComposerInputHistory("s1"), []);
  data.set(KEY, JSON.stringify([{ text: "legacy array shape" }]));
  assert.deepEqual(loadComposerInputHistory("s1"), []);
  data.set(
    KEY,
    JSON.stringify({
      sessions: [
        { sessionId: "s1", entries: [{ text: 1 }, { text: "ok", fileReferences: [] }] },
        { sessionId: "", entries: [] },
        { entries: [] },
      ],
    }),
  );
  assert.deepEqual(texts("s1"), ["ok"]);
  delete globalThis.localStorage;
  assert.deepEqual(loadComposerInputHistory("s1"), []);
  installStorage({ failWrites: true });
  assert.doesNotThrow(() => rememberComposerInput("s1", snap("x")));
});

test("browse index walks older, clamps, and unwinds (AC2)", () => {
  const len = 2;
  let index = null;
  const seen = [];
  for (const direction of ["older", "older", "older", "newer", "newer"]) {
    index = stepHistoryIndex(index, direction, len);
    seen.push(index);
  }
  assert.deepEqual(seen, [0, 1, 1, 0, null]);
  assert.equal(stepHistoryIndex(null, "newer", len), null);
  assert.equal(stepHistoryIndex(null, "older", 0), null);
});

test("an empty draft starts a browse and walks both directions (AC2)", () => {
  const plan = (index, direction, draftEmpty = true) =>
    planHistoryNavigation({ index, direction, length: 3, draftEmpty });
  assert.deepEqual(plan(null, "older"), { action: "load", index: 0 });
  assert.deepEqual(plan(0, "older"), { action: "load", index: 1 });
  assert.deepEqual(plan(2, "older"), { action: "keep" });
  assert.deepEqual(plan(2, "newer"), { action: "load", index: 1 });
  assert.deepEqual(plan(0, "newer"), { action: "exit" });
  assert.deepEqual(plan(null, "newer"), { action: "ignore" });
  assert.deepEqual(
    planHistoryNavigation({ index: null, direction: "older", length: 0, draftEmpty: true }),
    { action: "ignore" },
  );
});

test("an unsent draft and an edited entry keep the arrows native (AC3, AC4)", () => {
  assert.deepEqual(
    planHistoryNavigation({ index: null, direction: "older", length: 5, draftEmpty: false }),
    { action: "ignore" },
  );
  assert.deepEqual(
    planHistoryNavigation({ index: null, direction: "newer", length: 5, draftEmpty: false }),
    { action: "ignore" },
  );
  assert.deepEqual(
    planHistoryNavigation({ index: null, direction: "older", length: 5, draftEmpty: true }),
    { action: "load", index: 0 },
  );
});

test("recall walks this conversation's history and unwinds to empty (AC2)", () => {
  installStorage();
  rememberComposerInput("s1", snap("m1"));
  rememberComposerInput("s1", snap("m2"));
  rememberComposerInput("s1", snap("m3"));
  const { state, run } = createHarness("store", { sessionId: "s1" });
  run("older", { draftEmpty: true });
  run("older", { draftEmpty: false });
  run("older", { draftEmpty: false });
  run("older", { draftEmpty: false });
  run("newer", { draftEmpty: false });
  run("newer", { draftEmpty: false });
  run("newer", { draftEmpty: false });
  assert.deepEqual(
    state.applied.map((step) => step.text),
    ["m3", "m2", "m1", "m2", "m3", ""],
  );
  assert.deepEqual(state.consumed, [true, true, true, true, true, true, true]);
  assert.equal(state.index, null, "passing the newest entry leaves the draft empty");
  assert.equal(state.applied.at(-1).caret, 0);
});

test("a recalled entry brings its own references back (AC6)", () => {
  const entry = {
    text: "see the shot",
    fileReferences: [
      { path: "C:\\scratch\\s1\\a.png", name: "a.png", kind: "image", token: "\ue001" },
      { path: "src/foo.ts", name: "foo.ts", kind: "file", token: "\ue002" },
    ],
  };
  const { state, run } = createHarness([entry]);
  run("older", { draftEmpty: true });
  assert.equal(state.applied[0].text, "see the shot");
  assert.deepEqual(
    state.applied[0].references.map((reference) => reference.path),
    ["C:\\scratch\\s1\\a.png", "src/foo.ts"],
  );
  assert.equal(state.applied[0].caret, entry.text.length);
});

test("a fresh arrow with text and an edit behind the entry are both native (AC3, AC4)", () => {
  const history = [
    { text: "m2", fileReferences: [] },
    { text: "m1", fileReferences: [] },
  ];
  const { state, run } = createHarness(history);
  assert.equal(run("older", { draftEmpty: false }).consumed, false);
  assert.equal(run("newer", { draftEmpty: false }).consumed, false);
  assert.equal(state.applied.length, 0, "an unsent draft is never replaced");

  run("older", { draftEmpty: true });
  assert.equal(state.applied.length, 1);
  // The user typed into the recalled entry: the next arrow is a caret move.
  assert.equal(run("older", { draftEmpty: false, edited: true }).consumed, false);
  assert.equal(state.applied.length, 1);
  assert.equal(state.index, null, "editing ends browsing");
  // Deleting back to empty starts a fresh browse from the newest entry.
  run("older", { draftEmpty: true });
  assert.deepEqual(state.applied.at(-1).text, "m2");
});

test("keydown order: IME guard < autocomplete < history < send (AC5)", async () => {
  const source = await readComposerModule("ComposerInput.tsx");
  const start = source.indexOf("onKeyDown={(event: ReactKeyboardEvent");
  const handler = source.slice(start, source.indexOf("        />", start));
  const ime = handler.indexOf("event.nativeEvent.isComposing");
  const autocomplete = handler.indexOf("composerAc.hasItems");
  const history = handler.indexOf("onHistoryNavigate(");
  const send = handler.search(
    /event\.key === "Enter"\s*&&\s*!event\.shiftKey\s*&&\s*\(enterToSend/,
  );
  assert.ok(ime > -1 && autocomplete > ime, "IME guard runs before autocomplete");
  assert.ok(history > autocomplete, "autocomplete keeps arrow priority over history");
  assert.ok(send > history, "history branch precedes the send branch");
  const branch = handler.slice(handler.lastIndexOf("if (", history), history);
  for (const modifier of ["shiftKey", "altKey", "metaKey", "ctrlKey"]) {
    assert.ok(branch.includes(`!event.${modifier}`), `history ignores ${modifier} arrows`);
  }
});

test("history is recorded only on accepted submissions of the submitting conversation (AC1)", async () => {
  const source = await readComposerModule("hooks/useComposerSubmit.ts");
  assert.match(source, /const targetSessionId = activeSessionId \?\? useAppStore\.getState\(\)\.activeSessionId;/);
  assert.match(source, /if \(targetSessionId\) recordHistory\?\.\(submittedDraft, targetSessionId\);/);
  assert.match(
    source,
    /if \(!accepted\) draft\.restoreDraftForKey\(submittedDraftKey, submittedDraft\);\s*else remember\(\);/,
  );
  const blocked = source.slice(
    source.indexOf('dispatch.action === "blocked"'),
    source.indexOf('dispatch.action === "dispatch"'),
  );
  assert.ok(!blocked.includes("remember()"), "blocked slash commands are not recorded");
  const recordCalls = source.match(/remember\(\);/g) ?? [];
  assert.equal(recordCalls.length, 4, "mode, extension, palette, and prompt paths record");
});

test("the composer wires recall, its exits, and the record point (AC3)", async () => {
  const composer = await readComposerSource();
  const hook = await readComposerModule("hooks/useComposerInputHistory.ts");
  // The behaviour under test above is the one the hook actually runs.
  assert.match(hook, /runHistoryStep\(\{/);
  assert.match(hook, /loadHistory: \(\) => loadComposerInputHistory\(referenceSessionId\)/);
  assert.match(hook, /draft\.draftRevision\(draftKey\) !== appliedRevisionRef\.current/);
  assert.match(hook, /useEffect\(\(\) => \{\s*exitBrowsing\(\);\s*\}, \[draftKey\]\);/);
  assert.match(composer, /onInput=\{\(source, caret\) => \{\s*inputHistory\.exitBrowsing\(\);/);
  assert.match(composer, /onHistoryNavigate=\{inputHistory\.navigate\}/);
  assert.match(composer, /recordHistory: inputHistory\.record/);
  // Both submit entry points — the composer's Enter and the toolbar's Send —
  // leave browsing before the draft is cleared.
  assert.match(
    composer,
    /const submitFromComposer = \(steering\?: boolean\) => \{\s*inputHistory\.exitBrowsing\(\);\s*return submit\(steering\);\s*\};/,
  );
  assert.match(composer, /onSubmit=\{\(steering\) => void submitFromComposer\(steering\)\}/);
  assert.match(composer, /submit=\{submitFromComposer\}/);
});

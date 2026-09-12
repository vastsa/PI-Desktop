import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const composer = await readFile(new URL("../src/components/Composer.tsx", import.meta.url), "utf8");
const store = await readFile(new URL("../src/stores/app-store.ts", import.meta.url), "utf8");
const handler = composer.match(/onKeyDown=\{(\(e\) => \{\s*\/\/ An Enter[\s\S]*?)\}\}\s*\/>/)?.[1] + "}";
assert.ok(handler.includes("void submit(runActive)"), "read the actual Composer key handler");

function press(overrides = {}, { running = true, enterToSend = true, menu = false } = {}) {
  const calls = [];
  const autocomplete = {
    open: menu, hasItems: menu, highlight: 0, items: ["candidate"],
    close: () => calls.push("close"), setHighlight: () => {},
  };
  const keydown = new Function("composerAc", "acceptCompletion", "submit", "runActive", "enterToSend", `return ${handler}`)(
    autocomplete, () => calls.push("completion"), (steer = false) => calls.push(steer ? "steer" : "send"), running, enterToSend,
  );
  keydown({ key: "Enter", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
    nativeEvent: { isComposing: false, keyCode: 13 }, preventDefault: () => calls.push("prevent"), stopPropagation: () => {}, ...overrides });
  return calls;
}

test("Alt+Enter steers a running turn regardless of the Enter preference and autocomplete", () => {
  for (const enterToSend of [true, false]) for (const menu of [true, false]) {
    assert.deepEqual(press({ altKey: true }, { enterToSend, menu }), ["prevent", "close", "steer"]);
  }
  assert.deepEqual(press({ altKey: true }, { running: false }), ["prevent", "close", "send"]);
});

test("ordinary send, newlines, autocomplete and IME retain their keyboard behavior", () => {
  assert.deepEqual(press(), ["prevent", "send"]);
  assert.deepEqual(press({}, { enterToSend: false }), []);
  assert.deepEqual(press({ ctrlKey: true }, { enterToSend: false }), ["prevent", "send"]);
  assert.deepEqual(press({ metaKey: true }, { enterToSend: false }), ["prevent", "send"]);
  assert.deepEqual(press({ shiftKey: true }), []);
  assert.deepEqual(press({ altKey: true, shiftKey: true }), []);
  assert.deepEqual(press({}, { menu: true }), ["prevent", "completion"]);
  for (const nativeEvent of [{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }]) {
    assert.deepEqual(press({ altKey: true, nativeEvent }, { menu: true }), []);
  }
});

const steerBody = store.match(/steerPrompt: (async \(content, draft\) => \{[\s\S]*?\n  \}),\n\n  compactContext:/)?.[1];
assert.ok(steerBody, "read the actual store steering action");
function steeringStore(steer = async () => ({ accepted: true, turnId: "turn-1" })) {
  const state = { activeSessionId: "session-1", runningSessions: { "session-1": true }, agentStatuses: { "session-1": { currentTurnId: "turn-1" } }, pendingPlans: {}, showToast: () => {} };
  const calls = [];
  const steeringMessageIds = new Map();
  const action = new Function("get", "api", "optimisticUserMessage", "insertOptimisticUserMessage", "retractOptimisticUserMessage", "promptAttachmentsFromDraft", "i18n", "crypto", "messageErrorFromUnknown", "steeringMessageIds", `return ${steerBody.replace(/new Set<string>\(\)/g, "new Set()")}`)(
    () => state, { steer: (request) => { calls.push(request); return steer(request); } },
    (id, content) => ({ id, content }), (...args) => calls.push(["insert", ...args]), (...args) => calls.push(["retract", ...args]),
    (references) => references, { t: (key) => key }, { randomUUID: () => "message-1" }, (error) => error, steeringMessageIds,
  );
  return { action, state, calls, steeringMessageIds };
}

test("steering captures the target session and turn, without enqueueing or changing run state", async () => {
  const { action, state, calls } = steeringStore();
  assert.equal(await action("direction", { text: "direction", fileReferences: [{ path: "image.png" }] }), true);
  assert.deepEqual(calls[1], { sessionId: "session-1", expectedTurnId: "turn-1", content: "direction", messageId: "message-1", attachments: [{ path: "image.png" }] });
  assert.equal(state.runningSessions["session-1"], true);
});

test("a rejected steer retracts only its own optimistic row and lets Composer restore the draft", async () => {
  let reject;
  const { action, state, calls } = steeringStore(() => new Promise((_resolve, rejectRequest) => { reject = rejectRequest; }));
  const pending = action("direction");
  state.activeSessionId = "session-2";
  reject({ code: "TURN_NOT_FOUND", message: "target ended" });
  assert.equal(await pending, false);
  assert.deepEqual(calls.at(-1), ["retract", "session-1", { id: "message-1", content: "direction" }]);
  assert.equal(state.runningSessions["session-1"], true);
  assert.match(composer, /if \(!accepted\) restoreDraftForKey\(submittedDraftKey, submittedDraft\)/);
});

test("missing turn identity and a pending approval reject before creating a message", async () => {
  for (const reason of ["missing", "approval", "idle"]) {
    const { action, state, calls } = steeringStore();
    if (reason === "missing") state.agentStatuses = {};
    if (reason === "approval") state.pendingPlans["session-1"] = { status: "pending" };
    if (reason === "idle") state.runningSessions["session-1"] = false;
    assert.equal(await action("direction"), false);
    assert.deepEqual(calls, []);
  }
});


test("steering protects all turn inputs from smart Stop and a rejected request releases its marker", async () => {
  const accepted = steeringStore();
  await accepted.action("direction");
  assert.equal(accepted.steeringMessageIds.get("session-1").size, 1);
  const rejected = steeringStore(async () => { throw { code: "TURN_NOT_FOUND" }; });
  await rejected.action("direction");
  assert.equal(rejected.steeringMessageIds.size, 0);
  assert.match(store, /const preserveSteering = Boolean\(steeringMessageIds\.get\(sessionId\)\?\.size\);[\s\S]*?await Promise\.allSettled/);
  assert.match(store, /const smartStop = preserveSteering\s*\? \{ kind: "settle" as const \}/);
  assert.match(store, /steeringMessageIds\.delete\(envelope\.sessionId\)/);
});

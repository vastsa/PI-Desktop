import { SteeringSubmissions } from "../src/lib/composer-submission.ts";
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

function steeringFixture(request = async () => ({ accepted: true, turnId: "turn-1" })) {
  const calls = [];
  const service = new SteeringSubmissions({
    request: (req) => { calls.push(req); return request(req); },
    insert: (...args) => calls.push(["insert", ...args]),
    retract: (...args) => calls.push(["retract", ...args]),
    reportError: () => {},
  });
  const target = { sessionId: "session-1", turnId: "turn-1", running: true, approvalPending: false };
  return { service, target, calls };
}

test("steering captures the target and transports image chips without changing run state", async () => {
  const { service, target, calls } = steeringFixture();
  assert.equal(await service.submit("direction", { text: "direction", fileReferences: [{ path: "image.png", name: "image.png" }] }, target), true);
  assert.deepEqual(calls[1], { sessionId: "session-1", expectedTurnId: "turn-1", content: "direction", messageId: calls[0][2].id, attachments: [{ path: "image.png", name: "image.png", kind: "image" }] });
  assert.equal(target.running, true);
  assert.equal(service.hasInput("session-1"), true);
  service.settle("session-1");
  assert.equal(service.hasInput("session-1"), false);
});

test("a rejected steer retracts its own row after session navigation and releases Stop protection", async () => {
  let reject;
  const { service, target, calls } = steeringFixture(() => new Promise((_resolve, rejectRequest) => { reject = rejectRequest; }));
  const pending = service.submit("direction", undefined, target);
  assert.equal(service.hasInput("session-1"), true);
  target.sessionId = "session-2";
  reject({ code: "TURN_NOT_FOUND", message: "target ended" });
  assert.equal(await pending, false);
  assert.deepEqual(calls.at(-1), ["retract", "session-1", calls[0][2]]);
  assert.equal(service.hasInput("session-1"), false);
  assert.match(composer, /if \(!accepted\) restoreDraftForKey\(submittedDraftKey, submittedDraft\)/);
});

test("missing turn identity and a pending approval reject before creating a message", async () => {
  for (const reason of ["missing", "approval", "idle"]) {
    const { service, target, calls } = steeringFixture();
    if (reason === "missing") target.turnId = undefined;
    if (reason === "approval") target.approvalPending = true;
    if (reason === "idle") target.running = false;
    assert.equal(await service.submit("direction", undefined, target), false);
    assert.deepEqual(calls, []);
  }
});

test("the store snapshots steering before Stop and clears protection at terminal settlement", () => {
  assert.match(store, /steerPrompt:[\s\S]*?steeringSubmissions\.submit\(content, draft/);
  assert.match(store, /const preserveSteering = steeringSubmissions\.hasInput\(sessionId\);[\s\S]*?await Promise\.allSettled/);
  assert.match(store, /const smartStop = preserveSteering\s*\? \{ kind: "settle" as const \}/);
  assert.match(store, /steeringSubmissions\.settle\(envelope\.sessionId\)/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createPluginShellLayoutRelay } = await import("../electron/main/services/plugin-shell-layout.ts");
const layout = { sidebar: { collapsed: false, width: 240, minWidth: 180, maxWidth: 400 }, workPanel: { visible: false, width: 320, minWidth: 244, tabs: [], activeTabId: null } };
const snapshot = (revision = 1, bootId = "boot", contextId = "context") => ({ bootId, revision, contextId, sessionId: "s", projectPath: null, layout });
function setup(options = {}) { const sent = [], events = []; const relay = createPluginShellLayoutRelay({ sendToRenderer: (_, message) => sent.push(message), announce: (value) => events.push(value), authorize: () => true, ...options }); return { relay, sent, events }; }
test("live reads correlate answers and never announce pointer-preview replies", async () => {
  const { relay, sent, events } = setup();
  assert.equal(relay.publish(snapshot()), true);
  const pending = relay.request("p", { kind: "get" });
  const request = sent.at(-1);
  assert.equal(relay.settle({ requestId: "unknown", snapshot: snapshot(2) }), false);
  assert.equal(relay.settle({ requestId: request.requestId, snapshot: snapshot(2) }), true);
  assert.deepEqual(await pending, layout);
  assert.equal(events.length, 1);
  assert.equal(relay.publish(snapshot(3)), true);
  assert.equal(events.length, 1, "identical committed layout is deduplicated");
});
test("retired boots cannot reactivate and renderer reset cancels queued work", async () => {
  const { relay, sent } = setup(); relay.publish(snapshot());
  const pending = relay.request("p", { kind: "setSidebar", input: { collapsed: true } });
  const request = sent.at(-1); relay.rendererLost();
  await assert.rejects(pending, { code: "UNAVAILABLE" });
  assert.deepEqual(sent.at(-1), { kind: "cancel", requestId: request.requestId });
  assert.equal(relay.publish(snapshot(2)), false);
  assert.equal(relay.publish(snapshot(0, "new")), true);
  assert.equal(relay.publish(snapshot(20)), false);
});
test("out-of-order snapshots and stale mutation contexts cannot win", async () => {
  const { relay, sent } = setup(); relay.publish(snapshot(3));
  assert.equal(relay.publish(snapshot(2)), false);
  const pending = relay.request("p", { kind: "activateTab", tabId: "x" });
  const request = sent.at(-1); relay.publish(snapshot(4, "boot", "context2"));
  await assert.rejects(pending, { code: "UNAVAILABLE" });
  assert.equal(relay.settle({ requestId: request.requestId, snapshot: snapshot(5) }), false);
});
test("unavailable renderer, plugin unload and timeout expose coded errors and cancel", async () => {
  const { relay, sent } = setup({ answerTimeoutMs: 15 });
  await assert.rejects(relay.request("p", { kind: "get" }), { code: "UNAVAILABLE" });
  relay.publish(snapshot());
  const unload = relay.request("p", { kind: "get" }); relay.clearPlugin("p");
  await assert.rejects(unload, { code: "UNAVAILABLE" });
  const timeout = relay.request("q", { kind: "get" });
  await assert.rejects(timeout, { code: "TIMEOUT" });
  assert.equal(sent.at(-1).kind, "cancel");
});
test("destroying one caller cancels its queued request without cancelling other callers", async () => {
  const { relay, sent } = setup(); relay.publish(snapshot());
  const controller = new AbortController();
  const one = relay.request("p", { kind: "get" }, controller.signal);
  const two = relay.request("p", { kind: "get" });
  const replyId = sent.at(-1).requestId;
  controller.abort();
  await assert.rejects(one, { code: "UNAVAILABLE" });
  relay.settle({ requestId: replyId, snapshot: snapshot(2) });
  assert.deepEqual(await two, layout);
});


test("scope is checked against the displayed project before dispatch and after a live read", async () => {
  const { relay, sent } = setup({ authorize: (pluginId, snapshot) => pluginId === snapshot.projectPath });
  relay.publish({ ...snapshot(), projectPath: "project-A" });
  await assert.rejects(relay.request("project-B", { kind: "get" }), { code: "PERMISSION_DENIED" });
  assert.equal(sent.length, 0, "a plugin from the newly selected Main workspace cannot read the old displayed tabs");
  const pending = relay.request("project-A", { kind: "get" });
  relay.settle({ requestId: sent.at(-1).requestId, snapshot: { ...snapshot(2), projectPath: "project-B" } });
  await assert.rejects(pending, { code: "PERMISSION_DENIED" });
});

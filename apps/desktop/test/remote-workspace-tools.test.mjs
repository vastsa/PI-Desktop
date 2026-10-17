import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createRemoteWorkspaceToolRelay } = await import("../electron/main/remote/remote-workspace-tools.ts");
const request = {
  requestId: "request", sessionId: "session", turnId: "turn", toolCallId: "tool",
  toolName: "Read", args: { path: "README.md" }, remoteWorkspace: { hostKey: "ssh", path: "/work/app" },
};
function fixture(execute) {
  const sent = [], replies = [], aborted = [];
  let current = true, dispatchable = true;
  const relay = createRemoteWorkspaceToolRelay({ call: async (method, params) => replies.push({ method, params }) }, {
    getBoot: () => ({ executeWorkspaceTool: async (input) => { sent.push(input); return execute(input); },
      abortWorkspaceTool: async (input) => aborted.push(input) }),
    isCurrent: () => current, isTurnDispatchable: () => dispatchable, log: () => {},
  });
  return { relay, sent, replies, aborted, replace: () => { current = false; }, cancelTurn: () => { dispatchable = false; } };
}
test("an admitted local turn sends only a workspace tool and completes locally", async () => {
  const f = fixture(() => ({ ok: true, content: "remote README" }));
  await f.relay.execute(request);
  assert.deepEqual(f.sent, [{ hostKey: "ssh", path: "/work/app", sessionId: "session", turnId: "turn",
    toolCallId: "tool", toolName: "Read", args: { path: "README.md" } }]);
  assert.deepEqual(f.replies, [{ method: "tools.remoteComplete", params: { requestId: "request", result: { ok: true, content: "remote README" } } }]);
});
test("cancelled turns cannot dispatch a remote side effect", async () => {
  const f = fixture(() => assert.fail("not admitted"));
  f.cancelTurn();
  await f.relay.execute(request);
  assert.equal(f.sent.length, 0);
  assert.equal(f.replies[0].params.result.errorCode, "TOOL_ABORTED");
});
test("abort is routed to the active remote call and never accepts its late success", async () => {
  let resolve;
  const f = fixture(() => new Promise((done) => { resolve = done; }));
  const pending = f.relay.execute(request);
  f.relay.cancel(request);
  resolve({ ok: true, content: "late result" });
  await pending;
  assert.deepEqual(f.aborted, [{ hostKey: "ssh", sessionId: "session", toolCallId: "tool" }]);
  assert.equal(f.replies[0].params.result.errorCode, "TOOL_ABORTED");
});
test("a replaced local Host does not receive a previous generation result", async () => {
  let resolve;
  const f = fixture(() => new Promise((done) => { resolve = done; }));
  const pending = f.relay.execute(request);
  f.replace(); f.relay.dispose(); resolve({ ok: true, content: "old result" });
  await pending;
  assert.equal(f.aborted.length, 1);
  assert.equal(f.replies.length, 0);
});
test("remote failure remains an observable local tool error without fallback", async () => {
  const f = fixture(() => { throw Object.assign(new Error("disconnected"), { errorCode: "HOST_DISCONNECTED" }); });
  await f.relay.execute(request);
  assert.equal(f.sent.length, 1);
  assert.equal(f.replies[0].params.result.errorCode, "HOST_DISCONNECTED");
  assert.equal(f.replies[0].params.result.content.error, "disconnected");
});
test("a duplicate dispatch does not remove the original call's cancellation owner", async () => {
  let resolve;
  const f = fixture(() => new Promise((done) => { resolve = done; }));
  const pending = f.relay.execute(request);
  await f.relay.execute({ ...request, requestId: "duplicate" });
  f.relay.cancel(request);
  resolve({ ok: true, content: "late result" });
  await pending;
  assert.equal(f.sent.length, 1);
  assert.equal(f.aborted.length, 1);
  assert.equal(f.replies.find(reply => reply.params.requestId === "request").params.result.errorCode, "TOOL_ABORTED");
});

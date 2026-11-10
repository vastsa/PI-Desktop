import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createInteractionSlice } = await import("../src/stores/slices/interaction-slice.ts");
const { api } = await import("../src/lib/api.ts");

for (const kind of ["ask", "permission"]) {
  test(`a failed ${kind} answer preserves its card and allows retry`, async t => {
    const request = { requestId: "request", sessionId: "session", toolCallId: "tool" };
    const next = { ...request, requestId: "next" };
    const draft = { index: 0, answers: [{ values: ["chosen"], customSelected: false, customText: "", skipped: false }] };
    let state = { pendingAsks: { session: [request, next] }, pendingPermissions: { session: [request, next] }, askDrafts: { request: draft } };
    const slice = createInteractionSlice({ get: () => state, set: patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; } });
    const method = kind === "ask" ? "resolveAskTool" : "resolvePermission";
    const invoke = () => kind === "ask" ? slice.resolveAsk("session", { requestId: "request", sessionId: "session", answers: [["chosen"]] }) : slice.resolvePermission("session", "request", "allow-once");
    t.mock.method(api, method, async () => { throw new Error("temporary transport failure"); });
    await assert.rejects(invoke(), /transport failure/);
    assert.equal((kind === "ask" ? state.pendingAsks : state.pendingPermissions).session[0], request);
    assert.equal(state.askDrafts.request, draft);
    t.mock.method(api, method, async () => ({ ok: true }));
    await invoke();
    assert.deepEqual((kind === "ask" ? state.pendingAsks : state.pendingPermissions).session, [next]);
    if (kind === "ask") assert.equal(state.askDrafts.request, undefined);
  });
}

test("a late successful answer cannot remove a replacement request or its draft", async t => {
  const first = { requestId: "first", sessionId: "session", toolCallId: "tool" };
  const replacement = { ...first, requestId: "replacement" };
  const draft = { index: 0, answers: [] };
  let state = { pendingAsks: { session: [first] }, askDrafts: { first: draft } };
  const slice = createInteractionSlice({ get: () => state, set: patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; } });
  let finish;
  t.mock.method(api, "resolveAskTool", () => new Promise(resolve => { finish = resolve; }));
  const pending = slice.resolveAsk("session", { requestId: "first", answers: [null] });
  state = { pendingAsks: { session: [replacement] }, askDrafts: { replacement: draft } };
  finish({ ok: true });
  await pending;
  assert.deepEqual(state.pendingAsks.session, [replacement]);
  assert.equal(state.askDrafts.replacement, draft);
});

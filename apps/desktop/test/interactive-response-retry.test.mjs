import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createInteractionSlice } = await import("../src/stores/slices/interaction-slice.ts");
const { api } = await import("../src/lib/api.ts");

// Based on the reproduction in #2235 by yg2224.

function fixture() {
  const request = { requestId: "request", sessionId: "session", toolCallId: "tool" };
  const next = { ...request, requestId: "next" };
  const draft = { index: 0, answers: [{ values: ["chosen"], customSelected: false, customText: "", skipped: false }] };
  let state = {
    pendingAsks: { session: [request, next] },
    pendingPermissions: { session: [request, next] },
    askDrafts: { request: draft },
  };
  const slice = createInteractionSlice({
    get: () => state,
    set: patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; },
  });
  return { request, next, draft, slice, state: () => state };
}

function coded(code, message = code) {
  return Object.assign(new Error(message), { code });
}

for (const kind of ["ask", "permission"]) {
  const method = kind === "ask" ? "resolveAskTool" : "resolvePermission";
  const answer = slice => kind === "ask"
    ? slice.resolveAsk("session", { requestId: "request", sessionId: "session", answers: [["chosen"]] })
    : slice.resolvePermission("session", "request", "allow-once");
  const cards = state => kind === "ask" ? state.pendingAsks : state.pendingPermissions;

  test(`a failed ${kind} answer preserves its card and draft, and a retry settles it`, async t => {
    const f = fixture();
    t.mock.method(api, method, async () => { throw new Error("temporary transport failure"); });
    await assert.rejects(answer(f.slice), /transport failure/);
    assert.equal(cards(f.state()).session[0], f.request);
    assert.equal(f.state().askDrafts.request, f.draft);

    t.mock.method(api, method, async () => ({ ok: true }));
    await answer(f.slice);
    assert.deepEqual(cards(f.state()).session, [f.next]);
    if (kind === "ask") assert.equal(f.state().askDrafts.request, undefined);
  });

  for (const code of kind === "ask" ? ["ASKTOOL_NOT_FOUND", "NOT_FOUND"] : ["NOT_FOUND"]) {
    test(`a ${kind} answer for a request that is gone (${code}) drops the card without an error`, async t => {
      const f = fixture();
      t.mock.method(api, method, async () => { throw coded(code); });
      await answer(f.slice);
      assert.deepEqual(cards(f.state()).session, [f.next]);
      if (kind === "ask") assert.equal(f.state().askDrafts.request, undefined);
    });
  }
}

test("a late successful answer cannot remove a replacement request or its draft", async t => {
  const first = { requestId: "first", sessionId: "session", toolCallId: "tool" };
  const replacement = { ...first, requestId: "replacement" };
  const draft = { index: 0, answers: [] };
  let state = { pendingAsks: { session: [first] }, askDrafts: { first: draft } };
  const slice = createInteractionSlice({
    get: () => state,
    set: patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; },
  });
  let finish;
  t.mock.method(api, "resolveAskTool", () => new Promise(resolve => { finish = resolve; }));
  const pending = slice.resolveAsk("session", { requestId: "first", answers: [null] });
  state = { pendingAsks: { session: [replacement] }, askDrafts: { replacement: draft } };
  finish({ ok: true });
  await pending;
  assert.deepEqual(state.pendingAsks.session, [replacement]);
  assert.equal(state.askDrafts.replacement, draft);
});

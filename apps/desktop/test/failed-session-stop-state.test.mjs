import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionSlice } = await import("../src/stores/slices/session-slice.ts");
const { api } = await import("../src/lib/api.ts");

test("a rejected remote stop preserves running state and allows retry", async t => {
  let state = { activeSessionId: "remote:session", isRunning: true, runningSessions: { "remote:session": true }, sessions: [] };
  const slice = createSessionSlice({ get: () => state, set: patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; } });
  t.mock.method(api, "abort", async () => { throw new Error("remote host disconnected"); });
  await assert.rejects(slice.abortSession("remote:session"), /disconnected/);
  assert.equal(state.isRunning, true);
  assert.equal(state.runningSessions["remote:session"], true);
  t.mock.method(api, "abort", async () => ({ ok: true }));
  await slice.abortSession("remote:session");
  assert.equal(state.isRunning, false);
  assert.equal(state.runningSessions["remote:session"], false);
});

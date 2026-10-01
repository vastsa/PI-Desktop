import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { createEventsSlice } = await import("../src/stores/slices/events-slice.ts");

function snapshot(revision, todos = []) {
  return {
    sessionId: "session-1",
    todos,
    revision,
    updatedAt: revision,
  };
}

function makeSlice() {
  let state = { sessionTodos: {} };
  const get = () => state;
  const set = (update) => {
    const next = typeof update === "function" ? update(state) : update;
    state = { ...state, ...next };
  };
  return {
    slice: createEventsSlice({
      get,
      set,
      runtime: { nextPlanSyncGeneration() {} },
      withoutRecordKey: (record, key) => {
        const copy = { ...record };
        delete copy[key];
        return copy;
      },
      sessionModeForPlanningState: () => "agent",
      openPlanArtifact() {},
      notifyInteractivePrompt() {},
      triggerAutoTitleSummarization: async () => {},
      flushPendingSessionConfiguration: async () => {},
      assistantErrorMessage: () => ({ role: "assistant", content: "" }),
      withCompactionMark: (marks, mark) => [...(marks ?? []), mark],
    }),
    read: () => state,
  };
}

test("Todo events keep the newest valid session snapshot only", () => {
  const { slice, read } = makeSlice();
  const apply = slice.applyTodosChanged;
  apply(snapshot(2, [{ content: "new", status: "pending", priority: "medium" }]));
  apply(snapshot(1, [{ content: "old", status: "pending", priority: "medium" }]));
  assert.equal(read().sessionTodos["session-1"].todos[0].content, "new");
  assert.equal(read().sessionTodos["session-1"].revision, 2);

  apply({ sessionId: "session-1", revision: 3, updatedAt: 3 });
  apply(snapshot(3, [{ content: "bad status", status: "unknown", priority: "medium" }]));
  assert.equal(read().sessionTodos["session-1"].revision, 2);

  apply(snapshot(3, [{ content: "cleared", status: "cancelled", priority: "low" }]));
  assert.equal(read().sessionTodos["session-1"].revision, 3);
});

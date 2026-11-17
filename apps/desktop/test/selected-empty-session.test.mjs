import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionRuntime } = await import("../src/stores/runtime/session-runtime.ts");
const { createSessionSlice } = await import("../src/stores/slices/session-slice.ts");
const { activeEmptySessionId } = await import("../src/lib/session-create.ts");
const { compareSessionsForDisplay } = await import("../src/lib/sidebar-session-groups.ts");

test("New Task preserves the selected unsent slot while an older run updates", async () => {
  const background = { id: "background", projectPath: "/fixture", messageCount: 4, updatedAt: "2026-11-17T10:00:00Z" };
  const draft = { ...background, id: "draft", messageCount: 0, updatedAt: "2026-11-17T10:01:00Z" };
  let state = { sessions: [background, draft], activeSessionId: "draft", messages: [],
    workspace: { path: "/fixture" }, activeProjectPath: "/fixture", sessionMeta: {},
    runningSessions: { background: true }, retainedTranscripts: {}, page: "chat" };
  let creations = 0;
  const get = () => state;
  const set = patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; };
  const runtime = createSessionRuntime({ get, set });
  const actions = createSessionSlice({ get, set, runtime,
    persistSessionAndSelect: async () => { creations++; return "new"; },
  });
  const visibleIds = () => [...state.sessions].sort(compareSessionsForDisplay({
    sort: "recent", sessionMeta: state.sessionMeta, taskTitle: title => title,
    emptySessionId: activeEmptySessionId(state),
  })).map(row => row.id);
  assert.deepEqual(visibleIds(), ["draft", "background"]);
  await actions.newSession({ projectPath: "/fixture" });
  assert.equal(creations, 0);
  background.updatedAt = "2026-11-17T10:02:00Z";
  assert.deepEqual(visibleIds(), ["draft", "background"]);
  await actions.newSession({ projectPath: "/fixture" });
  assert.equal(creations, 0, "background output must not allow duplicate empty tasks");
  assert.equal(state.activeSessionId, "draft");
  set({ messages: [{ id: "sent", role: "user", content: "Synthetic prompt" }] });
  assert.deepEqual(visibleIds(), ["background", "draft"]);
  await actions.newSession({ projectPath: "/fixture" });
  assert.equal(creations, 1, "sending releases the empty slot");
});

test("empty-slot priority preserves pins, archives, explicit sorts and live-message guards", () => {
  const draft = { id: "draft", title: "Z", messageCount: 0, createdAt: "2026-11-17T10:00:00Z" };
  const other = { id: "other", title: "A", createdAt: "2026-11-17T11:00:00Z" };
  const compare = (sort, sessionMeta = {}) => compareSessionsForDisplay({ sort, sessionMeta, taskTitle: title => title, emptySessionId: draft.id });
  for (const [sort, first] of [["name", "other"], ["created", "other"], ["oldest", "draft"]]) {
    assert.equal([draft, other].sort(compare(sort))[0].id, first);
  }
  assert.equal([draft, other].sort(compare("recent", { other: { pinned: true } }))[0].id, "other");
  assert.equal([draft, other].sort(compare("recent", { draft: { archived: true } }))[0].id, "other");
  const state = { activeSessionId: "draft", sessions: [draft], messages: [], runningSessions: {} };
  assert.equal(activeEmptySessionId(state), "draft");
  for (const patch of [
    { activeSessionId: undefined }, { sessions: [] }, { messages: [{ id: "sent" }] },
    { runningSessions: { draft: true } },
    ...[{ messageCount: 1 }, { messageCount: undefined }, { scheduledRun: true }, { worktree: {} }]
      .map(fields => ({ sessions: [{ ...draft, ...fields }] })),
  ]) assert.equal(activeEmptySessionId({ ...state, ...patch }), undefined);
});

test("selected empty reuse stays within the requested group and excludes archives", () => {
  const background = { id: "background", projectPath: "/fixture", messageCount: 4, updatedAt: "2026-11-17T10:02:00Z" };
  const draft = { ...background, id: "draft", messageCount: 0, updatedAt: "2026-11-17T10:01:00Z" };
  const state = { activeSessionId: "draft", sessions: [background, draft], messages: [], runningSessions: {} };
  const runtime = createSessionRuntime({ get: () => state, set: () => {} });
  assert.equal(runtime.latestSessionInScope(state.sessions, "/fixture", {})?.id, "draft");
  assert.equal(runtime.latestSessionInScope(state.sessions, "/fixture", { draft: { archived: true } })?.id, "background");
  draft.projectPath = "/other";
  assert.equal(runtime.latestSessionInScope(state.sessions, "/fixture", {})?.id, "background");
});

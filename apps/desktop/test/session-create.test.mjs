import { readStoreModule } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const {
  EMPTY_SESSION_WINDOW,
  sessionIsReusableEmpty,
} = await import("../src/lib/session-create.ts");
const { createSessionRuntime } = await import("../src/stores/runtime/session-runtime.ts");

const sessionSlice = await readStoreModule("slices/session-slice.ts");
const sessionCoordination = await readStoreModule("runtime/session-coordination.ts");

test("an empty latest session is reusable only when the renderer agrees", () => {
  const empty = { messageCount: 0 };
  assert.equal(sessionIsReusableEmpty(empty), true);
  assert.equal(sessionIsReusableEmpty(empty, {}), true);
  assert.equal(sessionIsReusableEmpty({ messageCount: 1 }), false);
  assert.equal(sessionIsReusableEmpty(empty, { running: true }), false);
  assert.equal(sessionIsReusableEmpty(empty, { liveMessageCount: 1 }), false);
  assert.equal(sessionIsReusableEmpty(empty, { submitted: true }), false);
  assert.equal(
    sessionIsReusableEmpty(empty, {
      running: false,
      liveMessageCount: 0,
      submitted: false,
    }),
    true,
  );
});

test("isolated sessions are never reused for a new task (ADR 0329)", () => {
  const empty = { messageCount: 0 };
  const emptyIsolated = { messageCount: 0, worktree: { branch: "pi-desktop/a", status: "active" } };
  assert.equal(sessionIsReusableEmpty(emptyIsolated), false, "ordinary + must not pick an isolated session");
  assert.equal(sessionIsReusableEmpty(emptyIsolated, { isolated: true }), false);
  assert.equal(sessionIsReusableEmpty(empty, { isolated: true }), false, "isolation always creates a worktree");
  assert.equal(sessionIsReusableEmpty(empty, { isolated: false }), true);
});

test("automation and scheduled sessions are never reused for a new task (#1684)", () => {
  const empty = { messageCount: 0 };
  const emptyScheduled = { messageCount: 0, scheduledRun: true };
  assert.equal(
    sessionIsReusableEmpty(emptyScheduled),
    false,
    "an empty scheduled run session must never be reused for a new task",
  );
  assert.equal(
    sessionIsReusableEmpty({ messageCount: 0, scheduledRun: false }),
    true,
    "an ordinary session with scheduledRun: false is reusable when empty",
  );
  assert.equal(sessionIsReusableEmpty(empty), true);
});

test("latestSessionInScope excludes automation sessions so empty scheduled runs are not reused (#1684)", () => {
  const runtime = createSessionRuntime({ get: () => ({}), set: () => {} });
  const scheduledEmpty = {
    id: "session-scheduled",
    projectPath: "/workspace/project",
    messageCount: 0,
    scheduledRun: true,
    updatedAt: "2026-10-15T12:00:00Z",
  };
  const userEmpty = {
    id: "session-user-empty",
    projectPath: "/workspace/project",
    messageCount: 0,
    scheduledRun: false,
    updatedAt: "2026-10-15T11:00:00Z",
  };
  const userNonEmpty = {
    id: "session-user-nonempty",
    projectPath: "/workspace/project",
    messageCount: 3,
    scheduledRun: false,
    updatedAt: "2026-10-15T10:00:00Z",
  };

  // Case 1: The most recent session is an empty scheduled run, but an older empty user session exists.
  // The user empty session must be selected as the latest in scope.
  const candidate1 = runtime.latestSessionInScope(
    [scheduledEmpty, userEmpty, userNonEmpty],
    "/workspace/project",
    {},
  );
  assert.equal(candidate1?.id, "session-user-empty");

  // Case 2: The only session in scope is an empty scheduled run.
  // latestSessionInScope must return undefined so a new session is created.
  const candidate2 = runtime.latestSessionInScope(
    [scheduledEmpty],
    "/workspace/project",
    {},
  );
  assert.equal(candidate2, undefined);

  // Case 3: The most recent session is an empty scheduled run, followed by a non-empty user session.
  // latestSessionInScope must return the user session (which is not empty, causing newSession to create a fresh one).
  const candidate3 = runtime.latestSessionInScope(
    [scheduledEmpty, userNonEmpty],
    "/workspace/project",
    {},
  );
  assert.equal(candidate3?.id, "session-user-nonempty");
});

test("empty sessions have a whole, already-known transcript window", () => {
  assert.deepEqual(EMPTY_SESSION_WINDOW, {
    messageStart: 0,
    hasMoreBefore: false,
  });
});

test("new task reuses renderer-empty sessions without a blocking list refresh", () => {
  const newSession =
    sessionSlice.match(/newSession: async [\s\S]*?\n    forkSession: async/)?.[0] ?? "";
  assert.ok(newSession.length > 0, "newSession implementation not found");
  assert.match(newSession, /sessionIsReusableEmpty/);
  assert.match(newSession, /liveMessageCountForSession/);
  assert.doesNotMatch(newSession, /refreshSessions/);
  assert.match(newSession, /persistSessionAndSelect/);
  assert.match(newSession, /pendingNewSessionRequests/);
});

test("creating a session reveals the empty destination before host IO", () => {
  const persist =
    sessionCoordination.match(
      /async function persistSessionAndSelect[\s\S]*?\n  }\n\n  async function materializeDraftSession/,
    )?.[0] ?? "";
  assert.ok(persist.length > 0, "persistSessionAndSelect not found");
  assert.ok(
    persist.indexOf("revealEmptyCreatingSession") <
      persist.indexOf("await api.createSession"),
    "the previous transcript must yield before session.create is awaited",
  );
  assert.doesNotMatch(persist, /refreshSessions/);
  assert.doesNotMatch(persist, /api\.getSession/);
  assert.match(persist, /commitCreatedEmptySession/);
  assert.match(sessionCoordination, /function commitCreatedEmptySession/);
  assert.match(sessionCoordination, /scheduleHomeDraftAdopt/);
  assert.match(persist, /inheritedSessionModelBinding/);
  assert.match(persist, /providerId: inherited\.providerId/);
  assert.match(persist, /modelId: inherited\.modelId/);
  assert.doesNotMatch(persist, /providerId: draftConfig\?\.providerId/);
  assert.doesNotMatch(persist, /modelId: draftConfig\?\.modelId/);
});

test("send and paste wait for an in-flight New Task instead of creating a second session", () => {
  const materialize =
    sessionCoordination.match(
      /async function materializeDraftSession[\s\S]*?\n  }\n\n  return/,
    )?.[0] ?? "";
  assert.match(materialize, /pendingNewSessionRequests/);
  assert.match(materialize, /await pending/);
});

test("opening an unpinned session snapshots its first selected model", () => {
  const select =
    sessionSlice.match(/selectSession: async[\s\S]*?\n    newSession: async/)?.[0] ?? "";
  assert.ok(select.length > 0, "selectSession implementation not found");
  assert.match(select, /sessionNeedsModelPin/);
  assert.match(select, /pinnedSessionModelBinding/);
  assert.match(select, /configureActiveSession/);
  assert.match(select, /api\.configureSession\(id,/);
});


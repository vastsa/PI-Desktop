import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  EMPTY_SESSION_WINDOW,
  sessionIsReusableEmpty,
} from "../src/lib/session-create.ts";

const store = await readFile(
  new URL("../src/stores/app-store.ts", import.meta.url),
  "utf8",
);

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

test("empty sessions have a whole, already-known transcript window", () => {
  assert.deepEqual(EMPTY_SESSION_WINDOW, {
    messageStart: 0,
    hasMoreBefore: false,
  });
});

test("new task reuses renderer-empty sessions without a blocking list refresh", () => {
  const newSession =
    store.match(/newSession: async [\s\S]*?\n  forkSession: async/)?.[0] ?? "";
  assert.ok(newSession.length > 0, "newSession implementation not found");
  assert.match(newSession, /sessionIsReusableEmpty/);
  assert.match(newSession, /liveMessageCountForSession/);
  assert.doesNotMatch(newSession, /refreshSessions/);
  assert.match(newSession, /persistSessionAndSelect/);
  assert.match(newSession, /pendingNewSessionRequests/);
});

test("creating a session reveals the empty destination before host IO", () => {
  const persist =
    store.match(
      /async function persistSessionAndSelect[\s\S]*?\n  return sessionId;\n\}\n/,
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
  assert.match(store, /function commitCreatedEmptySession/);
  assert.match(store, /scheduleHomeDraftAdopt/);
});

test("send and paste wait for an in-flight New Task instead of creating a second session", () => {
  const materialize =
    store.match(
      /export async function materializeDraftSession[\s\S]*?\n\}/,
    )?.[0] ?? "";
  assert.match(materialize, /pendingNewSessionRequests/);
  assert.match(materialize, /await pending/);
});

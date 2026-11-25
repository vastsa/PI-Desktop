import assert from "node:assert/strict";
import test from "node:test";
import {
  getVisibleRecentSessions,
  nextRecentSessionsLimit,
  RECENT_SESSIONS_INITIAL_COUNT,
  RECENT_SESSIONS_PAGE_SIZE,
  selectRecentSessions,
} from "../src/lib/sidebar-recent-sessions.ts";

const at = (minutes) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();

test("recent sessions merge project and temporary chats newest first, without pins", () => {
  const sessions = [
    { id: "project-old", projectPath: "/a", updatedAt: at(1) },
    { id: "temporary-new", projectPath: null, updatedAt: at(9) },
    { id: "project-new", projectPath: "/b", updatedAt: at(5) },
    { id: "pinned", projectPath: "/a", updatedAt: at(10) },
    { id: "undated", projectPath: null },
  ];
  assert.deepEqual(
    selectRecentSessions(sessions, new Set(["pinned"])).map((s) => s.id),
    ["temporary-new", "project-new", "project-old", "undated"],
  );
  assert.deepEqual(sessions[0].id, "project-old", "input order is untouched");
});

test("recent sessions show seven rows, then grow by ten per Load more", () => {
  assert.equal(RECENT_SESSIONS_INITIAL_COUNT, 7);
  assert.equal(RECENT_SESSIONS_PAGE_SIZE, 10);
  const ids = Array.from({ length: 30 }, (_, index) => `s-${index}`);

  let limit = RECENT_SESSIONS_INITIAL_COUNT;
  let page = getVisibleRecentSessions(ids, limit);
  assert.deepEqual(page.visibleSessions, ids.slice(0, 7));
  assert.equal(page.nextPageCount, 10);

  limit = nextRecentSessionsLimit(limit);
  page = getVisibleRecentSessions(ids, limit);
  assert.equal(page.visibleSessions.length, 17);
  assert.equal(page.nextPageCount, 10);

  limit = nextRecentSessionsLimit(nextRecentSessionsLimit(limit));
  page = getVisibleRecentSessions(ids, limit);
  assert.equal(page.visibleSessions.length, 30);
  assert.equal(page.nextPageCount, 0);

  assert.deepEqual(getVisibleRecentSessions(ids.slice(0, 12), 7).nextPageCount, 5);
});

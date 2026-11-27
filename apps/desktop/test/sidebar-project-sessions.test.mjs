import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_VISIBLE_PROJECT_SESSION_COUNT,
  MAX_VISIBLE_PROJECT_SESSION_COUNT,
  MIN_VISIBLE_PROJECT_SESSION_COUNT,
  getVisibleProjectSessions,
  normalizeVisibleProjectSessionCount,
  resolveProjectCollapseAllAction,
  updateProjectSessionExpansion,
} from "../src/lib/sidebar-project-sessions.ts";

test("loading more project sessions resets to the initial page after collapse", () => {
  const projectKey = "/work/demo";
  const otherProjectKey = "/work/other";
  const sessions = Array.from({ length: 12 }, (_, index) => `session-${index + 1}`);
  let expandedByProject = {};

  const initialPage = getVisibleProjectSessions(
    sessions,
    expandedByProject[projectKey] ?? false,
  );
  assert.deepEqual(initialPage.visibleSessions, sessions.slice(0, 10));
  assert.equal(initialPage.hiddenCount, 2);

  expandedByProject = updateProjectSessionExpansion(
    expandedByProject,
    projectKey,
    true,
  );
  expandedByProject = updateProjectSessionExpansion(
    expandedByProject,
    otherProjectKey,
    true,
  );
  const loadedPage = getVisibleProjectSessions(
    sessions,
    expandedByProject[projectKey] ?? false,
  );
  assert.deepEqual(loadedPage.visibleSessions, sessions);
  assert.equal(loadedPage.hiddenCount, 0);

  expandedByProject = updateProjectSessionExpansion(
    expandedByProject,
    projectKey,
    false,
  );
  assert.equal(expandedByProject[projectKey], undefined);
  assert.equal(expandedByProject[otherProjectKey], true);

  const reopenedPage = getVisibleProjectSessions(
    sessions,
    expandedByProject[projectKey] ?? false,
  );
  assert.deepEqual(reopenedPage.visibleSessions, sessions.slice(0, 10));
  assert.equal(
    reopenedPage.hiddenCount,
    sessions.length - DEFAULT_VISIBLE_PROJECT_SESSION_COUNT,
  );
});

test("the visible session count comes from the setting, not a fixed ten", () => {
  const sessions = Array.from({ length: 12 }, (_, index) => `session-${index + 1}`);

  const three = getVisibleProjectSessions(sessions, false, 3);
  assert.deepEqual(three.visibleSessions, sessions.slice(0, 3));
  assert.equal(three.hiddenCount, 9);

  const twenty = getVisibleProjectSessions(
    sessions,
    false,
    MAX_VISIBLE_PROJECT_SESSION_COUNT,
  );
  assert.equal(twenty.visibleSessions.length, sessions.length);
  assert.equal(twenty.hiddenCount, 0);

  // Absent and unusable values fall back to the released default.
  for (const value of [undefined, null, "", 0, 21, -4, 2.5, "many", {}]) {
    assert.equal(
      normalizeVisibleProjectSessionCount(value),
      DEFAULT_VISIBLE_PROJECT_SESSION_COUNT,
      `expected default for ${String(value)}`,
    );
  }
  assert.equal(
    getVisibleProjectSessions(sessions, false, undefined).visibleSessions.length,
    DEFAULT_VISIBLE_PROJECT_SESSION_COUNT,
  );
});

test("the visible session count keeps every accepted value inside its range", () => {
  for (
    let count = MIN_VISIBLE_PROJECT_SESSION_COUNT;
    count <= MAX_VISIBLE_PROJECT_SESSION_COUNT;
    count += 1
  ) {
    assert.equal(normalizeVisibleProjectSessionCount(count), count);
    assert.equal(normalizeVisibleProjectSessionCount(String(count)), count);
  }
});

test("collapse-all folds every group unless they are all already folded", () => {
  // Mixed state resolves to collapse: one open group is enough.
  assert.equal(resolveProjectCollapseAllAction([true, false, true]), "collapse");
  assert.equal(resolveProjectCollapseAllAction([false, false]), "collapse");
  // Everything folded resolves to expand.
  assert.equal(resolveProjectCollapseAllAction([true, true]), "expand");
  assert.equal(resolveProjectCollapseAllAction([true]), "expand");
});

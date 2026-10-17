import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_VISIBLE_PROJECT_SESSION_COUNT,
  getVisibleProjectSessions,
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

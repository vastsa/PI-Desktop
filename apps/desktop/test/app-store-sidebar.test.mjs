import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const storeSource = await readFile(
  new URL("../src/stores/app-store.ts", import.meta.url),
  "utf8",
);
const sidebarSource = await readFile(
  new URL("../src/components/Sidebar.tsx", import.meta.url),
  "utf8",
);

test("project activation separates visible transcript state from background run state", () => {
  const activationBlock = storeSource.match(
    /activateProject: async[\s\S]*?openProjectPath:/,
  )?.[0] ?? "";
  assert.match(activationBlock, /switchesVisibleProject[\s\S]*activeSessionId: undefined/);
  assert.match(activationBlock, /switchesVisibleProject[\s\S]*messages: \[\]/);
  assert.match(activationBlock, /switchesVisibleProject[\s\S]*isRunning: false/);
  assert.doesNotMatch(
    activationBlock,
    /runningSessions:\s*\{\}/,
  );
  assert.doesNotMatch(activationBlock, /pendingPermissions:\s*\{\}/);
});

test("closed projects are not recreated from historical sidebar sessions", () => {
  assert.doesNotMatch(sidebarSource, /add\(session\.projectPath\)/);
  assert.match(sidebarSource, /const entry = byPath\.get\(sessionPath\)/);
  assert.match(sidebarSource, /if \(entry\) entry\.sessions\.push\(session\)/);
});

test("project new-session creation uses one store-owned navigation transaction", () => {
  assert.match(
    sidebarSource,
    /const createProjectSession[\s\S]*createSession\(\{ projectPath: path \}\)/,
  );
  assert.doesNotMatch(
    sidebarSource,
    /const createProjectSession[\s\S]*selectProject\(path\)/,
  );
});

test("durable empty sessions render and title heuristics do not filter them", () => {
  assert.doesNotMatch(
    sidebarSource,
    /candidates\.filter\(\(session\) => !isDefaultSessionTitle\(session\.title\)\)/,
  );
  assert.match(storeSource, /latestSessionInScope/);
  assert.match(storeSource, /sessionIsReusableEmpty/);
  assert.match(storeSource, /pendingNewSessionRequests/);
  assert.doesNotMatch(sidebarSource, /keptEmptyScopes/);
});

test("project title toggles its conversation group without forcing it open", () => {
  const projectTitleBlock = sidebarSource.match(
    /className="sidebar-session-group-title project-toggle"[\s\S]*?<IconFolder/,
  )?.[0] ?? "";
  assert.match(projectTitleBlock, /aria-expanded=\{!collapsedProject\}/);
  assert.match(projectTitleBlock, /data-action="toggle-project-collapse"/);
  assert.match(projectTitleBlock, /sidebar-disclosure-icon/);
  assert.match(projectTitleBlock, /setCollapsed\(entry\.path, !collapsedProject\)/);
  assert.doesNotMatch(projectTitleBlock, /setCollapsed\(entry\.path, false\)/);
  assert.doesNotMatch(sidebarSource, /className="project-collapse-toggle"/);
});

test("expanded sidebar search opens the global search surface", () => {
  const searchButtonBlock = sidebarSource.match(
    /aria-label=\{t\("nav\.search"\)\}[\s\S]*?<\/button>/,
  )?.[0] ?? "";
  assert.match(searchButtonBlock, /onOpenSearch/);
  assert.doesNotMatch(sidebarSource, /sidebar-session-search|toggleSearch/);
});

test("manual ordering stays a persistence-only compatibility value", () => {
  assert.doesNotMatch(sidebarSource, /data-sort=["']manual["']/);
  for (const value of ["recent", "created", "oldest", "name"]) {
    assert.match(sidebarSource, new RegExp(`"${value}"`));
  }
});

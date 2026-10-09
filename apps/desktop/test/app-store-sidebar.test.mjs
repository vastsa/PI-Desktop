import { readStoreSource, readStoreModule } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const storeSource = await readStoreSource();
const projectSliceSource = await readStoreModule("slices/project-slice.ts");
const sidebarSource = await readFile(
  new URL("../src/components/Sidebar.tsx", import.meta.url),
  "utf8",
);
const hoverSource = await readFile(
  new URL("../src/features/sessions/SessionHoverCard.tsx", import.meta.url),
  "utf8",
);
const topbarSource = await readFile(
  new URL("../src/components/ConversationTopbar.tsx", import.meta.url),
  "utf8",
);
const stylesSource = await readFile(
  new URL("../src/styles/chrome.css", import.meta.url),
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

test("sidebar hover refreshes the active project branch without activating a project", () => {
  const refreshBlock = projectSliceSource.match(
    /refreshProject: async[\s\S]*?\n    openProjectPath:/,
  )?.[0] ?? "";
  assert.match(refreshBlock, /api\.getProject\(\)/);
  assert.match(refreshBlock, /normalizeProjectPath\(workspace\.path\) !== requestedKey/);
  assert.match(refreshBlock, /normalizeProjectPath\(state\.activeProjectPath\) !== requestedKey/);
  assert.match(refreshBlock, /openProjects: upsertWorkspace\(state\.openProjects, workspace\)/);

  assert.match(hoverSource, /refreshProject\(session\.projectPath \?\? ""\)/);
  assert.match(hoverSource, /current && target\.isConnected && workspace/);
  assert.match(hoverSource, /setProject\(\{ space: workspace\.name, branch: workspace\.branch \}\)/);
  assert.match(sidebarSource, /branch: entry\?\.branch/);
  assert.match(sidebarSource, /for \(const entry of projectEntries\) map\.set\(entry\.key, entry\)/);
  assert.match(sidebarSource, /projectEntriesByPath\.get\(normalizedProjectPath \?\? ""\)/);
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

test("global search stays on the conversation topbar, not the sidebar header", () => {
  assert.doesNotMatch(sidebarSource, /onOpenSearch|IconSearch|nav\.search/);
  assert.doesNotMatch(sidebarSource, /sidebar-session-search|toggleSearch/);
  assert.match(topbarSource, /onOpenSearch/);
  assert.match(topbarSource, /<IconSearch/);
  assert.match(topbarSource, /ariaLabel=\{t\("nav\.search"\)\}/);
});

test("conversation topbar shows and refreshes the active project's git branch", () => {
  assert.match(topbarSource, /const branch = workspace\?\.branch\?\.trim\(\)/);
  assert.match(topbarSource, /refreshProject\(projectPath\)/);
  assert.match(topbarSource, /window\.addEventListener\("focus", refreshBranch\)/);
  assert.match(topbarSource, /className="ct-branch"/);
  assert.match(topbarSource, /hoverCardBranchAria/);
  assert.match(topbarSource, /<IconBranch/);
  assert.match(stylesSource, /\.conversation-topbar \.ct-branch\s*\{/);
  assert.match(stylesSource, /text-overflow:\s*ellipsis/);
});

test("project rows expose press-and-move title drag and keyboard reorder behavior", () => {
  assert.doesNotMatch(sidebarSource, /sidebar-project-drag-handle/);
  assert.doesNotMatch(sidebarSource, /IconGripVertical/);
  assert.doesNotMatch(sidebarSource, /PROJECT_DRAG_MIME/);
  assert.doesNotMatch(sidebarSource, /PROJECT_REORDER_LONG_PRESS_MS/);
  assert.match(sidebarSource, /projectReorderShouldArm/);
  assert.match(sidebarSource, /beginProjectReorderPress\(event, entry\.key\)/);
  assert.match(sidebarSource, /onKeyDown=\{\(event\) => moveProjectWithKeyboard/);
  assert.match(sidebarSource, /aria-grabbed=\{draggingProjectKey === entry.key\}/);
  assert.match(sidebarSource, /className="sidebar-session-group-title project-toggle"/);
  assert.match(sidebarSource, /is-drop-before/);
  assert.match(storeSource, /reorderProjects: \(paths\) =>/);
  assert.match(storeSource, /projectSort: "manual"/);
  assert.match(storeSource, /persistCurrentSidebar\(get\)/);
});

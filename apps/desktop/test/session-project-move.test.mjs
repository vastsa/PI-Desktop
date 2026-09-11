import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const protocol = read("../../../packages/shared/src/protocol.ts");
const sessions = read("../../../crates/host-core/src/sessions.rs");
const rpc = read("../../../crates/host-core/src/rpc/mod.rs");
const main = read("../electron/main/index.ts");
const mcpControl = read("../electron/main/mcp-control.ts");
const api = read("../src/lib/api.ts");
const store = read("../src/stores/app-store.ts");
const sidebar = read("../src/components/Sidebar.tsx");
const sidebarPreferences = read("../src/lib/sidebar-preferences.ts");
const composer = read("../src/components/Composer.tsx");
const sessionsCss = read("../src/styles/sessions.css");
const composerCss = read("../src/styles/composer.css");

test("session project move is a durable host command, not a renderer-only regroup", () => {
  assert.match(protocol, /sessionMoveProject:\s*"pi-desktop\/session\/moveProject"/);
  assert.match(rpc, /"session\.moveProject" =>/);
  assert.match(rpc, /sessions::move_session_project\(&st\.db, session_id, project_path\)/);
  assert.match(rpc, /MoveSessionProjectResult::NotFound =>[\s\S]*?NOT_FOUND/);
  assert.match(rpc, /MoveSessionProjectResult::Busy =>[\s\S]*?CONFLICT/);

  const moveBlock = sessions.match(
    /pub fn move_session_project\([\s\S]*?\n\}\n/,
  )?.[0] ?? "";
  assert.match(moveBlock, /SELECT EXISTS\([\s\S]*?status = 'running'/);
  assert.match(moveBlock, /db\.ensure_project\(project_path, false\)/);
  assert.match(
    moveBlock,
    /UPDATE sessions SET project_id = \?1, updated_at = \?2 WHERE id = \?3/,
  );
  // Only the project association and activity stamp change: the transcript,
  // revisions, artifacts, and scratch data belong to the session.
  assert.doesNotMatch(moveBlock, /DELETE FROM/);
  assert.doesNotMatch(moveBlock, /transcripts::/);
});

test("moving a running session is rejected in Electron and in the host", () => {
  const handler = main.match(
    /IPC\.invoke\.sessionMoveProject,[\s\S]*?\n  \);\n/,
  )?.[0] ?? "";
  assert.match(handler, /activeTurns\.has\(sessionId\)/);
  assert.match(handler, /errorCode: ErrorCodes\.AGENT_BUSY/);
  assert.match(handler, /errorCode: ErrorCodes\.INVALID_ARGUMENT/);
  assert.match(handler, /host\.call\("session\.moveProject", \{ sessionId, projectPath \}\)/);
  assert.match(handler, /error\?\.data\?\.errorCode === ErrorCodes\.CONFLICT/);
});

test("a successful move rebinds the live agent to the new project", () => {
  const handler = main.match(
    /IPC\.invoke\.sessionMoveProject,[\s\S]*?\n  \);\n/,
  )?.[0] ?? "";
  assert.match(handler, /sessionProjects\.set\(sessionId, movedProjectPath\)/);
  assert.match(handler, /sidecar\.clearProjectInstructionRoot\(sessionId\)/);
  assert.match(handler, /sidecar\.clearVendorAuthBindings\(sessionId\)/);
  assert.match(handler, /sidecar\s*\n?\s*\.call\("agent\.disposeSession", \{ sessionId \}\)/);
  assert.match(handler, /sidecar\.setProjectInstructionRoot\(sessionId, movedProjectPath\)/);
  assert.match(mcpControl, /spec\("sessionMoveProject", "session\/moveProject"/);
});

test("renderer api and store expose one guarded move action", () => {
  assert.match(
    api,
    /moveSessionProject:\s*\(sessionId: string, projectPath: string\)/,
  );
  assert.match(api, /IPC\.invoke\.sessionMoveProject/);
  assert.match(
    store,
    /moveSessionProject: \(id: string, projectPath: string\) => Promise<boolean>;/,
  );

  const storeBlock = store.match(/moveSessionProject: async \(id, projectPath\)[\s\S]*?\n  \},\n/)?.[0] ?? "";
  assert.match(storeBlock, /state\.runningSessions\[id\]/);
  assert.match(storeBlock, /state\.openProjectPaths\.some/);
  assert.match(storeBlock, /await api\.moveSessionProject\(id, projectPath\)/);
});

test("sidebar sessions drag onto project groups and offer a menu fallback", () => {
  assert.match(sidebar, /const SESSION_DRAG_MIME = "application\/x-pi-desktop-session";/);
  assert.match(sidebar, /draggable=\{!running\}/);
  assert.match(sidebar, /beginSessionDrag\(event, session\.id\)/);
  assert.match(sidebar, /onDragEnd=\{endSessionDrag\}/);
  assert.match(sidebar, /is-dragging/);
  assert.match(sidebar, /onProjectDropTargetOver\(event, entry\)/);
  assert.match(sidebar, /onProjectDropTargetDrop\(event, entry\)/);
  // The transfer payload is authoritative: a stale dragging id must never
  // move a session the user did not drag.
  assert.match(sidebar, /sessionIdFromDrag\(event\.dataTransfer\)/);
  assert.match(sidebar, /dropProjectKey === entry\.key \? "is-drop-target" : ""/);
  assert.match(sidebar, /data-action="move-session-to-project"/);
  assert.match(sidebar, /nav\.moveToProject/);
  assert.match(sidebar, /disabled=\{Boolean\(runningSessions\[session\.id\]\)\}/);
  // A drag inside the same project group must not offer itself as a target.
  assert.match(
    sidebar,
    /item\.key !== normalizeProjectPath\(session\.projectPath\)/,
  );
});

test("dropping a folder on the projects list adds or switches that project", () => {
  assert.match(sidebar, /onDragOver=\{onProjectsAreaDragOver\}/);
  assert.match(sidebar, /onDrop=\{onProjectsAreaDrop\}/);
  const dropBlock = sidebar.match(
    /const onProjectsAreaDrop = async[\s\S]*?\n  \};\n/,
  )?.[0] ?? "";
  assert.match(dropBlock, /composerDropItems\(event\.dataTransfer, api\.getDroppedFilePath\)/);
  assert.match(dropBlock, /item\.isDirectory/);
  assert.match(dropBlock, /await activateProject\(directory\.path!\)/);
  assert.match(dropBlock, /nav\.dropFolderToAddProject/);
  assert.match(sessionsCss, /\.project-group\.is-drop-target\s*\{[\s\S]*?outline:/);
  assert.match(sessionsCss, /\.thread-item\.is-dragging\s*\{[\s\S]*?opacity: 0\.5/);
});

test("a composer folder drop asks for an explicit project decision", () => {
  const dropBlock = composer.match(
    /const onComposerDrop = \([\s\S]*?\n  \};\n/,
  )?.[0] ?? "";
  assert.match(dropBlock, /const directories = items\.filter\(\(item\) => item\.isDirectory\)/);
  assert.match(dropBlock, /const files = items\.filter\(\(item\) => !item\.isDirectory\)/);
  // Files attach; directories are held for a decision, never attached blindly.
  assert.match(dropBlock, /if \(directories\.length\) setDroppedDirectories\(directories\)/);
  assert.match(dropBlock, /if \(files\.length\) void attachDroppedItems\(files\)/);
  assert.doesNotMatch(dropBlock, /attachDroppedItems\(items\)/);
  assert.match(composer, /data-action="open-dropped-folder-project"/);
  assert.match(composer, /data-action="reference-dropped-folder"/);
  assert.match(composer, /activateProject\(directory\.path\)/);
  assert.match(composer, /void attachDroppedItems\(directories\)/);
  assert.match(composerCss, /\.composer-directory-drop\s*\{/);
});

test("new drag/drop copy ships in the reviewed locales", () => {
  const en = read("../../../packages/i18n/src/locales/en/index.ts");
  const zhCN = read("../../../packages/i18n/src/locales/zh-CN/index.ts");
  const zhTW = read("../../../packages/i18n/src/locales/zh-TW/index.ts");

  for (const source of [en, zhCN, zhTW]) {
    for (const key of [
      "moveToProject",
      "sessionMoved",
      "moveRunningSessionBlocked",
      "moveSessionUnavailable",
      "dropFolderToAddProject",
      "dismissFolderDrop",
      "droppedFolder",
      "openAsProject",
      "referenceFolder",
    ]) {
      assert.match(source, new RegExp(`${key}:`));
    }
  }
  assert.match(en, /moveToProject: "Move to project"/);
  assert.match(zhCN, /moveToProject: "移动到项目"/);
});

test("drag state cannot outlive the dragged row or trust a stale id", () => {
  // A row can unmount mid-drag (sort refresh, archive, delete) before its own
  // dragend fires, so the drag session is also cleared from the window.
  assert.match(sidebar, /window\.addEventListener\("dragend", clearDragState\)/);
  assert.match(sidebar, /window\.addEventListener\("drop", clearDragState, true\)/);

  const overBlock = sidebar.match(
    /const onProjectDropTargetOver = \([\s\S]*?\n  \};\n/,
  )?.[0] ?? "";
  const dropBlock = sidebar.match(
    /const onProjectDropTargetDrop = \([\s\S]*?\n  \};\n/,
  )?.[0] ?? "";
  // The transfer payload wins over renderer state in both directions, and an
  // unknown id is dropped rather than moving a session the user never dragged.
  assert.match(overBlock, /const sessionId = sessionIdForDragOver\(event\.dataTransfer, draggingSessionId\);/);
  assert.match(dropBlock, /const sessionId = sessionIdFromDrag\(event\.dataTransfer\);/);
  assert.match(sidebar, /Array\.from\(dataTransfer\.types\)\.includes\(SESSION_DRAG_MIME\)/);
  assert.doesNotMatch(sidebar, /sessionIdFromDrag\(event\.dataTransfer\) \?\? draggingSessionId/);
  assert.match(dropBlock, /if \(!dragged\) return;/);
  // A drop without a session payload belongs to the native folder handler.
  assert.match(dropBlock, /const dragged = sessionId/);
  assert.match(
    sidebar,
    /onDragLeave=\{\(event\) => \{[\s\S]*?event\.currentTarget\.contains\(relatedTarget\)/,
  );
});

test("session move and prompt setup share a per-session critical section", () => {
  assert.match(main, /const sessionOperationTails = new Map<string, Promise<void>>\(\)/);
  assert.match(main, /async function acquireSessionOperation\(sessionId: string\)/);
  const moveHandler = main.match(
    /IPC\.invoke\.sessionMoveProject,[\s\S]*?\n  \);\n/,
  )?.[0] ?? "";
  assert.match(moveHandler, /acquireSessionOperation\(sessionId\)/);
  assert.match(moveHandler, /finally \{[\s\S]*?releaseSessionOperation\(\)/);
  const promptHandler = main.match(
    /handle\(IPC\.invoke\.agentPrompt,[\s\S]*?\n  \}\);\n\n  handle\(IPC\.invoke\.agentCompact/,
  )?.[0] ?? "";
  assert.match(promptHandler, /acquireSessionOperation\(req\.sessionId\)/);
  assert.match(promptHandler, /finally \{[\s\S]*?releaseSessionOperation\(\)/);
  const planDispatch = main.match(
    /async function dispatchApprovedPlan\([\s\S]*?\n\}\n\nasync function drainApprovedPlanExecutions/,
  )?.[0] ?? "";
  assert.match(planDispatch, /acquireSessionOperation\(initial\.sessionId\)/);
  assert.match(sidebar, /window\.addEventListener\("dragend", clearDragState\)/);
});

test("drag ordering keeps priority buckets and rejects malformed ranks", () => {
  // Project reordering moved from HTML5 drag events to a long-press pointer
  // flow; the bucket guard now lives in sidebar-project-reorder.ts.
  const reorderLib = read("../src/lib/sidebar-project-reorder.ts");
  assert.match(reorderLib, /Boolean\(source\.archived\) === Boolean\(target\.archived\)/);
  assert.match(reorderLib, /Boolean\(source\.pinned\) === Boolean\(target\.pinned\)/);
  assert.match(sidebar, /projectReorderShouldArm\(/);
  assert.match(sidebar, /sameProjectReorderBucket\(source\.meta, destination\.meta\)/);
  assert.match(sidebarPreferences, /Number\.isSafeInteger\(value\)/);
  assert.match(sidebarPreferences, /manualOrder\(meta\[ak\]\?\.order\)/);
});

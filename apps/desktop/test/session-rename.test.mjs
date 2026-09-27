import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [sidebarSource, projectsSource, dialogSource, storeSource, apiSource, hostSource, rpcSource, styles] =
  await Promise.all([
    read("../src/components/Sidebar.tsx"),
    read("../src/pages/ProjectsPage.tsx"),
    read("../src/components/SessionRenameDialog.tsx"),
    read("../src/stores/app-store.ts"),
    read("../src/lib/api.ts"),
    read("../../../crates/host-core/src/sessions.rs"),
    read("../../../crates/host-core/src/rpc/mod.rs"),
    loadStyles(),
  ]);

test("session rename is available from sidebar and project archive task rows", () => {
  assert.match(sidebarSource, /data-action="rename-session"/);
  assert.match(sidebarSource, /setRenameFor\(session\)/);
  assert.match(projectsSource, /projects-detail-task-rename/);
  assert.match(projectsSource, /setRenameFor\(s\)/);
  assert.match(projectsSource, /onContextMenu=/);
  assert.match(styles, /\.projects-detail-task-row\s*\{/);
});

test("rename dialog is modal, localized, and caps input by Unicode code points", () => {
  assert.match(dialogSource, /role="dialog"/);
  assert.match(dialogSource, /aria-modal="true"/);
  assert.match(dialogSource, /event\.key === "Escape"/);
  assert.match(dialogSource, /querySelectorAll<HTMLElement>\(/);
  assert.match(dialogSource, /draft\.trim\(\)/);
  assert.match(dialogSource, /Array\.from\(event\.target\.value\)/);
  assert.match(dialogSource, /MAX_SESSION_TITLE_LENGTH/);
  assert.match(dialogSource, /t\("session\.renameSave"\)/);
  assert.match(styles, /\.session-rename-dialog-overlay\s*\{[^}]*z-index:\s*65;/s);
});

test("rename uses the existing IPC bridge and updates only the local session title", () => {
  assert.match(apiSource, /invoke<\{ ok: boolean \}>\(IPC\.invoke\.sessionRename, id, title\)/);
  assert.match(storeSource, /renameSession: \(id: string, title: string\) => Promise<void>/);
  assert.match(storeSource, /const nextTitle = title\.trim\(\)/);
  assert.match(storeSource, /sessions: state\.sessions\.map\(/);
  assert.match(storeSource, /session\.id === id \? \{ \.\.\.session, title: nextTitle \}/);
  assert.match(rpcSource, /normalize_session_title\(title\)/);
  assert.match(rpcSource, /"INVALID_PARAMS"/);
});

test("host title validation is bounded and does not change activity ordering", () => {
  assert.match(hostSource, /MAX_SESSION_TITLE_CHARS: usize = 80/);
  assert.match(hostSource, /let title = title\.trim\(\)/);
  assert.match(hostSource, /title\.chars\(\)\.count\(\) > MAX_SESSION_TITLE_CHARS/);
  assert.match(hostSource, /UPDATE sessions SET title = \?1 WHERE id = \?2/);
  assert.doesNotMatch(hostSource, /UPDATE sessions SET title = \?1, updated_at = \?2 WHERE id = \?3/);
  assert.match(hostSource, /rename_session_normalizes_title_without_touching_activity/);
});

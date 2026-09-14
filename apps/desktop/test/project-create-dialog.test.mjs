import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readMainSource } from "./helpers/main-source.mjs";
import { readStoreSource } from "./helpers/store-source.mjs";

const read = (relativePath) => readFile(new URL(relativePath, import.meta.url), "utf8");

const [dialog, store, api, protocol, main, styles] = await Promise.all([
  read("../src/components/ProjectCreateDialog.tsx"),
  readStoreSource(),
  read("../src/lib/api.ts"),
  read("../../../packages/shared/src/protocol.ts"),
  readMainSource(),
  read("../src/styles/project-create-dialog.css"),
]);

test("create project dialog supports named multi-folder setup", () => {
  assert.match(dialog, /role="dialog"/);
  assert.doesNotMatch(dialog, /project\.createNamePlaceholder/);
  assert.match(dialog, /api\.pickProjectFolders\(\)/);
  assert.match(dialog, /result\.folders/);
  assert.match(dialog, /project\.createRemoveFolder/);
  assert.match(dialog, /project\.createPrimary/);
  assert.match(dialog, /data-project-source="local"/);
  assert.doesNotMatch(dialog, /project\.createMemoryHint/);
  assert.doesNotMatch(dialog, /project\.createAddFolderHint/);
  assert.doesNotMatch(dialog, /aria-describedby="project-create-memory-hint"/);
  assert.match(dialog, /project-create-dialog-content/);
  assert.match(dialog, /project-create-dialog-section/);
  assert.match(dialog, /project-create-dialog-field-label/);
  assert.match(dialog, /disabled=\{!name\.trim\(\) \|\| folders\.length === 0 \|\| busy\}/);
  assert.match(dialog, /querySelectorAll<HTMLElement>\(/);
});

test("project creation creates one logical group with a primary workspace", () => {
  assert.match(store, /createProjectDialogOpen: boolean/);
  assert.match(store, /openProject: async \(\) => \{\s*set\(\{ createProjectDialogOpen: true \}\)/);
  assert.match(store, /createProjectFromFolders: async \(\{ name, folders, primaryPath \}\)/);
  assert.match(store, /const orderedFolders = \[/);
  assert.match(store, /api\.createProjectGroup\(normalizedName, orderedFolders\)/);
  assert.match(store, /created\.group\.primaryPath/);
  assert.doesNotMatch(store, /for \(const path of orderedFolders\)/);
  assert.match(store, /get\(\)\.renameProject\(groupPrimary, normalizedName\)/);
  assert.match(store, /set\(\{ createProjectDialogOpen: false, onboarding, page: "chat" \}\)/);
});

test("folder picker is a renderer-only multi-directory selection", () => {
  assert.match(protocol, /projectPickFolders:\s*"pi-desktop\/project\/pickFolders"/);
  assert.match(protocol, /projectGroupCreate:\s*"pi-desktop\/project-group\/create"/);
  assert.match(api, /createProjectGroup: \(name: string, folders: string\[\]\)/);
  assert.match(main, /project\.group\.create/);
  assert.match(api, /pickProjectFolders: \(\) =>[\s\S]*?projectPickFolders/);
  const start = main.indexOf("IPC.invoke.projectPickFolders");
  const end = main.indexOf("IPC.invoke.projectClone", start);
  const handler = main.slice(start, end);
  assert.ok(start >= 0 && end > start, "folder picker handler should exist");
  assert.match(handler, /openDirectory/);
  assert.match(handler, /multiSelections/);
  assert.match(handler, /createDirectory/);
  assert.match(handler, /folders:/);
  assert.doesNotMatch(handler, /workspace\.set/);
});

test("create project dialog remains usable on narrow screens and reduced motion", () => {
  assert.match(styles, /width: min\(100%, 480px\)/);
  assert.match(styles, /border-radius: var\(--radius-lg-plus\)/);
  assert.match(styles, /font-size: var\(--text-lg\)/);
  assert.match(styles, /font-size: var\(--text-base\)/);
  assert.match(styles, /gap: 16px/);
  assert.match(styles, /padding: 14px 18px 18px/);
  assert.match(styles, /@media \(max-width: 520px\)/);
  assert.match(styles, /align-items: flex-end/);
  assert.match(styles, /min-height: 48px/);
  assert.match(styles, /project-create-dialog-actions/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /overflow-y: auto/);
});

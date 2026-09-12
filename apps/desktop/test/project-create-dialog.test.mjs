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
  assert.match(dialog, /project\.createNamePlaceholder/);
  assert.match(dialog, /api\.pickProjectFolders\(\)/);
  assert.match(dialog, /result\.folders/);
  assert.match(dialog, /project\.createRemoveFolder/);
  assert.match(dialog, /project\.createPrimary/);
  assert.match(dialog, /project\.createMemoryHint/);
  assert.match(dialog, /project-create-dialog-field-label/);
  assert.match(dialog, /disabled=\{!name\.trim\(\) \|\| folders\.length === 0 \|\| busy\}/);
  assert.match(dialog, /querySelectorAll<HTMLElement>\(/);
});

test("project creation keeps one primary workspace and retains additional folders", () => {
  assert.match(store, /createProjectDialogOpen: boolean/);
  assert.match(store, /openProject: async \(\) => \{\s*set\(\{ createProjectDialogOpen: true \}\)/);
  assert.match(store, /createProjectFromFolders: async \(\{ name, folders, primaryPath \}\)/);
  assert.match(store, /const orderedFolders = \[/);
  assert.match(store, /for \(const path of orderedFolders\)/);
  assert.match(store, /get\(\)\.renameProject\(primary, normalizedName\)/);
  assert.match(store, /set\(\{ createProjectDialogOpen: false, onboarding, page: "chat" \}\)/);
});

test("folder picker is a renderer-only multi-directory selection", () => {
  assert.match(protocol, /projectPickFolders:\s*"pi-desktop\/project\/pickFolders"/);
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
  assert.match(styles, /@media \(max-width: 520px\)/);
  assert.match(styles, /align-items: flex-end/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /overflow-y: auto/);
});

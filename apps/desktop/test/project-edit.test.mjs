import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [sidebarSource, projectsSource, dialogSource, apiSource, protocolSource, hostSource, enSource, zhSource, trSource] =
  await Promise.all([
    read("../src/components/Sidebar.tsx"),
    read("../src/pages/ProjectsPage.tsx"),
    read("../src/components/ProjectEditDialog.tsx"),
    read("../src/lib/api.ts"),
    read("../../../packages/shared/src/protocol.ts"),
    read("../../../crates/host-core/src/rpc/mod.rs"),
    read("../../../packages/i18n/src/locales/en/index.ts"),
    read("../../../packages/i18n/src/locales/zh-CN/index.ts"),
    read("../../../packages/i18n/src/locales/tr/index.ts"),
  ]);

test("project rows expose an edit action in both project surfaces", () => {
  assert.match(sidebarSource, /data-action="edit-project"/);
  assert.match(sidebarSource, /setEditProjectFor\(entry\)/);
  assert.match(sidebarSource, /ProjectEditDialog/);
  assert.match(projectsSource, /data-action="edit-project"/);
  assert.match(projectsSource, /setEditProjectFor\(\{\s*path: project\.path/);
  assert.match(projectsSource, /roots: project\.roots/);
  assert.match(projectsSource, /ProjectEditDialog/);
});

test("project edit dialog updates names and adjusts folder roots", () => {
  assert.match(dialogSource, /export function ProjectEditDialog/);
  assert.match(dialogSource, /listProjectGroups\(\)/);
  assert.match(dialogSource, /api\.updateProjectGroup\(group\.id, trimmedName, folders\)/);
  assert.match(dialogSource, /api\.pickProjectFolders\(\)/);
  assert.match(dialogSource, /setFolders\(\(current\) =>[\s\S]*?current\.filter/);
  assert.match(dialogSource, /busy \|\| primary/);
  assert.match(dialogSource, /project\.editPrimaryLocked/);
  assert.match(dialogSource, /aria-modal="true"/);
  assert.match(dialogSource, /event\.key === "Escape"/);
});

test("project group update is available through the host RPC and preload API", () => {
  assert.match(protocolSource, /projectGroupUpdate:\s*"pi-desktop\/project-group\/update"/);
  assert.match(apiSource, /updateProjectGroup: \(groupId: string, name: string, folders: string\[\]\)/);
  assert.match(hostSource, /"project\.group\.update"/);
  assert.match(hostSource, /update_project_group\(group_id, name, &folders\)/);
});

for (const [locale, source] of [["en", enSource], ["zh-CN", zhSource], ["tr", trSource]]) {
  test(`project edit labels are present in ${locale}`, () => {
    for (const key of [
      "edit",
      "editTitle",
      "editDescription",
      "editAction",
      "editSaving",
      "editCancel",
      "editPrimaryLocked",
    ]) {
      assert.match(source, new RegExp(`(?:\\b${key}|"${key}"):`));
    }
  });
}

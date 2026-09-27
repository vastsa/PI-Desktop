import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [sidebarSource, projectsSource, dialogSource, enSource, zhSource, trSource] =
  await Promise.all([
    read("../src/components/Sidebar.tsx"),
    read("../src/pages/ProjectsPage.tsx"),
    read("../src/components/SessionRenameDialog.tsx"),
    read("../../../packages/i18n/src/locales/en/index.ts"),
    read("../../../packages/i18n/src/locales/zh-CN/index.ts"),
    read("../../../packages/i18n/src/locales/tr/index.ts"),
  ]);

test("project rows expose a rename action in both project surfaces", () => {
  assert.match(sidebarSource, /data-action="rename-project"/);
  assert.match(sidebarSource, /setRenameProjectFor\(entry\)/);
  assert.match(sidebarSource, /renameProject\(entry\.path, name\)/);
  assert.match(projectsSource, /data-action="rename-project"/);
  assert.match(projectsSource, /setRenameProjectFor\(\{\s*path: project\.path/);
  assert.match(projectsSource, /projectMeta\[normalizeProjectPath\(project\.path\)/);
});

test("project rename reuses the accessible, bounded rename dialog", () => {
  assert.match(dialogSource, /export function ProjectRenameDialog/);
  assert.match(dialogSource, /maxLength=\{MAX_PROJECT_NAME_CHARS\}/);
  assert.match(dialogSource, /aria-modal="true"/);
  assert.match(dialogSource, /event\.key === "Escape"/);
  assert.match(dialogSource, /Array\.from\(event\.target\.value\)/);
  assert.match(dialogSource, /dialogId="project-rename-dialog"/);
});

for (const [locale, source] of [["en", enSource], ["zh-CN", zhSource], ["tr", trSource]]) {
  test(`project rename labels are present in ${locale}`, () => {
    for (const key of [
      "rename",
      "renameTitle",
      "renameDescription",
      "renameLabel",
      "renameHint",
      "renameCancel",
      "renameSave",
      "renameSaving",
    ]) {
      assert.match(source, new RegExp(`\\b${key}:`));
    }
  });
}

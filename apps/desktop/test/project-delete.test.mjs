import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const LOCALE_IDS = ["en", "zh-CN", "zh-TW", "de", "es", "fr", "ko", "tr"];

/** Every catalog key the delete-project flow adds to `project`. */
const DELETE_KEYS = [
  "delete",
  "deleteTitle",
  "deleteDescription",
  "deleteSessions_one",
  "deleteSessions_other",
  "deleteFolderKept",
  "deleteRunningBlocked",
  "deleteConfirm",
  "deleteCancel",
  "deleting",
  "deleted",
];

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [dialogSource, projectsSource, sidebarSource, ...localeSources] = await Promise.all([
  read("../src/components/ProjectDeleteDialog.tsx"),
  read("../src/pages/ProjectsPage.tsx"),
  read("../src/components/Sidebar.tsx"),
  ...LOCALE_IDS.map((id) => read(`../../../packages/i18n/src/locales/${id}/index.ts`)),
]);

const catalogs = new Map(LOCALE_IDS.map((id, index) => [id, localeSources[index]]));

function placeholders(value) {
  return [...value.matchAll(/{{\s*([^},\s]+)[^}]*}}|{([A-Za-z_][A-Za-z0-9_]*)}/g)]
    .map((match) => match[1] ?? match[2])
    .sort();
}

/**
 * Only the `project` block: `delete` and `deleteTitle` also exist in other
 * blocks of the same catalog, so a file-wide lookup would match the wrong key.
 */
function projectBlock(source) {
  const start = source.search(/^  "?project"?: \{/m);
  assert.ok(start >= 0, "project block starts");
  const rest = source.slice(start + 1);
  const end = rest.search(/^  "?pulls"?: \{/m);
  assert.ok(end > 0, "project block ends");
  return rest.slice(0, end);
}

function projectValue(block, key) {
  const match = block.match(new RegExp(`^    "?${key}"?:\\s*"([^"]*)"`, "m"));
  assert.ok(match, `${key} is defined in the project block`);
  return match[1];
}

/**
 * The delete menu item from its action attribute to the end of its opening
 * tag, so a guard inside that handler is checked without matching sibling
 * menus of the same surface.
 */
function deleteHandler(source) {
  const start = source.indexOf('data-action="delete-project"');
  assert.ok(start >= 0, "the delete action is present");
  const rest = source.slice(start);
  const end = rest.search(/\n\s+>\n/);
  assert.ok(end > 0, "the delete action button closes");
  return rest.slice(0, end);
}

test("the delete dialog is a real confirmation backed by the store action", () => {
  assert.match(dialogSource, /export function ProjectDeleteDialog/);
  assert.match(dialogSource, /const deleteProject = useAppStore\(\(s\) => s\.deleteProject\)/);
  assert.match(dialogSource, /await deleteProject\(project\.path\)/);
  assert.match(dialogSource, /onDeleted/);
  assert.match(dialogSource, /onError\(error\)/);
});

test("the delete dialog names the sessions and keeps the folder on disk", () => {
  assert.match(dialogSource, /t\("project\.deleteSessions", \{ count: project\.sessionCount \}\)/);
  assert.match(dialogSource, /t\("project\.deleteDescription", \{ name: project\.name \}\)/);
  assert.match(dialogSource, /t\("project\.deleteFolderKept"\)/);
  assert.match(dialogSource, /createPortal\(dialog, document\.body\)/);
});

test("the delete dialog is a labelled modal that blocks cancel while busy", () => {
  assert.match(dialogSource, /role="dialog"/);
  assert.match(dialogSource, /aria-labelledby="project-delete-dialog-title"/);
  assert.match(dialogSource, /id="project-delete-dialog-title"/);
  assert.match(dialogSource, /aria-describedby="project-delete-dialog-description/);
  for (const id of [
    "project-delete-dialog-description",
    "project-delete-dialog-sessions",
    "project-delete-dialog-folder-kept",
  ]) {
    assert.match(dialogSource, new RegExp(`id="${id}"`));
  }
  assert.match(dialogSource, /event\.key === "Escape"/);
  assert.match(dialogSource, /disabled=\{busy\}/);
  assert.match(dialogSource, /busy \? t\("project\.deleting"\) : t\("project\.deleteConfirm"\)/);
});

test("both project menus expose a destructive delete action", () => {
  for (const [surface, source] of [
    ["ProjectsPage", projectsSource],
    ["Sidebar", sidebarSource],
  ]) {
    assert.match(source, /className="danger"\s+data-action="delete-project"/, surface);
    assert.match(source, /<ProjectDeleteDialog/, surface);
  }

  // The delete item follows the archive/restore item and opens the dialog.
  assert.ok(
    projectsSource.indexOf('data-action="delete-project"') >
      projectsSource.indexOf("toggleProjectArchive(project)"),
    "ProjectsPage orders delete after archive",
  );
  assert.match(projectsSource, /sessionCount: totalSessions/);
  assert.match(projectsSource, /setDeleteFor\(\{/);
  assert.match(
    projectsSource,
    /setRecents\(loadRecentProjects\(\)\);\s+showToast\(t\("project\.deleted", \{ name: deleteFor\.name \}\), \{ variant: "success" \}\)/,
  );

  const sidebarDelete = sidebarSource.indexOf('data-action="delete-project"');
  assert.ok(
    sidebarDelete > sidebarSource.indexOf('data-action="toggle-project-archive"'),
    "Sidebar orders delete after archive",
  );
  assert.ok(
    sidebarDelete < sidebarSource.indexOf('t("project.close")'),
    "Sidebar orders delete before close",
  );
  assert.match(sidebarSource, /sessionCount: deleteProjectFor\.sessions\.length/);
  assert.match(sidebarSource, /onError=\{reportError\}/);
});

test("deleting a project is blocked while its tasks are running", () => {
  for (const [surface, source, dialogSetter] of [
    ["ProjectsPage", projectsSource, "setDeleteFor("],
    ["Sidebar", sidebarSource, "setDeleteProjectFor("],
  ]) {
    const handler = deleteHandler(source);
    const runningCheck = handler.indexOf("runningSessions[session.id]");
    assert.ok(runningCheck >= 0, `${surface} consults runningSessions`);
    assert.match(handler, /\.filter\(/, `${surface} filters the project sessions`);
    assert.match(
      handler,
      /showToast\(\s*t\("project\.deleteRunningBlocked"\),\s*\{\s*variant: "warning",?\s*\},?\s*\)/,
      `${surface} warns instead of deleting`,
    );

    // The guard must short-circuit before the dialog state is touched.
    const dialogState = handler.indexOf(dialogSetter);
    assert.ok(dialogState > runningCheck, `${surface} checks running tasks first`);
    assert.match(
      handler.slice(runningCheck, dialogState),
      /return;/,
      `${surface} returns before opening the dialog`,
    );
  }

  // Each surface counts the sessions that belong to the project row itself.
  assert.match(deleteHandler(projectsSource), /sessionMatchesIndexProject\(session, project\)/);
  assert.match(deleteHandler(sidebarSource), /entry\.sessions\.filter\(/);

  const englishBlock = projectBlock(catalogs.get("en"));
  assert.equal(
    projectValue(englishBlock, "deleteRunningBlocked"),
    "Stop this project's running tasks before deleting it.",
  );
  assert.deepEqual(placeholders(projectValue(englishBlock, "deleteRunningBlocked")), []);
  assert.equal(
    projectValue(projectBlock(catalogs.get("zh-CN")), "deleteRunningBlocked"),
    "请先停止该项目中正在运行的任务，再删除项目。",
  );
  assert.equal(
    projectValue(projectBlock(catalogs.get("zh-TW")), "deleteRunningBlocked"),
    "請先停止該專案中正在執行的任務，再刪除專案。",
  );
  for (const id of LOCALE_IDS) {
    const value = projectValue(projectBlock(catalogs.get(id)), "deleteRunningBlocked");
    assert.notEqual(value.trim(), "", `${id} deleteRunningBlocked`);
    assert.deepEqual(placeholders(value), [], `${id} deleteRunningBlocked placeholders`);
    if (id !== "en") {
      assert.notEqual(
        value,
        projectValue(englishBlock, "deleteRunningBlocked"),
        `${id} deleteRunningBlocked is translated`,
      );
    }
  }
});

test("every shipped catalog defines the delete keys with matching placeholders", () => {
  const englishBlock = projectBlock(catalogs.get("en"));
  assert.equal(projectValue(englishBlock, "delete"), "Delete project");
  assert.equal(projectValue(englishBlock, "deleteTitle"), "Delete project");
  assert.equal(projectValue(englishBlock, "deleteConfirm"), "Delete project");
  assert.equal(projectValue(englishBlock, "deleteFolderKept"), "The folder on disk is not deleted.");
  assert.deepEqual(placeholders(projectValue(englishBlock, "deleteSessions_one")), ["count"]);
  assert.deepEqual(placeholders(projectValue(englishBlock, "deleteDescription")), ["name"]);

  for (const id of LOCALE_IDS) {
    const block = projectBlock(catalogs.get(id));
    for (const key of DELETE_KEYS) {
      const value = projectValue(block, key);
      assert.notEqual(value.trim(), "", `${id} ${key}`);
      assert.deepEqual(
        placeholders(value),
        placeholders(projectValue(englishBlock, key)),
        `${id} ${key} placeholders`,
      );
      if (id !== "en") {
        assert.notEqual(value, projectValue(englishBlock, key), `${id} ${key} is translated`);
      }
    }
  }
});

test("translated delete copy stays recognizable in the shipped locales", () => {
  assert.equal(projectValue(projectBlock(catalogs.get("zh-CN")), "deleteConfirm"), "删除项目");
  assert.equal(
    projectValue(projectBlock(catalogs.get("zh-CN")), "deleteFolderKept"),
    "磁盘上的文件夹不会被删除。",
  );
  assert.equal(projectValue(projectBlock(catalogs.get("zh-TW")), "deleteConfirm"), "刪除專案");
  assert.equal(projectValue(projectBlock(catalogs.get("de")), "deleteCancel"), "Abbrechen");
  assert.equal(projectValue(projectBlock(catalogs.get("fr")), "deleteCancel"), "Annuler");
  assert.equal(projectValue(projectBlock(catalogs.get("ko")), "deleteCancel"), "취소");
});

test("a project the host does not know is still removed from the desktop", async () => {
  const storeSource = await read("../src/stores/slices/project-slice.ts");
  const storeBlock =
    storeSource.match(/deleteProject: async[\s\S]*?\n    \},/)?.[0] ?? "";
  assert.ok(storeBlock, "deleteProject action exists");
  // A missing host row must not read as a failure, so the host result never
  // gates the renderer-local removal.
  assert.doesNotMatch(storeBlock, /removed === true/);
  assert.match(storeBlock, /await api\.removeProject\(path\)/);
  assert.match(storeBlock, /delete projectMeta\[key\]/);
  assert.match(storeBlock, /removeRecentProject\(path\)/);
  assert.match(storeBlock, /clearLocalSessionState\(/);
  assert.doesNotMatch(dialogSource, /project\.notFound/);
});

test("the delete dialog reports success once and localizes the busy refusal", () => {
  const confirmBlock =
    dialogSource.match(/const confirm = async \(\) => \{[\s\S]*?\n  \};/)?.[0] ?? "";
  assert.ok(confirmBlock, "confirm handler exists");
  // A duplicated success call would fire two cleanup paths and two toasts.
  assert.equal(
    (confirmBlock.match(/await onDeleted\(\)/g) ?? []).length,
    1,
    "onDeleted is awaited exactly once",
  );
  assert.equal((confirmBlock.match(/onError\(/g) ?? []).length, 2);
  // The host refuses with CONFLICT while a task runs; the dialog must show the
  // same localized explanation the menu guard uses instead of the raw message.
  assert.match(confirmBlock, /errorCode === ErrorCodes\.CONFLICT/);
  assert.match(
    confirmBlock,
    /onError\(new Error\(t\("project\.deleteRunningBlocked"\)\)\)/,
  );
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const LOCALE_IDS = ["en", "zh-CN", "zh-TW", "de", "es", "fr", "ko", "tr", "pt-BR"];

/** Every catalog key the delete-project flow adds to `project`. */
const DELETE_KEYS = [
  "delete",
  "deleteTitle",
  "deleteDescription",
  "deleteSessions_one",
  "deleteSessions_other",
  "deleteFolderKept",
  "deleteRunningBlocked",
  "deleteRunning_one",
  "deleteRunning_other",
  "deleteRunningConfirm",
  "deleteConfirm",
  "deleteMenuConfirm",
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

/** The props `<ProjectDeleteDialog>` receives on a surface, up to `onClose`. */
function dialogProps(source) {
  const start = source.indexOf("<ProjectDeleteDialog");
  assert.ok(start >= 0, "the dialog is rendered");
  const rest = source.slice(start);
  const end = rest.indexOf("onClose=");
  assert.ok(end > 0, "the dialog receives props");
  return rest.slice(0, end);
}

/**
 * The body of the two-step project delete, from its declaration to the closing
 * brace at component indentation. The click handler of the menu item is checked
 * separately, so this helper owns the second half of the flow.
 */
function requestBlock(source) {
  const start = source.indexOf("const requestDeleteProject = async");
  assert.ok(start >= 0, "the two-step delete handler is present");
  const rest = source.slice(start);
  const end = rest.indexOf("\n  };");
  assert.ok(end > 0, "the two-step delete handler closes");
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
  assert.match(dialogSource, /portalToBody\(dialog\)/);
});

test("the delete dialog is a labelled modal that blocks cancel while busy", () => {
  assert.match(dialogSource, /role="dialog"/);
  assert.match(dialogSource, /aria-labelledby="project-delete-dialog-title"/);
  assert.match(dialogSource, /id="project-delete-dialog-title"/);
  // The running-session line joins the description by id only while rendered.
  assert.match(dialogSource, /aria-describedby=\{`project-delete-dialog-description/);
  for (const id of [
    "project-delete-dialog-description",
    "project-delete-dialog-sessions",
    "project-delete-dialog-folder-kept",
  ]) {
    assert.match(dialogSource, new RegExp(`id="${id}"`));
  }
  assert.match(dialogSource, /event\.key === "Escape"/);
  assert.match(dialogSource, /disabled=\{busy\}/);
  assert.match(
    dialogSource,
    /busy\s*\?\s*t\("project\.deleting"\)\s*:\s*runningCount > 0\s*\?\s*t\("project\.deleteRunningConfirm"\)\s*:\s*t\("project\.deleteConfirm"\)/,
  );
});

test("both project menus expose a destructive delete action", () => {
  for (const [surface, source] of [
    ["ProjectsPage", projectsSource],
    ["Sidebar", sidebarSource],
  ]) {
    // The item keeps its destructive styling and adds the armed state on top.
    // The item keeps its destructive styling and adds the armed state on top.
    assert.match(source, /className=\{cx\(\s*"danger",/, surface);
    assert.match(source, /data-action="delete-project"/, surface);
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

test("the menu item arms first and only a live task reaches the dialog", () => {
  for (const [surface, source] of [
    ["ProjectsPage", projectsSource],
    ["Sidebar", sidebarSource],
  ]) {
    const handler = deleteHandler(source);
    // The item is now the first step of a two-click delete, so the running-task
    // refusal can no longer live in the menu: the click only arms the row.
    assert.doesNotMatch(handler, /deleteRunningBlocked/, `${surface} drops the toast refusal`);
    assert.doesNotMatch(handler, /showToast/, `${surface} does not toast instead of confirming`);
    assert.doesNotMatch(
      handler,
      /setDelete(?:Project)?For\(/,
      `${surface} arms instead of opening the dialog`,
    );
    assert.match(
      handler,
      /requestDeleteProject\(/,
      `${surface} routes the click through the two-step handler`,
    );
    assert.match(handler, /data-armed=/, `${surface} exposes the armed state`);
    // The label has to name the second click while the item is armed.
    assert.match(source, /project\.deleteMenuConfirm/, `${surface} relabels the armed item`);
    assert.match(
      source,
      /t\("project\.delete"(?:, \{ defaultValue: "[^"]*" \})?\)/,
      `${surface} keeps the plain label`,
    );

    const request = requestBlock(source);
    assert.match(request, /if \(armedDelete !== key\) \{/, `${surface} arms on the first click`);
    assert.match(request, /setArmedDelete\(key\)/, `${surface} records the armed key`);
    assert.ok(
      request.indexOf("deleteProjectAction(") > request.indexOf("setArmedDelete(key)"),
      `${surface} deletes only after arming`,
    );
    // A project with a live turn still gets the dialog that stops it.
    assert.match(request, /runningSessions\[session\.id\] === true/, `${surface} checks live turns`);
    assert.match(
      request,
      /setDelete(?:Project)?For\(/,
      `${surface} opens the dialog for a project with a live task`,
    );
    assert.match(
      request,
      /showToast\(t\("project\.deleted", \{ name: (?:entry|project)\.name \}\), \{ variant: "success" \}\)/,
      `${surface} reports the idle delete`,
    );
    assert.match(
      request,
      /errorCode === ErrorCodes\.CONFLICT[\s\S]{0,90}project\.deleteRunningBlocked/,
      `${surface} keeps the host refusal localized`,
    );

    // The dialog still has to learn which of the project's sessions are live.
    const props = dialogProps(source);
    assert.match(props, /runningSessionIds=\{/, `${surface} passes the running sessions`);
    assert.match(
      props,
      /runningSessions\[session\.id\] === true/,
      `${surface} derives them from the live store`,
    );
    assert.match(props, /\.map\(\(session\) => session\.id\)/, `${surface} passes session ids`);
  }

  // Each surface counts the sessions that belong to its own row.
  assert.match(dialogProps(projectsSource), /sessionMatchesIndexProject\(session, deleteFor\)/);
  assert.match(dialogProps(sidebarSource), /deleteProjectFor\.sessions\s*\.filter\(/);
});

test("the delete dialog names the running sessions and asks for an explicit confirmation", () => {
  assert.match(dialogSource, /runningSessionIds: string\[\]/);
  assert.match(dialogSource, /const runningCount = runningSessionIds\.length/);
  assert.match(dialogSource, /id="project-delete-dialog-running"/);
  assert.match(dialogSource, /t\("project\.deleteRunning", \{ count: runningCount \}\)/);
  // The description lists the line only while the line is actually rendered.
  assert.match(dialogSource, /runningCount > 0 \? " project-delete-dialog-running" : ""/);
  assert.match(dialogSource, /t\("project\.deleteRunningConfirm"\)/);
  assert.ok(
    dialogSource.indexOf('t("project.deleteRunningConfirm")') <
      dialogSource.indexOf('t("project.deleteConfirm")'),
    "the running label is offered instead of the plain confirm label",
  );
});

test("the delete dialog stops the running sessions before it deletes the project", () => {
  assert.match(dialogSource, /const abortSession = useAppStore\(\(s\) => s\.abortSession\)/);
  const confirmBlock =
    dialogSource.match(/const confirm = async \(\) => \{[\s\S]*?\n  \};/)?.[0] ?? "";
  assert.ok(confirmBlock, "confirm handler exists");
  const loop = confirmBlock.indexOf("for (const sessionId of runningSessionIds)");
  const abortCall = confirmBlock.indexOf("await abortSession(sessionId)");
  const deleteCall = confirmBlock.indexOf("await deleteProject(project.path)");
  assert.ok(loop >= 0, "the confirm handler stops the running sessions");
  assert.ok(abortCall > loop, "each running session is aborted");
  assert.ok(deleteCall > abortCall, "the delete is awaited only after every stop");
});

test("deleting a project still explains a host-side running-task refusal", () => {
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

  // The host still refuses a turn that starts after the dialog opened, so the
  // localized explanation has to stay reachable from the dialog.
  assert.match(dialogSource, /onError\(new Error\(t\("project\.deleteRunningBlocked"\)\)\)/);
});

test("the running-session copy is translated in every shipped catalog", () => {
  const englishBlock = projectBlock(catalogs.get("en"));
  assert.equal(
    projectValue(englishBlock, "deleteRunning_one"),
    "{{count}} session in this project is still running. Deleting the project stops it.",
  );
  assert.equal(projectValue(englishBlock, "deleteRunningConfirm"), "Stop tasks and delete");
  assert.deepEqual(placeholders(projectValue(englishBlock, "deleteRunning_other")), ["count"]);
  assert.deepEqual(placeholders(projectValue(englishBlock, "deleteRunningConfirm")), []);
  assert.equal(
    projectValue(projectBlock(catalogs.get("zh-CN")), "deleteRunningConfirm"),
    "停止任务并删除",
  );
  assert.deepEqual(
    placeholders(projectValue(projectBlock(catalogs.get("zh-TW")), "deleteRunning_one")),
    ["count"],
  );
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

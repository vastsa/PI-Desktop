import { readComposerSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  COMPOSER_WORKSPACE_FILE_MIME,
  composerDropItems,
  composerWorkspaceFileDrop,
  createComposerWorkspaceDropDeduper,
  hasComposerFileDrag,
  parseComposerWorkspaceFileDrop,
} from "../src/lib/composer-drop.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [
  composer,
  api,
  preload,
  panelPreload,
  panelHost,
  pluginServices,
  styles,
  fileManagerView,
] =
  await Promise.all([
    readComposerSource(),
    read("../src/lib/api.ts"),
    read("../electron/preload/index.ts"),
    read("../electron/preload/plugin-panel.ts"),
    read("../electron/main/plugin-panel-host.ts"),
    read("../electron/main/services/plugin-services.ts"),
    read("../src/styles/composer.css"),
    read("../resources/plugins/pi.file-manager/views/assets/index.js"),
  ]);

function droppedFile(name, type = "text/plain") {
  return { name, type };
}

function droppedItem(file, isDirectory) {
  return {
    kind: "file",
    getAsFile: () => file,
    webkitGetAsEntry: () => ({ isDirectory }),
  };
}

function transfer(items) {
  return {
    items,
    files: items.map((item) => item.getAsFile()).filter(Boolean),
  };
}

test("native drops preserve mixed file/folder order and identify directories", () => {
  const file = droppedFile("notes.txt");
  const folder = droppedFile("source", "application/x-directory");
  const fileItem = droppedItem(file, false);
  const folderItem = droppedItem(folder, true);
  const data = transfer([fileItem, folderItem]);

  assert.equal(hasComposerFileDrag(data), true);
  assert.deepEqual(
    composerDropItems(data, (item) =>
      item === file ? "/tmp/notes.txt" : "/Users/lan/project/source",
    ).map((item) => ({ path: item.path, isDirectory: item.isDirectory })),
    [
      { path: "/tmp/notes.txt", isDirectory: false },
      { path: "/Users/lan/project/source", isDirectory: true },
    ],
  );
});

test("native drop normalization does not duplicate DataTransfer files", () => {
  const file = droppedFile("duplicate.md");
  const secondFileObject = droppedFile("duplicate.md");
  const data = {
    items: [droppedItem(file, false), droppedItem(secondFileObject, false)],
    files: [file, secondFileObject],
  };

  assert.equal(
    composerDropItems(data, () => "/tmp/duplicate.md").length,
    1,
  );
});

test("Composer handles native drops through the existing file bridge", () => {
  assert.match(composer, /onDragEnter=\{onComposerDragEnter\}/);
  assert.match(composer, /onDragOver=\{onComposerDragOver\}/);
  assert.match(composer, /onDrop=\{onComposerDrop\}/);
  assert.match(composer, /event\.dataTransfer\.dropEffect = "copy"/);
  assert.match(composer, /composerDropItems\(event\.dataTransfer, api\.getDroppedFilePath\)/);
  assert.match(composer, /formatDroppedDirectoryPath\(item\.path\)/);
  assert.match(composer, /formatFileInsert\(normalized, "dir"\)/);
  assert.match(composer, /api\.pasteFiles\(/);
  assert.match(composer, /applyEditorDraft\(nextText, nextReferences/);
  assert.match(api, /getDroppedFilePath: \(file: File\)/);
  assert.match(preload, /import \{ contextBridge, ipcRenderer, webUtils \} from "electron"/);
  assert.match(preload, /webUtils\.getPathForFile\(file\)/);
  assert.match(styles, /\.composer-shell\.is-drop-target\s*\{[\s\S]*?outline:/);
  assert.match(styles, /outline-offset: 3px/);
});

test("workspace file-tree drags become relative Composer file references", () => {
  const values = new Map();
  const data = {
    effectAllowed: "all",
    files: [],
    items: [],
    get types() {
      return [...values.keys()];
    },
    setData(type, value) {
      values.set(type, value);
    },
    getData(type) {
      return values.get(type) ?? "";
    },
  };
  data.effectAllowed = "copy";
  data.setData(
    COMPOSER_WORKSPACE_FILE_MIME,
    JSON.stringify({ path: "src/App.tsx", name: "App.tsx" }),
  );

  assert.equal(hasComposerFileDrag(data), true);
  assert.deepEqual(composerWorkspaceFileDrop(data), {
    path: "src/App.tsx",
    name: "App.tsx",
  });
  assert.equal(COMPOSER_WORKSPACE_FILE_MIME, "application/x-pi-desktop-workspace-file");
  assert.match(fileManagerView, /draggable:!([\w$]+)\.isDirectory&&!\1\.isSymlink/);
  assert.match(fileManagerView, /application\/x-pi-desktop-workspace-file/);
  assert.match(fileManagerView, /effectAllowed="copy"/);
  assert.match(panelPreload, /event\.isTrusted/);
  assert.match(panelPreload, /pi-plugin-panel-composer-file-drop/);
  assert.match(panelHost, /screenX/);
  assert.match(panelHost, /screenY/);
  assert.match(pluginServices, /IPC\.event\.pluginComposerFileDrop/);
  assert.match(api, /onPluginComposerFileDrop/);
  assert.match(composer, /getBoundingClientRect\(\)/);
  assert.match(composer, /parseComposerWorkspaceFileDrop\(data\)/);
  assert.match(composer, /composerWorkspaceFileDrop\(event\.dataTransfer\)/);
  assert.match(composer, /createFileReference\(workspaceFile\.path, workspaceFile\.name/);
});

test("workspace file-tree payloads reject absolute and parent paths", () => {
  assert.equal(parseComposerWorkspaceFileDrop('{"path":"/tmp/a","name":"a"}'), null);
  assert.equal(parseComposerWorkspaceFileDrop('{"path":"../a","name":"a"}'), null);
  assert.equal(parseComposerWorkspaceFileDrop('{"path":"src/../a","name":"a"}'), null);
  assert.deepEqual(
    parseComposerWorkspaceFileDrop('{"path":"src/App.tsx","name":"App.tsx"}'),
    { path: "src/App.tsx", name: "App.tsx" },
  );
});

test("one workspace drag is attached once when both delivery paths fire", () => {
  const accept = createComposerWorkspaceDropDeduper();
  const file = { path: "src/App.tsx", name: "App.tsx" };
  assert.equal(accept(file, 1_000), true);
  assert.equal(accept(file, 1_001), false);
  assert.equal(accept(file, 1_501), true);
  assert.equal(accept({ path: "src/main.ts", name: "main.ts" }, 1_502), true);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  composerDropItems,
  hasComposerFileDrag,
} from "../src/lib/composer-drop.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [composer, api, preload, styles] = await Promise.all([
  read("../src/components/Composer.tsx"),
  read("../src/lib/api.ts"),
  read("../electron/preload/index.ts"),
  read("../src/styles/composer.css"),
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

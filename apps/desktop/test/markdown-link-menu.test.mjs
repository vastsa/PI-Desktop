import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const markdownSource = await readFile(
  new URL("../src/components/Markdown.tsx", import.meta.url),
  "utf8",
);
const koreanCatalog = await readFile(
  new URL("../../../packages/i18n/src/locales/ko/index.ts", import.meta.url),
  "utf8",
);

test("chat links use the shared pointer-anchored menu", () => {
  assert.match(markdownSource, /useContextMenu\(\)/);
  assert.match(markdownSource, /<ContextMenu state=\{contextMenu\} onClose=\{closeContextMenu\} \/>/);
  assert.match(markdownSource, /openContextMenu\(event, \{/);
  assert.match(markdownSource, /id: "open-external"/);
  assert.match(markdownSource, /id: "open-workpanel"/);
  assert.match(markdownSource, /id: "copy-address"/);
});

test("copy link feedback follows the clipboard result", () => {
  assert.match(markdownSource, /await navigator\.clipboard\.writeText\(target\)/);
  assert.match(markdownSource, /t\("settings\.linkCopied"/);
  assert.match(markdownSource, /t\("settings\.linkCopyFailed"/);
  assert.doesNotMatch(
    markdownSource,
    /void navigator\.clipboard\.writeText\([^)]+\);\s*showToast\(/,
  );
});

test("Korean ships every chat link setting and menu label", () => {
  for (const key of [
    "linkOpenTarget",
    "linkOpenTargetWorkpanel",
    "linkOpenTargetExternal",
    "linkContextMenuOpenExternal",
    "linkContextMenuOpenWorkpanel",
    "linkContextMenuCopy",
    "linkCopied",
    "linkCopyFailed",
  ]) {
    assert.match(koreanCatalog, new RegExp(`\\b${key}:`), key);
  }
});

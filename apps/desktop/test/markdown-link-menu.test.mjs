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

test("chat link menus keep inside clicks and keyboard navigation", () => {
  assert.match(
    markdownSource,
    /if \(menuRef\.current\?\.contains\(event\.target as Node\)\) return;/,
  );
  assert.match(markdownSource, /ref=\{menuRef\}/);
  assert.match(markdownSource, /onKeyDown=\{onMenuKeyDown\}/);
  assert.match(
    markdownSource,
    /querySelector<HTMLButtonElement>\('\[role="menuitem"\]'\)/,
  );
});

test("copy link feedback follows the clipboard result", () => {
  assert.match(markdownSource, /await navigator\.clipboard\.writeText\(href\)/);
  assert.match(markdownSource, /t\("settings\.linkCopied"/);
  assert.match(markdownSource, /t\("settings\.linkCopyFailed"/);
  assert.doesNotMatch(
    markdownSource,
    /void navigator\.clipboard\.writeText\(href\);\s*showToast\(/,
  );
});

test("Korean ships every chat link setting and menu label", () => {
  for (const key of [
    "linkOpenTarget",
    "linkOpenTargetDesc",
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

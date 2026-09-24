import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const styles = await loadStyles();
const menuSource = await readFile(
  new URL("../src/components/ContextMenu.tsx", import.meta.url),
  "utf8",
);
const transcriptSource = await readFile(
  new URL("../src/features/chat/transcript/ChatTranscript.tsx", import.meta.url),
  "utf8",
);
const messageRowSource = await readFile(
  new URL("../src/features/chat/transcript/MessageRow.tsx", import.meta.url),
  "utf8",
);
const assistantTurnSource = await readFile(
  new URL("../src/features/chat/transcript/AssistantTurn.tsx", import.meta.url),
  "utf8",
);

test("the pointer-anchored menu portals, measures, and closes without trapping focus", () => {
  assert.match(menuSource, /portalToBody\(/);
  assert.match(menuSource, /placeContextMenu\(/);
  assert.match(menuSource, /className=\{`context-menu\$\{placement \? " is-open" : ""\}`\}/);
  assert.match(menuSource, /window\.addEventListener\("pointerdown", onOutside, true\)/);
  assert.match(menuSource, /window\.addEventListener\("keydown", onKeyDown, true\)/);
  assert.match(menuSource, /if \(event\.key === "Tab"\)/);
  assert.match(menuSource, /onContextMenu=\{/);
  assert.match(menuSource, /function snapshotSelection\(/);
  assert.match(menuSource, /live\.isCollapsed/);
  assert.match(menuSource, /root\.contains\(anchorNode\)/);
  assert.match(menuSource, /root\.contains\(focusNode\)/);
  assert.match(menuSource, /item\.onSelect\(state\.selection\)/);
  assert.match(menuSource, /if \(!request\.items\.length\) return;/);
});

test("the transcript owns one menu and each speaking row can open it", () => {
  assert.match(transcriptSource, /<TranscriptMenuProvider>/);
  assert.match(transcriptSource, /onContextMenu=\{onContextMenu\}/);
  assert.match(transcriptSource, /conversationMenuItems\(/);
  assert.match(messageRowSource, /onContextMenu=\{onContextMenu\}/);
  assert.match(messageRowSource, /userMessageMenuItems\(/);
  assert.match(assistantTurnSource, /onContextMenu=\{onContextMenu\}/);
  assert.match(assistantTurnSource, /assistantTurnMenuItems\(/);
});

test("the context-menu surface is a measured fixed layer", () => {
  const rule = styles.match(/\.context-menu\s*\{[\s\S]*?\}/)?.[0] ?? "";
  assert.match(rule, /position:\s*fixed/);
  assert.match(rule, /z-index:\s*60/);
  assert.match(rule, /visibility:\s*hidden/);
  assert.match(styles, /\.context-menu\.is-open\s*\{[\s\S]*?visibility:\s*visible/);
});

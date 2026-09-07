import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [transcript, styles, hook, api] = await Promise.all([
  read("../src/components/ChatTranscript.tsx"),
  read("../src/styles/chat-links.css"),
  read("../src/hooks/use-preview-target.ts"),
  read("../src/lib/api.ts"),
]);

test("sent user-message file refs render as composer-like chips", () => {
  assert.match(transcript, /className=\"composer-chip chat-file-chip\"/);
  assert.match(transcript, /function FileRefChip/);
  assert.match(transcript, /segment\.target\.kind === \"file\"/);
  assert.match(transcript, /useOpenChatFileRef/);
  assert.match(transcript, /composer-chip-name/);
  assert.match(styles, /\.chat-file-chip[\s\S]*?appearance: none/);
});

test("user-message file chips open HTML in the browser and other files via fs/open", () => {
  assert.match(hook, /isHtmlFilePath\(rel\)/);
  assert.match(hook, /openUrl\(rel\)/);
  assert.match(hook, /api\.fsOpen\(path\)/);
  assert.match(api, /fsOpen: \(path: string\) => invoke\(IPC\.invoke\.fsOpen, \{ path \}\)/);
});

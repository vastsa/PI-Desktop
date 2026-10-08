import {
  readTranscriptModule,
  readTranscriptSource,
} from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const markdown = await read("../src/components/Markdown.tsx");

const [transcript, styles, hook, api, toolDetails, toolRow, filesTab] = await Promise.all([
  readTranscriptSource(),
  read("../src/styles/chat-links.css"),
  read("../src/hooks/use-preview-target.ts"),
  read("../src/lib/api.ts"),
  read("../src/components/ToolDetails.tsx"),
  readTranscriptModule("ToolRow.tsx"),
  read("../src/components/workpanel/FilesTab.tsx"),
]);

test("sent user-message file refs render as composer-like chips", () => {
  assert.match(transcript, /className=\"composer-chip chat-file-chip\"/);
  assert.match(transcript, /function FileRefChip/);
  assert.match(transcript, /segment\.target\.kind === \"file\"/);
  assert.match(transcript, /useOpenChatFileRef/);
  assert.match(transcript, /composer-chip-name/);
  assert.match(styles, /\.chat-file-chip[\s\S]*?appearance: none/);
  assert.match(transcript, /mimeType=\{attachment\.mimeType\}/);
  assert.match(transcript, /onOpen\(path, undefined, mimeType, \{ line, column \}\)/);
});

test("a file chip is routed by where the reference resolved, never optimistically", () => {
  // Completion happens in the main process first, so the click can no longer
  // open a path that does not exist — the empty panel this used to produce is
  // replaced by a report.
  assert.match(hook, /api\.fsResolveRef\(/);
  assert.match(hook, /chat\.fileRefMissing/);
  // A project group can hold several folders (ADR 0249), so the address shape
  // follows the folder that answered: relative for the primary one, absolute
  // for its siblings, and the file view switches to the folder it is given.
  assert.match(hook, /match\.projectRoot \? match\.projectRoot\.primary : true/);
  assert.match(hook, /path: primary \? match\.relativePath : match\.absolutePath/);
  // A workspace HTML page is a page to run, not a file to read (ADR 0163), and
  // only the primary folder has a workspace-relative address for the browser.
  assert.match(hook, /resolved\.primary &&/);
  assert.match(hook, /isHtmlFilePath\(resolved\.relativePath\)/);
  assert.match(hook, /openUrl\(resolved\.relativePath\)/);
  // Plain project files prefer the bundled file view. A path:line reference
  // uses the host file tab because the bundled view has no line-navigation API.
  assert.match(hook, /FILE_MANAGER_PLUGIN_TAB/);
  assert.match(hook, /const hasPosition = line !== undefined \|\| column !== undefined/);
  assert.match(hook, /!hasPosition[\s\S]*?isHtmlFilePath/);
  assert.match(hook, /!hasPosition[\s\S]*?fileViewAvailable/);
  assert.match(hook, /fileManagerPluginTab\(resolved\.path\)/);
  assert.match(filesTab, /data-line=\{i \+ 1\}/);
  assert.match(filesTab, /viewerBodyRef\.current\?\.querySelector/);
  assert.match(filesTab, /if \(!file \|\| selectedLine == null\) return/);
  assert.match(filesTab, /data-line="\$\{selectedLine\}"/);
  assert.match(filesTab, /return \(\) => cancelAnimationFrame\(frame\)/);
  assert.match(filesTab, /selectedLine === undefined/);
  // Session scratch and attachment files live outside the plugin's project
  // roots, and positioned references need the host viewer's line navigation.
  assert.match(hook, /inProject: false/);
  assert.match(hook, /openFile\(resolved\.path, mimeType, \{ line, column \}\)/);
  // The OS handoff is no longer what a chat click does; the channel itself
  // stays part of the public IPC surface.
  assert.doesNotMatch(hook, /api\.fsOpen\(/);
  assert.match(api, /fsOpen: \(path: string, mimeType\?: string\) =>\s*invoke\(IPC\.invoke\.fsOpen, \{ path, mimeType \}\)/);
});

test("Markdown file anchors route clicks through the existing file opener", () => {
  assert.match(markdown, /handleMarkdownFileLinkClick\(e, href, root, baseDir, openFileRef\)/);
});

test("a tool row and a tool result row open a file where the message body does", () => {
  // One opener serves every transcript surface that names a file. It completes
  // the reference the same way a chat chip does instead of handing the raw path
  // to the host viewer, so a Read/Write/Edit row summary and a Glob/Grep result
  // row land in the bundled file view too (ADR 0262). The call this replaces is
  // the one that let those surfaces pick the destination themselves.
  assert.match(hook, /const openFileRef = useOpenChatFileRef\(\);/);
  assert.match(hook, /target\.kind === "file"[\s\S]*?openFileRef\(target\.path, undefined, undefined, \{/);
  assert.match(hook, /line: target\.line,[\s\S]*?column: target\.column/);
  assert.doesNotMatch(hook, /openFile\(target\.path\)/);
  // Both surfaces still call that opener, and neither reaches the host viewer's
  // store action directly: the tool row summary carries the call's own path,
  // and the result lists carry one entry per file and per matched file.
  assert.match(toolRow, /const openTarget = useOpenPreviewTarget\(\)/);
  assert.match(toolRow, /openTarget\(previewTarget\)/);
  assert.doesNotMatch(toolRow, /openFileInWorkPanel/);
  assert.equal(
    toolDetails.match(/openTarget\(\{ kind: "file", path: rel \}\)/g)?.length,
    2,
  );
  assert.doesNotMatch(toolDetails, /openFileInWorkPanel/);
});

test("user-message bare paths wait for fs/resolveRef before becoming chips", async () => {
  const [verified, files] = await Promise.all([
    read("../src/hooks/use-verified-chat-text.ts"),
    read("../src/lib/verified-chat-files.ts"),
  ]);
  assert.match(transcript, /useVerifiedChatText\(text, attachments\)/);
  assert.match(transcript, /attachments=\{message\.attachments\}/);
  assert.match(verified, /useAppStore\(\(s\) => s\.workspace\?\.path\)/);
  assert.doesNotMatch(verified, /useAppStore\(\(s\) => s\.workspace\)(?!\?)/);
  assert.match(verified, /api\.fsResolveRef\(/);
  assert.match(files, /MAX_MESSAGE_CANDIDATES = 32/);
  assert.match(files, /MAX_CONCURRENT_LOOKUPS = 4/);
  assert.match(files, /!segment\.text\.startsWith\("@\"\)/);
});

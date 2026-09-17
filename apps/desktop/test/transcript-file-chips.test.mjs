import {
  readTranscriptModule,
  readTranscriptSource,
} from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [transcript, styles, hook, api, toolDetails, toolRow] = await Promise.all([
  readTranscriptSource(),
  read("../src/styles/chat-links.css"),
  read("../src/hooks/use-preview-target.ts"),
  read("../src/lib/api.ts"),
  read("../src/components/ToolDetails.tsx"),
  readTranscriptModule("ToolRow.tsx"),
]);

test("sent user-message file refs render as composer-like chips", () => {
  assert.match(transcript, /className=\"composer-chip chat-file-chip\"/);
  assert.match(transcript, /function FileRefChip/);
  assert.match(transcript, /segment\.target\.kind === \"file\"/);
  assert.match(transcript, /useOpenChatFileRef/);
  assert.match(transcript, /composer-chip-name/);
  assert.match(styles, /\.chat-file-chip[\s\S]*?appearance: none/);
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
  assert.match(hook, /inPrimary \? match\.relativePath : match\.absolutePath/);
  // A workspace HTML page is a page to run, not a file to read (ADR 0163), and
  // only the primary folder has a workspace-relative address for the browser.
  assert.match(hook, /inPrimary && isHtmlFilePath\(match\.relativePath\)/);
  assert.match(hook, /openUrl\(match\.relativePath\)/);
  // A project file prefers the bundled file view; without that plugin the
  // host file tab is the same surface this hook used before.
  assert.match(hook, /FILE_MANAGER_PLUGIN_TAB/);
  assert.match(hook, /fileManagerPluginTab\(target\)/);
  assert.match(hook, /openFile\(target, mimeType\)/);
  // Session scratch and attachment files live outside the plugin's project
  // roots, so they are addressed by absolute path on the host file tab.
  assert.match(hook, /openFile\(match\.absolutePath, mimeType\)/);
  // The OS handoff is no longer what a chat click does; the channel itself
  // stays part of the public IPC surface.
  assert.doesNotMatch(hook, /api\.fsOpen\(/);
  assert.match(api, /fsOpen: \(path: string\) => invoke\(IPC\.invoke\.fsOpen, \{ path \}\)/);
});

test("a tool row and a tool result row open a file where the message body does", () => {
  // One opener serves every transcript surface that names a file. It completes
  // the reference the same way a chat chip does instead of handing the raw path
  // to the host viewer, so a Read/Write/Edit row summary and a Glob/Grep result
  // row land in the bundled file view too (ADR 0262). The call this replaces is
  // the one that let those surfaces pick the destination themselves.
  assert.match(hook, /const openFileRef = useOpenChatFileRef\(\);/);
  assert.match(hook, /if \(target\.kind === "file"\) return openFileRef\(target\.path\);/);
  assert.match(hook, /if \(target\.kind === "session"\) \{/);
  assert.match(hook, /return openUrl\(target\.url\);/);
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

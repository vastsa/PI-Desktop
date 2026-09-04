import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [composer, api, main, saver, protocol, sidecar] = await Promise.all([
  read("../src/components/Composer.tsx"),
  read("../src/lib/api.ts"),
  read("../electron/main/index.ts"),
  read("../electron/main/composer-paste.ts"),
  read("../../../packages/shared/src/protocol.ts"),
  read("../../../packages/agent-runtime/src/sidecar.ts"),
]);

test("composer converts oversized text paste and materializes clipboard files", () => {
  assert.match(composer, /onPaste=\{pasteClipboardFiles\}/);
  assert.match(composer, /const text = event\.clipboardData\.getData\("text\/plain"\)/);
  assert.match(composer, /const textLength = Array\.from\(text\)\.length/);
  assert.match(composer, /!files\.length && textLength > largePasteThreshold/);
  assert.match(composer, /pasted-text-\$\{crypto\.randomUUID\(\)\.slice\(0, 8\)\}\.txt/);
  assert.match(composer, /mimeType: "text\/plain"/);
  // Oversized pastes attach as atomic inline chips: one sentinel character
  // inserted at the caret inside an editable draft, never an editable
  // @token that later edits could corrupt or silently drop.
  assert.doesNotMatch(composer, /const token = `@\$\{displayName\}`/);
  assert.match(composer, /sourceValue\.slice\(0, selectionStart\) \+/);
  assert.match(composer, /draftCacheRef\.current\.set\(sessionId, \{/);
  assert.match(composer, /if \(isLargeTextPaste \|\| files\.length\) \{/);
  assert.match(composer, /file\.arrayBuffer\(\)/);
  assert.match(
    composer,
    /createFileReference\(file\.path, file\.name, sessionId, \{[\s\S]*kind: file\.kind/,
  );
  assert.match(composer, /serializeComposerFileReferences\(text, activeFileReferences\)/);
  assert.match(
    composer,
    /const serializedContent = serializeComposerFileReferences\(text, activeFileReferences\)/,
  );
  // The draft is a contenteditable rich field: sentinels render as atomic
  // chips and every caret write goes through the DOM-range helper.
  assert.match(composer, /contentEditable=\{!inputBlocked\}/);
  assert.match(composer, /function readEditorValue\(/);
  assert.match(composer, /function setEditorCaret\(/);
  assert.doesNotMatch(composer, /<textarea/);
  assert.doesNotMatch(composer, /setSelectionRange\(/);
  assert.match(composer, /await materializeDraftSession\(\)/);
});

test("paste IPC is a typed renderer-to-main bridge", () => {
  assert.match(protocol, /composerPasteFiles: "pi-desktop\/composer\/pasteFiles"/);
  assert.match(api, /pasteFiles: \(sessionId: string, files: ComposerPasteFile\[\]\)/);
  assert.match(api, /IPC\.invoke\.composerPasteFiles/);
  assert.match(main, /host\.call\("session\.get", \{ id: sessionId \}\)/);
  assert.match(main, /saveComposerPasteFiles\(dataDir, sessionId, files\)/);
});

test("pasted bytes stay in the session scratch directory", () => {
  assert.match(saver, /join\(dataDir, "scratch", sessionId, "pasted"\)/);
  assert.match(saver, /basename\(normalized\)/);
  assert.match(saver, /writeFile\(path, bytes, \{ flag: "wx" \}\)/);
  assert.match(saver, /MAX_TOTAL_BYTES/);
  assert.match(saver, /kind: isImageFile\(name, mimeType\) \? "image" : "file"/);
  assert.match(saver, /size: bytes\.byteLength/);
});

test("large image attachments avoid whole-file startup reads", () => {
  assert.match(main, /async function hashFile\(path: string\)/);
  assert.match(main, /createReadStream\(path\)/);
  assert.match(main, /const inline = supportsVision && size <= MAX_INLINE_IMAGE_BYTES/);
  assert.match(main, /await copyFile\(source, target, fsConstants\.COPYFILE_EXCL\)/);
  assert.doesNotMatch(main, /const bytes = readFileSync\(source\.absolute\)/);
  assert.match(sidecar, /const size = \(await stat\(canonical\)\)\.size/);
  assert.match(sidecar, /shouldInline && size <= MAX_INLINE_IMAGE_BYTES/);
  assert.match(sidecar, /await copyFile\(source, target, fsConstants\.COPYFILE_EXCL\)/);
});

test("paste results separate display names from unique storage paths", async () => {
  const { saveComposerPasteFiles } = await import(
    "../electron/main/composer-paste.ts"
  );
  const root = await mkdtemp(join(tmpdir(), "pi-composer-paste-"));
  try {
    const files = await saveComposerPasteFiles(root, "session-1", [
      {
        name: "C:\\Users\\lan\\image.png",
        mimeType: "image/png",
        data: new Uint8Array([1, 2, 3]).buffer,
      },
      {
        name: "/tmp/other/image.png",
        mimeType: "image/png",
        data: new Uint8Array([4, 5]).buffer,
      },
    ]);

    assert.deepEqual(files.map((file) => file.name), ["image.png", "image.png"]);
    assert.deepEqual(files.map((file) => file.kind), ["image", "image"]);
    assert.notEqual(files[0].path, files[1].path);
    assert.match(basename(files[0].path), /^pasted-.+-image\.png$/);
    assert.notEqual(basename(files[0].path), files[0].name);
    assert.deepEqual(
      Array.from(await readFile(files[0].path)),
      [1, 2, 3],
    );
    assert.deepEqual(Array.from(await readFile(files[1].path)), [4, 5]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("large pasted text is preserved byte-for-byte in session scratch", async () => {
  const { saveComposerPasteFiles } = await import(
    "../electron/main/composer-paste.ts"
  );
  const root = await mkdtemp(join(tmpdir(), "pi-composer-paste-text-"));
  const text = "第一行\nsecond line — exact bytes\n";
  try {
    const [file] = await saveComposerPasteFiles(root, "session-text", [
      {
        name: "pasted-text-1234abcd.txt",
        mimeType: "text/plain",
        data: new TextEncoder().encode(text).buffer,
      },
    ]);

    assert.equal(file.name, "pasted-text-1234abcd.txt");
    assert.equal(file.kind, "file");
    assert.equal(file.mimeType, "text/plain");
    assert.equal(
      Buffer.from(await readFile(file.path)).toString("utf8"),
      text,
    );
    assert.match(file.path, /scratch[\\/]session-text[\\/]pasted[\\/]/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

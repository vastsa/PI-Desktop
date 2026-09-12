import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [composer, api, main, attachments, saver, protocol, sidecar, picker] = await Promise.all([
  read("../src/components/Composer.tsx"),
  read("../src/lib/api.ts"),
  read("../electron/main/index.ts"),
  read("../electron/main/prompt-attachments.ts"),
  read("../electron/main/composer-paste.ts"),
  read("../../../packages/shared/src/protocol.ts"),
  read("../../../packages/agent-runtime/src/sidecar.ts"),
  read("../electron/main/composer-picker.ts"),
]);

test("composer converts oversized text paste and materializes clipboard files", () => {
  assert.match(composer, /onPaste=\{pasteClipboardFiles\}/);
  assert.match(composer, /const text = event\.clipboardData\.getData\("text\/plain"\)/);
  assert.match(composer, /const textLength = Array\.from\(text\)\.length/);
  assert.match(composer, /!files\.length && textLength > largePasteThreshold/);
  assert.match(composer, /pasted-text-\$\{crypto\.randomUUID\(\)\.slice\(0, 8\)\}\.txt/);
  assert.match(composer, /mimeType: "text\/plain"/);
  assert.match(composer, /recordHistory: true/);
  assert.match(composer, /api\.recordClipboardPaste\(text\)/);
  // Oversized pastes attach as atomic inline chips: one sentinel character
  // inserted at the caret inside an editable draft, never an editable
  // @token that later edits could corrupt or silently drop.
  assert.doesNotMatch(composer, /const token = `@\$\{displayName\}`/);
  assert.match(composer, /sourceValue\.slice\(0, selectionStart\) \+/);
  assert.match(composer, /writeComposerDraft\(sessionId, \{/);
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

test("chip sentinels stay unique inside the private-use range", () => {
  const baseLiteral = composer.match(/const CHIP_TOKEN_BASE = (0x[0-9a-f]+);/)?.[1];
  const endLiteral = composer.match(/const CHIP_TOKEN_END = (0x[0-9a-f]+);/)?.[1];
  const body = composer.match(
    /function nextChipToken\(\): string \{[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(baseLiteral && endLiteral && body, "sentinel helpers missing");

  // Execute the real arithmetic (not a re-implementation): a past regression
  // computed `(seq - BASE + 1) % range`, which produced Hangul code points
  // that rendered as raw garbage text instead of chips.
  const snippet = [
    `const CHIP_TOKEN_BASE = ${baseLiteral};`,
    `const CHIP_TOKEN_END = ${endLiteral};`,
    "let chipTokenSequence = 0;",
    body.replace(/: string/g, ""),
    "return nextChipToken;",
  ].join("\n");
  const nextChipToken = new Function(snippet)();

  const seen = new Set();
  for (let i = 0; i < 128; i += 1) {
    const token = nextChipToken();
    const code = token.codePointAt(0) ?? 0;
    assert.ok(code >= 0xe000 && code <= 0xf8ff, `token ${i} left the PUA range`);
    assert.ok(!seen.has(token), `token ${i} repeated within a cycle`);
    seen.add(token);
  }
});

test("paste IPC is a typed renderer-to-main bridge", () => {
  assert.match(protocol, /composerPasteFiles: "pi-desktop\/composer\/pasteFiles"/);
  assert.match(protocol, /clipboardRecordPaste: "pi-desktop\/clipboard\/recordPaste"/);
  assert.match(protocol, /composerImportFiles: "pi-desktop\/composer\/importFiles"/);
  assert.match(api, /pasteFiles: \(sessionId: string, files: ComposerPasteFile\[\]\)/);
  assert.match(api, /pickFiles: \(\) =>[\s\S]*token: string \| null/);
  assert.match(api, /importFiles: \(sessionId: string, token: string\)/);
  assert.match(api, /IPC\.invoke\.composerPasteFiles/);
  assert.match(api, /recordClipboardPaste: \(text: string\)/);
  assert.match(api, /IPC\.invoke\.clipboardRecordPaste/);
  assert.match(api, /IPC\.invoke\.composerImportFiles/);
  assert.match(main, /host\.call\("session\.get", \{ id: sessionId \}\)/);
  assert.match(main, /saveComposerPasteFiles\(dataDir, sessionId, files\)/);
  assert.match(main, /recordPastedClipboardFiles\(files\)/);
  assert.match(main, /assertMainWindowSender\(event\)/);
  assert.match(main, /imageDimensions\(bytes\)/);
  assert.match(main, /MAX_CLIPBOARD_IMAGE_PIXELS/);
  assert.match(main, /clipboardHistory\.recordText\(input\.text\)/);
  assert.match(main, /rememberComposerPickerSelection\(result\.filePaths, event\.sender\.id\)/);
  assert.match(main, /consumeComposerPickerSelection\(input\.token, event\.sender\.id\)/);
  assert.match(main, /importComposerFiles\(\s*dataDir,\s*sessionId,\s*paths/);
  assert.doesNotMatch(main, /input\.paths/);
  assert.doesNotMatch(api, /importFiles: \(sessionId: string, paths: string\[\]\)/);
});

test("picker attachments materialize a session before importing paths", () => {
  assert.match(
    composer,
    /const sessionId = sourceSessionId \?\? \(await materializeDraftSession\(\)\)/,
  );
  assert.match(composer, /api\.importFiles\(\s*sessionId,\s*result\.token\s*\)/);
  assert.match(
    composer,
    /createFileReference\(file\.path, file\.name, sessionId, \{[\s\S]*kind: file\.kind/,
  );
  assert.doesNotMatch(
    composer,
    /createFileReference\(path, undefined, referenceSessionId/,
  );
});

test("composer opens one unified file picker directly from the plus button", () => {
  const leftStart = composer.indexOf('<div className="composer-left">');
  const plusIndex = composer.indexOf('tooltip={t("chat.addFiles")}', leftStart);
  const modeIndex = composer.indexOf("composer-mode-chip", leftStart);
  assert.ok(leftStart >= 0 && plusIndex > leftStart && modeIndex > leftStart);
  assert.ok(plusIndex < modeIndex, "upload must precede the agent mode chip");
  assert.match(composer, /void pickAndAttach\(\);/);
  assert.match(composer, /const pickAndAttach = async \(\) =>/);
  assert.match(composer, /const result = await api\.pickFiles\(\);/);
  assert.doesNotMatch(composer, /plusOpen|plusRef|composer-plus-menu|pickAndAttach\("photos"\)/);
});

test("pasted bytes stay in the session scratch directory", () => {
  assert.match(saver, /join\(dataDir, "scratch", sessionId, "pasted"\)/);
  assert.match(saver, /basename\(normalized\)/);
  assert.match(saver, /writeFile\(path, bytes, \{ flag: "wx" \}\)/);
  assert.match(saver, /MAX_TOTAL_BYTES/);
  assert.match(saver, /kind: isImageFile\(name, mimeType\) \? "image" : "file"/);
  assert.match(saver, /size: bytes\.byteLength/);
});

test("picker imports are copied into the owning session scratch directory", async () => {
  const { importComposerFiles } = await import(
    "../electron/main/composer-paste.ts"
  );
  const dataRoot = await mkdtemp(join(tmpdir(), "pi-composer-import-data-"));
  const sourceRoot = await mkdtemp(join(tmpdir(), "pi-composer-import-source-"));
  const textPath = join(sourceRoot, "notes with spaces.txt");
  const imagePath = join(sourceRoot, "marker.png");
  const text = "picker marker: FILE-7f4d2";
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  await writeFile(textPath, text, "utf8");
  await writeFile(imagePath, image);
  try {
    const files = await importComposerFiles(dataRoot, "session-import", [
      textPath,
      imagePath,
    ]);

    assert.deepEqual(files.map((file) => file.name), [
      "notes_with_spaces.txt",
      "marker.png",
    ]);
    assert.deepEqual(files.map((file) => file.kind), ["file", "image"]);
    assert.deepEqual(files.map((file) => file.mimeType), [
      "text/plain",
      "image/png",
    ]);
    assert.notEqual(files[0].path, files[1].path);
    assert.match(
      files[0].path,
      /scratch[\\/]session-import[\\/]pasted[\\/]pasted-.+-notes_with_spaces\.txt$/,
    );
    assert.deepEqual(
      (await readFile(files[0].path)).toString("utf8"),
      text,
    );
    assert.deepEqual(Array.from(await readFile(files[1].path)), Array.from(image));
    // The picker source remains untouched; only the session-owned copies are
    // handed back to the renderer.
    assert.deepEqual((await readFile(textPath)).toString("utf8"), text);
  } finally {
    await Promise.all([
      rm(dataRoot, { recursive: true, force: true }),
      rm(sourceRoot, { recursive: true, force: true }),
    ]);
  }
});

test("picker selections are one-shot, sender-bound capabilities", async () => {
  const {
    consumeComposerPickerSelection,
    rememberComposerPickerSelection,
  } = await import("../electron/main/composer-picker.ts");
  const token = rememberComposerPickerSelection(["/etc/passwd"], 17, 1000);

  assert.deepEqual(consumeComposerPickerSelection(token, 17, 1001), ["/etc/passwd"]);
  assert.throws(
    () => consumeComposerPickerSelection(token, 17, 1002),
    /picker selection is unavailable/,
  );

  const otherToken = rememberComposerPickerSelection(["/tmp/selected.txt"], 17, 2000);
  assert.throws(
    () => consumeComposerPickerSelection(otherToken, 18, 2001),
    /picker selection is unavailable/,
  );
  assert.throws(
    () => consumeComposerPickerSelection(otherToken, 17, 2002),
    /picker selection is unavailable/,
  );

  const expiredToken = rememberComposerPickerSelection(["/tmp/expired.txt"], 17, 3000);
  assert.throws(
    () => consumeComposerPickerSelection(expiredToken, 17, 63001),
    /picker selection is unavailable/,
  );
});

test("file picker exposes files only", () => {
  assert.match(main, /properties: \["openFile", "multiSelections"\]/);
  assert.doesNotMatch(main, /properties: \["openFile", "openDirectory", "multiSelections"\]/);
  assert.doesNotMatch(api, /paths: string\[\]/);
  assert.match(picker, /PICKER_TOKEN_TTL_MS = 60_000/);
});

test("large image attachments avoid whole-file startup reads", () => {
  assert.match(attachments, /async function hashFile\(path: string\)/);
  assert.match(attachments, /createReadStream\(path\)/);
  assert.match(attachments, /const inline = supportsVision && size <= MAX_INLINE_IMAGE_BYTES/);
  assert.match(attachments, /await copyFile\(source, target, fsConstants\.COPYFILE_EXCL\)/);
  assert.doesNotMatch(attachments, /const bytes = readFileSync\(source\.absolute\)/);
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

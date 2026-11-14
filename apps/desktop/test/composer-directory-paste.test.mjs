import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function extract(source, name) {
  const tree = ts.createSourceFile("module.ts", source, ts.ScriptTarget.Latest, true);
  let result;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) result = node.getText(tree).replace(/^export\s+/, "");
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name) result = node.initializer?.getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(result, name);
  return result;
}

function harness(native, { files = [], text = "", items = [], paused, sourceSessionId = "source" } = {}) {
  const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
  const editor = read("../src/features/chat/composer/editor.ts");
  const hook = read("../src/features/chat/composer/hooks/useComposerAttachments.ts");
  const drafts = [], errors = [], writes = [], imported = [], transfers = [], created = [];
  const nativeReads = [], textInsertions = [];
  let revision = 0;
  let activeSessionId = sourceSessionId;
  let workspacePath = "/synthetic/project";
  const element = { textContent: "before after" };
  const context = {
    inputBlocked: false, attachmentsAllowed: true, activeSessionId,
    draftKey: sourceSessionId ?? "home", largePasteThreshold: 1000,
    ref: { current: element }, valueRef: { current: element.textContent },
    previousWorkspacePathRef: { current: "/synthetic/project" },
    snapshotReferences: () => [], invalidateComposerTransforms() {},
    applyEditorDraft: (text, references) => drafts.push({ text, references }),
    showToast(message, options) { if (options?.variant === "error") errors.push(message); },
    t: key => key,
  };
  let sequence = 0;
  const environment = {
    module: { exports: {} }, Array, TextEncoder, crypto,
    context: () => context, ...context, draft: context, isInputBlocked: false,
    setPasting() {}, readEditorValue: editor => editor.textContent,
    editorSelectionRange: () => ({ start: 7, end: 7 }),
    pasteSessionLinks: () => false, parseSessionLinks: () => [],
    showErrorToast: error => errors.push(error.message),
    api: {
      getDroppedFilePath: () => null,
      readClipboardDirectories: async () => { nativeReads.push(true); if (paused) await paused; return native; },
      recordClipboardPaste: async () => {},
      importFiles: async (session, token, reference) => {
        imported.push({ session, token });
        assert.equal(reference, true);
        return { files: [{ path: "/synthetic/original/notes.txt", name: "notes.txt", kind: "file", size: 67108865, localReference: "selection-id" }] };
      },
      pasteFiles: async (_session, payload) => {
        transfers.push(payload);
        return { files: payload.map(file => ({ path: "/synthetic/scratch/" + file.name, name: file.name, kind: "file", mimeType: file.mimeType })) };
      },
    },
    nextChipToken: () => String.fromCodePoint(0xe001 + sequence++),
    createFileReference: (path, name, sessionId, metadata) => ({ path, name, sessionId, ...metadata }),
    draftFileReference: reference => reference,
    writeComposerDraft: (key, snapshot) => writes.push({ key, snapshot }),
    readComposerDraftRevision: () => revision,
    readComposerDraft: () => undefined,
    document: { execCommand: (_command, _showUi, text) => { textInsertions.push(text); return true; } },
    insertClipboardText: (_editor, text) => { textInsertions.push(text); return true; },
    deleteComposerDraft() {}, HOME_DRAFT_KEY: "home",
    useAppStore: { getState: () => ({ activeSessionId, workspace: { path: workspacePath }, sessions: [{ id: "source" }, { id: "created" }] }) },
    materializeDraftSession: async () => { created.push(workspacePath); activeSessionId = "created"; return "created"; },
  };
  const code = extract(editor, "clipboardFiles") + "\n" + extract(editor, "preferClipboardText") + "\nmodule.exports = " + extract(hook, "pasteClipboardFiles");
  vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, environment);
  return {
    drafts, errors, writes, imported, transfers, created, nativeReads, textInsertions,
    edit(text) { element.textContent = text; revision++; },
    switchSession() { activeSessionId = "other"; },
    switchProject() { workspacePath = "/synthetic/other-project"; },
    paste: () => environment.module.exports({ currentTarget: element, preventDefault() {}, clipboardData: { files, items, types: ["Files"], getData: () => text } }),
  };
}

const folder = { kind: "directory", path: "/synthetic/copied folder", name: "copied folder" };
test("paste uses native directory paths even when Chromium exposes no File", async () => {
  const run = harness({ items: [folder], token: null });
  await run.paste();
  assert.equal(run.drafts.length, 1);
  assert.equal(run.drafts[0].references[0].kind, "directory");
  assert.equal(run.drafts[0].references[0].path, folder.path);
  assert.equal(run.drafts[0].text, "before after");
  assert.equal(run.drafts[0].references[0].token, undefined);
  assert.equal(run.imported.length, 0);
  assert.equal(run.transfers.length, 0);
  assert.deepEqual(run.errors, []);
});

test("mixed native folders and files preserve their order and use the existing import token", async () => {
  const run = harness({ items: [folder, { kind: "file", name: "notes.txt" }], token: "native-selection" });
  await run.paste();
  assert.equal(run.drafts.length, 1);
  assert.deepEqual(Array.from(run.drafts[0].references, reference => reference.kind), ["directory", "file"]);
  assert.equal(run.drafts[0].text, "before \ue001after");
  assert.deepEqual(run.imported, [{ session: "source", token: "native-selection" }]);
});

test("pending directory paste stays with its captured session", async () => {
  let resume;
  const paused = new Promise(resolve => { resume = resolve; });
  const run = harness({ items: [folder], token: null }, { paused });
  const pending = run.paste();
  run.switchSession();
  resume();
  await pending;
  assert.equal(run.drafts.length, 0);
  assert.equal(run.writes[0].key, "source");
  assert.equal(run.writes[0].snapshot.fileReferences[0].path, folder.path);
});

test("directory paste preserves edits made while native metadata is pending", async () => {
  let resume;
  const paused = new Promise(resolve => { resume = resolve; });
  const run = harness({ items: [folder], token: null }, { paused });
  const pending = run.paste();
  run.edit("newer edits remain");
  resume();
  await pending;
  assert.equal(run.drafts[0].text, "newer edits remain");
});

test("native directory paste never reads browser directory bytes", async () => {
  const directory = new File([], "copied folder", { type: "application/x-directory" });
  directory.arrayBuffer = () => assert.fail("directory bytes were read");
  const run = harness({ items: [folder], token: null }, { files: [directory] });
  await run.paste();
  assert.equal(run.drafts[0].references[0].kind, "directory");
  assert.equal(run.transfers.length, 0);
});

test("ordinary native files keep their existing byte attachment flow", async () => {
  const run = harness(null, { files: [new File(["notes"], "notes.txt", { type: "text/plain" })] });
  await run.paste();
  assert.equal(run.drafts[0].references[0].kind, "file");
  assert.equal(run.transfers.length, 1);
  assert.equal(new TextDecoder().decode(run.transfers[0][0].data), "notes");
});

test("native large-file paste keeps original path and size without reading browser bytes", async () => {
  const file = new File([], "notes.txt", { type: "text/plain" });
  file.arrayBuffer = () => assert.fail("disk file contents must not cross IPC");
  const run = harness({ items: [{ kind: "file", name: "notes.txt" }], token: "selection" }, { files: [file] });
  await run.paste();
  assert.equal(run.drafts[0].references[0].path, "/synthetic/original/notes.txt");
  assert.equal(run.drafts[0].references[0].size, 67108865);
  assert.equal(run.drafts[0].references[0].localReference, "selection-id");
  assert.equal(run.writes[0].snapshot.fileReferences[0].size, 67108865);
  assert.deepEqual(run.transfers, []);
});

for (const navigate of ["switchSession", "switchProject"]) {
  test(`pending home folder paste cannot materialize in a destination after ${navigate}`, async () => {
    let resume;
    const paused = new Promise(resolve => { resume = resolve; });
    const run = harness({ items: [folder], token: null }, { paused, sourceSessionId: null });
    const pending = run.paste();
    run[navigate]();
    resume();
    await pending;
    assert.deepEqual(run.created, []);
    assert.deepEqual(run.writes, []);
    assert.deepEqual(run.drafts, []);
  });
}

test("home folder paste materializes only its original unchanged workspace", async () => {
  const run = harness({ items: [folder], token: null }, { sourceSessionId: null });
  await run.paste();
  assert.deepEqual(run.created, ["/synthetic/project"]);
  assert.equal(run.drafts[0].references[0].sessionId, "created");
});

test("Word text plus a generated image keeps text paste without a native file read", async () => {
  const run = harness(null, { text: "Copied text from Word", files: [new File([], "image.png", { type: "image/png" })] });
  await run.paste();
  assert.deepEqual(run.errors, []);
  assert.deepEqual(run.nativeReads, []);
  assert.deepEqual(run.textInsertions, ["Copied text from Word"]);
});

test("screenshot-only paste transfers image bytes without waiting for native directory discovery", async () => {
  const image = new File(["screenshot bytes"], "image.png", { type: "image/png" });
  const run = harness(null, { files: [image] });
  await run.paste();
  assert.deepEqual(run.errors, []);
  assert.deepEqual(run.nativeReads, []);
  assert.equal(run.transfers.length, 1);
  assert.equal(new TextDecoder().decode(run.transfers[0][0].data), "screenshot bytes");
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { mkdir, mkdtemp, open, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pasteComposerClipboardFiles, referenceComposerFiles, resolveComposerFileReference } from "../electron/main/composer-file-references.ts";
import { preparePromptAttachments, appendPromptFallbackPaths } from "../electron/main/prompt-attachments.ts";
import { appendLocalFileReferenceContext } from "@pi-desktop/shared";
import { consumeComposerPickerSelection, rememberComposerPickerSelection } from "../electron/main/composer-picker.ts";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-file-reference-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, "data"), project = join(root, "project"), other = join(root, "other");
  await Promise.all([data, project, other].map(path => mkdir(path)));
  const path = join(root, "outside project & 中文.bin");
  const file = await open(path, "w");
  await file.truncate(64 * 1024 * 1024 + 1);
  await file.close();
  return { root, data, project, other, path };
}

test("large disk file becomes metadata, survives a new session, and refreshes size on send", async t => {
  const { data, project, path } = await fixture(t);
  const [reference] = await referenceComposerFiles(data, "source", project, [path]);
  assert.equal(reference.path, path);
  assert.equal(reference.size, 67108865);
  assert.equal(reference.kind, "file");
  assert.deepEqual(await readdir(data), ["composer-file-references"], "no scratch copy or content-addressed blob");
  await writeFile(path, "changed");
  const [prepared] = await preparePromptAttachments(data, "restored", project, [{ ...reference, size: 1 }], true, `Review @"${path}"`);
  assert.equal(prepared.message.size, 7, "renderer size is not authoritative");
  assert.equal(prepared.message.localReference, reference.localReference);
  assert.equal(prepared.inlineData, undefined);
  const prompt = appendPromptFallbackPaths("Review", [prepared]);
  assert.ok(prompt.includes(path));
  assert.ok(prompt.includes("7 bytes"));
  assert.equal(appendLocalFileReferenceContext(prompt, [{ ...prepared.message, path }]), prompt, "history replay is idempotent");
  assert.deepEqual(await readdir(data), ["composer-file-references"]);
});

test("disk metadata and project line ranges remain distinct in a mixed prompt", async t => {
  const { data, project, path } = await fixture(t);
  const [reference] = await referenceComposerFiles(data, "source", project, [path]);
  const source = join(project, "gpt.py");
  await writeFile(source, "first\nsecond\n");
  const line = { kind: "file", path: source, name: "gpt.py", lineRange: { start: 1, end: 2 } };
  const prepared = await preparePromptAttachments(data, "source", project, [reference, line], false, "Compare");
  assert.equal(prepared.length, 2);
  assert.equal(prepared[0].message.localReference, reference.localReference);
  assert.equal(prepared[0].message.size, 67108865);
  assert.deepEqual(prepared[1].message.lineRange, line.lineRange);
  const prompt = appendPromptFallbackPaths("Compare", prepared);
  assert.ok(prompt.includes("67108865 bytes"));
  assert.ok(!prompt.includes(source), "line ranges are resolved by the scoped runtime Read");
  assert.deepEqual(await readdir(data), ["composer-file-references"]);
  for (const attachment of [{ ...reference, lineRange: line.lineRange }, { ...line, localReference: reference.localReference }]) {
    await assert.rejects(preparePromptAttachments(data, "source", project, [attachment], false, "Inspect"), { errorCode: "INVALID_ARGUMENT" });
  }
});

test("selection records reject forged paths, another project, remote context, and redirected files", async t => {
  const { data, project, other, path, root } = await fixture(t);
  const [reference] = await referenceComposerFiles(data, "source", project, [path]);
  const resolve = (projectPath, source = path, id = reference.localReference) => resolveComposerFileReference(data, projectPath, source, id);
  await assert.rejects(resolve(other), /does not belong/);
  await assert.rejects(resolve(undefined), /unavailable/);
  await assert.rejects(resolve(project, path, "../../escape"), /unavailable/);
  await assert.rejects(resolve(project, join(root, "forged")), /does not belong/);
  const moved = join(root, "moved.bin");
  await rename(path, moved);
  await assert.rejects(resolve(project), /Referenced file is unavailable/);
  await symlink(moved, path);
  await assert.rejects(resolve(project), /Referenced file is unavailable/);
});

test("a reference to an image remains metadata and never hydrates outside-project image bytes", async t => {
  const { data, project, path } = await fixture(t);
  const image = path + ".png";
  await rename(path, image);
  const [reference] = await referenceComposerFiles(data, "source", project, [image]);
  const [prepared] = await preparePromptAttachments(data, "source", project, [reference], true, "Inspect");
  assert.equal(prepared.message.kind, "file");
  assert.equal(prepared.inlineData, undefined);
  await assert.rejects(preparePromptAttachments(data, "source", project, [{ ...reference, localReference: undefined }], true, "Inspect"), /outside the session roots/);
});

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNo2PDgPwAG1AMQ/5r/oAAAAABJRU5ErkJggg==", "base64");

test("native clipboard images are copied like picker imports while other files stay live references (#2529)", async t => {
  const { root, data, project, path } = await fixture(t);
  const image = join(root, "PixPin_2026-11-23_14-37-54.png");
  const notes = join(root, "notes.txt");
  await writeFile(image, PNG);
  await writeFile(notes, "notes");
  const files = await pasteComposerClipboardFiles(data, "source", project, [notes, image, path]);
  assert.deepEqual(files.map(file => file.name), ["notes.txt", "PixPin_2026-11-23_14-37-54.png", "outside project & 中文.bin"], "paste order is preserved");
  assert.equal(files[0].localReference !== undefined, true);
  assert.equal(files[2].localReference !== undefined, true);
  const [, pasted] = files;
  assert.equal(pasted.kind, "image");
  assert.equal(pasted.localReference, undefined);
  assert.equal(pasted.size, PNG.length);
  assert.ok(pasted.path.startsWith(join(data, "scratch", "source", "pasted")), "image is materialized in session scratch");
  assert.deepEqual(readFileSync(pasted.path), PNG);
  // The screenshot tool may clear its temp file before the user sends.
  await rm(image);
  const prepared = await preparePromptAttachments(data, "source", project, files, true, "What is in this screenshot?");
  assert.equal(prepared[1].message.kind, "image");
  assert.ok(prepared[1].inlineData, "vision models receive the image bytes");
  assert.match(prepared[1].message.ref, /^attachments\/[0-9a-f]{64}$/);
  assert.equal(prepared[0].inlineData, undefined);
  assert.equal(prepared[2].inlineData, undefined);
});

test("native clipboard images beyond the import bounds, SVGs, and non-images keep the reference flow", async t => {
  const { root, data, project } = await fixture(t);
  const large = join(root, "huge.png");
  const handle = await open(large, "w");
  await handle.truncate(64 * 1024 * 1024 + 1);
  await handle.close();
  const svg = join(root, "icon.svg");
  await writeFile(svg, "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
  const batch = [];
  for (let index = 0; index < 3; index++) {
    const part = join(root, `part-${index}.png`);
    const file = await open(part, "w");
    await file.truncate(60 * 1024 * 1024);
    await file.close();
    batch.push(part);
  }
  const files = await pasteComposerClipboardFiles(data, "source", project, [large, svg, ...batch]);
  assert.deepEqual(files.map(file => file.localReference !== undefined), [true, true, false, false, true], "the batch byte budget overflows to references");
  assert.deepEqual(files.map(file => file.kind), ["file", "file", "image", "image", "file"]);
});

test("native clipboard images paste without a local project; other files still require one", async t => {
  const { root, data } = await fixture(t);
  const image = join(root, "remote.png");
  await writeFile(image, PNG);
  const [pasted] = await pasteComposerClipboardFiles(data, "source", undefined, [image]);
  assert.equal(pasted.kind, "image");
  await writeFile(join(root, "notes.txt"), "notes");
  await assert.rejects(pasteComposerClipboardFiles(data, "source", undefined, [image, join(root, "notes.txt")]), /require a local project/);
  await assert.rejects(pasteComposerClipboardFiles(data, "source", undefined, [join(root, "missing.png")]));
});

test("native selection IPC binds sender and session before registering and dispatching a large reference", async t => {
  const { data, project, path } = await fixture(t);
  const source = readFileSync(new URL("../electron/main/ipc/workspace-ipc.ts", import.meta.url), "utf8");
  const tree = ts.createSourceFile("workspace.ts", source, ts.ScriptTarget.Latest, true);
  let callback;
  function visit(node) {
    if (ts.isCallExpression(node) && node.arguments[0]?.getText(tree) === "IPC.invoke.composerImportFiles") callback = node.arguments[1];
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(callback);
  const code = ts.transpileModule(`(${callback.getText(tree)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const sessions = { source: { projectPath: project }, remote: { projectPath: project, remoteWorkspace: { id: "remote" } } };
  const host = { call: async (_method, input) => ({ session: sessions[input.id] ?? null }) };
  const handler = vm.runInNewContext(code, {
    host, getHost: () => host, dataDir: data,
    assertMainWindowSender: event => assert.equal(event.sender.id, 1, "main sender required"),
    consumeComposerPickerSelection, pasteComposerClipboardFiles,
    importComposerFiles: () => assert.fail("native clipboard files must not use the picker importer directly"),
    ErrorCodes: { NOT_FOUND: "NOT_FOUND", INVALID_ARGUMENT: "INVALID_ARGUMENT" },
  });
  const input = { sessionId: "source", token: rememberComposerPickerSelection([path], 1), reference: true };
  await assert.rejects(handler({ sender: { id: 2 } }, input), /main sender/);
  await assert.rejects(handler({ sender: { id: 1 } }, { ...input, sessionId: "deleted" }), /session not found/);
  const { files } = await handler({ sender: { id: 1 } }, input);
  assert.equal(files[0].path, path);
  assert.equal(files[0].size, 67108865);
  await assert.rejects(handler({ sender: { id: 1 } }, input), /selection is unavailable/);
  const remote = { sessionId: "remote", token: rememberComposerPickerSelection([path], 1), reference: true };
  await assert.rejects(handler({ sender: { id: 1 } }, remote), /require a local project/);
  const [prepared] = await preparePromptAttachments(data, "source", project, files, false, "Inspect");
  assert.equal(prepared.message.size, 67108865);
  assert.ok(appendPromptFallbackPaths("Inspect", [prepared]).includes("67108865 bytes"));
  assert.deepEqual(await readdir(data), ["composer-file-references"]);
});

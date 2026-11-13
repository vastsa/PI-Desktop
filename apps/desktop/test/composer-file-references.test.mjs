import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { mkdir, mkdtemp, open, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { referenceComposerFiles, resolveComposerFileReference } from "../electron/main/composer-file-references.ts";
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
  const host = { call: async (_method, input) => ({ session: input.id === "source" ? { projectPath: project } : null }) };
  const handler = vm.runInNewContext(code, {
    host, getHost: () => host, dataDir: data,
    assertMainWindowSender: event => assert.equal(event.sender.id, 1, "main sender required"),
    consumeComposerPickerSelection, referenceComposerFiles,
    importComposerFiles: () => assert.fail("reference must not invoke the byte importer"),
    ErrorCodes: { NOT_FOUND: "NOT_FOUND", INVALID_ARGUMENT: "INVALID_ARGUMENT" },
  });
  const input = { sessionId: "source", token: rememberComposerPickerSelection([path], 1), reference: true };
  await assert.rejects(handler({ sender: { id: 2 } }, input), /main sender/);
  await assert.rejects(handler({ sender: { id: 1 } }, { ...input, sessionId: "deleted" }), /session not found/);
  const { files } = await handler({ sender: { id: 1 } }, input);
  assert.equal(files[0].path, path);
  assert.equal(files[0].size, 67108865);
  await assert.rejects(handler({ sender: { id: 1 } }, input), /selection is unavailable/);
  const [prepared] = await preparePromptAttachments(data, "source", project, files, false, "Inspect");
  assert.equal(prepared.message.size, 67108865);
  assert.ok(appendPromptFallbackPaths("Inspect", [prepared]).includes("67108865 bytes"));
  assert.deepEqual(await readdir(data), ["composer-file-references"]);
});

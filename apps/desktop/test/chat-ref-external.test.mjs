import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { isChatRefOutsideRoots, resolveChatFileRef, resolveExternalChatRef } = await import(
  "../../../packages/host-runtime/src/chat-ref-resolve.ts"
);
const { readUserOpenableFile, resolveExternalFile, resolveUserOpenablePath } =
  await import("../../../packages/host-runtime/src/external-files.ts");

/**
 * Issue #1837 / ADR 0339: the agent names a file by its exact absolute path
 * outside the open project (a download, a chat client's folder, the temp
 * directory) and the user clicks it. That click must open that exact file, and
 * no same-name file is looked up anywhere else.
 */

function tempTree(name, files) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `pi-ext-ref-${name}-`)));
  for (const file of files) {
    const target = join(root, ...file.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${file}\n`);
  }
  return root;
}

function projectRoots(workspace, extra = {}) {
  return { project: [{ path: workspace, name: "ws", primary: true }], ...extra };
}

test("an exact absolute path outside every root resolves to that file", async () => {
  const workspace = tempTree("ws", ["src/a.ts"]);
  const outside = tempTree("outside", ["专业实践 考核.txt", "notes/report.md"]);
  const target = join(outside, "专业实践 考核.txt");
  const roots = projectRoots(workspace);

  assert.equal(await isChatRefOutsideRoots(target, roots), true);
  assert.equal(await resolveChatFileRef(target, roots), null);
  const result = await resolveExternalChatRef(target);
  assert.deepEqual(result, {
    match: {
      root: "external",
      relativePath: "专业实践 考核.txt",
      absolutePath: target,
      matchedBy: "exact-absolute",
    },
  });

  const withLine = await resolveExternalChatRef(`${join(outside, "notes", "report.md")}:3`);
  assert.equal(withLine.match?.absolutePath, join(outside, "notes", "report.md"));
  const withAnchor = await resolveExternalChatRef(`${join(outside, "notes", "report.md")}#L2-L4`);
  assert.equal(withAnchor.match?.absolutePath, join(outside, "notes", "report.md"));
});

test("a missing external file is a miss, not an access limit", async () => {
  const outside = tempTree("missing", ["here.txt"]);
  assert.deepEqual(await resolveExternalChatRef(join(outside, "gone.txt")), { match: null });
  assert.deepEqual(await resolveExternalChatRef(join(outside)), { match: null });
});

test("a shorthand never resolves outside the managed roots", async () => {
  const workspace = tempTree("ws-short", ["src/a.ts"]);
  const roots = projectRoots(workspace);
  assert.equal(await isChatRefOutsideRoots("report.md", roots), false);
  assert.equal(await resolveChatFileRef("report.md", roots), null);
  assert.equal((await resolveExternalChatRef("report.md")).match, null);
  assert.equal((await resolveExternalChatRef("~/report.md")).match, null);
  assert.equal((await resolveExternalFile("notes/report.md")).kind, "notAbsolute");
});

test("dotfiles and credential-looking paths open like any other file", async () => {
  // A click only shows the file to the user on this machine; nothing reaches
  // the model or the network, so no path shape is withheld (ADR 0339).
  const outside = tempTree("dot", [".ssh/config", "app/.env", "keys/server.pem", "repo/.git/config"]);
  for (const file of [".ssh/config", "app/.env", "keys/server.pem", "repo/.git/config"]) {
    const target = join(outside, ...file.split("/"));
    assert.deepEqual(await resolveExternalChatRef(target), {
      match: {
        root: "external",
        relativePath: file.split("/").pop(),
        absolutePath: target,
        matchedBy: "exact-absolute",
      },
    }, file);
  }
});

test("symlinks and dot-dot spellings resolve to the real file", async () => {
  const outside = tempTree("link", ["data/real.txt", "plain/readme.txt"]);
  const link = join(outside, "plain", "alias.txt");
  symlinkSync(join(outside, "data", "real.txt"), link);
  assert.equal((await resolveExternalChatRef(link)).match?.absolutePath, join(outside, "data", "real.txt"));
  const dotted = `${join(outside, "plain")}/../data/real.txt`;
  assert.deepEqual(await resolveExternalFile(dotted), { kind: "file", path: join(outside, "data", "real.txt") });
  const dangling = join(outside, "plain", "dangling.txt");
  symlinkSync(join(outside, "data", "gone.txt"), dangling);
  assert.deepEqual(await resolveExternalFile(dangling), { kind: "missing" });
});

test("scratch keeps answering through containment before the external rule", async () => {
  const dataDir = tempTree("data", ["scratch/s1/out.md"]);
  const scratch = join(dataDir, "scratch");
  assert.equal(
    await resolveUserOpenablePath(join(scratch, "s1", "out.md"), null, [scratch]),
    join(scratch, "s1", "out.md"),
  );
});

test("fs/read admits an exact absolute external file but never a shorthand", async () => {
  const workspace = tempTree("ws-read", ["src/a.ts"]);
  const outside = tempTree("read", ["report.md", ".ssh/config"]);
  const preview = await readUserOpenableFile(join(outside, "report.md"), workspace, []);
  assert.equal(preview.kind, "text");
  assert.equal(preview.content, "report.md\n");
  const dotfile = await readUserOpenableFile(join(outside, ".ssh", "config"), workspace, []);
  assert.equal(dotfile.content, ".ssh/config\n");
  await assert.rejects(readUserOpenableFile(outside, workspace, []), /path outside allowed roots/);
  await assert.rejects(readUserOpenableFile("report.md", workspace, []), /path outside allowed roots/);
  const inside = await readUserOpenableFile("src/a.ts", workspace, []);
  assert.equal(inside.content, "src/a.ts\n");
});

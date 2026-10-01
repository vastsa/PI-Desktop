import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { isChatRefOutsideRoots, parseChatRef, resolveChatFileRef } = await import(
  "../electron/main/chat-ref-resolve.ts"
);

/**
 * The resolver takes the open project's folders, primary first (ADR 0263). A
 * single-folder project is a one-element list, so tests that do not care about
 * groups keep the earlier `{ workspace }` spelling through this shorthand.
 */
function folder(path, primary = true) {
  const name = String(path).split(/[\\/]/).filter(Boolean).at(-1) ?? String(path);
  return { path, name, primary };
}

function roots(options) {
  const { workspace, project, ...rest } = options ?? {};
  if (project) return { ...rest, project };
  return { ...rest, project: workspace ? [folder(workspace)] : [] };
}

const resolve = (ref, options) => resolveChatFileRef(ref, roots(options));

/**
 * Partial-path completion for chat file references.
 *
 * The reported defect: an agent writes `/root/dir/openimage.js` in a tool call
 * but names only `openimage.js` in its reply, so the click resolved to a
 * workspace-root path that does not exist and the panel opened blank. The
 * contract under test is the product priority — the open project answers
 * first, the session scratch store second — plus the "best" rule inside one
 * root: longest matching tail, then shallowest path.
 */

function tempTree(name, files) {
  const root = mkdtempSync(join(tmpdir(), `pi-chat-ref-${name}-`));
  for (const file of files) {
    const target = join(root, ...file.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${file}\n`);
  }
  return root;
}

function relOf(match, root) {
  return match ? match.relativePath : null;
}

test("a workspace-relative hit is exact and wins over every other root", async () => {
  const workspace = tempTree("ws", ["openimage.js"]);
  const scratch = tempTree("scratch", ["openimage.js"]);
  const match = await resolve("openimage.js", { workspace, scratch });
  assert.equal(match?.root, "workspace");
  assert.equal(match?.matchedBy, "exact-relative");
  assert.equal(relOf(match, workspace), "openimage.js");
  assert.equal(match?.absolutePath, join(workspace, "openimage.js"));
});

test("a multi-segment relative hit is exact before any fuzzy rule", async () => {
  const workspace = tempTree("ws", ["src/dir/a.ts"]);
  const match = await resolve("src/dir/a.ts", { workspace });
  assert.equal(match?.matchedBy, "exact-relative");
  assert.equal(match?.relativePath, "src/dir/a.ts");
});

test("a bare leaf name resolves through the workspace index", async () => {
  const workspace = tempTree("ws", ["src/dir/openimage.js"]);
  const match = await resolve("openimage.js", { workspace });
  assert.equal(match?.root, "workspace");
  assert.equal(match?.matchedBy, "basename");
  assert.equal(match?.relativePath, "src/dir/openimage.js");
});

test("an absolute path outside the project cannot select a same-name file by tail", async () => {
  const workspace = tempTree("ws", ["src/dir/openimage.js"]);
  const match = await resolve("/root/dir/openimage.js", { workspace });
  assert.equal(match, null);
  const unc = "\\\\server\\my share\\openimage.js";
  assert.equal(parseChatRef(unc)?.absolute, true);
  assert.equal(await isChatRefOutsideRoots(unc, roots({ workspace })), true);
  assert.equal(await resolve(unc, { workspace }), null);
});

test("an exact absolute path with spaces resolves only inside an allowed root", async () => {
  const workspace = tempTree("spaced ws", ["my project/page.md", "other/page.md"]);
  const absolute = join(workspace, "my project", "page.md");
  const match = await resolve(absolute, { workspace });
  assert.equal(match?.matchedBy, "exact-absolute");
  assert.equal(match?.absolutePath, absolute);
  assert.equal(await resolve(join(dirname(workspace), "page.md"), { workspace }), null);
  assert.equal(await isChatRefOutsideRoots(absolute, roots({ workspace })), false);
  assert.equal(await isChatRefOutsideRoots(join(dirname(workspace), "page.md"), roots({ workspace })), true);
});

test("an absolute realpath alias resolves under the same registered root", async () => {
  const workspace = tempTree("alias-target", ["my project/page.md"]);
  const aliasParent = mkdtempSync(join(tmpdir(), "pi-chat-ref-alias-"));
  const alias = join(aliasParent, "linked-project");
  symlinkSync(workspace, alias, process.platform === "win32" ? "junction" : "dir");
  const target = join(workspace, "my project", "page.md");
  const project = [folder(alias)];
  assert.equal(await isChatRefOutsideRoots(target, { project }), false);
  const match = await resolveChatFileRef(target, { project });
  assert.equal(match?.matchedBy, "exact-absolute");
  assert.equal(match?.relativePath, "my project/page.md");
  assert.equal(match?.absolutePath, target);
  const missing = join(workspace, "my project", "missing.md");
  assert.equal(await isChatRefOutsideRoots(missing, { project }), false);
  assert.equal(await resolveChatFileRef(missing, { project }), null);
  assert.equal((await resolveChatFileRef("my project/page.md", { project }))?.relativePath, "my project/page.md");
});

test("an in-root symlink cannot resolve a file outside the registered root", async () => {
  const workspace = tempTree("symlink-root", ["safe.md"]);
  const outside = tempTree("symlink-outside", ["page.md"]);
  symlinkSync(outside, join(workspace, "linked"), process.platform === "win32" ? "junction" : "dir");
  const ref = join(workspace, "linked", "page.md");
  assert.equal(await isChatRefOutsideRoots(ref, roots({ workspace })), true);
  assert.equal(await resolve(ref, { workspace }), null);
  assert.equal(await isChatRefOutsideRoots(join(workspace, "linked", "missing.md"), roots({ workspace })), true);
});

test("an exact relative symlink escape does not fall back to a same-name file", async () => {
  const workspace = tempTree("relative-escape", ["other/linked/page.md"]);
  const outside = tempTree("relative-outside", ["page.md"]);
  symlinkSync(outside, join(workspace, "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(await resolve("linked/page.md", { workspace }), null);

  const scratch = tempTree("scratch-escape", []);
  symlinkSync(outside, join(scratch, "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(await resolve("linked/page.md", { scratch }), null);
});

test("an exact relative link within its root remains resolvable", async () => {
  const workspace = tempTree("relative-inside", ["docs/page.md"]);
  symlinkSync(join(workspace, "docs"), join(workspace, "linked"), process.platform === "win32" ? "junction" : "dir");
  const match = await resolve("linked/page.md", { workspace });
  assert.equal(match?.matchedBy, "exact-relative");
  assert.equal(match?.relativePath, "linked/page.md");
});

test("a stale fuzzy index skips escaped and missing candidates in priority order", async () => {
  const workspace = tempTree("stale-index", ["a/page.md", "b/page.md", "c/page.md"]);
  assert.equal((await resolve("page.md", { workspace }))?.relativePath, "a/page.md");
  renameSync(join(workspace, "a"), join(workspace, "old-a"));
  renameSync(join(workspace, "b"), join(workspace, "old-b"));
  const outside = tempTree("stale-outside", ["page.md"]);
  symlinkSync(outside, join(workspace, "a"), process.platform === "win32" ? "junction" : "dir");
  assert.equal((await resolve("page.md", { workspace }))?.relativePath, "c/page.md");
});

test("a dangling relative link, including a middle directory, does not fall back", async () => {
  const workspace = tempTree("dangling-link", ["other/linked/page.md"]);
  symlinkSync(join(workspace, "missing"), join(workspace, "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(await resolve("linked/page.md", { workspace }), null);

  const terminal = tempTree("dangling-terminal", ["other/linked"]);
  symlinkSync(join(terminal, "missing"), join(terminal, "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(await resolve("linked", { workspace: terminal }), null);

  const scratch = tempTree("dangling-scratch", ["other/linked/page.md"]);
  symlinkSync(join(scratch, "missing"), join(scratch, "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(await resolve("linked/page.md", { scratch }), null);
});

test("a longer matching tail beats a bare leaf name", async () => {
  const workspace = tempTree("ws", ["deep/openimage.js", "src/dir/openimage.js"]);
  const match = await resolve("dir/openimage.js", { workspace });
  assert.equal(match?.matchedBy, "path-suffix");
  assert.equal(match?.relativePath, "src/dir/openimage.js");
});

test("the shallowest candidate wins when the tail length ties", async () => {
  const workspace = tempTree("ws", ["a/b/openimage.js", "openimage.js"]);
  const match = await resolve("openimage.js", { workspace });
  assert.equal(match?.relativePath, "openimage.js");
});

test("the project answers before the session scratch store", async () => {
  const workspace = tempTree("ws", ["notes/openimage.js"]);
  const scratch = tempTree("scratch", ["openimage.js"]);
  const match = await resolve("openimage.js", { workspace, scratch });
  assert.equal(match?.root, "workspace");
  assert.equal(match?.relativePath, "notes/openimage.js");
});

test("the session scratch store answers when the project has nothing", async () => {
  const workspace = tempTree("ws", ["src/index.ts"]);
  const scratch = tempTree("scratch", ["deeper/openimage.js"]);
  const match = await resolve("openimage.js", { workspace, scratch });
  assert.equal(match?.root, "scratch");
  assert.equal(match?.relativePath, "deeper/openimage.js");
  assert.equal(match?.matchedBy, "basename");
});

test("an absolute scratch path matches exactly inside that root", async () => {
  const workspace = tempTree("ws", ["src/index.ts"]);
  const scratch = tempTree("scratch", ["tmp/openimage.js"]);
  const absolute = join(scratch, "tmp", "openimage.js");
  const match = await resolve(absolute, { workspace, scratch });
  assert.equal(match?.root, "scratch");
  assert.equal(match?.matchedBy, "exact-absolute");
  assert.equal(match?.relativePath, "tmp/openimage.js");
  assert.equal(match?.absolutePath, absolute);
});

test("the attachment store is the last root searched", async () => {
  const scratch = tempTree("scratch", []);
  const attachments = tempTree("attachments", ["openimage.js"]);
  const match = await resolve("openimage.js", { scratch, attachments });
  assert.equal(match?.root, "attachments");
  assert.equal(match?.relativePath, "openimage.js");
});

test("a path that exists nowhere resolves to null instead of a guess", async () => {
  const workspace = tempTree("ws", ["src/index.ts"]);
  const scratch = tempTree("scratch", ["other.js"]);
  assert.equal(
    await resolve("missing/openimage.js", { workspace, scratch }),
    null,
  );
  assert.equal(await resolve("openimage.js", {}), null);
  assert.equal(
    await resolve("openimage.js", { workspace: tempTree("empty", []) }),
    null,
  );
});

test("ignored directories are not searched", async () => {
  const workspace = tempTree("ws", ["node_modules/openimage.js", ".git/openimage.js"]);
  assert.equal(await resolve("openimage.js", { workspace }), null);
});

test("a directory with a matching name never matches", async () => {
  const workspace = tempTree("ws", ["openimage.js/placeholder.txt"]);
  assert.equal(await resolve("openimage.js", { workspace }), null);
});

test("a content-addressed attachment blob resolves against the attachment store", async () => {
  const digest = "a".repeat(64);
  const attachments = tempTree("attachments", [digest]);
  const scratch = tempTree("scratch", []);
  const match = await resolve(`attachments/${digest}`, {
    scratch,
    attachments,
  });
  assert.equal(match?.root, "attachments");
  assert.equal(match?.relativePath, digest);
  assert.equal(match?.absolutePath, join(attachments, digest));
  // A blob whose payload is gone must not resolve to a path guess.
  assert.equal(
    await resolve(`attachments/${"b".repeat(64)}`, { attachments }),
    null,
  );
});

test("an attachment link cannot escape its store", async () => {
  const digest = "c".repeat(64);
  const attachments = tempTree("attachment-link", []);
  const outside = tempTree("attachment-outside", ["page.md"]);
  if (process.platform === "win32") {
    symlinkSync(outside, join(attachments, "linked"), "junction");
    assert.equal(await resolve("linked/page.md", { attachments }), null);
  } else {
    symlinkSync(join(outside, "page.md"), join(attachments, digest), "file");
    assert.equal(await resolve(`attachments/${digest}`, { attachments }), null);
  }
});

test("an attachment blob reference rejects invalid hash formats or non-hex characters", async () => {
  const attachments = tempTree("attachments", ["not-a-valid-sha256"]);
  assert.equal(
    await resolve("attachments/not-a-valid-sha256", { attachments }),
    null,
  );
  assert.equal(
    await resolve("Attachments/not-a-valid-sha256", { attachments }),
    null,
  );
  assert.equal(
    await resolve(`attachments/${"z".repeat(64)}`, { attachments }),
    null,
  );
  assert.equal(
    await resolve("attachments/..%2F..%2Fsecrets", { attachments }),
    null,
  );
});

test("line and column references are stripped before matching", async () => {
  const workspace = tempTree("ws", ["src/a.ts"]);
  const match = await resolve("src/a.ts:12:4", { workspace });
  assert.equal(match?.relativePath, "src/a.ts");
});

test("the composer sigil and quoting are tolerated", async () => {
  const workspace = tempTree("ws", ["src/a.ts"]);
  assert.equal((await resolve("@src/a.ts", { workspace }))?.relativePath, "src/a.ts");
  assert.equal(
    (await resolve('@"src/a.ts"', { workspace }))?.relativePath,
    "src/a.ts",
  );
});

test("parseChatRef rejects home paths, escapes, and oversized tokens", () => {
  assert.equal(parseChatRef("~/secrets.txt"), null);
  assert.equal(parseChatRef("../../etc/passwd"), null);
  assert.equal(parseChatRef(""), null);
  assert.equal(parseChatRef("   "), null);
  assert.equal(parseChatRef(`${"a".repeat(600)}.ts`), null);
  assert.deepEqual(parseChatRef("./src/../src/a.ts"), {
    segments: ["src", "a.ts"],
    absolute: false,
  });
  assert.deepEqual(parseChatRef("/root/dir/a.ts"), {
    segments: ["root", "dir", "a.ts"],
    absolute: true,
  });
});


test("a match in a sibling folder names the folder it answered from", async () => {
  const primary = tempTree("primary", ["src/index.ts"]);
  const sibling = tempTree("sibling", ["src/dir/openimage.js"]);
  const match = await resolve("openimage.js", {
    project: [folder(primary), folder(sibling, false)],
  });
  assert.equal(match?.root, "workspace");
  assert.equal(match?.relativePath, "src/dir/openimage.js");
  assert.equal(match?.projectRoot?.path, sibling);
  assert.equal(match?.projectRoot?.primary, false);
  // The absolute path is what the caller uses for a non-primary folder.
  assert.equal(match?.absolutePath, join(sibling, "src", "dir", "openimage.js"));
});

test("the primary folder answers before its siblings, in group order", async () => {
  // Both folders can answer the same shorthand; the group's own order decides,
  // so the folder the agent's tools default to wins.
  const primary = tempTree("primary", ["a/openimage.js"]);
  const sibling = tempTree("sibling", ["openimage.js"]);
  const inPrimary = await resolve("openimage.js", {
    project: [folder(primary), folder(sibling, false)],
  });
  assert.equal(inPrimary?.projectRoot?.path, primary);
  assert.equal(inPrimary?.projectRoot?.primary, true);
  assert.equal(inPrimary?.relativePath, "a/openimage.js");

  // Reverse the order and the sibling answers instead: nothing about the match
  // is hardcoded to the primary folder.
  const swapped = await resolve("openimage.js", {
    project: [folder(sibling, true), folder(primary, false)],
  });
  assert.equal(swapped?.relativePath, "openimage.js");
  assert.equal(swapped?.projectRoot?.path, sibling);
});

test("a project folder never loses to the scratch store", async () => {
  const primary = tempTree("primary", ["src/index.ts"]);
  const sibling = tempTree("sibling", ["openimage.js"]);
  const scratch = tempTree("scratch", ["openimage.js"]);
  const match = await resolve("openimage.js", {
    project: [folder(primary), folder(sibling, false)],
    scratch,
  });
  assert.equal(match?.root, "workspace");
  assert.equal(match?.projectRoot?.path, sibling);
});

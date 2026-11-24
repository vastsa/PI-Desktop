"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const FILE_LIMIT = 100;
const PATCH_BYTES = 96 * 1024;
const LOG = ["log", "--no-patch", "--no-color", "--no-notes", "--no-decorate", "--no-show-signature", "-z",
  "--format=%H%x00%P%x00%an%x00%aI%x00%s"];
const safeModes = new Set(["000000", "100644", "100755"]);
const clean = (s, n) => s.slice(0, n).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ");
const line = r => r.stdout.toString("utf8").replace(/\r?\n$/, "");

function createGitHistory({ gitContext, panelCommand, gitFileAllowed, fail }) {
  const stale = () => fail("GIT_STALE", "The selected folder or branch changed. Refresh history.");
  const invalid = () => fail("GIT_COMMIT", "Select a commit on the current branch.");
  const layout = () => fail("GIT_LAYOUT", "Open an ordinary local repository to view its history.");
  const command = async (ctx, args, codes) => {
    try { return await panelCommand(ctx, args, codes); }
    catch (err) {
      // Do not return Git diagnostics containing an unreviewed filename or repository data.
      if (err.code === "GIT_FAILED") throw fail("GIT_FAILED", "Git could not read this history.");
      throw err;
    }
  };
  const stat = async p => { try { return await fs.lstat(p); } catch (e) { if (e.code === "ENOENT") return null; throw layout(); } };
  async function open(payload) {
    const ctx = await gitContext(payload);
    const gd = path.join(ctx.root, ".git");
    const dir = await stat(gd);
    if (!dir) throw fail("GIT_REPO_ROOT", "Select the root of a local Git repository.");
    if (!dir.isDirectory() || (await stat(ctx.root))?.isSymbolicLink()) throw layout();
    // No linked worktrees, external object stores, grafts or indirection of primary metadata.
    for (const name of ["commondir", "shallow", "objects/info/alternates", "objects/info/http-alternates", "info/grafts"]) {
      if (await stat(path.join(gd, name))) throw layout();
    }
    for (const name of ["HEAD", "config", "packed-refs", "objects", "objects/info", "objects/pack", "refs", "refs/heads"]) {
      if ((await stat(path.join(gd, name)))?.isSymbolicLink()) throw layout();
    }
    const top = line(await command(ctx, ["rev-parse", "--show-toplevel"]));
    if (path.relative(await fs.realpath(ctx.root), top)) throw layout();
    ctx.options = [`--git-dir=${gd}`, `--work-tree=${ctx.root}`, "-c", "log.showSignature=false", "-c", "color.ui=false"];
    return ctx;
  }
  async function branchHead(ctx) {
    const ref = line(await command(ctx, ["symbolic-ref", "-q", "HEAD"], [0, 1]));
    if (!ref.startsWith("refs/heads/")) throw fail("GIT_BRANCH", "Check out a local branch to view its history.");
    const head = line(await command(ctx, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], [0, 1]));
    if (head && !OID.test(head)) throw invalid();
    return { ref, head };
  }
  async function checked(payload, read) {
    const ctx = await open(payload);
    const start = await branchHead(ctx);
    const data = await read(ctx, start);
    const end = await branchHead(ctx);
    if ((await gitContext(payload)).key !== ctx.key || end.ref !== start.ref || end.head !== start.head) throw stale();
    return { ok: true, ...data };
  }
  async function commits(ctx, head, limit) {
    if (!head) return [];
    const fields = (await command(ctx, [...LOG, `-${limit}`, head, "--"])).stdout.toString("utf8").split("\0");
    if (fields.pop() !== "" || fields.length % 5 || fields.length > limit * 5) throw invalid();
    const rows = [];
    for (let i = 0; i < fields.length; i += 5) {
      const [oid, parents, author, date, subject] = fields.slice(i, i + 5);
      if (!OID.test(oid) || (parents && !parents.split(" ").every(p => OID.test(p)))) throw invalid();
      rows.push({ commit: { oid, author: clean(author, 160), date: clean(date, 40), subject: clean(subject, 512) }, parent: parents.split(" ")[0] });
    }
    return rows;
  }
  // Anchor content to blob ids from a -z raw diff. Even literal pathspecs would expand a
  // former file into all its descendants across a file→directory transition.
  async function fileList(ctx, oid, parent) {
    let raw;
    try {
      raw = (await command(ctx, ["diff-tree", "--root", "--no-commit-id", "-r", "--raw", "--no-abbrev", "-z", "--no-renames",
        "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", ...(parent ? [parent] : []), oid, "--"])).stdout;
    } catch (err) { if (err.code === "GIT_LIMIT") return { entries: [], omitted: true }; throw err; }
    let offset = 0;
    const entries = [];
    let omitted = false;
    for (let n = 0; offset < raw.length && n < FILE_LIMIT; n++) {
      const h = raw.indexOf(0, offset), e = h >= 0 ? raw.indexOf(0, h + 1) : -1;
      if (e < 0) throw invalid();
      const match = /^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([A-Z])$/.exec(raw.toString("ascii", offset, h));
      const rel = e - h <= 4097 ? raw.toString("utf8", h + 1, e) : "";
      offset = e + 1;
      if (!match || !OID.test(match[3]) || !OID.test(match[4])) throw invalid();
      if (!safeModes.has(match[1]) || !safeModes.has(match[2]) || !/^[ADM]$/.test(match[5]) || !rel || /[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(rel) ||
          rel.split("/").length > 64 || !await gitFileAllowed(ctx.root, rel, "read", ctx.nested)) { omitted = true; continue; }
      entries.push({ path: rel, status: match[5], before: match[3], after: match[4] });
    }
    return { entries, omitted: omitted || offset !== raw.length };
  }
  async function patch(ctx, file) {
    const ids = [file.before, file.after].filter(x => !/^0+$/.test(x));
    for (const id of ids) {
      // The mode in a tree entry is not proof of the referenced object's actual type.
      if (line(await command(ctx, ["cat-file", "-t", id])) !== "blob") return { kind: "unavailable" };
      const size = line(await command(ctx, ["cat-file", "-s", id]));
      if (!/^\d+$/.test(size) || Number(size) > PATCH_BYTES) return { kind: "limit" };
    }
    if (file.before === file.after) return { kind: "mode" };
    let text;
    if (ids.length === 1) {
      const bytes = (await command(ctx, ["cat-file", "blob", ids[0]])).stdout;
      if (bytes.includes(0)) return { kind: "binary" };
      const rows = bytes.toString("utf8").split("\n");
      if (rows.at(-1) === "") rows.pop();
      const add = file.status === "A";
      const hunk = add ? `@@ -0,0 +${rows.length ? 1 : 0},${rows.length} @@` : `@@ -${rows.length ? 1 : 0},${rows.length} +0,0 @@`;
      text = [hunk, ...rows.map(s => (add ? "+" : "-") + s)].join("\n");
      if (bytes.length && bytes.at(-1) !== 10) text += "\n\\ No newline at end of file";
    } else {
      const out = (await command(ctx, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--unified=3", ...ids, "--"])).stdout;
      text = out.toString("utf8");
      if (out.includes(0) || /^Binary files /m.test(text)) return { kind: "binary" };
      // Omit synthetic filenames (git diff <blob> <blob> uses the hashes as labels).
      const hunk = text.indexOf("\n@@ ");
      if (hunk < 0) return { kind: "unavailable" };
      text = text.slice(hunk + 1);
    }
    const limited = Buffer.from(text).subarray(0, PATCH_BYTES).toString("utf8").split("\n", 1500).join("\n");
    return { kind: "text", text: limited, truncated: limited !== text };
  }
  return {
    "fm.git.history": payload => checked(payload, async (ctx, { ref, head }) => ({ branch: clean(ref.slice(11), 256),
      commits: (await commits(ctx, head, 50)).map(row => row.commit) })),
    "fm.git.commitDetail": payload => checked(payload, async (ctx, { head }) => {
      const { oid } = payload;
      if (typeof oid !== "string" || !OID.test(oid) || !head || oid.length !== head.length ||
          (await command(ctx, ["merge-base", "--is-ancestor", oid, head], [0, 1, 128])).code) throw invalid();
      const [row] = await commits(ctx, oid, 1);
      if (!row || row.commit.oid !== oid) throw invalid();
      const { entries, omitted } = await fileList(ctx, oid, row.parent);
      const files = entries.map(({ path, status }) => ({ path, status }));
      const result = { commit: row.commit, parent: row.parent || null, files, omitted };
      const file = payload.path === undefined ? entries[0] : entries.find(f => f.path === payload.path);
      if (!file && payload.path !== undefined) throw fail("GIT_PATH", "Select a visible regular file in this commit.");
      if (file) {
        result.selectedPath = file.path;
        try { result.patch = await patch(ctx, file); } catch (err) { if (err.code !== "GIT_LIMIT") throw err; result.patch = { kind: "limit" }; }
        if (!await gitFileAllowed(ctx.root, file.path, "read", ctx.nested)) throw stale();
      }
      return result;
    }),
  };
}
module.exports = { createGitHistory };

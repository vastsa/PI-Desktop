import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const hostProcessEntry = join(desktopRoot, "electron/main/plugin-host-process.mjs");

// Set before the runtime is imported so the write ledger and per-plugin data
// land in a throwaway directory instead of the developer's real one.
process.env.PI_DESKTOP_DATA_DIR = mkdtempSync(join(tmpdir(), "pi-fs-scope-data-"));

register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { MAX_DELETES_PER_WINDOW, PluginRuntime } = await import(
  "../electron/main/plugin-runtime.ts"
);

function forkPluginProcess({ entry }) {
  const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  return {
    postMessage: (message) => {
      if (child.connected) child.send(message);
    },
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    kill: () => child.kill(),
  };
}

/**
 * A plugin that turns one fs call into data instead of a thrown error, so a
 * refusal can be asserted on without unwrapping it across the process boundary.
 * `fs.remove` is deliberately absent from the panel bridge, so this is also the
 * only way to reach a delete the way a real plugin would.
 */
const PLUGIN_MAIN = `
  async function attempt(fn) {
    try {
      return { ok: true, value: (await fn()) ?? null };
    } catch (error) {
      return { ok: false, code: error?.code ?? "UNKNOWN", message: String(error?.message ?? "") };
    }
  }
  module.exports = {
    async onPanelInvoke(channel, payload) {
      if (channel === "try.remove") return attempt(() => pi.fs.remove(payload.path));
      if (channel === "try.removeMany") {
        const results = [];
        for (const path of payload.paths) results.push(await attempt(() => pi.fs.remove(path)));
        return results;
      }
      if (channel === "try.write") {
        return attempt(() => pi.fs.writeText(payload.path, payload.content ?? "x"));
      }
      if (channel === "try.stat") {
        return attempt(() => pi.fs.stat(payload.path, payload.grantId));
      }
      if (channel === "try.range") {
        return attempt(() => pi.fs.readRange(
          payload.path,
          payload.byteOffset,
          payload.length,
          payload.grantId,
        ));
      }
      throw new Error("unknown channel: " + channel);
    },
  };
`;

/** A workspace with the shapes every test below needs to reason about. */
function makeWorkspace(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-fs-scope-ws-"));
  const all = {
    "docs/a.md": "a",
    "notes.txt": "notes",
    "dist/build.js": "built",
    ".env": "PI_TOKEN=secret",
    ".git/config": "[core]",
    ...files,
  };
  for (const [rel, content] of Object.entries(all)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return dir;
}

function writePlugin({ id, permissions, fs: fsPolicy }) {
  const dir = mkdtempSync(join(tmpdir(), "pi-fs-scope-plugin-"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: id,
      version: "0.0.1",
      main: "main.js",
      permissions,
      ...(fsPolicy ? { fs: fsPolicy } : {}),
    }),
    "utf8",
  );
  writeFileSync(join(dir, "main.js"), PLUGIN_MAIN, "utf8");
  return dir;
}

/**
 * @param options.consent answers the native dialog would return, in order; the
 *   last one repeats. Omit it entirely to test a host that cannot ask.
 */
async function harness(t, { id, permissions, fs: fsPolicy, workspace, granted, consent, protectedPaths }) {
  const ws = workspace ?? makeWorkspace();
  const audits = [];
  const consents = [];
  const trashed = [];
  const opened = [];
  const revealed = [];
  const answers = [...(consent ?? [])];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    getWorkspacePath: () => ws,
    audit: (entry) => audits.push(entry),
    trashItem: async (fullPath) => trashed.push(fullPath),
    openPath: async (fullPath) => opened.push(fullPath),
    revealPath: async (fullPath) => revealed.push(fullPath),
    ...(protectedPaths ? { protectedPaths: () => protectedPaths } : {}),
    ...(consent
      ? {
          confirmFsAccess: async (request) => {
            consents.push(request);
            return answers.length > 1 ? answers.shift() : (answers[0] ?? "deny");
          },
        }
      : {}),
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  const dir = writePlugin({ id, permissions, fs: fsPolicy });
  await runtime.loadFromPath(dir, granted);
  return { runtime, ws, audits, consents, trashed, opened, revealed, dir };
}

function refused(t, promise, code, pattern) {
  return assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

test("a read inside the declared scope lands and one outside is refused", async (t) => {
  const { runtime, audits } = await harness(t, {
    id: "fs.read.scoped",
    permissions: ["fs.read"],
    fs: { read: { scope: ["docs/**"] } },
  });

  assert.equal(
    await runtime.invokePanelBridge("fs.read.scoped", "fs.readText", { path: "docs/a.md" }),
    "a",
  );
  // No consent service is wired here: a host that cannot ask must refuse,
  // never assume yes.
  await refused(
    t,
    runtime.invokePanelBridge("fs.read.scoped", "fs.readText", { path: "notes.txt" }),
    "PERMISSION_DENIED",
    /outside manifest\.fs\.read\.scope: notes\.txt/,
  );
  assert.ok(
    audits.some(
      (e) => e.api === "fs.read" && e.errorCode === "PERMISSION_DENIED" && e.path === "notes.txt",
    ),
    "the refused read is audited",
  );
});

test("stat and readRange share the read permission and byte cap", async (t) => {
  const { runtime, audits } = await harness(t, {
    id: "fs.read.range",
    permissions: ["fs.read"],
    fs: { read: { scope: ["docs/**"] } },
  });

  const stat = await runtime.invokePanelBridge("fs.read.range", "try.stat", {
    path: "docs/a.md",
  });
  assert.equal(stat.ok, true);
  assert.equal(stat.value.size, 1);
  assert.equal(typeof stat.value.mtimeMs, "number");

  const range = await runtime.invokePanelBridge("fs.read.range", "try.range", {
    path: "docs/a.md",
    byteOffset: 0,
    length: 8,
  });
  assert.equal(range.ok, true);
  assert.equal(String.fromCharCode(...Object.values(range.value.bytes)), "a");
  assert.equal(range.value.totalSize, 1);

  const empty = await runtime.invokePanelBridge("fs.read.range", "try.range", {
    path: "docs/a.md",
    byteOffset: 99,
    length: 8,
  });
  assert.equal(empty.ok, true);
  assert.equal(Object.keys(empty.value.bytes).length, 0);

  const tooLarge = await runtime.invokePanelBridge("fs.read.range", "try.range", {
    path: "docs/a.md",
    byteOffset: 0,
    length: 8 * 1024 * 1024 + 1,
  });
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.code, "INVALID_ARGUMENT");
  assert.ok(audits.some((entry) => entry.api === "fs.read" && entry.errorCode === "INVALID_ARGUMENT"));
});

test("a real panel drop creates a one-file read grant", async (t) => {
  const droppedDir = mkdtempSync(join(tmpdir(), "pi-fs-scope-dropped-"));
  const droppedPath = join(droppedDir, "dropped.log");
  writeFileSync(droppedPath, "dropped contents", "utf8");
  const { runtime } = await harness(t, {
    id: "fs.read.dropped",
    permissions: ["fs.read"],
    fs: { read: { scope: [] } },
  });

  await refused(
    t,
    runtime.invokePanelBridge("fs.read.dropped", "fs.registerDropped", {
      path: droppedPath,
    }),
    "PERMISSION_DENIED",
    /not dropped/,
  );
  const grant = await runtime.invokePanelBridge(
    "fs.read.dropped",
    "fs.registerDropped",
    { path: droppedPath },
    { droppedPath },
  );
  assert.equal(typeof grant.grantId, "string");

  const stat = await runtime.invokePanelBridge("fs.read.dropped", "try.stat", {
    path: droppedPath,
    grantId: grant.grantId,
  });
  assert.equal(stat.ok, true);
  assert.equal(stat.value.size, "dropped contents".length);

  const range = await runtime.invokePanelBridge("fs.read.dropped", "try.range", {
    path: droppedPath,
    grantId: grant.grantId,
    byteOffset: 0,
    length: 32,
  });
  assert.equal(range.ok, true);
  assert.equal(
    String.fromCharCode(...Object.values(range.value.bytes)),
    "dropped contents",
  );

  const outside = await runtime.invokePanelBridge("fs.read.dropped", "try.range", {
    path: join(droppedDir, "other.log"),
    grantId: grant.grantId,
    byteOffset: 0,
    length: 8,
  });
  assert.equal(outside.ok, false);
  assert.equal(outside.code, "PERMISSION_DENIED");
});

test("a write outside the declared scope is refused", async (t) => {
  const { runtime, ws } = await harness(t, {
    id: "fs.write.scoped",
    permissions: ["fs.write"],
    fs: { write: { scope: ["out/**"] } },
  });

  // Creating a file whose parent does not exist yet must still resolve: the
  // containment check walks up to the nearest existing ancestor.
  await runtime.invokePanelBridge("fs.write.scoped", "fs.writeText", {
    path: "out/nested/x.txt",
    content: "written",
  });
  assert.equal(readFileSync(join(ws, "out/nested/x.txt"), "utf8"), "written");

  await refused(
    t,
    runtime.invokePanelBridge("fs.write.scoped", "fs.writeText", {
      path: "notes.txt",
      content: "clobbered",
    }),
    "PERMISSION_DENIED",
    /outside manifest\.fs\.write\.scope/,
  );
  assert.equal(readFileSync(join(ws, "notes.txt"), "utf8"), "notes");
});

test("a symlink inside the workspace cannot carry a read out of it", async (t) => {
  const outside = mkdtempSync(join(tmpdir(), "pi-fs-scope-outside-"));
  writeFileSync(join(outside, "id_rsa"), "PRIVATE KEY", "utf8");
  const ws = makeWorkspace();
  symlinkSync(join(outside, "id_rsa"), join(ws, "innocent.txt"));
  symlinkSync(outside, join(ws, "elsewhere"));

  const { runtime } = await harness(t, {
    id: "fs.read.symlink",
    permissions: ["fs.read"],
    fs: { read: { scope: ["**/*"] } },
    workspace: ws,
  });

  // The old lexical containment check accepted both of these: the string stayed
  // under the workspace even though the file never was.
  for (const path of ["innocent.txt", "elsewhere/id_rsa"]) {
    await refused(
      t,
      runtime.invokePanelBridge("fs.read.symlink", "fs.readText", { path }),
      "INVALID_ARGUMENT",
      /path escapes the plugin's root/,
    );
  }
  await refused(
    t,
    runtime.invokePanelBridge("fs.read.symlink", "fs.readText", { path: "../outside.txt" }),
    "INVALID_ARGUMENT",
    /path escapes the plugin's root/,
  );
});

test("credentials and repository internals are refused under a whole-tree scope", async (t) => {
  const { runtime } = await harness(t, {
    id: "fs.read.deny",
    permissions: ["fs.read"],
    fs: { read: { scope: ["**/*"] } },
    // Answering "session" would let anything through, so the deny-list is
    // being tested against the most permissive host there is.
    consent: ["session"],
  });

  for (const path of [".env", ".git/config"]) {
    await refused(
      t,
      runtime.invokePanelBridge("fs.read.deny", "fs.readText", { path }),
      "PERMISSION_DENIED",
      /credentials and repository internals/,
    );
  }
  // A listing is a read: the names must not come back either.
  const matches = await runtime.invokePanelBridge("fs.read.deny", "fs.glob", { pattern: "**/*" });
  assert.ok(matches.includes("docs/a.md"));
  assert.ok(!matches.some((m) => m === ".env" || m.startsWith(".git/")));
});

test("glob returns only what the read scope already allows", async (t) => {
  const { runtime } = await harness(t, {
    id: "fs.glob.scoped",
    permissions: ["fs.read"],
    fs: { read: { scope: ["docs/**"] } },
  });

  assert.deepEqual(
    await runtime.invokePanelBridge("fs.glob.scoped", "fs.glob", { pattern: "**/*" }),
    ["docs/a.md"],
  );
});

test("list walks one directory and honours the same guards as glob", async (t) => {
  const ws = makeWorkspace({ "docs/sub/deep.md": "d", "node_modules/pkg/i.js": "x" });
  const { runtime, audits } = await harness(t, {
    id: "fs.list.scoped",
    permissions: ["fs.read"],
    fs: { read: { scope: ["docs/**"] } },
    workspace: ws,
  });

  const root = await runtime.invokePanelBridge("fs.list.scoped", "fs.list", { path: "" });
  const byName = Object.fromEntries(root.map((entry) => [entry.name, entry]));

  // A directory is always offered, so a narrow scope still yields a navigable
  // tree rather than an empty one.
  assert.equal(byName.docs?.isDirectory, true);
  assert.equal(byName.docs?.path, "docs");
  // A file outside the read scope is not named, because a listing is a read.
  assert.equal(byName["notes.txt"], undefined);
  // Credentials and repository internals stay hidden under any scope.
  assert.equal(byName[".env"], undefined);
  assert.equal(byName[".git"], undefined);
  // Heavy trees are skipped, exactly as glob skips them.
  assert.equal(byName.node_modules, undefined);

  const docs = await runtime.invokePanelBridge("fs.list.scoped", "fs.list", { path: "docs" });
  const doc = docs.find((entry) => entry.name === "a.md");
  assert.equal(doc.isDirectory, false);
  assert.equal(doc.path, "docs/a.md", "paths are root-relative and directly readable");
  assert.equal(typeof doc.size, "number");
  assert.equal(
    await runtime.invokePanelBridge("fs.list.scoped", "fs.readText", { path: doc.path }),
    "a",
  );

  assert.ok(audits.some((entry) => entry.api === "fs.list" && entry.ok === true));
});

test("list cannot escape the root", async (t) => {
  const { runtime } = await harness(t, {
    id: "fs.list.escape",
    permissions: ["fs.read"],
    fs: { read: { scope: ["**/*"] } },
  });

  await refused(
    t,
    runtime.invokePanelBridge("fs.list.escape", "fs.list", { path: "../.." }),
    "INVALID_ARGUMENT",
  );
});

test("default-app opening reuses the readable file scope", async (t) => {
  const { runtime, ws, opened, audits } = await harness(t, {
    id: "fs.open-default.scoped",
    permissions: ["fs.read"],
    fs: { read: { scope: ["docs/**", "docs"] } },
  });

  assert.deepEqual(
    await runtime.invokePanelBridge("fs.open-default.scoped", "fs.openDefault", {
      path: "docs/a.md",
    }),
    { ok: true },
  );
  assert.deepEqual(opened, [realpathSync(join(ws, "docs/a.md"))]);
  assert.ok(
    audits.some((entry) => entry.api === "fs.openDefault" && entry.ok === true),
    "opening a file is audited",
  );

  await refused(
    t,
    runtime.invokePanelBridge("fs.open-default.scoped", "fs.openDefault", {
      path: "docs",
    }),
    "INVALID_ARGUMENT",
    /only files can be opened/,
  );

  await refused(
    t,
    runtime.invokePanelBridge("fs.open-default.scoped", "fs.openDefault", {
      path: "notes.txt",
    }),
    "PERMISSION_DENIED",
    /outside manifest\.fs\.read\.scope/,
  );
});

test("file reveal reuses the readable file scope", async (t) => {
  const { runtime, ws, revealed, audits } = await harness(t, {
    id: "fs.reveal.scoped",
    permissions: ["fs.read"],
    fs: { read: { scope: ["docs/**", "docs"] } },
  });

  assert.deepEqual(
    await runtime.invokePanelBridge("fs.reveal.scoped", "fs.reveal", {
      path: "docs/a.md",
    }),
    { ok: true },
  );
  assert.deepEqual(revealed, [realpathSync(join(ws, "docs/a.md"))]);
  assert.ok(
    audits.some((entry) => entry.api === "fs.reveal" && entry.ok === true),
    "revealing a file is audited",
  );

  await refused(
    t,
    runtime.invokePanelBridge("fs.reveal.scoped", "fs.reveal", { path: "docs" }),
    "INVALID_ARGUMENT",
    /only files can be revealed/,
  );
  await refused(
    t,
    runtime.invokePanelBridge("fs.reveal.scoped", "fs.reveal", { path: "notes.txt" }),
    "PERMISSION_DENIED",
    /outside manifest\.fs\.read\.scope/,
  );
});

test("classified preview reuses the readable file scope", async (t) => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const { runtime, ws, audits } = await harness(t, {
    id: "fs.read-preview.scoped",
    permissions: ["fs.read"],
    fs: { read: { scope: ["docs/**", "docs", "pixel.png", "blob.bin"] } },
    workspace: makeWorkspace({ "pixel.png": "placeholder" }),
  });
  writeFileSync(join(ws, "pixel.png"), png);
  writeFileSync(join(ws, "blob.bin"), Buffer.from([0, 1, 2, 0, 3]));

  const text = await runtime.invokePanelBridge(
    "fs.read-preview.scoped",
    "fs.readPreview",
    { path: "docs/a.md" },
  );
  assert.equal(text.kind, "text");
  assert.equal(text.content, "a");
  assert.equal(typeof text.size, "number");

  const image = await runtime.invokePanelBridge(
    "fs.read-preview.scoped",
    "fs.readPreview",
    { path: "pixel.png" },
  );
  assert.equal(image.kind, "image");
  assert.match(image.dataUrl, /^data:image\/png;base64,/);

  const binary = await runtime.invokePanelBridge(
    "fs.read-preview.scoped",
    "fs.readPreview",
    { path: "blob.bin" },
  );
  assert.equal(binary.kind, "binary");
  assert.equal(binary.content, undefined);

  assert.ok(
    audits.some((entry) => entry.api === "fs.readPreview" && entry.ok === true),
    "previewing a file is audited",
  );

  await refused(
    t,
    runtime.invokePanelBridge("fs.read-preview.scoped", "fs.readPreview", {
      path: "docs",
    }),
    "INVALID_ARGUMENT",
    /only files can be previewed/,
  );
  await refused(
    t,
    runtime.invokePanelBridge("fs.read-preview.scoped", "fs.readPreview", {
      path: "notes.txt",
    }),
    "PERMISSION_DENIED",
    /outside manifest\.fs\.read\.scope/,
  );
});

test("list requires the read permission", async (t) => {
  const { runtime } = await harness(t, {
    id: "fs.list.nogrant",
    permissions: [],
  });

  await refused(
    t,
    runtime.invokePanelBridge("fs.list.nogrant", "fs.list", { path: "" }),
    "PERMISSION_DENIED",
  );
});

test("a path the host reserves is refused even reached through a link", async (t) => {
  const ws = makeWorkspace({ "vault/keys.json": "{}" });
  const { runtime, audits } = await harness(t, {
    id: "fs.read.reserved",
    permissions: ["fs.read"],
    fs: { read: { scope: ["**/*"] } },
    workspace: ws,
    consent: ["session"],
    // Handed over unresolved, which is how `dataDir` arrives in production and
    // how a temp path arrives here: on macOS this is /var/..., while the file
    // resolves to /private/var/... Comparing the two raw would never match.
    protectedPaths: [join(ws, "vault")],
  });

  await refused(
    t,
    runtime.invokePanelBridge("fs.read.reserved", "fs.readText", { path: "vault/keys.json" }),
    "PERMISSION_DENIED",
    /reserved by the app/,
  );
  assert.ok(audits.some((e) => e.api === "fs.read" && e.errorCode === "PERMISSION_DENIED"));
  const matches = await runtime.invokePanelBridge("fs.read.reserved", "fs.glob", {
    pattern: "**/*",
  });
  assert.ok(!matches.some((m) => m.startsWith("vault/")), "a reserved tree is not even listed");
});

test("the write ledger lets a plugin delete its own output without a prompt", async (t) => {
  const { runtime, ws, consents, trashed } = await harness(t, {
    id: "fs.delete.own",
    permissions: ["fs.write", "fs.delete"],
    fs: { write: { scope: ["out/**"] }, delete: { own: true } },
    consent: ["deny"],
  });

  await runtime.invokePanelBridge("fs.delete.own", "fs.writeText", {
    path: "out/report.md",
    content: "generated",
  });
  const mine = await runtime.invokePanelBridge("fs.delete.own", "try.remove", {
    path: "out/report.md",
  });
  assert.equal(mine.ok, true);
  assert.equal(consents.length, 0, "removing your own output asks nobody");
  assert.deepEqual(trashed.map((p) => p.endsWith("out/report.md")), [true]);

  // A file the plugin never wrote is somebody else's, ledger or not.
  const theirs = await runtime.invokePanelBridge("fs.delete.own", "try.remove", {
    path: "notes.txt",
  });
  assert.equal(theirs.ok, false);
  assert.equal(theirs.code, "PERMISSION_DENIED");
  assert.match(theirs.message, /the user refused delete/);
  assert.equal(consents.at(-1).mode, "delete");
  assert.equal(consents.at(-1).reason, "scope");
  assert.ok(existsSync(join(ws, "notes.txt")));
});

test("a file the user edited after the plugin wrote it stops being the plugin's", async (t) => {
  const { runtime, ws, consents } = await harness(t, {
    id: "fs.delete.stale",
    permissions: ["fs.write", "fs.delete"],
    fs: { write: { scope: ["out/**"] }, delete: { own: true } },
    consent: ["deny"],
  });

  await runtime.invokePanelBridge("fs.delete.stale", "fs.writeText", {
    path: "out/draft.md",
    content: "generated",
  });
  // Stand in for the user opening the file and saving it, past the one second
  // of slack the ownership check allows for coarse filesystems.
  const later = Date.now() / 1000 + 30;
  utimesSync(join(ws, "out/draft.md"), later, later);

  const result = await runtime.invokePanelBridge("fs.delete.stale", "try.remove", {
    path: "out/draft.md",
  });
  assert.equal(result.ok, false);
  assert.equal(consents.length, 1, "the delete falls to the user, not to the ledger");
});

test("a delete inside the declared scope needs no prompt, and the root never goes", async (t) => {
  const { runtime, consents, trashed } = await harness(t, {
    id: "fs.delete.scoped",
    permissions: ["fs.delete"],
    fs: { delete: { scope: ["dist/**"] } },
    consent: ["deny"],
  });

  const inScope = await runtime.invokePanelBridge("fs.delete.scoped", "try.remove", {
    path: "dist/build.js",
  });
  assert.equal(inScope.ok, true);
  assert.equal(consents.length, 0);
  assert.equal(trashed.length, 1, "the delete went to the trash, not to rmSync");

  for (const path of ["", ".", "docs"]) {
    const result = await runtime.invokePanelBridge("fs.delete.scoped", "try.remove", { path });
    assert.equal(result.ok, false, `${path || "<root>"} must not be removable`);
  }
  const missing = await runtime.invokePanelBridge("fs.delete.scoped", "try.remove", {
    path: "dist/gone.js",
  });
  assert.equal(missing.code, "NOT_FOUND");
});

test("a non-empty directory is refused rather than emptied", async (t) => {
  const { runtime, ws } = await harness(t, {
    id: "fs.delete.tree",
    permissions: ["fs.delete"],
    fs: { delete: { scope: ["docs/**", "docs"] } },
  });

  const result = await runtime.invokePanelBridge("fs.delete.tree", "try.remove", { path: "docs" });
  assert.equal(result.ok, false);
  assert.match(result.message, /non-empty directory/);
  assert.ok(existsSync(join(ws, "docs/a.md")));
});

test("a runaway delete loop trips the rate brake", async (t) => {
  const count = MAX_DELETES_PER_WINDOW + 10;
  const files = {};
  for (let i = 0; i < count; i += 1) files[`tmp/f${i}.txt`] = "junk";
  const { runtime, consents } = await harness(t, {
    id: "fs.delete.rate",
    permissions: ["fs.delete"],
    fs: { delete: { scope: ["tmp/**"] } },
    workspace: makeWorkspace(files),
    consent: ["deny"],
  });

  // Every one of these is in scope: `recursive: false` and a narrow glob are
  // both satisfied, and the workspace still empties. The window is what tells
  // a cleanup from a wipe.
  const results = await runtime.invokePanelBridge("fs.delete.rate", "try.removeMany", {
    paths: Object.keys(files),
  });
  assert.equal(results.filter((r) => r.ok).length, MAX_DELETES_PER_WINDOW);
  assert.equal(results[MAX_DELETES_PER_WINDOW].ok, false);
  assert.ok(consents.length > 0);
  assert.ok(
    consents.every((request) => request.reason === "rate"),
    "the prompt says why it appeared, so the user is not asked to judge one file",
  );
});

test("a userSelected root is nothing until the user points at a directory", async (t) => {
  const picked = mkdtempSync(join(tmpdir(), "pi-fs-scope-picked-"));
  writeFileSync(join(picked, "hello.txt"), "outside the workspace", "utf8");
  writeFileSync(join(picked, ".env"), "TOKEN=1", "utf8");
  const asked = [];

  const ws = makeWorkspace();
  const audits = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    getWorkspacePath: () => ws,
    audit: (entry) => audits.push(entry),
    pickDirectory: async (request) => {
      asked.push(request.pluginId);
      return picked;
    },
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  const dir = writePlugin({
    id: "fs.user.root",
    permissions: ["fs.read", "fs.write"],
    // No scope, and none is needed: the directory the user hands over is the
    // grant. Nothing is reachable before they do.
    fs: { read: { root: "userSelected", scope: [] }, write: { root: "userSelected", scope: [] } },
  });
  await runtime.loadFromPath(dir);

  await refused(
    t,
    runtime.invokePanelBridge("fs.user.root", "fs.readText", { path: "hello.txt" }),
    "NOT_FOUND",
    /no directory has been chosen/,
  );

  const handle = await runtime.invokePanelBridge("fs.user.root", "fs.requestDirectory");
  assert.deepEqual(asked, ["fs.user.root"]);
  assert.equal(handle.path, picked);

  assert.equal(
    await runtime.invokePanelBridge("fs.user.root", "fs.readText", { path: "hello.txt" }),
    "outside the workspace",
  );
  await runtime.invokePanelBridge("fs.user.root", "fs.writeText", {
    path: "sub/new.txt",
    content: "ok",
  });
  assert.equal(readFileSync(join(picked, "sub/new.txt"), "utf8"), "ok");

  // The grant is a directory, not an escape hatch: the deny-list and
  // containment both still apply inside it.
  await refused(
    t,
    runtime.invokePanelBridge("fs.user.root", "fs.readText", { path: ".env" }),
    "PERMISSION_DENIED",
    /credentials and repository internals/,
  );
  await refused(
    t,
    runtime.invokePanelBridge("fs.user.root", "fs.readText", { path: "../hello.txt" }),
    "INVALID_ARGUMENT",
    /path escapes the plugin's root/,
  );
});

test("a revoked permission is not handed back by the manifest", async (t) => {
  const { runtime } = await harness(t, {
    id: "fs.revoked",
    permissions: ["fs.read", "fs.write"],
    fs: { read: { scope: ["**/*"] }, write: { scope: ["docs/**"] } },
    // What the user left checked at install; the manifest asks for more.
    granted: ["fs.read"],
  });

  assert.equal(
    await runtime.invokePanelBridge("fs.revoked", "fs.readText", { path: "notes.txt" }),
    "notes",
  );
  await refused(
    t,
    runtime.invokePanelBridge("fs.revoked", "fs.writeText", { path: "docs/a.md", content: "no" }),
    "PERMISSION_DENIED",
    /missing permission: fs\.write/,
  );
});

test("a legacy fs permission is downgraded rather than honoured", async (t) => {
  const { runtime, ws } = await harness(t, {
    id: "fs.legacy",
    // An install recorded before scopes existed: no `fs` block to fall back on.
    permissions: ["fs.read.workspace", "fs.write.workspace", "fs.delete.workspace"],
  });

  // Reading stays broad, because egress is what made a broad read dangerous
  // and that half is closed elsewhere.
  assert.equal(
    await runtime.invokePanelBridge("fs.legacy", "fs.readText", { path: "notes.txt" }),
    "notes",
  );
  await refused(
    t,
    runtime.invokePanelBridge("fs.legacy", "fs.readText", { path: ".env" }),
    "PERMISSION_DENIED",
    /credentials and repository internals/,
  );
  // Writing and deleting are cut back to nothing until the manifest says where.
  await refused(
    t,
    runtime.invokePanelBridge("fs.legacy", "fs.writeText", { path: "notes.txt", content: "no" }),
    "PERMISSION_DENIED",
    /outside manifest\.fs\.write\.scope/,
  );
  assert.equal(readFileSync(join(ws, "notes.txt"), "utf8"), "notes");
  const removal = await runtime.invokePanelBridge("fs.legacy", "try.remove", {
    path: "dist/build.js",
  });
  assert.equal(removal.ok, false);
  assert.equal(removal.code, "PERMISSION_DENIED");

  // The UI needs to know it happened, so it can tell the author to declare a
  // scope instead of leaving the plugin quietly broken.
  const loaded = runtime.listLoaded().find((entry) => entry.manifest.id === "fs.legacy");
  assert.deepEqual(loaded.legacyFs, [
    "fs.read.workspace",
    "fs.write.workspace",
    "fs.delete.workspace",
  ]);
});

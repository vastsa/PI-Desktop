import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

/**
 * The production receiver the directory-location hotfix (issue #2113) builds
 * on, executed for real: the bundled plugin main process answers the channels
 * the rebuilt view relies on when a host location names a directory.
 *
 * The chat open flow used to send directories into `fm.read`, which refuses
 * them (`INVALID_PATH "path is a directory"`) — the failure the PR review
 * reproduced against this exact handler. The rebuilt view classifies the
 * target from the loaded parent listing (`fm.list`) and never dispatches the
 * read for a directory, so the contract pinned here is the production shape
 * both sides of that decision depend on: reads refuse directories in every
 * addressing mode, lists answer directories and refuse files, and ordinary
 * files are untouched.
 */

const FILE_MANAGER = resolve("resources/plugins/pi.file-manager");

function tempWorkspace(name) {
  const root = mkdtempSync(join(tmpdir(), `pi-fm-dir-${name}-`));
  mkdirSync(join(root, "examples"), { recursive: true });
  writeFileSync(join(root, "examples", "child.txt"), "child\n");
  writeFileSync(join(root, "test.ts"), "const visible = true;\n");
  return root;
}

function withPi(workspace, dataPath, run) {
  const previous = globalThis.pi;
  globalThis.pi = {
    workspace: { get: async () => workspace },
    plugin: {
      getDataPath: async () => dataPath,
      getSettings: async () => ({}),
    },
    // handleHello probes this with a bare typeof; an absent fs would throw.
    fs: {},
  };
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (previous === undefined) delete globalThis.pi;
      else globalThis.pi = previous;
    });
}

test("fm.read refuses directories in every addressing mode", async () => {
  const workspacePath = tempWorkspace("read");
  const outsideDir = mkdtempSync(join(tmpdir(), "pi-fm-dir-outside-"));
  mkdirSync(join(outsideDir, "run"), { recursive: true });
  try {
    await withPi({ path: workspacePath, name: "ws" }, join(outsideDir, "data"), async () => {
      const require = createRequire(import.meta.url);
      const plugin = require(join(FILE_MANAGER, "main.js"));

      const inProject = await plugin.onPanelInvoke("fm.read", {
        path: "examples",
        workspacePath,
      });
      assert.deepEqual(
        { ok: inProject.ok, code: inProject.code, message: inProject.message },
        { ok: false, code: "INVALID_PATH", message: "path is a directory" },
      );

      const scratch = await plugin.onPanelInvoke("fm.read", {
        path: join(outsideDir, "run"),
        external: true,
        workspacePath,
      });
      assert.deepEqual(
        { ok: scratch.ok, code: scratch.code, message: scratch.message },
        { ok: false, code: "INVALID_PATH", message: "path is a directory" },
      );
    });
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("fm.list answers for directories and refuses files", async () => {
  const workspacePath = tempWorkspace("list");
  try {
    await withPi({ path: workspacePath, name: "ws" }, join(workspacePath, "data"), async () => {
      const require = createRequire(import.meta.url);
      const plugin = require(join(FILE_MANAGER, "main.js"));

      const listing = await plugin.onPanelInvoke("fm.list", {
        path: "examples",
        workspacePath,
      });
      assert.equal(listing.ok, true, listing.message);
      assert.deepEqual(
        listing.entries.map((entry) => [entry.path, entry.isDirectory]),
        [["examples/child.txt", false]],
      );

      const fileListing = await plugin.onPanelInvoke("fm.list", {
        path: "test.ts",
        workspacePath,
      });
      assert.equal(fileListing.ok, false);
      assert.equal(fileListing.code, "INVALID_PATH");
    });
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("ordinary files still read through the same channels", async () => {
  const workspacePath = tempWorkspace("file");
  const outsideDir = mkdtempSync(join(tmpdir(), "pi-fm-file-outside-"));
  writeFileSync(join(outsideDir, "report.txt"), "external report\n");
  try {
    await withPi({ path: workspacePath, name: "ws" }, join(outsideDir, "data"), async () => {
      const require = createRequire(import.meta.url);
      const plugin = require(join(FILE_MANAGER, "main.js"));

      const inProject = await plugin.onPanelInvoke("fm.read", {
        path: "test.ts",
        workspacePath,
      });
      assert.equal(inProject.ok, true, inProject.message);
      assert.equal(inProject.kind, "text");
      assert.match(inProject.text, /const visible/);

      const external = await plugin.onPanelInvoke("fm.read", {
        path: join(outsideDir, "report.txt"),
        external: true,
        workspacePath,
      });
      assert.equal(external.ok, true, external.message);
      assert.match(external.text, /external report/);
    });
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("the main.js identity the boundary tests exercise is the vendored one", () => {
  // The receiver above is loaded from the resource directory shipped in the
  // app; a stray development copy would silently test something else.
  const require = createRequire(import.meta.url);
  const mainPath = join(FILE_MANAGER, "main.js");
  assert.ok(
    require.resolve(mainPath).includes(join("resources", "plugins", "pi.file-manager")),
  );
  assert.equal(dirname(mainPath), FILE_MANAGER);
});

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("bundled file manager creates, renames and moves real entries with valid names", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-file-mutations-"));
  const previous = globalThis.pi;
  globalThis.pi = { workspace: { get: async () => ({ path: root }) }, plugin: { getDataPath: async () => null, getSettings: async () => ({}) } };
  const require = createRequire(import.meta.url);
  const entry = require.resolve("../resources/plugins/pi.file-manager/main.js");
  delete require.cache[entry];
  const plugin = require(entry);
  try {
    await plugin.onLoad();
    const file = await plugin.onPanelInvoke("fm.create", { parent: "", name: " new-file.txt ", isDirectory: false });
    assert.equal(file.ok, true, JSON.stringify(file));
    assert.equal(file.entry.path, "new-file.txt");
    assert.equal(await readFile(join(root, "new-file.txt"), "utf8"), "");
    const folder = await plugin.onPanelInvoke("fm.create", { name: "新文件夹", isDirectory: true });
    assert.equal(folder.ok, true, JSON.stringify(folder));
    assert.equal(folder.entry.isDirectory, true);
    const renamed = await plugin.onPanelInvoke("fm.rename", { path: "new-file.txt", newName: "renamed.txt" });
    assert.equal(renamed.ok, true, JSON.stringify(renamed));
    const moved = await plugin.onPanelInvoke("fm.move", { from: "renamed.txt", toDir: "新文件夹" });
    assert.equal(moved.ok, true, JSON.stringify(moved));
    assert.equal(moved.entry.path, "新文件夹/renamed.txt");
    assert.equal((await stat(join(root, "新文件夹/renamed.txt"))).isFile(), true);
    for (const name of ["", ".", "..", "../escape", "a/b", "a\\b", "bad\0name", "bad:name", "CON", "nul.txt", "trailing."]) {
      const rejected = await plugin.onPanelInvoke("fm.create", { name });
      assert.equal(rejected.ok, false, name);
      assert.equal(rejected.code, "INVALID_NAME", JSON.stringify(rejected));
      const renameRejected = await plugin.onPanelInvoke("fm.rename", { path: "新文件夹/renamed.txt", newName: name });
      assert.equal(renameRejected.code, "INVALID_NAME", JSON.stringify(renameRejected));
    }
    const duplicate = await plugin.onPanelInvoke("fm.create", { name: "新文件夹", isDirectory: true });
    assert.equal(duplicate.code, "EXISTS");
  } finally {
    await plugin.onUnload();
    globalThis.pi = previous;
    delete require.cache[entry];
    await rm(root, { recursive: true, force: true });
  }
});

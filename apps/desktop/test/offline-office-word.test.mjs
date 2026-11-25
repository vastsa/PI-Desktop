import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const plugin = new URL("../resources/offline-office/", import.meta.url);

test("Word commands fail clearly without the bundled interpreters", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pie-office-test-"));
  try {
    const plugins = join(root, "plugins");
    await mkdir(plugins);
    const installed = join(plugins, "pie.offline-office");
    await cp(plugin, installed, { recursive: true });
    const launcher = join(installed, "word", "word.sh");
    for (const args of [["create", "文档 样例.docx", "标题"], ["extract", "文档 样例.docx"]]) {
      const result = spawnSync("/bin/sh", [launcher, ...args], { cwd: root, encoding: "utf8", env: { PATH: "" } });
      assert.equal(result.status, 1, result.error?.message ?? result.stderr);
      assert.match(result.stderr, /bundled Office Runtime is missing/i);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

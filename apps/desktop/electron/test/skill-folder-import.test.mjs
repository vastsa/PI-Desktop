import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "..", "..", "test", "helpers", "ts-import-hooks.mjs")));
const { importSkillFolders, readLastSkillImportDirectory, writeLastSkillImportDirectory } = await import(
  "../main/skill-folder-import.ts"
);

test("folder batch preserves order and reports failures without stopping later imports", async () => {
  const attempted = [];
  const result = await importSkillFolders(
    ["/one", "/bad", "/two"],
    { level: "project", projectPath: "/project", mode: "copy", path: "/forged", shape: "file" },
    async (params) => {
      attempted.push(params);
      if (params.path === "/bad") throw new Error("missing SKILL.md");
      return { skill: { name: params.path } };
    },
  );
  assert.deepEqual(attempted, ["/one", "/bad", "/two"].map((path) => ({
    path, shape: "dir", level: "project", projectPath: "/project", mode: "copy",
  })));
  assert.deepEqual(result.imported, [{ name: "/one" }, { name: "/two" }]);
  assert.deepEqual(result.failed, [{ path: "/bad", error: "missing SKILL.md" }]);
  assert.equal(result.lastImportedPath, "/two", "the last successful folder wins");
});

test("all failures leave the remembered folder unchanged", async () => {
  const result = await importSkillFolders(["/bad"], {}, async () => {
    throw new Error("missing SKILL.md");
  });
  assert.equal(result.lastImportedPath, undefined);
  assert.equal(result.imported.length, 0);
});

test("the picker remembers the parent of the last successful Skill folder", (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "skill-folder-import-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const parent = join(dataDir, "collection");
  const folder = join(parent, "beta");
  mkdirSync(folder, { recursive: true });
  assert.equal(readLastSkillImportDirectory(dataDir), undefined);
  writeLastSkillImportDirectory(dataDir, folder);
  assert.equal(readLastSkillImportDirectory(dataDir), parent);
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, "skill-import-directory.json"), "utf8")), {
    directory: parent,
  });
  rmSync(folder, { recursive: true });
  assert.equal(readLastSkillImportDirectory(dataDir), parent, "siblings remain reachable");
  rmSync(parent, { recursive: true });
  assert.equal(readLastSkillImportDirectory(dataDir), undefined);
});

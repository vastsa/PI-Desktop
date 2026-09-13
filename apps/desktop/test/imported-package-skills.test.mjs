import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { generateImportedExtensionPlugin } = await import("../electron/main/agent-extensions.ts");

function fixture(t, pi, nested = false) {
  const root = mkdtempSync(join(tmpdir(), "pi-package-skill-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, ...(nested ? [".pi", "agent", "npm", "node_modules"] : []), "planning");
  const write = (path, text) => {
    const target = join(source, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, text);
  };
  write("package.json", JSON.stringify({ name: "planning", pi }));
  return { root, source, write, imports: join(root, "imports") };
}

test("imports an installed npm package without filtering its node_modules ancestors", (t) => {
  const f = fixture(t, { extensions: ["index.ts"], skills: ["SKILL.md"] }, true);
  f.write("index.ts", "export default function () {}\n");
  f.write("SKILL.md", "---\nname: planning\ndescription: Plan work\n---\nUse templates/plan.md\n");
  f.write("templates/plan.md", "# Plan\n");
  f.write("node_modules/dependency/index.js", "throw new Error('must not copy')");
  f.write("my_node_modules_notes.txt", "keep this resource");
  const result = generateImportedExtensionPlugin(f.source, f.imports);
  assert.ok(existsSync(join(result.path, "src/index.ts")));
  assert.equal(readFileSync(join(result.path, "src/templates/plan.md"), "utf8"), "# Plan\n");
  assert.ok(existsSync(join(result.path, "src/my_node_modules_notes.txt")));
  assert.ok(!existsSync(join(result.path, "src/node_modules")));
  const manifest = JSON.parse(readFileSync(join(result.path, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.contributes.skills.map((skill) => skill.path), ["src/SKILL.md"]);
  assert.deepEqual(manifest.permissions, ["agent.extension", "agent.prompt.inject"]);
});

test("imports skill-only packages and expands declared skill directories deterministically", (t) => {
  const f = fixture(t, { skills: ["skills", "skills/a/SKILL.md"] });
  f.write("skills/a/SKILL.md", "# A");
  f.write("skills/a/reference.md", "not another skill");
  f.write("skills/b/SKILL.md", "# B");
  f.write("skills/.hidden/SKILL.md", "hidden");
  f.write("index.js", "throw new Error('a helper must not become an extension')");
  const result = generateImportedExtensionPlugin(f.source, f.imports);
  const manifest = JSON.parse(readFileSync(join(result.path, "manifest.json"), "utf8"));
  assert.deepEqual(result.entries, []);
  assert.deepEqual(manifest.permissions, ["agent.prompt.inject"]);
  assert.deepEqual(manifest.contributes.skills.map((skill) => skill.path), ["src/skills/a/SKILL.md", "src/skills/b/SKILL.md"]);
  assert.equal(new Set(manifest.contributes.skills.map((skill) => skill.id)).size, 2);
  assert.equal(manifest.contributes.agentExtensions, undefined);
});

for (const skills of [["../outside.md"], ["/outside.md"], ["C:\\outside.md"], ["node_modules/x/SKILL.md"], ["missing.md"], ["index.ts"], "SKILL.md", [12]]) {
  test(`refuses invalid skill declaration ${JSON.stringify(skills)} before creating a plugin`, (t) => {
    const f = fixture(t, { extensions: ["index.ts"], skills });
    f.write("index.ts", "export default function () {}\n");
    assert.throws(() => generateImportedExtensionPlugin(f.source, f.imports), (e) => e.errorCode === "INVALID_ARGUMENT");
    assert.ok(!existsSync(f.imports));
  });
}

test("refuses linked skills without reading or copying the outside target", (t) => {
  const f = fixture(t, { skills: ["linked/SKILL.md"] });
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "SKILL.md"), "outside");
  symlinkSync(outside, join(f.source, "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => generateImportedExtensionPlugin(f.source, f.imports), /symbolic link/i);
  assert.ok(!existsSync(f.imports));
});

test("explicit directory declarations include direct Markdown files after an ancestor scan", (t) => {
  const f = fixture(t, { skills: ["skills", "skills/direct"], extensions: [] });
  f.write("skills/direct/guide.md", "# Guide");
  f.write("index.js", "throw new Error('not an extension')");
  const result = generateImportedExtensionPlugin(f.source, f.imports);
  const manifest = JSON.parse(readFileSync(join(result.path, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.contributes.skills.map((s) => s.path), ["src/skills/direct/guide.md"]);
  assert.deepEqual(manifest.permissions, ["agent.prompt.inject"]);
});

test("refuses oversized skill catalogs instead of silently dropping declarations", (t) => {
  const f = fixture(t, { skills: ["skills"] });
  for (let i = 0; i < 33; i++) f.write(`skills/${i}/SKILL.md`, `# Skill ${i}`);
  assert.throws(() => generateImportedExtensionPlugin(f.source, f.imports), /at most 32 skills/);
  assert.ok(!existsSync(f.imports));
});

test("cleans partial copies when a linked resource is encountered", (t) => {
  const f = fixture(t, { skills: ["SKILL.md"] });
  f.write("SKILL.md", "# Skill");
  mkdirSync(join(f.root, "outside"));
  symlinkSync(join(f.root, "outside"), join(f.source, "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => generateImportedExtensionPlugin(f.source, f.imports), /symbolic link/i);
  assert.ok(!existsSync(join(f.imports, "planning")));
});

import assert from "node:assert/strict";
import { fork } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { generateImportedExtensionPlugin } = await import("../electron/main/agent-extensions.ts");
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const hostEntry = fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url));

function createHarness(t, { skillsOnly = false, packageType } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-imported-package-skills-"));
  // The selected package itself lives under node_modules, as an npm global
  // installation would. Its own nested dependency tree must still be excluded.
  const source = join(root, "npm", "node_modules", "@fixture", "package-skills");
  const importRoot = join(root, "imported");
  const write = (path, content) => {
    const absolute = join(source, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  };
  const bodies = new Map([
    ["direct", "# Direct fixture\n\nUse fixture input."],
    ["release", "# Release fixture\n\nRead references/guide.txt before using assets/input.json."],
    ["alpha", "# Alpha fixture\n\nInspect fixture alpha."],
    ["beta", "# Beta fixture\n\nInspect fixture beta."],
  ]);
  const paths = new Map([
    ["direct", "skills/direct.md"],
    ["release", "skills/release/SKILL.md"],
    ["alpha", "skills/catalog/alpha/SKILL.md"],
    ["beta", "skills/catalog/beta/SKILL.md"],
  ]);
  write("package.json", JSON.stringify({
    name: "@fixture/package-skills",
    version: "1.0.0",
    ...(packageType ? { type: packageType } : {}),
    pi: {
      ...(!skillsOnly ? { extensions: ["index.ts"] } : {}),
      skills: ["skills/direct.md", "skills/release", "skills/catalog"],
    },
  }));
  if (!skillsOnly) write("index.ts", "export default function () {}\n");
  for (const [name, path] of paths) {
    write(path, `---\nname: ${name}\ndescription: Test ${name} skill.\n---\n\n${bodies.get(name)}\n`);
  }
  write("skills/release/references/guide.txt", "Fixture reference contents.\n");
  write("skills/release/assets/input.json", '{"fixture":true}\n');
  write("lib/node_modules-note.txt", "This is a resource, not a dependency directory.\n");
  write("node_modules/fixture-dependency/index.js", "module.exports = {};\n");

  const audits = [];
  const runtime = new PluginRuntime({
    hostEntry,
    spawnProcess: ({ entry }) => {
      // Execute only the repository's real plugin host and the importer's
      // generated no-op main.cjs. Fixture extension modules are only catalogued.
      const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      return {
        postMessage: (message) => { if (child.connected) child.send(message); },
        onMessage: (handler) => child.on("message", handler),
        onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
        kill: () => child.kill(),
      };
    },
    audit: (entry) => audits.push(entry),
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
    runtime.disposeWatchers();
    rmSync(root, { recursive: true, force: true });
  });
  return { source, importRoot, runtime, audits, bodies, paths };
}

function assertSkillCatalog(runtime, imported, bodies, paths) {
  const catalog = runtime.getSkills();
  assert.deepEqual(catalog.map((skill) => skill.name).sort(), [...bodies.keys()].sort());
  assert.equal(new Set(catalog.map((skill) => skill.id)).size, bodies.size,
    "different SKILL.md directories must not collide on one basename-derived ID");
  for (const skill of catalog) {
    assert.equal(skill.pluginId, imported.id);
    assert.ok(skill.id.startsWith(`${imported.id}/`));
    assert.equal(realpathSync(skill.path), realpathSync(join(imported.path, "src", paths.get(skill.name))));
    assert.equal(skill.description, `Test ${skill.name} skill.`);
    assert.deepEqual(runtime.loadSkillBody(skill.id), {
      id: skill.id,
      name: skill.name,
      body: bodies.get(skill.name),
      location: skill.path,
    });
  }
  return catalog;
}

test("an imported npm package exposes all declared skill files and directories through the real runtime", async (t) => {
  const { source, importRoot, runtime, bodies, paths } = createHarness(t);
  const imported = generateImportedExtensionPlugin(source, importRoot);
  await runtime.loadFromPath(imported.path);
  const catalog = assertSkillCatalog(runtime, imported, bodies, paths);
  assert.equal(runtime.getAgentExtensions().length, 1);
  assert.equal(realpathSync(runtime.getAgentExtensions()[0].entry), realpathSync(join(imported.path, "src/index.ts")));
  assert.equal(readFileSync(join(imported.path, "src/skills/release/references/guide.txt"), "utf8"), "Fixture reference contents.\n");
  assert.deepEqual(JSON.parse(readFileSync(join(imported.path, "src/skills/release/assets/input.json"), "utf8")), { fixture: true });
  assert.ok(existsSync(join(imported.path, "src/lib/node_modules-note.txt")));
  assert.equal(existsSync(join(imported.path, "src/node_modules")), false);

  await runtime.unload(imported.id);
  assert.deepEqual(runtime.getSkills(), []);
  assert.deepEqual(runtime.getAgentExtensions(), []);
  for (const skill of catalog) {
    assert.throws(() => runtime.loadSkillBody(skill.id), (error) => error.code === "NOT_FOUND");
  }
});

test("imported skill grants remain independent of agent extension grants and are revoked on reload", async (t) => {
  const { source, importRoot, runtime, audits, bodies, paths } = createHarness(t);
  const imported = generateImportedExtensionPlugin(source, importRoot);
  await runtime.loadFromPath(imported.path);
  const catalog = assertSkillCatalog(runtime, imported, bodies, paths);

  await runtime.loadFromPath(imported.path, ["agent.extension"]);
  assert.equal(runtime.getAgentExtensions().length, 1);
  assert.deepEqual(runtime.getSkills(), []);
  assert.ok(audits.some((entry) => entry.pluginId === imported.id &&
    entry.api === "plugin.skills.skipped" && entry.errorCode === "PERMISSION_DENIED"));
  for (const skill of catalog) {
    assert.throws(() => runtime.loadSkillBody(skill.id), (error) => error.code === "NOT_FOUND");
  }

  await runtime.loadFromPath(imported.path, ["agent.prompt.inject"]);
  assert.deepEqual(runtime.getAgentExtensions(), []);
  const restored = assertSkillCatalog(runtime, imported, bodies, paths);
  assert.deepEqual(restored.map((skill) => skill.id), catalog.map((skill) => skill.id));
});

test("a skill-only pi package loads in the plugin runtime without requiring executable extensions", async (t) => {
  const { source, importRoot, runtime, bodies, paths } = createHarness(t, { skillsOnly: true });
  const imported = generateImportedExtensionPlugin(source, importRoot);
  await runtime.loadFromPath(imported.path);
  assertSkillCatalog(runtime, imported, bodies, paths);
  assert.deepEqual(runtime.getAgentExtensions(), []);
  const manifest = runtime.getLoaded(imported.id).manifest;
  assert.ok(manifest.permissions.includes("agent.prompt.inject"));
  assert.equal(manifest.permissions.includes("agent.extension"), false);
});

for (const packageType of ["module", "commonjs", undefined]) {
  test(`imported ${packageType ?? "untyped"} packages initialize in the real plugin host`, async (t) => {
    const { source, importRoot, runtime, bodies, paths } = createHarness(t, { packageType });
    const imported = generateImportedExtensionPlugin(source, importRoot);
    await runtime.loadFromPath(imported.path);
    assertSkillCatalog(runtime, imported, bodies, paths);
    assert.equal(runtime.getAgentExtensions().length, 1);
    const manifest = runtime.getLoaded(imported.id).manifest;
    assert.equal(manifest.main, "main.cjs");
    assert.ok(existsSync(join(imported.path, manifest.main)));
    assert.equal(existsSync(join(imported.path, "main.js")), false);
    const original = readFileSync(join(source, "package.json"), "utf8");
    for (const path of ["package.json", "src/package.json"]) {
      assert.equal(readFileSync(join(imported.path, path), "utf8"), original);
    }
  });
}

test("re-importing an older ESM package creates a loadable copy without rewriting the existing plugin", async (t) => {
  const { source, importRoot, runtime, bodies, paths } = createHarness(t, { packageType: "module" });
  const previous = generateImportedExtensionPlugin(source, importRoot);
  // Model the on-disk layout generated before explicit CommonJS wrappers.
  const oldManifest = JSON.parse(readFileSync(join(previous.path, "manifest.json"), "utf8"));
  oldManifest.main = "main.js";
  writeFileSync(join(previous.path, "manifest.json"), JSON.stringify(oldManifest));
  renameSync(join(previous.path, "main.cjs"), join(previous.path, "main.js"));
  const oldFiles = new Map(["manifest.json", "main.js", "package.json", "src/package.json"]
    .map((path) => [path, readFileSync(join(previous.path, path), "utf8")]));

  const imported = generateImportedExtensionPlugin(source, importRoot);
  assert.notEqual(imported.id, previous.id);
  assert.notEqual(imported.path, previous.path);
  for (const [path, contents] of oldFiles) {
    assert.equal(readFileSync(join(previous.path, path), "utf8"), contents);
  }
  assert.equal(existsSync(join(previous.path, "main.cjs")), false);
  await runtime.loadFromPath(imported.path);
  assertSkillCatalog(runtime, imported, bodies, paths);
  assert.equal(runtime.getAgentExtensions().length, 1);
});

test("loading an older generated ESM wrapper rewrites it in place and initializes", async (t) => {
  const { source, importRoot, runtime, bodies, paths } = createHarness(t, { packageType: "module" });
  const imported = generateImportedExtensionPlugin(source, importRoot);
  const oldManifest = JSON.parse(readFileSync(join(imported.path, "manifest.json"), "utf8"));
  oldManifest.main = "main.js";
  writeFileSync(join(imported.path, "manifest.json"), JSON.stringify(oldManifest, null, 2) + "\n");
  renameSync(join(imported.path, "main.cjs"), join(imported.path, "main.js"));
  const originalPkg = readFileSync(join(imported.path, "package.json"), "utf8");

  await runtime.loadFromPath(imported.path);
  const manifest = runtime.getLoaded(imported.id).manifest;
  assert.equal(manifest.main, "main.cjs");
  assert.ok(existsSync(join(imported.path, "main.cjs")));
  assert.equal(existsSync(join(imported.path, "main.js")), false);
  assert.equal(readFileSync(join(imported.path, "package.json"), "utf8"), originalPkg);
  assertSkillCatalog(runtime, imported, bodies, paths);
  assert.equal(runtime.getAgentExtensions().length, 1);
});

test("loading a customized imported main.js does not rewrite the wrapper", async (t) => {
  const { source, importRoot, runtime } = createHarness(t, { packageType: "module" });
  const imported = generateImportedExtensionPlugin(source, importRoot);
  const oldManifest = JSON.parse(readFileSync(join(imported.path, "manifest.json"), "utf8"));
  oldManifest.main = "main.js";
  writeFileSync(join(imported.path, "manifest.json"), JSON.stringify(oldManifest, null, 2) + "\n");
  writeFileSync(join(imported.path, "main.js"), "module.exports = { custom: true };\n");
  const originalJs = readFileSync(join(imported.path, "main.js"), "utf8");

  await assert.rejects(runtime.loadFromPath(imported.path), /module is not defined in ES module scope/);
  assert.equal(JSON.parse(readFileSync(join(imported.path, "manifest.json"), "utf8")).main, "main.js");
  assert.equal(readFileSync(join(imported.path, "main.js"), "utf8"), originalJs);
});

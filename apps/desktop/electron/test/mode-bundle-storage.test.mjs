/**
 * Mode bundle storage and catalog service (issue #2544), against real temp dirs.
 *
 * These cover the rules that only exist because one mode directory is a
 * copyable unit: a reference never escapes it, a link never stands in for a
 * document, a copy refuses to merge, and a delete leaves unmanaged files alone.
 *
 * Node's resolve hook uses this worktree's mode sources rather than stale
 * workspace package builds, and leaves third-party resolution unchanged.
 */
import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const worktreeRoot = resolve(here, "..", "..", "..", "..");
const packages = join(worktreeRoot, "packages");
const url = (path) => pathToFileURL(path).href;

/**
 * A file symlink can require elevation or Developer Mode on Windows. Other
 * tests use directory junctions and hardlinks and still run on those hosts.
 */
async function linkOrSkip(t, target, path, type) {
  try {
    await symlink(target, path, type);
    return true;
  } catch (error) {
    if (error?.code !== "EPERM") throw error;
    t.skip("creating a symbolic link needs Developer Mode or elevation on Windows");
    return false;
  }
}
/**
 * Load the real mode-related workspace sources through a small barrel so the
 * test cannot pick up stale compiled package output.
 */
const sharedShim = `data:text/javascript,${encodeURIComponent([
  `export * from ${JSON.stringify(url(join(packages, "shared", "src", "mode-definition.ts")))};`,
  `export * from ${JSON.stringify(url(join(packages, "shared", "src", "mode-definition-parse.ts")))};`,
  `export * from ${JSON.stringify(url(join(packages, "shared", "src", "subagent-definition.ts")))};`,
  // `types.ts` is itself a barrel, and the hook resolves its `.js` specifiers.
  `export * from ${JSON.stringify(url(join(packages, "shared", "src", "types.ts")))};`,
].join("\n"))}`;

/** A data-URL module that re-exports both agent-runtime mode modules. */
const runtimeShim = `data:text/javascript,${encodeURIComponent([
  `export * from ${JSON.stringify(url(join(packages, "agent-runtime", "src", "mode-definitions.ts")))};`,
  `export * from ${JSON.stringify(url(join(packages, "agent-runtime", "src", "mode-definitions-bundle.ts")))};`,
].join("\n"))}`;

const hook = `
const shared = ${JSON.stringify(sharedShim)};
const modeRuntime = ${JSON.stringify(runtimeShim)};
/** Absolute URL for a specifier relative to its importer, or undefined. */
function absolute(specifier, parent) {
  if (!parent || !parent.startsWith("file:")) return undefined;
  try {
    return new URL(specifier, parent).href;
  } catch {
    return undefined;
  }
}

/**
 * Node strips the types itself; the sources use bundler-style specifiers
 * (extensionless, and .js that only exists as .ts), so the exact target is
 * tried first and the TypeScript sibling second. A real .js or .mjs still wins.
 */
export async function resolve(specifier, context, next) {
  // Only the mode loader is needed, so the package specifier maps to that
  // module rather than the whole agent-runtime barrel.
  if (specifier === "@pi-desktop/agent-runtime") return { url: modeRuntime, shortCircuit: true };
  if (specifier === "@pi-desktop/shared") return { url: shared, shortCircuit: true };
  if (specifier === "@pi-desktop/plugin-sdk") {
    return { url: ${JSON.stringify(url(join(packages, "plugin-sdk", "src", "skills.ts")))}, shortCircuit: true };
  }
  if (!specifier.startsWith(".") || specifier.startsWith("data:")) return next(specifier, context);
  try {
    return await next(specifier, context);
  } catch (error) {
    const target = absolute(specifier, context.parentURL);
    if (!target) throw error;
    const typescript = specifier.endsWith(".js")
      ? target.slice(0, -3) + ".ts"
      : /\\.[a-z]+$/i.test(specifier) ? null : target + ".ts";
    if (typescript === null) throw error;
    return next(typescript, context);
  }
}
`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

const storage = await import("../main/runtime/mode-bundle-storage.ts");
const catalogModule = await import("../main/runtime/mode-catalog.ts");
const { listModeSkills } = await import("../main/runtime/mode-skills.ts");

const BUNDLE_SOURCE = `name: sisyphus
label: Sisyphus
description: Split the work, keep the review separate
permission: agent
promptFile: prompts/orchestrator.md
subagents:
  - agents/oracle.agent.md
  - agents/fixer.agent.md
includeGlobalSubagents: false
disabledSkills:
  - verify-delivery
`;

const ORACLE = "---\nname: oracle\ndescription: Judge the trade-offs\ntools: Read, Grep\n---\nYou are the Oracle.\n";
const FIXER = "---\nname: fixer\ndescription: Make the change\ntools: inherit\n---\nYou are the Fixer.\n";

const STAGED_FIELDS = `artifacts:
  report:
    path: report.md
    template: templates/report.md
stages:
  work: {}
`;
const STAGED_BUNDLE_SOURCE = BUNDLE_SOURCE + STAGED_FIELDS;

async function makeRoot(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "pi-mode-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeMode(
  root,
  id,
  {
    source = BUNDLE_SOURCE,
    prompt = "You are the orchestrator.\n",
    agents = { "agents/oracle.agent.md": ORACLE, "agents/fixer.agent.md": FIXER },
  } = {},
) {
  const modeDir = join(root, id);
  await mkdir(join(modeDir, "prompts"), { recursive: true });
  await mkdir(join(modeDir, "agents"), { recursive: true });
  await writeFile(join(modeDir, "mode.yaml"), source, "utf8");
  if (source.includes("prompts/orchestrator.md")) {
    await writeFile(join(modeDir, "prompts", "orchestrator.md"), prompt, "utf8");
  }
  for (const [reference, text] of Object.entries(agents)) {
    await writeFile(join(modeDir, ...reference.split("/")), text, "utf8");
  }
  return modeDir;
}

test("readBundle returns the map, the prompt and agents keyed by relative path", async (t) => {
  const root = await makeRoot(t);
  const modeDir = await writeMode(root, "sisyphus");
  const contents = await storage.readModeBundle(modeDir);

  assert.equal(contents.source, BUNDLE_SOURCE);
  assert.equal(contents.prompt, "You are the orchestrator.\n");
  assert.deepEqual(Object.keys(contents.agents).sort(), ["agents/fixer.agent.md", "agents/oracle.agent.md"]);
  assert.equal(contents.agents["agents/oracle.agent.md"], ORACLE);
});

test("a directory without mode.yaml reads as the legacy format", async (t) => {
  const root = await makeRoot(t);
  const modeDir = join(root, "legacy");
  await mkdir(modeDir, { recursive: true });
  await writeFile(join(modeDir, "mode.md"), "---\nname: legacy\n---\nOld prompt.\n", "utf8");

  const contents = await storage.readModeBundle(modeDir);
  assert.equal(contents.source, null);
  assert.equal(contents.problem, undefined);
  assert.equal(contents.prompt, "");
  assert.deepEqual(contents.agents, {});
});

test("a missing mode has no bundle, has nothing to delete and cannot be copied", async (t) => {
  const root = await makeRoot(t);
  const from = join(root, "missing");
  const to = join(root, "copy");
  const service = catalogModule.createModeCatalogService({ dir: join(root, "missing-root") });

  assert.deepEqual(await storage.readModeBundle(from), { source: null, prompt: "", agents: {} });
  assert.equal(await storage.removeModeFiles(from), true);
  await assert.rejects(storage.copyModeBundle(from, to), { errorCode: "MODE_NOT_FOUND" });
  await assert.rejects(service.read("missing"), { errorCode: "MODE_NOT_FOUND" });
  assert.deepEqual(await readdir(root), []);
});

test("a reference that escapes the directory is reported, not read", async (t) => {
  const root = await makeRoot(t);
  const modeDir = join(root, "sisyphus");
  await mkdir(join(modeDir, "prompts"), { recursive: true });
  await writeFile(join(root, "outside.md"), "outside", "utf8");
  await writeFile(
    join(modeDir, "mode.yaml"),
    "name: sisyphus\npromptFile: ../outside.md\n",
    "utf8",
  );

  const contents = await storage.readModeBundle(modeDir);
  assert.equal(contents.prompt, "");
  const resolved = storage.resolveBundleReference(modeDir, "../outside.md");
  assert.equal(resolved.ok, false);
  assert.match(resolved.error, /must stay inside the mode directory/);
});

test("a symlinked document is reported instead of followed", async (t) => {
  const root = await makeRoot(t);
  const modeDir = join(root, "sisyphus");
  await mkdir(join(modeDir, "agents"), { recursive: true });
  const secret = join(root, "secret.md");
  await writeFile(secret, "SECRET", "utf8");
  if (!(await linkOrSkip(t, secret, join(modeDir, "agents", "oracle.agent.md"), "file"))) return;
  await writeFile(
    join(modeDir, "mode.yaml"),
    "name: sisyphus\npromptFile: prompt.md\nsubagents: [agents/oracle.agent.md]\n",
    "utf8",
  );
  await writeFile(join(modeDir, "prompt.md"), "Prompt.", "utf8");

  const bundle = await storage.readUserModeBundle(modeDir);
  assert.equal(bundle.subagents.length, 1);
  assert.equal(bundle.subagents[0].text, null);
  assert.match(bundle.subagents[0].problem, /symbolic link/);
  // The contents never leak the target.
  const contents = await storage.readModeBundle(modeDir);
  assert.deepEqual(contents.agents, {});
});

test("a hardlinked document is reported instead of read", async (t) => {
  const root = await makeRoot(t);
  const modeDir = join(root, "sisyphus");
  await mkdir(join(modeDir, "agents"), { recursive: true });
  const shared = join(root, "shared.md");
  await writeFile(shared, "SHARED", "utf8");
  await link(shared, join(modeDir, "agents", "oracle.agent.md"));
  await writeFile(join(modeDir, "mode.yaml"), "name: sisyphus\npromptFile: p.md\nsubagents: [agents/oracle.agent.md]\n", "utf8");
  await writeFile(join(modeDir, "p.md"), "p", "utf8");

  const bundle = await storage.readUserModeBundle(modeDir);
  assert.equal(bundle.subagents[0].text, null);
  assert.match(bundle.subagents[0].problem, /hardlinked/);
});

test("a mixed-separator or absolute reference never resolves outside", () => {
  const modeDir = join(tmpdir(), "pi-mode-ref");
  for (const reference of ["/abs.md", "C:/x.md", "~/x.md", "a/../../x.md", "a\\b.md", ".git/config"]) {
    const resolved = storage.resolveBundleReference(modeDir, reference);
    assert.equal(resolved.ok, false, `${reference} must be rejected`);
  }
});

test("writeBundle writes the map last and removes a stale legacy document", async (t) => {
  const root = await makeRoot(t);
  const modeDir = join(root, "sisyphus");
  await mkdir(modeDir, { recursive: true });
  await writeFile(join(modeDir, "mode.md"), "---\nname: sisyphus\n---\nOld prompt.\n", "utf8");

  await storage.writeModeBundle(modeDir, {
    source: BUNDLE_SOURCE,
    prompt: "New prompt.\n",
    agents: { "agents/oracle.agent.md": ORACLE, "agents/fixer.agent.md": FIXER },
  });

  assert.equal(await readFile(join(modeDir, "prompts", "orchestrator.md"), "utf8"), "New prompt.\n");
  assert.equal(await readFile(join(modeDir, "agents", "oracle.agent.md"), "utf8"), ORACLE);
  assert.deepEqual(await readdir(modeDir).then((names) => names.sort()), ["agents", "mode.yaml", "prompts"]);
  await assert.rejects(readFile(join(modeDir, "mode.md"), "utf8"), /ENOENT/);
});

test("writeBundle refuses a partial or escaping set before writing anything", async (t) => {
  const root = await makeRoot(t);
  const modeDir = join(root, "sisyphus");

  await assert.rejects(
    storage.writeModeBundle(modeDir, {
      source: "name: sisyphus\npromptFile: p.md\nsubagents: [agents/oracle.agent.md]\n",
      prompt: "p",
      agents: {},
    }),
    /no content for "agents\/oracle.agent.md"/,
  );
  await assert.rejects(
    storage.writeModeBundle(modeDir, {
      source: "name: sisyphus\npromptFile: ../escape.md\n",
      prompt: "p",
      agents: {},
    }),
    /promptFile: must stay inside the mode directory/,
  );
  await assert.rejects(
    storage.writeModeBundle(modeDir, {
      source: "name: sisyphus\npromptFile: p.md\nsubagents: [agents/a.md]\n",
      prompt: "p",
      agents: { "agents/a.md": "a", "agents/b.md": "b" },
    }),
    /"agents\/b.md" is not declared in mode.yaml/,
  );
  // Nothing was created for any of the three attempts.
  await assert.rejects(readdir(modeDir), /ENOENT/);
});

test("writeBundle refuses to write through a symlinked target", async (t) => {
  const root = await makeRoot(t);
  const modeDir = join(root, "sisyphus");
  await mkdir(modeDir, { recursive: true });
  const outside = join(root, "outside.md");
  await writeFile(outside, "untouched", "utf8");
  if (!(await linkOrSkip(t, outside, join(modeDir, "p.md"), "file"))) return;

  await assert.rejects(
    storage.writeModeBundle(modeDir, { source: "name: sisyphus\npromptFile: p.md\n", prompt: "new", agents: {} }),
    /symbolic link/,
  );
  assert.equal(await readFile(outside, "utf8"), "untouched");
});

test("the catalog copies only declared documents and discovered skills, preserving resource bytes", async (t) => {
  const root = await makeRoot(t);
  const from = await writeMode(root, "sisyphus", { source: STAGED_BUNDLE_SOURCE });
  const skill = join(from, "skills", "verify-delivery");
  const binary = Buffer.from([0, 13, 10, 234, 255]);
  await mkdir(join(skill, "assets"), { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: Verify delivery\n---\nUse assets/example.bin.\n");
  await writeFile(join(skill, "assets", "example.bin"), binary);
  await writeFile(join(from, "skills", "bare.md"), "Bare skill instructions.\n");
  await mkdir(join(from, "skills", "no-document"));
  await writeFile(join(from, "skills", "no-document", "notes.txt"), "not a skill");
  await writeFile(join(from, "skills", "notes.txt"), "not a skill either");
  await mkdir(join(from, "templates"));
  await writeFile(join(from, "templates", "report.md"), "# Report\n");
  await writeFile(join(from, "templates", "notes.md"), "# Personal notes\n");
  await writeFile(join(from, "agents", "notes.md"), "# More notes\n");
  await writeFile(join(from, "mode.md"), "Legacy contents.\n");

  const service = catalogModule.createModeCatalogService({ dir: root });
  const to = join(root, "sisyphus-copy");
  await service.copy("sisyphus", "sisyphus-copy");

  assert.equal(await readFile(join(to, "mode.yaml"), "utf8"), STAGED_BUNDLE_SOURCE.replace("name: sisyphus", "name: sisyphus-copy"));
  assert.equal(await readFile(join(to, "prompts", "orchestrator.md"), "utf8"), "You are the orchestrator.\n");
  assert.equal(await readFile(join(to, "agents", "oracle.agent.md"), "utf8"), ORACLE);
  assert.equal(await readFile(join(to, "templates", "report.md"), "utf8"), "# Report\n");
  assert.deepEqual(await readFile(join(to, "skills", "verify-delivery", "assets", "example.bin")), binary);
  assert.deepEqual((await readdir(join(to, "skills"))).sort(), ["bare.md", "verify-delivery"]);
  for (const path of ["templates/notes.md", "agents/notes.md", "mode.md"]) {
    await assert.rejects(readFile(join(to, path)), { code: "ENOENT" });
  }
  assert.equal((await service.definition("sisyphus-copy"))?.artifacts[0].template, "# Report\n");
  assert.deepEqual(await listModeSkills(service, "sisyphus-copy"), [
    { id: "bare", name: "bare", enabled: true },
    { id: "verify-delivery", name: "Verify delivery", enabled: false },
  ]);
});

test("a hardlinked or junctioned resource of a discovered skill prevents a partial copy", async (t) => {
  const root = await makeRoot(t);
  const modeDir = await writeMode(root, "sisyphus");
  const skill = join(modeDir, "skills", "check");
  const copy = join(root, "copy");
  const resource = join(skill, "resource.md");
  const outside = join(root, "external");
  await mkdir(outside);
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "Check the resource.\n");
  await writeFile(join(outside, "resource.md"), "Outside.\n");

  await link(join(outside, "resource.md"), resource);
  await assert.rejects(storage.copyModeBundle(modeDir, copy), /resource\.md: .*hardlinked/);
  await rm(resource);
  await symlink(outside, join(skill, "linked-resources"), "junction");
  await assert.rejects(storage.copyModeBundle(modeDir, copy), /linked-resources: .*symbolic link/);
  await assert.rejects(readdir(copy), { code: "ENOENT" });
  assert.equal(await readFile(join(outside, "resource.md"), "utf8"), "Outside.\n");
});

test("copy does not publish a bundle whose referenced role is invalid", async (t) => {
  const root = await makeRoot(t);
  const from = await writeMode(root, "sisyphus", { agents: { "agents/oracle.agent.md": "No description.\n", "agents/fixer.agent.md": FIXER } });
  const to = join(root, "copy");
  await assert.rejects(storage.copyModeBundle(from, to), /oracle\.agent\.md.*missing `description`/);
  await assert.rejects(readdir(to), { code: "ENOENT" });
});

test("copyModeBundle refuses to merge into an existing directory", async (t) => {
  const root = await makeRoot(t);
  const from = await writeMode(root, "sisyphus");
  const to = join(root, "occupied");
  await mkdir(to, { recursive: true });

  await assert.rejects(storage.copyModeBundle(from, to), /already exists/);
  assert.deepEqual(await readdir(to), []);
});

test("copy and delete preflight missing prompt, role and template references", async (t) => {
  const root = await makeRoot(t);
  for (const [id, missing] of [
    ["prompt", "prompts/orchestrator.md"],
    ["role", "agents/fixer.agent.md"],
    ["template", "templates/report.md"],
  ]) {
    const modeDir = await writeMode(root, id, { source: STAGED_BUNDLE_SOURCE });
    await mkdir(join(modeDir, "templates"));
    await writeFile(join(modeDir, "templates", "report.md"), "# Report\n");
    await writeFile(join(modeDir, "mode.md"), "Old prompt.\n");
    await rm(join(modeDir, missing));
    const destination = join(root, `${id}-copy`);

    await assert.rejects(storage.copyModeBundle(modeDir, destination), /not found/);
    await assert.rejects(storage.removeModeFiles(modeDir), /not found/);
    await assert.rejects(readdir(destination), { code: "ENOENT" });
    assert.equal(await readFile(join(modeDir, "mode.yaml"), "utf8"), STAGED_BUNDLE_SOURCE);
    assert.equal(await readFile(join(modeDir, "mode.md"), "utf8"), "Old prompt.\n");
    assert.equal(await readFile(join(modeDir, "agents", "oracle.agent.md"), "utf8"), ORACLE);
  }
});

test("a dangling manifest link is not absence and never activates mode.md", async (t) => {
  const root = await makeRoot(t);
  const modeDir = join(root, "sisyphus");
  const legacySource = "---\nname: sisyphus\n---\nLegacy prompt.\n";
  await mkdir(modeDir);
  await writeFile(join(modeDir, "mode.md"), legacySource);
  await symlink(join(root, "missing-target"), join(modeDir, "mode.yaml"), "junction");

  const service = catalogModule.createModeCatalogService({ dir: root });
  const catalog = await service.catalog();
  assert.equal(catalog.modes.find((entry) => entry.id === "sisyphus")?.available, false);
  assert.equal(catalog.diagnostics[0].filePath, join(modeDir, "mode.yaml"));
  assert.match(catalog.diagnostics[0].errors[0], /symbolic link/);
  await assert.rejects(service.read("sisyphus"), /mode.yaml: .*symbolic link/);
  await assert.rejects(service.copy("sisyphus", "copy"), /mode.yaml: .*symbolic link/);
  await assert.rejects(service.remove("sisyphus"), /mode.yaml: .*symbolic link/);
  assert.equal(await readFile(join(modeDir, "mode.md"), "utf8"), legacySource);
  await assert.rejects(readdir(join(root, "copy")), { code: "ENOENT" });
});

test("removeModeFiles deletes only what the mode manages", async (t) => {
  const root = await makeRoot(t);
  const modeDir = await writeMode(root, "sisyphus");
  await mkdir(join(modeDir, "skills", "mine"), { recursive: true });
  await writeFile(join(modeDir, "skills", "mine", "SKILL.md"), "# Mine\n", "utf8");
  await writeFile(join(modeDir, "notes.txt"), "user notes", "utf8");

  const removedDirectory = await storage.removeModeFiles(modeDir);

  assert.equal(removedDirectory, false, "a directory with user files stays");
  const remaining = (await readdir(modeDir)).sort();
  assert.deepEqual(remaining, ["notes.txt", "skills"]);
  assert.equal(await readFile(join(modeDir, "notes.txt"), "utf8"), "user notes");
  await assert.rejects(readFile(join(modeDir, "agents", "oracle.agent.md"), "utf8"), /ENOENT/);
});

test("removeModeFiles also clears a lingering legacy document and empty directory", async (t) => {
  const root = await makeRoot(t);
  const modeDir = await writeMode(root, "sisyphus");
  await writeFile(join(modeDir, "mode.md"), "---\nname: sisyphus\n---\nLegacy.\n", "utf8");

  assert.equal(await storage.removeModeFiles(modeDir), true);
  await assert.rejects(readdir(modeDir), /ENOENT/);
});

test("deleting a legacy mode removes declared templates, not other files in the directory", async (t) => {
  const root = await makeRoot(t);
  const modeDir = join(root, "review");
  await mkdir(join(modeDir, "templates"), { recursive: true });
  const legacySource = `---\n${STAGED_FIELDS}---\nReview.\n`;
  await writeFile(join(modeDir, "mode.md"), legacySource);
  await writeFile(join(modeDir, "templates", "report.md"), "# Template\n");
  await writeFile(join(modeDir, "templates", "notes.md"), "# Notes\n");
  const service = catalogModule.createModeCatalogService({ dir: root });

  assert.equal((await service.definition("review"))?.artifacts[0].template, "# Template\n");
  assert.equal((await service.remove("review")).modes.some((mode) => mode.id === "review"), false);
  assert.deepEqual(await readdir(join(modeDir, "templates")), ["notes.md"]);
  assert.equal(await readFile(join(modeDir, "templates", "notes.md"), "utf8"), "# Notes\n");
});

test("copy, read, save and delete refuse linked directory ancestors", async (t) => {
  const root = await makeRoot(t);
  const actual = await writeMode(root, "sisyphus");
  const alias = join(root, "linked-mode");
  const linkedRoot = join(root, "linked-root");
  const outside = await makeRoot(t);
  await symlink(actual, alias, "junction");
  await symlink(outside, linkedRoot, "junction");
  assert.match((await storage.readModeBundle(alias)).problem, /symbolic link/);
  await assert.rejects(storage.copyModeBundle(alias, join(root, "copy")), /symbolic link/);
  await assert.rejects(storage.copyModeBundle(actual, join(linkedRoot, "copy")), /symbolic link/);
  await assert.rejects(storage.removeModeFiles(alias), /symbolic link/);
  await assert.rejects(catalogModule.createModeCatalogService({ dir: linkedRoot }).catalog(), /symbolic link/);

  const agents = join(actual, "agents");
  await rm(agents, { recursive: true });
  await writeFile(join(outside, "oracle.agent.md"), ORACLE);
  await writeFile(join(outside, "fixer.agent.md"), FIXER);
  await symlink(outside, agents, "junction");
  const service = catalogModule.createModeCatalogService({ dir: root });
  const catalog = await service.catalog();
  assert.equal(catalog.modes.find((entry) => entry.id === "sisyphus")?.available, false);
  await assert.rejects(service.copy("sisyphus", "copy"), /symbolic link/);
  await assert.rejects(service.remove("sisyphus"), /symbolic link/);
  await assert.rejects(service.writeBundle("sisyphus", {
    source: BUNDLE_SOURCE,
    prompt: "changed",
    agents: { "agents/oracle.agent.md": ORACLE, "agents/fixer.agent.md": FIXER },
  }), /symbolic link/);
  await assert.rejects(readdir(join(root, "copy")), { code: "ENOENT" });
  assert.deepEqual((await readdir(outside)).sort(), ["fixer.agent.md", "oracle.agent.md"]);
  assert.equal(await readFile(join(outside, "oracle.agent.md"), "utf8"), ORACLE);
  assert.equal(await readFile(join(actual, "prompts", "orchestrator.md"), "utf8"), "You are the orchestrator.\n");
  await assert.rejects(service.read("linked-mode"), /symbolic link/);
  assert.equal(catalog.modes.some((entry) => entry.id === "linked-mode"), false);
});

test("copy, read, save and delete refuse hardlinked entry points", async (t) => {
  const root = await makeRoot(t);
  const modeDir = await writeMode(root, "sisyphus");
  const legacySource = "---\nname: sisyphus\n---\nOld prompt.\n";
  const manifest = join(modeDir, "mode.yaml");
  const legacy = join(modeDir, "mode.md");
  const externalManifest = join(root, "external.yaml");
  const externalLegacy = join(root, "external.md");
  await link(manifest, externalManifest);
  await writeFile(legacy, legacySource);
  const service = catalogModule.createModeCatalogService({ dir: root });

  assert.equal((await service.catalog()).modes.find((entry) => entry.id === "sisyphus")?.available, false);
  await assert.rejects(service.read("sisyphus"), /hardlinked/);
  await assert.rejects(service.copy("sisyphus", "copy"), /hardlinked/);
  await assert.rejects(service.remove("sisyphus"), /hardlinked/);
  await assert.rejects(service.writeBundle("sisyphus", {
    source: BUNDLE_SOURCE,
    prompt: "changed",
    agents: { "agents/oracle.agent.md": ORACLE, "agents/fixer.agent.md": FIXER },
  }), /hardlinked/);
  assert.equal(await readFile(join(modeDir, "prompts", "orchestrator.md"), "utf8"), "You are the orchestrator.\n");
  assert.equal(await readFile(legacy, "utf8"), legacySource);

  await rm(externalManifest);
  await link(legacy, externalLegacy);
  await assert.rejects(service.copy("sisyphus", "copy"), /hardlinked/);
  await assert.rejects(service.remove("sisyphus"), /hardlinked/);
  assert.equal(await readFile(manifest, "utf8"), BUNDLE_SOURCE);
  await rm(manifest);
  assert.equal((await service.catalog()).modes.find((entry) => entry.id === "sisyphus")?.available, false);
  await assert.rejects(service.read("sisyphus"), /hardlinked/);
  await assert.rejects(service.write("sisyphus", legacySource.replace("Old", "New")), /hardlinked/);
  await assert.rejects(service.remove("sisyphus"), /hardlinked/);
  assert.equal(await readFile(externalLegacy, "utf8"), legacySource);
  await assert.rejects(readdir(join(root, "copy")), { code: "ENOENT" });
});

test("modeSkillsDirectory creates on demand and refuses a link", async (t) => {
  const root = await makeRoot(t);
  const modeDir = await writeMode(root, "sisyphus");

  const missing = await storage.modeSkillsDirectory(modeDir, false);
  assert.equal(missing, join(modeDir, "skills"));
  await assert.rejects(readdir(missing), /ENOENT/);

  const created = await storage.modeSkillsDirectory(modeDir, true);
  assert.deepEqual(await readdir(created), []);

  const linked = join(await makeRoot(t), "elsewhere");
  await mkdir(linked, { recursive: true });
  const otherMode = await writeMode(root, "other");
  // A junction needs no elevation on Windows, and it is still a link the mode
  // must refuse: a skills tree cannot point at another mode's tree.
  if (!(await linkOrSkip(t, linked, join(otherMode, "skills"), "junction"))) return;
  await assert.rejects(storage.modeSkillsDirectory(otherMode, true), /symbolic link/);
});

test("the catalog service loads a bundle, reports diagnostics and copies it", async (t) => {
  const root = await makeRoot(t);
  await writeMode(root, "sisyphus");
  // A legacy mode in the same root must keep working unchanged.
  const legacyDir = join(root, "reviewer");
  await mkdir(legacyDir, { recursive: true });
  await writeFile(
    join(legacyDir, "mode.md"),
    "---\nname: reviewer\ndescription: Review without changing anything\npermission: contract\n---\nReview the change.\n",
    "utf8",
  );

  const service = catalogModule.createModeCatalogService({ dir: root });
  const catalog = await service.catalog();

  assert.deepEqual(
    catalog.modes.map((entry) => [entry.id, entry.available, entry.source]),
    [
      ["agent", true, "builtin"],
      ["plan", true, "builtin"],
      ["goal", true, "builtin"],
      ["reviewer", true, "user"],
      ["sisyphus", true, "user"],
    ],
  );
  assert.equal(
    catalog.modes.find((entry) => entry.id === "sisyphus")?.filePath,
    join(root, "sisyphus", "mode.yaml"),
  );
  assert.deepEqual(catalog.diagnostics, []);

  const definition = await service.definition("sisyphus");
  assert.deepEqual(definition?.bundle?.subagents.map((role) => role.name), ["oracle", "fixer"]);
  assert.equal(definition?.bundle?.includeGlobalSubagents, false);
  assert.deepEqual(definition?.bundle?.disabledSkills, ["verify-delivery"]);
  // `parseModeDefinition` trims the prompt body; `readBundle` returns the file as written.
  assert.equal(definition?.prompt, "You are the orchestrator.");

  // The legacy mode keeps a definition without a bundle.
  assert.equal((await service.definition("reviewer"))?.bundle, undefined);

  const bundle = await service.readBundle("sisyphus");
  assert.equal(bundle.source, BUNDLE_SOURCE);
  assert.equal(bundle.prompt, "You are the orchestrator.\n");
  assert.deepEqual(Object.keys(bundle.agents).sort(), ["agents/fixer.agent.md", "agents/oracle.agent.md"]);

  await service.copy("sisyphus", "sisyphus-clone");
  const clone = await service.definition("sisyphus-clone");
  assert.deepEqual(clone?.bundle?.subagents.map((role) => role.name), ["oracle", "fixer"]);
  assert.equal(clone?.prompt, "You are the orchestrator.");
  await assert.rejects(service.copy("sisyphus", "sisyphus-clone"), /already exists/);
});

test("a broken bundle is reported by file and field and never loads mode.md", async (t) => {
  const root = await makeRoot(t);
  const modeDir = join(root, "sisyphus");
  await mkdir(modeDir, { recursive: true });
  // A valid legacy document sits beside a broken bundle.
  await writeFile(join(modeDir, "mode.md"), "---\nname: sisyphus\n---\nLegacy prompt.\n", "utf8");
  await writeFile(join(modeDir, "mode.yaml"), "name: sisyphus\npromptFile: prompts/missing.md\n", "utf8");

  const service = catalogModule.createModeCatalogService({ dir: root });
  const catalog = await service.catalog();
  const entry = catalog.modes.find((candidate) => candidate.id === "sisyphus");
  assert.equal(entry?.available, false);
  assert.equal(entry?.filePath, join(modeDir, "mode.yaml"));
  assert.equal(catalog.diagnostics.length, 1);
  assert.equal(catalog.diagnostics[0].filePath, join(modeDir, "mode.yaml"));
  assert.deepEqual(catalog.diagnostics[0].errors, ["promptFile: not found in the mode directory"]);
  assert.equal(await service.definition("sisyphus"), undefined);
});

test("the catalog validates a YAML body as a bundle and keeps legacy validation", async (t) => {
  const root = await makeRoot(t);
  await writeMode(root, "sisyphus");
  const service = catalogModule.createModeCatalogService({ dir: root });

  const valid = await service.validate("sisyphus", BUNDLE_SOURCE);
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.errors, []);

  const escaping = await service.validate("sisyphus", "name: sisyphus\npromptFile: ../x.md\n");
  assert.equal(escaping.ok, false);
  assert.match(escaping.errors.join("\n"), /promptFile: must stay inside the mode directory/);

  // A legacy Markdown source keeps the old path and the old errors.
  const legacy = await service.validate("reviewer", "---\nname: reviewer\n---\nReview the change.\n");
  assert.equal(legacy.ok, true);
});

test("writeBundle rejects an invalid map and leaves the previous documents intact", async (t) => {
  const root = await makeRoot(t);
  const modeDir = await writeMode(root, "sisyphus");
  const service = catalogModule.createModeCatalogService({ dir: root });

  await assert.rejects(
    service.writeBundle("sisyphus", {
      source: "name: sisyphus\npromptFile: ../escape.md\n",
      prompt: "x",
      agents: {},
    }),
    /promptFile: must stay inside the mode directory/,
  );
  assert.equal(await readFile(join(modeDir, "mode.yaml"), "utf8"), BUNDLE_SOURCE);
  assert.equal(await readFile(join(modeDir, "prompts", "orchestrator.md"), "utf8"), "You are the orchestrator.\n");
});

test("a bundle save cannot claim an existing unmanaged file or an entry-point alias", async (t) => {
  const root = await makeRoot(t);
  const modeDir = await writeMode(root, "sisyphus");
  const notes = join(modeDir, "prompts", "notes.md");
  await writeFile(notes, "Unmanaged notes.\n");
  const service = catalogModule.createModeCatalogService({ dir: root });
  const agents = { "agents/oracle.agent.md": ORACLE, "agents/fixer.agent.md": FIXER };
  await assert.rejects(service.writeBundle("sisyphus", {
    source: BUNDLE_SOURCE.replace("prompts/orchestrator.md", "prompts/notes.md"),
    prompt: "changed",
    agents,
  }), /unmanaged/);
  await assert.rejects(service.writeBundle("sisyphus", {
    source: BUNDLE_SOURCE.replace("prompts/orchestrator.md", "mode.yaml."),
    prompt: "changed",
    agents,
  }), { errorCode: "MODE_DEFINITION_INVALID" });
  assert.equal(await readFile(notes, "utf8"), "Unmanaged notes.\n");
  assert.equal(await readFile(join(modeDir, "mode.yaml"), "utf8"), BUNDLE_SOURCE);
});

test("writeBundle persists a new bundle and the catalog picks it up", async (t) => {
  const root = await makeRoot(t);
  const service = catalogModule.createModeCatalogService({ dir: root });
  const source = storage.newModeBundleSource({
    id: "solo",
    label: "Solo",
    promptFile: "prompts/solo.md",
    includeGlobalSubagents: true,
  });

  await service.writeBundle("solo", { source, prompt: "Work alone.\n", agents: {} });
  const catalog = await service.catalog();
  assert.equal(catalog.modes.find((entry) => entry.id === "solo")?.available, true);
  const definition = await service.definition("solo");
  // The parsed prompt is trimmed; the file keeps what was written.
  assert.equal(definition?.prompt, "Work alone.");
  assert.equal(
    await readFile(join(root, "solo", "prompts", "solo.md"), "utf8"),
    "Work alone.\n",
  );
  assert.equal(definition?.bundle?.includeGlobalSubagents, true);
  assert.deepEqual(definition?.bundle?.subagents, []);
});

test("removing a bundle keeps the user's own files and the mode stops loading", async (t) => {
  const root = await makeRoot(t);
  const modeDir = await writeMode(root, "sisyphus", { source: STAGED_BUNDLE_SOURCE });
  await mkdir(join(modeDir, "templates", "archive"), { recursive: true });
  await writeFile(join(modeDir, "templates", "report.md"), "# Report\n", "utf8");
  await writeFile(join(modeDir, "templates", "notes.md"), "# Notes\n", "utf8");
  await writeFile(join(modeDir, "templates", "archive", "draft.md"), "# Draft\n", "utf8");
  await writeFile(join(modeDir, "mode.md"), "---\nname: sisyphus\n---\nOld prompt.\n");
  const service = catalogModule.createModeCatalogService({ dir: root });
  const catalog = await service.remove("sisyphus");
  assert.equal(catalog.modes.some((entry) => entry.id === "sisyphus"), false);
  for (const path of ["mode.yaml", "mode.md", "templates/report.md"]) {
    await assert.rejects(readFile(join(modeDir, path)), { code: "ENOENT" });
  }
  assert.equal(await readFile(join(modeDir, "templates", "notes.md"), "utf8"), "# Notes\n");
  assert.equal(await readFile(join(modeDir, "templates", "archive", "draft.md"), "utf8"), "# Draft\n");
});

test("skillsDirectory resolves and creates the mode's skills path", async (t) => {
  const root = await makeRoot(t);
  await writeMode(root, "sisyphus");
  const service = catalogModule.createModeCatalogService({ dir: root });

  const path = await service.skillsDirectory("sisyphus", true);
  assert.equal(path, join(root, "sisyphus", "skills"));
  assert.deepEqual(await readdir(path), []);
  // `create: false` reports the same path without creating it.
  await rm(path, { recursive: true });
  assert.equal(await service.skillsDirectory("sisyphus"), join(root, "sisyphus", "skills"));
  await assert.rejects(readdir(path), /ENOENT/);
});

test("isModeBundleSource tells a YAML map from a Markdown document", () => {
  assert.equal(catalogModule.isModeBundleSource("name: sisyphus\npromptFile: p.md\n"), true);
  assert.equal(catalogModule.isModeBundleSource("---\nname: legacy\n---\nBody.\n"), false);
  assert.equal(catalogModule.isModeBundleSource("Just a plain prompt."), false);
  assert.equal(catalogModule.isModeBundleSource(""), false);
  // The path separator in a value must not be mistaken for a key line.
  assert.equal(catalogModule.isModeBundleSource("Review: the change\nand more"), true);
});

test("relative paths in the copy stay relative to the new directory", async (t) => {
  const root = await makeRoot(t);
  const from = await writeMode(root, "sisyphus");
  const to = join(root, "nested", "sisyphus-copy");
  await mkdir(dirname(to), { recursive: true });
  await storage.copyModeBundle(from, to);

  const contents = await storage.readModeBundle(to);
  assert.equal(contents.prompt, "You are the orchestrator.\n");
  // Nothing was written into the source's parents.
  const siblings = await readdir(root);
  assert.deepEqual(siblings.sort(), ["nested", "sisyphus"]);
  assert.equal(relative(from, to).startsWith(".."), true);
  assert.equal(relative(to, from).startsWith(".."), true);
  assert.equal(await readFile(join(to, "agents", "fixer.agent.md"), "utf8"), FIXER);
  assert.equal(sep.length > 0, true);
});

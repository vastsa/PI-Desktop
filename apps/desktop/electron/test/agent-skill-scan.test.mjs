import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "..", "..", "test", "helpers", "ts-import-hooks.mjs")));
const { scanExternalSkills, readFrontmatter } = await import(
  "../main/importers/agent-skill-scan.ts"
);

async function makeHome() {
  const root = await mkdtemp(join(tmpdir(), "pi-skill-scan-"));
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  return { root, home };
}

const skillFile = (name, description, body = "instructions go here") =>
  ["---", `name: ${name}`, `description: ${description}`, "---", "", body, ""].join("\n");

test("file-shaped skills under ~/.claude/skills produce candidates", async () => {
  const { root, home } = await makeHome();
  try {
    const dir = join(home, ".claude", "skills");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "review.md"), skillFile("Review", "Reviews changes"));
    const result = await scanExternalSkills({ homeDir: home, env: {} });
    const cands = result.candidates.filter((c) => c.source === "claude-user");
    assert.equal(cands.length, 1);
    assert.equal(cands[0].shape, "file");
    assert.equal(cands[0].id, "review");
    assert.equal(cands[0].name, "Review");
    assert.equal(cands[0].description, "Reviews changes");
    assert.ok(cands[0].bytes > 0);
    const src = result.sources.find((s) => s.kind === "claude-user");
    assert.equal(src.exists, true);
    assert.equal(src.count, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("directory-shaped skills read SKILL.md and record rootDir", async () => {
  const { root, home } = await makeHome();
  try {
    const dir = join(home, ".claude", "skills", "code-review");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      skillFile("Code Review", "Deep review of a diff", "walk the diff hunks"),
    );
    const result = await scanExternalSkills({ homeDir: home, env: {} });
    const cand = result.candidates.find((c) => c.source === "claude-user");
    assert.equal(cand.shape, "dir");
    assert.equal(cand.rootDir, dir);
    assert.equal(cand.sourcePath, join(dir, "SKILL.md"));
    assert.equal(cand.name, "Code Review");
    assert.equal(cand.id, "code-review");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing frontmatter still produces a candidate with warnings", async () => {
  const { root, home } = await makeHome();
  try {
    const dir = join(home, ".claude", "skills");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "loose.md"), "just body text, no frontmatter\n");
    const result = await scanExternalSkills({ homeDir: home, env: {} });
    const cand = result.candidates.find((c) => c.source === "claude-user");
    assert.ok(cand);
    assert.equal(cand.id, "loose");
    assert.equal(cand.name, "loose");
    assert.equal(cand.description, "");
    assert.ok(cand.warnings.includes("missing frontmatter"));
    assert.ok(cand.warnings.includes("frontmatter missing name"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skills with an empty body are skipped entirely", async () => {
  const { root, home } = await makeHome();
  try {
    const dir = join(home, ".claude", "skills");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "empty.md"), ["---", "name: Empty", "description: nothing", "---", ""].join("\n"));
    await writeFile(join(dir, "good.md"), skillFile("Good", "has body"));
    const result = await scanExternalSkills({ homeDir: home, env: {} });
    const ids = result.candidates.filter((c) => c.source === "claude-user").map((c) => c.id);
    assert.deepEqual(ids, ["good"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project-level scanning picks up .claude/skills and .agents/skills", async () => {
  const { root, home } = await makeHome();
  const project = join(root, "project");
  try {
    await mkdir(join(project, ".claude", "skills"), { recursive: true });
    await writeFile(
      join(project, ".claude", "skills", "spec.md"),
      skillFile("Spec Writer", "Writes specs"),
    );
    await mkdir(join(project, ".agents", "skills"), { recursive: true });
    await writeFile(
      join(project, ".agents", "skills", "helper.md"),
      skillFile("Helper", "helps out"),
    );
    const result = await scanExternalSkills({ homeDir: home, projectPath: project, env: {} });
    const claudeProj = result.candidates.find((c) => c.source === "claude-project");
    const piProj = result.candidates.find((c) => c.source === "pi-project");
    assert.ok(claudeProj);
    assert.equal(claudeProj.id, "spec-writer");
    assert.ok(piProj);
    assert.equal(piProj.id, "helper");
    assert.ok(piProj.warnings.includes("already in current registry"));
    const kinds = result.sources.map((s) => s.kind);
    assert.ok(kinds.includes("claude-user"));
    assert.ok(kinds.includes("claude-project"));
    assert.ok(kinds.includes("pi-user"));
    assert.ok(kinds.includes("pi-project"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PI_DESKTOP_AGENTS_DIR overrides the default pi-user skills root", async () => {
  const { root, home } = await makeHome();
  const override = join(root, "custom");
  try {
    await mkdir(join(override, "skills"), { recursive: true });
    await writeFile(
      join(override, "skills", "boot.md"),
      skillFile("Boot", "bootstrap thing"),
    );
    const result = await scanExternalSkills({
      homeDir: home,
      env: { PI_DESKTOP_AGENTS_DIR: override },
    });
    const src = result.sources.find((s) => s.kind === "pi-user");
    assert.equal(src.path, join(override, "skills"));
    assert.equal(src.count, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readFrontmatter strips quotes and inline comments", () => {
  const { data, ok } = readFrontmatter("---\nname: 'Boxed'\ndescription: \"line\" # trailing\n---\nbody\n");
  assert.equal(ok, true);
  assert.equal(data.name, "Boxed");
  assert.equal(data.description, "line");
});

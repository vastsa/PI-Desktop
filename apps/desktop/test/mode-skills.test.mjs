/**
 * Mode-private skills (issue #2544 §3).
 *
 * A mode directory owns a `skills/` folder: the host discovers `SKILL.md`
 * documents there, Settings lists them read-only with a per-item switch, and
 * only an enabled one reaches the `/` menu. The catalog id is mode-scoped, so
 * the two failure modes this file locks are:
 *
 *  - a stale selection (mode switched, skill disabled, directory moved) must
 *    refuse instead of loading another mode's — or a global — document; and
 *  - two modes, or a mode and the global registry, may use the same local name
 *    without either one resolving the other's skill.
 *
 * The composer assertions run the real `createComposerCommandService`, so the
 * menu, the launch catalog and the `Skill` tool are checked against one
 * catalog rather than three re-implementations.
 */
import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const {
  discoverModeSkills,
  enabledModeSkills,
  enabledModeSkillsOrNone,
  listModeSkills,
  loadModeSkillDocument,
  modeSkillId,
  parseModeSkillId,
} = await import("../electron/main/runtime/mode-skills.ts");
const { createComposerCommandService } = await import("../electron/main/ipc/composer-ipc.ts");

const DOCUMENT = (name, body = "Follow these steps.") =>
  `---\nname: ${name}\ndescription: ${name} workflow\n---\n\n${body}\n`;

/**
 * A throwaway `~/.pi/modes` tree: `<root>/<mode>/skills/<name>/SKILL.md`.
 * `catalog` is what `createModeCatalogService` would return for it: a mode
 * normally has a `mode.yaml` bundle, `setLegacy` marks one that only has a
 * `mode.md` (no bundle, so no private skills), and `disable` rewrites the
 * bundle's `disabledSkills` the way the Settings switch does.
 */
async function modeTree(modes) {
  const root = await mkdtemp(join(tmpdir(), "pi-2544-"));
  for (const [mode, skills] of Object.entries(modes)) {
    for (const [name, source] of Object.entries(skills)) {
      const dir = join(root, mode, "skills", name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), source, "utf8");
    }
    await mkdir(join(root, mode, "skills"), { recursive: true });
  }
  /**
   * The catalog's cache hazard, modeled exactly: `disable` writes what is on
   * disk, `skillsDirectory` rescans (dropping the loaded snapshot), and
   * `definition` answers from that snapshot — repopulating it only when it was
   * dropped. Reading `definition` before resolving the directory therefore
   * yields the pre-edit bundle, which is the bug the ordering avoids.
   */
  const persisted = new Map();
  let loaded = null;
  const disabled = new Map();
  const catalog = {
    directories: [],
    async skillsDirectory(mode, create = false) {
      catalog.directories.push({ mode, create });
      // `locate(id, true)` in the real service: rescan, so the next
      // `definition` reads what is on disk now.
      loaded = null;
      const dir = join(root, mode, "skills");
      if (create) await mkdir(dir, { recursive: true });
      return dir;
    },
    setBundle(mode, bundle) {
      persisted.set(mode, bundle === undefined ? undefined : { bundle });
      loaded = null;
    },
    /** A legacy `mode.md` mode: the definition loads, it just has no bundle. */
    setLegacy(mode) {
      persisted.set(mode, {});
      loaded = null;
    },
    async definition(mode) {
      loaded ??= new Map(persisted);
      return loaded.get(mode);
    },
    disable(mode, localId) {
      const list = disabled.get(mode) ?? new Set();
      list.add(localId);
      disabled.set(mode, list);
      const current = persisted.get(mode);
      if (current === undefined) return;
      persisted.set(mode, {
        ...current,
        bundle: {
          ...(current?.bundle ?? {}),
          disabledSkills: [...list],
        },
      });
    },
  };
  for (const mode of Object.keys(modes)) {
    catalog.setBundle(mode, { disabledSkills: [], includeGlobalSubagents: false, subagents: [] });
  }
  return {
    root,
    catalog,
    skillDir: (mode, name) => join(root, mode, "skills", name),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/**
 * Link a directory into a mode the way a user might.
 *
 * Windows only lets a privileged process create a symbolic link, but a
 * junction needs no elevation — and a junction is the shape a user gets when
 * they "link" another folder into a mode. A null return means the environment
 * refused every link, and the test skips instead of passing on a weaker
 * assertion.
 */
async function linkDirectory(target, path) {
  for (const type of ["junction", "dir"]) {
    try {
      await symlink(target, path, type);
      return type;
    } catch (error) {
      if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
    }
  }
  return null;
}

test("discovery reads SKILL.md folders and bare documents, sorted and bounded", async () => {
  const tree = await modeTree({
    sisyphus: {
      "verify-delivery": DOCUMENT("Verify delivery"),
      "release-notes": DOCUMENT("Release notes"),
    },
  });
  try {
    const skipped = join(tree.root, "sisyphus", "skills", "empty");
    await mkdir(skipped, { recursive: true });
    await writeFile(join(skipped, "SKILL.md"), "---\nname: Empty\n---\n\n   \n", "utf8");
    await mkdir(join(tree.root, "sisyphus", "skills", ".hidden"), { recursive: true });
    await writeFile(
      join(tree.root, "sisyphus", "skills", "bare.md"),
      DOCUMENT("Bare skill"),
      "utf8",
    );

    const found = await discoverModeSkills(join(tree.root, "sisyphus", "skills"));
    assert.deepEqual(found.map((skill) => skill.id), ["bare", "release-notes", "verify-delivery"]);
    assert.equal(found[2].name, "Verify delivery");
    assert.equal(found[2].description, "Verify delivery workflow");
    assert.ok(found[2].path.endsWith(join("verify-delivery", "SKILL.md")));
  } finally {
    await tree.cleanup();
  }
});

test("a missing skills directory is an empty catalog, not a failure", async () => {
  const tree = await modeTree({ sisyphus: {} });
  try {
    await rm(join(tree.root, "sisyphus", "skills"), { recursive: true, force: true });
    assert.deepEqual(await discoverModeSkills(join(tree.root, "sisyphus", "skills")), []);
  } finally {
    await tree.cleanup();
  }
});

test("Settings lists every discovered skill with its own switch", async () => {
  const tree = await modeTree({
    sisyphus: { "verify-delivery": DOCUMENT("Verify delivery"), "release-notes": DOCUMENT("Notes") },
  });
  try {
    tree.catalog.disable("sisyphus", "release-notes");
    const listed = await listModeSkills(tree.catalog, "sisyphus");
    assert.deepEqual(listed, [
      { id: "release-notes", name: "Notes", enabled: false },
      { id: "verify-delivery", name: "Verify delivery", enabled: true },
    ]);
    // Listing is a read: it never creates the user's directory.
    assert.deepEqual(
      tree.catalog.directories.filter((entry) => entry.create),
      [],
      "opening the list must not create anything",
    );
  } finally {
    await tree.cleanup();
  }
});

test("the runtime catalog is mode-scoped and drops disabled entries", async () => {
  const tree = await modeTree({
    sisyphus: { "verify-delivery": DOCUMENT("Verify delivery") },
    plan: { "verify-delivery": DOCUMENT("Plan delivery") },
  });
  try {
    tree.catalog.disable("plan", "verify-delivery");
    const sisyphus = await enabledModeSkills(tree.catalog, "sisyphus");
    assert.deepEqual(sisyphus.map((skill) => skill.id), ["mode:sisyphus/verify-delivery"]);
    assert.equal(sisyphus[0].name, "Verify delivery");
    assert.deepEqual(
      await enabledModeSkills(tree.catalog, "plan"),
      [],
      "a disabled skill is not advertised",
    );
    // Same local name, different identity: neither mode can resolve the other.
    assert.notEqual(
      modeSkillId("sisyphus", "verify-delivery"),
      modeSkillId("plan", "verify-delivery"),
    );
  } finally {
    await tree.cleanup();
  }
});

test("a mode that no longer loads fails closed instead of falling back", async () => {
  const tree = await modeTree({ sisyphus: { "verify-delivery": DOCUMENT("Verify delivery") } });
  try {
    await assert.rejects(enabledModeSkills(tree.catalog, "gone"), /"gone" is not available/);
    await assert.rejects(listModeSkills(tree.catalog, "gone"), /"gone" is not available/);
    assert.deepEqual(
      await enabledModeSkillsOrNone(tree.catalog, "gone"),
      [],
      "a launch offers nothing rather than failing the session",
    );
  } finally {
    await tree.cleanup();
  }
});

test("load resolves the current mode's document", async () => {
  const tree = await modeTree({ sisyphus: { "verify-delivery": DOCUMENT("Verify delivery", "Run the checks.") } });
  try {
    const loaded = await loadModeSkillDocument(
      tree.catalog,
      "sisyphus",
      "mode:sisyphus/verify-delivery",
    );
    assert.equal(loaded.id, "mode:sisyphus/verify-delivery");
    assert.equal(loaded.name, "Verify delivery");
    assert.equal(loaded.body, "Run the checks.");
    assert.ok(loaded.location.endsWith(join("verify-delivery", "SKILL.md")));
    // A non-mode id stays the caller's to resolve against the global sources.
    assert.equal(await loadModeSkillDocument(tree.catalog, "sisyphus", "release-notes"), null);
  } finally {
    await tree.cleanup();
  }
});

test("a selection made for another mode is refused, never re-scoped", async () => {
  const tree = await modeTree({
    sisyphus: { "verify-delivery": DOCUMENT("Sisyphus delivery") },
    review: { "verify-delivery": DOCUMENT("Review delivery") },
  });
  try {
    await assert.rejects(
      loadModeSkillDocument(tree.catalog, "review", "mode:sisyphus/verify-delivery"),
      (error) => error.errorCode === "MODE_SKILL_MODE_MISMATCH",
    );
  } finally {
    await tree.cleanup();
  }
});

test("a switched-off skill is refused even though its document is on disk", async () => {
  const tree = await modeTree({ sisyphus: { "verify-delivery": DOCUMENT("Verify delivery") } });
  try {
    tree.catalog.disable("sisyphus", "verify-delivery");
    await assert.rejects(
      loadModeSkillDocument(tree.catalog, "sisyphus", "mode:sisyphus/verify-delivery"),
      (error) => error.errorCode === "MODE_SKILL_DISABLED",
    );
  } finally {
    await tree.cleanup();
  }
});

test("a moved or deleted skill is refused instead of loading what was there", async () => {
  const tree = await modeTree({
    sisyphus: { "verify-delivery": DOCUMENT("Verify delivery"), keep: DOCUMENT("Keep") },
  });
  try {
    await rm(join(tree.root, "sisyphus", "skills", "verify-delivery"), {
      recursive: true,
      force: true,
    });
    await assert.rejects(
      loadModeSkillDocument(tree.catalog, "sisyphus", "mode:sisyphus/verify-delivery"),
      (error) => error.errorCode === "MODE_SKILL_NOT_FOUND",
    );
    // The rest of the mode is unaffected.
    assert.ok(await loadModeSkillDocument(tree.catalog, "sisyphus", "mode:sisyphus/keep"));
  } finally {
    await tree.cleanup();
  }
});

test("switching the mode invalidates the previous menu selection", async () => {
  const tree = await modeTree({ sisyphus: { "verify-delivery": DOCUMENT("Verify delivery") } });
  try {
    const selected = (await enabledModeSkills(tree.catalog, "sisyphus"))[0].id;
    // The user switches this session to a builtin mode: the old id now names a
    // mode that is not the current one, so it cannot load.
    await tree.catalog.definition("sisyphus");
    await assert.rejects(
      loadModeSkillDocument(tree.catalog, "agent", selected),
      (error) => error.errorCode === "MODE_SKILL_MODE_MISMATCH",
    );
  } finally {
    await tree.cleanup();
  }
});

test("the composer menu offers an enabled mode skill under a scoped slash name", async () => {
  const tree = await modeTree({ sisyphus: { "verify-delivery": DOCUMENT("Verify delivery") } });
  try {
    const service = createComposerCommandService({
      plugins: { listLoaded: () => [], getSkills: () => [], getCommands: () => [] },
      agentExtensions: { allCommands: () => [] },
      activeUserSkills: async () => [],
      modeSkills: (mode) => enabledModeSkills(tree.catalog, mode),
      pluginActiveInProject: () => true,
      loadComposerTemplatesCached: async () => [],
    });
    const commands = await service.buildComposerCommands("/repo", { mode: "sisyphus" });
    const modeSkills = commands.filter(
      (command) => command.kind === "skill" && command.skillId?.startsWith("mode:"),
    );
    assert.deepEqual(modeSkills.map((command) => command.name), [
      "skill:mode:sisyphus/verify-delivery",
    ]);
    assert.equal(modeSkills[0].skillId, "mode:sisyphus/verify-delivery");
    assert.equal(modeSkills[0].title, "Verify delivery");

    // Without a mode the request contributes nothing beyond the pre-existing
    // sources: the mode entry appears only when its mode was asked for.
    const baseline = (await service.buildComposerCommands("/repo")).filter(
      (command) => command.kind === "skill",
    );
    assert.deepEqual(
      commands.filter((command) => command.kind === "skill").length - baseline.length,
      1,
    );
    assert.deepEqual(
      baseline.filter((command) => command.skillId?.startsWith("mode:")),
      [],
    );
  } finally {
    await tree.cleanup();
  }
});

test("a same-named global skill stays a separate entry from the mode's", async () => {
  const tree = await modeTree({ sisyphus: { "verify-delivery": DOCUMENT("Verify delivery") } });
  try {
    const service = createComposerCommandService({
      plugins: { listLoaded: () => [], getSkills: () => [], getCommands: () => [] },
      agentExtensions: { allCommands: () => [] },
      activeUserSkills: async () => [
        { id: "verify-delivery", name: "Global delivery", description: "global" },
      ],
      modeSkills: (mode) => enabledModeSkills(tree.catalog, mode),
      pluginActiveInProject: () => true,
      loadComposerTemplatesCached: async () => [],
    });
    const skills = (await service.buildComposerCommands("/repo", { mode: "sisyphus" }))
      .filter((command) => command.kind === "skill")
      // Bundled skills are shipped by the host and unrelated to this catalog.
      .filter((command) => !command.skillId?.startsWith("pi-desktop/"));
    assert.deepEqual(skills.map((command) => [command.name, command.skillId]), [
      ["skill:verify-delivery", "verify-delivery"],
      ["skill:mode:sisyphus/verify-delivery", "mode:sisyphus/verify-delivery"],
    ]);
    // The menu's scoped id resolves through the mode loader, and the global one
    // does not pass through it at all.
    assert.equal(parseModeSkillId("verify-delivery"), null);
    assert.deepEqual(parseModeSkillId("mode:sisyphus/verify-delivery"), {
      mode: "sisyphus",
      localId: "verify-delivery",
    });
  } finally {
    await tree.cleanup();
  }
});

test("the same local name in two modes resolves only in its own mode", async () => {
  const tree = await modeTree({
    sisyphus: { "verify-delivery": DOCUMENT("Verify delivery", "Sisyphus delivery") },
    review: { "verify-delivery": DOCUMENT("Verify delivery", "Review delivery") },
  });
  try {
    const sisyphusId = (await enabledModeSkills(tree.catalog, "sisyphus"))[0].id;
    const reviewId = (await enabledModeSkills(tree.catalog, "review"))[0].id;
    assert.notEqual(sisyphusId, reviewId);
    assert.equal(
      (await loadModeSkillDocument(tree.catalog, "sisyphus", sisyphusId)).body,
      "Sisyphus delivery",
    );
    assert.equal(
      (await loadModeSkillDocument(tree.catalog, "review", reviewId)).body,
      "Review delivery",
    );
    // Neither id can be pointed at the other mode's document, so a same-named
    // skill cannot be mixed up when the user switches modes.
    await assert.rejects(
      loadModeSkillDocument(tree.catalog, "review", sisyphusId),
      (error) => error.errorCode === "MODE_SKILL_MODE_MISMATCH",
    );
  } finally {
    await tree.cleanup();
  }
});

test("a legacy mode.md mode advertises no private skills", async () => {
  const tree = await modeTree({ classic: { "verify-delivery": DOCUMENT("Verify delivery") } });
  try {
    // The definition still loads; it simply has no bundle, which is what the
    // old single-document format produces.
    tree.catalog.setLegacy("classic");
    assert.deepEqual(await listModeSkills(tree.catalog, "classic"), []);
    assert.deepEqual(await enabledModeSkills(tree.catalog, "classic"), []);
    await assert.rejects(
      loadModeSkillDocument(tree.catalog, "classic", "mode:classic/verify-delivery"),
      (error) => error.errorCode === "MODE_SKILL_NOT_FOUND",
    );
  } finally {
    await tree.cleanup();
  }
});

test("a junctioned skill folder is skipped instead of followed", async (t) => {
  const tree = await modeTree({ sisyphus: { "verify-delivery": DOCUMENT("Verify delivery") } });
  const outside = await mkdtemp(join(tmpdir(), "pi-2544-outside-"));
  try {
    await mkdir(join(outside, "leaked"), { recursive: true });
    await writeFile(join(outside, "leaked", "SKILL.md"), DOCUMENT("Leaked"), "utf8");
    const kind = await linkDirectory(join(outside, "leaked"), tree.skillDir("sisyphus", "leaked"));
    if (!kind) {
      t.skip("this environment cannot create a directory link");
      return;
    }
    // The real skill still answers; the junction contributes nothing, so an
    // outside document never enters the mode's catalog.
    assert.deepEqual(
      (await discoverModeSkills(join(tree.root, "sisyphus", "skills"))).map((skill) => skill.id),
      ["verify-delivery"],
    );
    assert.deepEqual(
      (await enabledModeSkills(tree.catalog, "sisyphus")).map((skill) => skill.id),
      ["mode:sisyphus/verify-delivery"],
    );
    await assert.rejects(
      loadModeSkillDocument(tree.catalog, "sisyphus", "mode:sisyphus/leaked"),
      (error) => error.errorCode === "MODE_SKILL_NOT_FOUND",
    );
  } finally {
    await tree.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test("a linked skills directory leaves the mode with no catalog", async (t) => {
  const tree = await modeTree({ sisyphus: { "verify-delivery": DOCUMENT("Verify delivery") } });
  const outside = await mkdtemp(join(tmpdir(), "pi-2544-outside-"));
  try {
    await mkdir(join(outside, "verify-delivery"), { recursive: true });
    await writeFile(join(outside, "verify-delivery", "SKILL.md"), DOCUMENT("Leaked"), "utf8");
    // Replace the real `skills/` with a link to an unrelated tree: the mode
    // owns that folder, so a swapped root is refused rather than scanned.
    await rm(join(tree.root, "sisyphus", "skills"), { recursive: true, force: true });
    const kind = await linkDirectory(outside, join(tree.root, "sisyphus", "skills"));
    if (!kind) {
      t.skip("this environment cannot create a directory link");
      return;
    }
    assert.deepEqual(await enabledModeSkills(tree.catalog, "sisyphus"), []);
    assert.deepEqual(await listModeSkills(tree.catalog, "sisyphus"), []);
    await assert.rejects(
      loadModeSkillDocument(tree.catalog, "sisyphus", "mode:sisyphus/verify-delivery"),
      (error) => error.errorCode === "MODE_SKILL_NOT_FOUND",
    );
  } finally {
    await tree.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test("a hardlinked skill document is refused instead of read", async (t) => {
  const tree = await modeTree({ sisyphus: { "verify-delivery": DOCUMENT("Verify delivery") } });
  const outside = await mkdtemp(join(tmpdir(), "pi-2544-outside-"));
  try {
    await writeFile(join(outside, "shared.md"), DOCUMENT("Shared"), "utf8");
    // Windows allows a hardlink without elevation; when it does not, the test
    // reports the environment instead of a false pass.
    try {
      await link(join(outside, "shared.md"), tree.skillDir("sisyphus", "aliased.md"));
    } catch (error) {
      if (error.code === "EPERM" || error.code === "EACCES" || error.code === "EXDEV") {
        t.skip("this environment cannot create a hardlink");
        return;
      }
      throw error;
    }
    // A second name for a document the mode does not exclusively own is not a
    // mode skill: the link count is the only signal a hardlink leaves.
    assert.deepEqual(
      (await discoverModeSkills(join(tree.root, "sisyphus", "skills"))).map((skill) => skill.id),
      ["verify-delivery"],
    );
    await assert.rejects(
      loadModeSkillDocument(tree.catalog, "sisyphus", "mode:sisyphus/aliased"),
      (error) => error.errorCode === "MODE_SKILL_NOT_FOUND",
    );
    // The genuine document is unaffected by its aliased neighbour.
    assert.equal(
      (await loadModeSkillDocument(tree.catalog, "sisyphus", "mode:sisyphus/verify-delivery")).body,
      "Follow these steps.",
    );
  } finally {
    await tree.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test("a newly disabled skill stops advertising on the very next read", async () => {
  const tree = await modeTree({ sisyphus: { "verify-delivery": DOCUMENT("Verify delivery") } });
  try {
    assert.deepEqual(
      (await enabledModeSkills(tree.catalog, "sisyphus")).map((skill) => skill.id),
      ["mode:sisyphus/verify-delivery"],
    );
    // Warm the catalog's loaded snapshot, the way an earlier launch, menu read
    // or Settings page would.
    await tree.catalog.definition("sisyphus");

    // The Settings switch writes `disabledSkills` on disk and leaves the loaded
    // snapshot stale, which is exactly the state a user creates by toggling a
    // row and immediately sending `/skill:…`.
    tree.catalog.disable("sisyphus", "verify-delivery");

    // Reading `definition` before resolving the directory would answer from the
    // stale snapshot and keep advertising the skill; resolving first rescans.
    assert.deepEqual(await enabledModeSkills(tree.catalog, "sisyphus"), []);
    assert.deepEqual(await listModeSkills(tree.catalog, "sisyphus"), [
      { id: "verify-delivery", name: "Verify delivery", enabled: false },
    ]);
    await assert.rejects(
      loadModeSkillDocument(tree.catalog, "sisyphus", "mode:sisyphus/verify-delivery"),
      (error) => error.errorCode === "MODE_SKILL_DISABLED",
    );
  } finally {
    await tree.cleanup();
  }
});

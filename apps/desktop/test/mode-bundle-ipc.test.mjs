/**
 * The `mode.yaml` bundle channels (issue #2544), driven through the real
 * handler map and the real catalog service against a temporary directory.
 *
 * This is the layer that proves the wiring rather than the rules: the channel
 * names are registered, renderer arguments are checked before they reach the
 * filesystem, the mode-level switches rewrite only their own keys, and opening
 * a mode's skills folder goes through the injected trusted shell with the path
 * the catalog derived — never one the renderer supplied.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { IPC } = await import("@pi-desktop/shared/protocol");
const { createModeCatalogService } = await import("../electron/main/runtime/mode-catalog.ts");
const { registerModesIpc } = await import("../electron/main/ipc/modes-ipc.ts");

const PROMPT = "Work until the objective is verified.\n";
const ROLE = [
  "---",
  "name: oracle",
  "description: Technical judgment, read-only.",
  "tools: [Read, Grep]",
  "---",
  "",
  "Review only.",
  "",
].join("\n");
const BUNDLE = [
  "name: sisyphus",
  "label: Sisyphus",
  "permission: agent",
  "promptFile: prompts/orchestrator.md",
  "subagents:",
  "  - agents/oracle.agent.md",
  "",
].join("\n");

/** A handler map that behaves like `ipcMain` for one channel namespace. */
function registrar() {
  const handlers = new Map();
  return {
    handlers,
    ipcMain: { handle: () => undefined },
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
    handleWithEvent() {},
    assertMainWindowSender() {},
    call: (channel, ...args) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`channel not registered: ${channel}`);
      return handler(...args);
    },
  };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "modes-bundle-"));
  const modeDir = join(dir, "sisyphus");
  await mkdir(join(modeDir, "prompts"), { recursive: true });
  await mkdir(join(modeDir, "agents"), { recursive: true });
  await writeFile(join(modeDir, "mode.yaml"), BUNDLE);
  await writeFile(join(modeDir, "prompts", "orchestrator.md"), PROMPT);
  await writeFile(join(modeDir, "agents", "oracle.agent.md"), ROLE);
  const catalog = createModeCatalogService({ dir });
  const opened = [];
  const reg = registrar();
  registerModesIpc({
    registrar: reg,
    catalog,
    runs: { get: async () => ({ run: null }), control: async () => ({}), update: async () => ({}), resolve: async () => ({}) },
    openPath: async (path) => {
      opened.push(path);
      return "";
    },
  });
  return { dir, modeDir, catalog, reg, opened };
}

test("the bundle read channel returns the map and every document it names", async () => {
  const { dir, reg } = await fixture();
  try {
    const bundle = await reg.call(IPC.invoke.modesBundleRead, "sisyphus");
    assert.equal(bundle.source, BUNDLE);
    assert.equal(bundle.prompt, PROMPT);
    assert.deepEqual(bundle.agents, { "agents/oracle.agent.md": ROLE });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the mode switch rewrites only its own key and keeps the rest of the map", async () => {
  const { dir, modeDir, reg } = await fixture();
  try {
    await reg.call(IPC.invoke.modesBundleSettings, { id: "sisyphus", includeGlobalSubagents: true });
    let written = await readFile(join(modeDir, "mode.yaml"), "utf8");
    assert.match(written, /^includeGlobalSubagents: true$/m);
    // Everything the page does not own is untouched.
    assert.match(written, /promptFile: prompts\/orchestrator\.md/);
    assert.match(written, / {2}- agents\/oracle\.agent\.md/);
    assert.equal(await readFile(join(modeDir, "prompts", "orchestrator.md"), "utf8"), PROMPT);
    assert.equal(await readFile(join(modeDir, "agents", "oracle.agent.md"), "utf8"), ROLE);

    await reg.call(IPC.invoke.modesBundleSettings, { id: "sisyphus", disabledSkills: ["verify-delivery"] });
    written = await readFile(join(modeDir, "mode.yaml"), "utf8");
    assert.match(written, /^disabledSkills:\n {2}- verify-delivery$/m);
    assert.match(written, /^includeGlobalSubagents: true$/m);

    // An empty list removes the key rather than leaving an empty sequence.
    await reg.call(IPC.invoke.modesBundleSettings, { id: "sisyphus", disabledSkills: [] });
    written = await readFile(join(modeDir, "mode.yaml"), "utf8");
    assert.doesNotMatch(written, /disabledSkills/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an empty or malformed patch is refused before anything is written", async () => {
  const { dir, modeDir, reg } = await fixture();
  try {
    await assert.rejects(
      () => reg.call(IPC.invoke.modesBundleSettings, { id: "sisyphus" }),
      /nothing to update/,
    );
    await assert.rejects(
      () => reg.call(IPC.invoke.modesBundleSettings, { id: "sisyphus", includeGlobalSubagents: "yes" }),
      /true or false/,
    );
    await assert.rejects(
      () => reg.call(IPC.invoke.modesBundleSettings, { id: "sisyphus", disabledSkills: "one" }),
      /list of skill ids/,
    );
    await assert.rejects(
      () => reg.call(IPC.invoke.modesBundleSettings, { id: "sisyphus", disabledSkills: ["Not A Skill"] }),
      /not a skill id/,
    );
    await assert.rejects(
      () => reg.call(IPC.invoke.modesBundleSettings, { id: "Bad Id", includeGlobalSubagents: true }),
      /mode id is invalid/,
    );
    assert.equal(await readFile(join(modeDir, "mode.yaml"), "utf8"), BUNDLE);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a whole bundle write refuses a document the map does not declare", async () => {
  const { dir, modeDir, reg } = await fixture();
  try {
    await assert.rejects(
      () => reg.call(IPC.invoke.modesBundleWrite, {
        id: "sisyphus",
        source: BUNDLE,
        prompt: PROMPT,
        agents: { "agents/oracle.agent.md": ROLE, "agents/stray.md": "x" },
      }),
      /is not declared in mode\.yaml/,
    );
    // A reference outside the directory never reaches the writer.
    await assert.rejects(
      () => reg.call(IPC.invoke.modesBundleWrite, {
        id: "sisyphus",
        source: BUNDLE.replace("prompts/orchestrator.md", "../escape.md"),
        prompt: PROMPT,
        agents: { "agents/oracle.agent.md": ROLE },
      }),
      /mode\.yaml|relative|stay inside/i,
    );
    assert.equal(await readFile(join(modeDir, "mode.yaml"), "utf8"), BUNDLE);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("copy keeps relative references and refuses an occupied destination", async () => {
  const { dir, reg } = await fixture();
  try {
    await reg.call(IPC.invoke.modesCopy, { fromId: "sisyphus", toId: "copy" });
    const copied = await readFile(join(dir, "copy", "mode.yaml"), "utf8");
    assert.match(copied, /^name: copy$/m);
    assert.match(copied, /promptFile: prompts\/orchestrator\.md/);
    assert.equal(await readFile(join(dir, "copy", "prompts", "orchestrator.md"), "utf8"), PROMPT);
    assert.equal(await readFile(join(dir, "copy", "agents", "oracle.agent.md"), "utf8"), ROLE);

    await assert.rejects(
      () => reg.call(IPC.invoke.modesCopy, { fromId: "sisyphus", toId: "copy" }),
      /already exists|already holds/,
    );
    await assert.rejects(
      () => reg.call(IPC.invoke.modesCopy, { fromId: "sisyphus", toId: "goal" }),
      /builtin/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the skills channels report the folder and hand only that path to the shell", async () => {
  const { dir, modeDir, reg, opened } = await fixture();
  try {
    const before = await reg.call(IPC.invoke.modesSkills, "sisyphus");
    assert.equal(before.directory, join(modeDir, "skills"));
    // A read never creates the directory the user has not opened yet.
    assert.equal(before.exists, false);
    assert.deepEqual(before.skills, []);

    await mkdir(join(modeDir, "skills", "verify-delivery"), { recursive: true });
    await writeFile(
      join(modeDir, "skills", "verify-delivery", "SKILL.md"),
      "---\nname: Verify delivery\ndescription: Check the result.\n---\n\nRun the checks.\n",
    );
    const after = await reg.call(IPC.invoke.modesSkills, "sisyphus");
    assert.equal(after.exists, true);
    assert.deepEqual(after.skills, [{ id: "verify-delivery", name: "Verify delivery", enabled: true }]);

    // A switch in this mode only.
    await reg.call(IPC.invoke.modesBundleSettings, { id: "sisyphus", disabledSkills: ["verify-delivery"] });
    const off = await reg.call(IPC.invoke.modesSkills, "sisyphus");
    assert.deepEqual(off.skills, [{ id: "verify-delivery", name: "Verify delivery", enabled: false }]);

    const openedResult = await reg.call(IPC.invoke.modesSkillsOpen, "sisyphus");
    assert.deepEqual(opened, [join(modeDir, "skills")]);
    assert.equal(openedResult.directory, join(modeDir, "skills"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("opening a skills folder creates it when it is missing", async () => {
  const { dir, modeDir, reg, opened } = await fixture();
  try {
    await reg.call(IPC.invoke.modesSkillsOpen, "sisyphus");
    assert.deepEqual(opened, [join(modeDir, "skills")]);
    const listed = await reg.call(IPC.invoke.modesSkills, "sisyphus");
    assert.equal(listed.exists, true);
    assert.deepEqual(listed.skills, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a build without a trusted shell reports the open channel as unsupported", async () => {
  const dir = await mkdtemp(join(tmpdir(), "modes-bundle-"));
  try {
    const modeDir = join(dir, "sisyphus");
    await mkdir(join(modeDir, "prompts"), { recursive: true });
    await writeFile(join(modeDir, "mode.yaml"), BUNDLE);
    await writeFile(join(modeDir, "prompts", "orchestrator.md"), PROMPT);
    const reg = registrar();
    registerModesIpc({
      registrar: reg,
      catalog: createModeCatalogService({ dir }),
      runs: { get: async () => ({ run: null }), control: async () => ({}), update: async () => ({}), resolve: async () => ({}) },
    });
    await assert.rejects(() => reg.call(IPC.invoke.modesSkillsOpen, "sisyphus"), /cannot open a folder/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

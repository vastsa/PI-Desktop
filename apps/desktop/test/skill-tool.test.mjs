import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSkillToolHandler } = await import("../electron/main/skill-tool.ts");

function fixture(overrides = {}) {
  const projects = new Map([["fixture-session", "fixture-project"]]);
  const loads = [];
  const handler = createSkillToolHandler({
    sessionProjects: projects, disabledBuiltinSkills: async () => ["pi-desktop/imagegen"],
    loadUserSkillBody: async () => null, activeUserSkills: async () => [],
    plugins: {
      getSkills: () => [{ id: "allowed/docs", pluginId: "allowed" }, { id: "hidden/docs", pluginId: "hidden" }],
      loadSkillBody(id) { loads.push(id); return { id, name: "Fixture", body: "BODY-SENTINEL", location: "fixture/SKILL.md" }; },
    },
    pluginActiveInProject: (id, project) => id === "allowed" && project === "fixture-project",
    ...overrides,
  });
  const run = (id) => handler({ sessionId: "fixture-session", toolCallId: "fixture-call", args: { id }, signal: new AbortController().signal });
  return { run, loads, projects };
}

test("an allowed child skill resolves through Main's production handler", async () => {
  const { run, loads } = fixture();
  const result = await run("allowed/docs");
  assert.equal(result.ok, true);
  assert.match(result.content, /BODY-SENTINEL/);
  assert.deepEqual(loads, ["allowed/docs"]);
});
test("a guessed out-of-project plugin id cannot load a document or leak its catalog", async () => {
  const { run, loads } = fixture();
  const result = await run("hidden/docs");
  assert.equal(result.isError, true);
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.content, /BODY-SENTINEL|Available skills:.*hidden/);
  assert.match(result.content, /Available skills: allowed\/docs/);
  assert.deepEqual(loads, []);
});
test("disabled bundled skills and unknown ids fail without reading a plugin body", async () => {
  const { run, loads } = fixture();
  assert.equal((await run("pi-desktop/imagegen")).isError, true);
  assert.equal((await run("unknown/docs")).isError, true);
  assert.deepEqual(loads, []);
});
test("a project switch during asynchronous lookup cannot reuse a stale grant", async () => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const { run, projects, loads } = fixture({ loadUserSkillBody: async () => { await wait; return null; } });
  const result = run("allowed/docs");
  projects.set("fixture-session", "other-project");
  release();
  assert.equal((await result).isError, true);
  assert.deepEqual(loads, []);
});

test("project skill selection narrows enabled skills and inherited settings restore them", async () => {
  let selected = [];
  const { run, loads } = fixture({ selectedSkillIds: async () => selected });
  const denied = await run("allowed/docs");
  assert.equal(denied.isError, true);
  assert.doesNotMatch(denied.content, /BODY-SENTINEL|Available skills/);
  assert.deepEqual(loads, []);
  selected = ["allowed/docs", "hidden/docs"];
  assert.equal((await run("allowed/docs")).ok, true);
  assert.equal((await run("hidden/docs")).isError, true);
  selected = undefined;
  assert.equal((await run("allowed/docs")).ok, true);
});

test("revoking a selection while a skill loads prevents content delivery", async () => {
  let selected = ["user/docs"];
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const wait = new Promise((resolve) => { release = resolve; });
  const { run } = fixture({
    selectedSkillIds: async () => selected,
    loadUserSkillBody: async () => {
      entered(); await wait;
      return { id: "user/docs", name: "Docs", body: "PRIVATE-BODY", location: "fixture/SKILL.md" };
    },
  });
  const result = run("user/docs");
  await started;
  selected = [];
  release();
  const denied = await result;
  assert.equal(denied.isError, true);
  assert.doesNotMatch(denied.content, /PRIVATE-BODY/);
});

test("unavailable project settings fail closed", async () => {
  const { run, loads } = fixture({ selectedSkillIds: async () => { throw new Error("Host unavailable"); } });
  assert.equal((await run("allowed/docs")).isError, true);
  assert.deepEqual(loads, []);
});

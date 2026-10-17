import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [registry, dispatch, specEn, specZh] = await Promise.all([
  read("../electron/main/builtin-commands.ts"),
  read("../src/lib/commands.ts"),
  read("../../../docs/spec/04-ux/04-builtin-commands.md"),
  read("../../../docs/zh-CN/spec/04-ux/04-builtin-commands.md"),
]);

const coreIds = [
  "builtin.session.new",
  "builtin.agent.compact",
  "builtin.mode.agent",
  "builtin.mode.plan",
  "builtin.mode.goal",
  "builtin.session.fast",
];

const coreAliases = ["new", "compact", "agent-mode", "plan-mode", "goal-mode", "fast"];

const removedIds = [
  "builtin.session.delete",
  "builtin.agent.abort",
  "builtin.project.open",
  "builtin.project.clear",
  "builtin.settings.open",
  "builtin.settings.providers",
  "builtin.settings.import",
  "builtin.plugins.open",
  "builtin.plugins.loadDev",
  "builtin.logs.open",
  "builtin.session.rename",
  "builtin.commandPalette.show",
  "builtin.app.reloadWindow",
  "builtin.app.toggleDevtools",
];

test("builtin registry exposes exactly the six core commands and aliases", () => {
  const ids = [...registry.matchAll(/\bid: "([^"]+)"/g)].map((match) => match[1]);
  const aliases = [...registry.matchAll(/slash: "([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(ids, coreIds);
  assert.deepEqual(aliases, coreAliases);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(aliases).size, aliases.length);
  for (const id of coreIds) {
    const pattern = new RegExp("`" + id + "`");
    assert.match(specEn, pattern);
    assert.match(specZh, pattern);
  }
  for (const alias of coreAliases) {
    const pattern = new RegExp("`/" + alias + "`");
    assert.match(specEn, pattern);
    assert.match(specZh, pattern);
  }
  for (const id of removedIds) {
    const pattern = new RegExp("`" + id + "`");
    assert.doesNotMatch(specEn, pattern);
    assert.doesNotMatch(specZh, pattern);
  }
});

test("renderer dispatch keeps only core cases and drops legacy aliases", () => {
  for (const id of coreIds) {
    assert.match(dispatch, new RegExp(`case "${id}"`));
  }
  for (const id of removedIds) {
    assert.doesNotMatch(dispatch, new RegExp(`case "${id}"`));
  }
  assert.doesNotMatch(dispatch, /builtin\.(newChat|openProject|openSettings)/);
});

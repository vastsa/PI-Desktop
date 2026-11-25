import assert from "node:assert/strict";
import test from "node:test";
import { currentModeBundle, sessionSubagents } from "../electron/main/runtime/mode-subagents.ts";

const global = { name: "oracle", source: "user", prompt: "global" };
const other = { name: "search", source: "builtin" };
const globals = async () => ({ definitions: [global, other], builtins: [other], diagnostics: [] });
const privateBundle = (prompt, includeGlobalSubagents = false) => ({
  subagents: [{ ...global, prompt }], includeGlobalSubagents, disabledSkills: [],
});

test("launch and mention catalogs isolate private roles, even when empty", async () => {
  const forbidden = () => assert.fail("unexpected global catalog read");
  const a = await sessionSubagents(privateBundle("first"), forbidden, "one");
  const b = await sessionSubagents(privateBundle("second", true), globals, "two");
  assert.deepEqual(a.definitions.map(r => [r.name, r.prompt, r.modeOwner]), [["oracle", "first", "one"]]);
  assert.deepEqual(b.definitions.map(r => [r.name, r.prompt, r.modeOwner]), [["oracle", "second", "two"], ["search", undefined, undefined]]);
  assert.deepEqual((await sessionSubagents({ subagents: [] }, forbidden, "empty")).definitions, []);
  assert.deepEqual((await sessionSubagents(undefined, globals, "legacy")).definitions, [global, other]);
});

test("a removed mode cannot substitute global roles", async () => {
  await assert.rejects(currentModeBundle({ refresh: async () => {}, definition: async () => undefined }, "gone"), /gone.*not available/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/components/settings/SubagentFallbackModels.tsx", import.meta.url), "utf8");

test("each fallback selects its own thinking; inherit is default and omit is not offered", () => {
  assert.match(source, /value=\{parsed\.thinkingLevel \?\? ""\}/);
  assert.match(source, /thinkingInheritDefinition/);
  assert.match(source, /SUBAGENT_THINKING_LEVELS\.filter\(\(level\) => level !== "omit"\)/);
  assert.match(source, /formatSubagentFallbackEntry\(pin, id as SubagentThinkingLevel/);
});

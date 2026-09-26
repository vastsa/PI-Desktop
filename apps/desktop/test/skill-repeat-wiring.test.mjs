import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const hook = readFileSync(new URL("../src/hooks/use-composer-autocomplete.ts", import.meta.url), "utf8");
const menu = readFileSync(new URL("../src/components/ComposerAutocomplete.tsx", import.meta.url), "utf8");

test("skill acceptance keeps the menu open without changing native host dispatch", () => {
  assert.match(hook, /continuingSkillTrigger\(/);
  assert.match(hook, /setContinuation\(/);
  assert.match(hook, /selectedSkillNames\(/);
  assert.match(menu, /ac\.selectedSkills\.map/);
});

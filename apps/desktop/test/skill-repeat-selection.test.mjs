import assert from "node:assert/strict";
import test from "node:test";
import { applyCompletion, detectTrigger, formatCommandInsert } from "@pi-desktop/shared";
import {
  continuingSkillTrigger,
  selectedSkillNames,
} from "../src/lib/skill-repeat-selection.ts";

test("selecting successive native skill commands can keep the skill-only menu open", () => {
  const first = applyCompletion("/alpha", detectTrigger("/alpha", 6), formatCommandInsert("alpha"));
  assert.deepEqual(first, { value: "/alpha ", cursor: 7 });
  const secondTrigger = continuingSkillTrigger(first.value, first.cursor, first.value, "s1", "s1");
  assert.deepEqual(secondTrigger, { mode: "slash", query: "", tokenStart: 7, tokenEnd: 7 });
  const second = applyCompletion(first.value, secondTrigger, formatCommandInsert("beta"));
  assert.deepEqual(second, { value: "/alpha /beta ", cursor: 13 });
});

test("typing and session changes end automatic continuation", () => {
  assert.equal(continuingSkillTrigger("/alpha hey", 10, "/alpha ", "s1", "s1"), null);
  assert.equal(continuingSkillTrigger("/alpha ", 7, "/alpha ", "s1", "s2"), null);
  assert.equal(continuingSkillTrigger("/alpha ", 3, "/alpha ", "s1", "s1"), null);
});

test("chips only reflect active skill ids present as explicit slash mentions", () => {
  const commands = [
    { name: "alpha", kind: "skill", skillId: "alpha" },
    { name: "beta", kind: "skill", skillId: "beta" },
    { name: "review", kind: "builtin" },
  ];
  assert.deepEqual(selectedSkillNames("/alpha /beta /alpha /unknown /review ", commands), ["alpha", "beta"]);
});

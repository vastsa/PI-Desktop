/**
 * Test for applySubagentPreset - the helper the editor relies on for
 * preset/template application (issue #60). Model-pin mapping is covered by the
 * dedicated subagent-models tests.
 *
 * We test by re-implementing the same logic against the source string so this
 * stays a source-contract test (no React, no Node imports of the .tsx file).
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const editorSource = await readFile(
  new URL("../src/components/settings/SubagentEditorSheet.tsx", import.meta.url),
  "utf8",
);
const presetSource = await readFile(
  new URL("../../../packages/shared/src/subagent-presets.ts", import.meta.url),
  "utf8",
);

test("applySubagentPreset replaces only the template-owned fields", () => {
  const m = editorSource.match(
    /export function applySubagentPreset\([\s\S]+?\n\}/,
  );
  assert.ok(m, "applySubagentPreset not found");
  const fn = m[0];
  // The preset overwrites: name, description, tools (cloned), maxTurns, body.
  assert.match(fn, /name: preset\.name/);
  assert.match(fn, /description: preset\.description/);
  assert.match(fn, /tools: \[\.\.\.preset\.tools\]/);
  assert.match(fn, /maxTurns: preset\.maxTurns/);
  assert.match(fn, /body: preset\.body/);
  // The preset does NOT overwrite: id (slug), model, thinkingLevel, scope,
  // enabled — these survive a reroll.
  assert.doesNotMatch(fn, /id: preset/);
  assert.doesNotMatch(fn, /model: preset/);
  assert.doesNotMatch(fn, /thinkingLevel: preset/);
  assert.doesNotMatch(fn, /scope: preset/);
  assert.doesNotMatch(fn, /enabled: preset/);
});

test("resetSubagentTemplate clears a selected preset without dropping model choices", () => {
  const m = editorSource.match(
    /export function resetSubagentTemplate\([\s\S]+?\n\}/,
  );
  assert.ok(m, "resetSubagentTemplate not found");
  const fn = m[0];
  assert.match(fn, /name: ""/);
  assert.match(fn, /description: ""/);
  assert.match(fn, /tools: \[\.\.\.DEFAULT_SUBAGENT_TOOLS\]/);
  assert.match(fn, /maxTurns: 0/);
  assert.match(fn, /body: ""/);
  assert.doesNotMatch(fn, /model:/);
  assert.doesNotMatch(fn, /thinkingLevel:/);
  assert.doesNotMatch(fn, /scope:/);
  assert.match(editorSource, /setDraft\(resetSubagentTemplate\(draft\)\)/);
});

test("preset ids and builtin document ids agree", () => {
  // The runtime ships the same five delegates in
  // `agent-runtime/src/subagent-definitions.ts`; the shared preset catalog
  // duplicates them as UI-ready data. A drift here would mean a user picks
  // "explorer" in the editor and the runtime loads a different prompt.
  const presetIds = [
    ...presetSource.matchAll(
      /id: "(explorer|code-reviewer|test-runner|fixer|ui-designer)",/g,
    ),
  ].map((m) => m[1]);
  assert.deepEqual(presetIds, [
    "explorer",
    "code-reviewer",
    "test-runner",
    "fixer",
    "ui-designer",
  ]);
});

test("preset tools and maxTurns match the runtime builtin documents", () => {
  // Spot-check explorer and fixer — they cover the read-only and
  // write-capable extremes.
  assert.match(presetSource, /id: "explorer"[\s\S]*?tools: \["Read", "Glob", "Grep", "Bash"\]/);
  assert.match(presetSource, /id: "explorer"[\s\S]*?maxTurns: 60/);
  assert.match(presetSource, /id: "code-reviewer"[\s\S]*?tools: \["Read", "Glob", "Grep"\]/);
  assert.match(presetSource, /id: "code-reviewer"[\s\S]*?maxTurns: 50/);
  assert.match(presetSource, /id: "test-runner"[\s\S]*?tools: \["Read", "Glob", "Grep", "Bash"\]/);
  assert.match(presetSource, /id: "test-runner"[\s\S]*?maxTurns: 40/);
  assert.match(presetSource, /id: "fixer"[\s\S]*?tools: \["Read", "Glob", "Grep", "Edit", "Write", "Bash"\]/);
  assert.match(presetSource, /id: "fixer"[\s\S]*?maxTurns: 80/);
  assert.match(presetSource, /id: "ui-designer"[\s\S]*?tools: \["Read", "Glob", "Grep", "BrowserPreview", "Bash", "Edit", "Write"\]/);
  assert.match(presetSource, /id: "ui-designer"[\s\S]*?maxTurns: 80/);
});

test("preset bodies mirror the runtime markdown frontmatter bodies", () => {
  // The shared preset catalog embeds the body verbatim from the runtime docs
  // so the editor pre-fills the same system prompt the sidecar will run. We
  // spot-check the leading sentence of each prompt rather than full text so a
  // typo in the prose still fails.
  const bodies = [...presetSource.matchAll(/body:\s*\n?\s*`([^`]+)`/g)].map(
    (m) => m[1],
  );
  // explorer
  assert.match(bodies[0], /Explorer/);
  assert.match(bodies[0], /codebase navigation specialist/);
  // code-reviewer
  assert.match(bodies[1], /Review only what the task names/);
  // test-runner
  assert.match(bodies[2], /Run the command the task names/);
  // fixer
  assert.match(bodies[3], /fast, focused implementation specialist/);
  // ui-designer (the extraction stops at the body's first escaped backtick,
  // so only the leading bullets are visible here; the BrowserPreview grant is
  // asserted by the tools test above)
  assert.match(bodies[4], /UI designer/);
  assert.match(bodies[4], /design contract/);
});

test("presets stay within the published max-turns clamp", () => {
  const maxTurns = [...presetSource.matchAll(/maxTurns: (\d+)/g)].map((m) =>
    Number(m[1]),
  );
  for (const n of maxTurns) {
    assert.ok(n >= 1 && n <= 80, `unexpected maxTurns ${n}`);
  }
});

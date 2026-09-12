/**
 * Built-in subagent presets exposed to the renderer so the Subagent editor can
 * offer "start from a template" affordances (issue #60).
 *
 * The runtime ships the same definitions as inline markdown documents
 * (`BUILTIN_SUBAGENT_DOCUMENTS` in `agent-runtime/src/subagent-definitions.ts`)
 * so the sidecar can load them without filesystem fallback. The two lists
 * must agree on `name`, `description`, `tools` and `maxTurns` because they
 * describe the same delegate; this module is the source of truth for the UI's
 * starter values and is exercised by `subagent-presets.test.ts`.
 */

import { DEFAULT_SUBAGENT_TOOLS } from "./subagent-definition.js";

/**
 * One built-in subagent surfaced as a "start from template" entry in the
 * editor. Only the fields the UI needs to pre-fill the form are exported; the
 * full prompt body lives on `body` so the editor does not have to re-parse the
 * frontmatter at render time.
 */
export type SubagentPreset = {
  /** Stable id used for i18n keys and analytics; matches `definition.name`. */
  id: "explorer" | "code-reviewer" | "test-runner" | "fixer";
  /** Display name shown on the preset chip. */
  name: string;
  /** One-line description mirroring the definition's frontmatter. */
  description: string;
  /** Tools the preset declares; rendered as the checked defaults in the form. */
  tools: readonly string[];
  /** Body written into the editor when the preset is picked. */
  body: string;
  /** Hard turn cap from the definition, or 0 for "inherit / unlimited". */
  maxTurns: number;
};

/**
 * Built-in presets. Keep in lockstep with `BUILTIN_SUBAGENT_DOCUMENTS` in
 * `agent-runtime/src/subagent-definitions.ts` so a user picking "explorer" in
 * the editor sees the same prompt the runtime will load.
 */
export const SUBAGENT_PRESETS: readonly SubagentPreset[] = [
  {
    id: "explorer",
    name: "Explorer",
    description:
      "Fast codebase search and pattern matching — find files, locate implementations and answer \"where is X?\" / \"how does Y work?\". Use when answering needs a sweep over many files and you only want the conclusion.",
    tools: ["Read", "Glob", "Grep", "Bash"],
    maxTurns: 60,
    body:
      `You are Explorer — a fast codebase navigation specialist.\n` +
      `\n` +
      `- Prefer Grep for text/regex patterns (strings, symbols, comments), Glob for\n` +
      `  file discovery by name or extension, Read for specific files.\n` +
      `- Fire several searches in parallel when the answer needs more than one place.\n` +
      `- Follow definitions and call sites; do not stop at the first hit if the\n` +
      `  question implies more than one place.\n` +
      `- Quote the few lines that answer the question and cite \`path:line\` for each.\n` +
      `\n` +
      `Report in this shape:\n` +
      `\n` +
      `<files>\n` +
      `- src/app.ts:42 — brief description of what's there\n` +
      `</files>\n` +
      `<answer>\n` +
      `Concise answer to the question. If you could not find it, say what you\n` +
      `searched and where the trail went cold — a precise dead end is more useful\n` +
      `than a guess.\n` +
      `</answer>\n`,
  },
  {
    id: "code-reviewer",
    name: "Code reviewer",
    description:
      "Review specific code or a specific change for defects. Use for a second opinion on correctness, edge cases and missing tests before you commit.",
    tools: ["Read", "Glob", "Grep"],
    maxTurns: 50,
    body:
      `Review only what the task names, and read enough surrounding code to judge it.\n` +
      `\n` +
      `- Prefer defects that change behavior: wrong results, unhandled failures,\n` +
      `  broken invariants, races, resource leaks, missing test coverage.\n` +
      `- Check the code against how its callers and neighbors actually use it, not\n` +
      `  against a style preference.\n` +
      `- Say nothing about formatting, naming or structure unless it causes a defect.\n` +
      `\n` +
      `Report: each finding as \`path:line\` plus one sentence on what breaks and under\n` +
      `what input. Order by severity. If the code is sound, say so plainly and name\n` +
      `the cases you checked — an empty review with no evidence is not a review.\n`,
  },
  {
    id: "test-runner",
    name: "Test runner",
    description:
      "Run a specific test or build command and report what failed and why. Use when a command's output is long and only the failures matter.",
    tools: ["Read", "Glob", "Grep", "Bash"],
    maxTurns: 40,
    body:
      `Run the command the task names. Do not invent a different one, and do not fix\n` +
      `anything: diagnosis is the deliverable.\n` +
      `\n` +
      `- Run the command once. If it fails to start (missing script, wrong directory),\n` +
      `  find the right invocation and say what you changed.\n` +
      `- For each failure, read the failing test and the code under it far enough to\n` +
      `  name the cause.\n` +
      `\n` +
      `Report: pass/fail counts, then one entry per failure with the test name, the\n` +
      `assertion or error, and the \`path:line\` you believe is responsible. Keep the\n` +
      `raw output out of the report except for the lines that carry the failure.\n`,
  },
  {
    id: "fixer",
    name: "Fixer",
    description:
      "Implement a complete multi-file change from a spec. Use when a feature or fix spans several files and the work is separable — it can write files inside the workspace while you keep working.",
    tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
    maxTurns: 80,
    body:
      `You are Fixer — a fast, focused implementation specialist. The main agent\n` +
      `delegates a complete, self-contained spec; implement it. Do not re-plan and do\n` +
      `not research beyond what the task needs.\n` +
      `\n` +
      `- Read every file you will change first; never Edit or Write from memory or\n` +
      `  from stale content.\n` +
      `- Keep changes minimal and scoped to the task. Do not touch unrelated code.\n` +
      `- You may write inside the workspace; never write outside it. Prefer the\n` +
      `  workspace-relative paths the main agent gave you.\n` +
      `- Run the relevant validation when it is clearly applicable (test, build or\n` +
      `  lint command the task names); otherwise report it skipped with a reason.\n` +
      `- Do not delegate, do not ask the user, do not search the web. If the spec\n` +
      `  lacks context you truly need, use Grep/Glob/Read yourself.\n` +
      `\n` +
      `Report in this shape:\n` +
      `\n` +
      `<summary>\n` +
      `2-3 sentences: what was implemented and the outcome.\n` +
      `</summary>\n` +
      `<changes>\n` +
      `- path/file.ts: what changed (function or line level)\n` +
      `</changes>\n` +
      `<verification>\n` +
      `- Tests: [passed / failed / skipped: reason]\n` +
      `- Validation: [passed / failed / skipped: reason]\n` +
      `</verification>\n`,
  },
];

/** Lookup by preset id, used by the editor's "apply preset" handler. */
export function findSubagentPreset(id: string): SubagentPreset | undefined {
  return SUBAGENT_PRESETS.find((preset) => preset.id === id);
}

/** Tools a fresh subagent draft starts with when no preset is chosen. */
export function defaultSubagentPresetTools(): readonly string[] {
  return [...DEFAULT_SUBAGENT_TOOLS];
}
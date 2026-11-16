# ADR 0210: Subagent output-token cap

- Status: Accepted (issue #171, merged in #193)
- Date: 2026-09-10
- Related: ADR 0062, ADR 0063, ADR 0194, D383, E2E-119, E2E-155

## Context

A subagent definition could bound a delegate's turns and reasoning level but not
its response length. The only limit available was `ModelBinding.maxTokens`, the
per-model **Max output** value that `modelConfigWithBinding` folds into the model a
session builds, so it applies to every request that model serves. Delegation needs
a finer granularity: `explorer` sweeps many files and reports a conclusion while
`fixer` edits one path, and capping the model to size the cheap one would also cap
the session and every other delegate.

## Decision

1. D383: a definition declares its own cap. Subagent frontmatter and the settings
   API accept `maxTokens`, an optional non-negative integer where omitted, `none`,
   or `0` means "follow the model's published limit", which is what every existing
   document already does. The value travels the same path as `maxTurns`.
2. The accepted range starts at 1 and has a defensive ceiling set above every
   published model limit, so an out-of-range value is clamped or ignored as a
   warning instead of silently changing what the document asked for.
3. The cap overrides the model built for that delegate and only that delegate.
   `SubagentRun` already builds its own model and single-model provider registry,
   so the cap is applied as `{ ...builtModel, maxTokens }` and the adapters derive
   `max_tokens` / `max_completion_tokens` / `max_output_tokens` from it without an
   adapter branch. The session's binding stays untouched.
4. The editor places the field next to the turn limit inside the existing Advanced
   disclosure, and an empty field reads as "follow the model" rather than "no
   limit".
5. The change is additive only: no migration, protocol bump, IPC method, or
   tool-result shape changes.

## Consequences

- Sizing one worker no longer resizes the session or its siblings, and the
  provider still enforces its own maximum.
- A definition that omits the field parses, stores, and runs exactly as before,
  so built-in definitions are unchanged.
- Presets could carry a per-role cap later; that is a follow-up because it would
  change what a preset overwrites in the editor.

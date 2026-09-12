# ADR 0210: Subagent output-token cap

- Status: Accepted (issue #171, merged in #193)
- Date: 2026-09-10
- Deciders: PI-Desktop runtime and UX maintainers
- Related: D383, E2E-155, E2E-119, ADR 0062, ADR 0063, ADR 0194

## Context

A subagent definition could bound a delegate's turns and its reasoning level,
but not its response length. The only output limit in play was the one the
model binding carries: `ModelBinding.maxTokens` is edited under **Max output**
in a model's Advanced settings, and `modelConfigWithBinding` folds it into the
model the session builds. That value belongs to the model, not to a caller, so
it applies to every request that model serves.

Delegation is where that is the wrong granularity. A delegate is a bounded
worker by design (ADR 0062): `explorer` sweeps many files and reports a
conclusion, while `fixer` edits one path. Capping the model to size the cheap
one would also cap the session and every other delegate, and a definition
cannot express "this worker answers briefly" at all. Users therefore had no
way to bound a delegate's own output, and the cost the issue names — a search
delegate spending far more output than its report needs — was not addressable
from Settings.

## Decision

1. **D383 — a definition declares its own output cap.** Subagent frontmatter
   and the settings API accept `maxTokens`, an optional non-negative integer.
   Omitted, `none`, or `0` means "follow the model's published limit", which is
   the behavior every existing document already had. The value travels the same
   path as `maxTurns`: frontmatter, `SubagentDefinition`, `UserSubagentRecord`,
   the settings input, and the editor draft.
2. **The ceiling is 200000 and the accepted range starts at 1.** The clamp is
   defensive, not policy: no published model accepts an output limit above
   128k, so a larger number is a typo, and a limit of `0` would mean "no
   output" — a state the empty field already expresses. A value above the
   ceiling is clamped to it; a negative or fractional value is not a cap at
   all and is ignored, leaving the delegate on the model's limit. The parser
   reports both as warnings rather than silently changing what the document
   asked for.
3. **The cap overrides the model built for that delegate, and only that
   delegate.** `SubagentRun` already builds its own model and its own
   single-model provider registry, so the cap is applied as
   `{ ...builtModel, maxTokens }` on that object. The adapters derive
   `max_tokens` / `max_completion_tokens` / `max_output_tokens` from this
   field, so no adapter-specific branch is introduced, and the session's
   requests keep the binding untouched.
4. **The editor places it beside the turn limit, in the Advanced area that
   already exists.** Both are caps that belong to the definition rather than to
   the model; the pre-existing Advanced disclosure already carries model,
   thinking, turn limit and scope, so no new surface is created. The empty
   field reads as "follow the model", not "no limit", so its placeholder is the
   model default.
5. **Additive only.** No SQLite migration, protocol version bump, IPC method,
   or tool-result shape changes. A document without `maxTokens` parses, stores
   and runs exactly as before.

## Consequences

- A delegate's output can be bounded without changing the model binding, so
  sizing one worker no longer resizes the session or its siblings.
- A cap may be stricter than the model's own limit but never looser in effect:
  the provider still enforces its own maximum, and the ceiling keeps a typo
  from reaching it.
- Definitions gain a field that only matters when a delegate writes long
  answers; an existing document keeps following the model.
- The built-in definitions do not declare a cap, so their behavior is
  unchanged. Presets could carry one per builtin role later; that is a
  follow-up rather than part of this decision, because it would change what a
  preset overwrites in the editor.

## Alternatives rejected

- **Reuse `ModelBinding.maxTokens`.** It is a per-model value, so it would cap
  the session and every delegate pinned to that model. It also cannot express
  two delegates on one model with different budgets.
- **Make the cap a turn-level or session-level setting.** Both are coarser than
  the problem: the issue is one delegate's report length, and a session-wide
  cap would silently truncate the parent's answers.
- **Reject a value above the ceiling instead of clamping it.** A definition
  document is hand-editable, and refusing to load it over one typo would take
  the delegate out of the catalog. Clamping with a warning keeps the delegate
  usable and says what happened.
- **Default the field to a concrete number.** A default would change existing
  delegates' requests on upgrade, which is exactly what an opt-in cap must not
  do.

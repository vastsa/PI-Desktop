# ADR 0210: Subagent output-token cap

- Status: Accepted (issue #171, merged in #193)
- Date: 2026-09-10
- Deciders: PI-Desktop runtime and UX maintainers
- Related: D383, E2E-155, E2E-119, ADR 0062, ADR 0063, ADR 0194

## Context

A subagent definition could bound a delegate's turns and its reasoning level,
but not its response length. The only output limit in play was the one the model
binding carries: `ModelBinding.maxTokens` is edited under **Max output** in a
model's Advanced settings, and `modelConfigWithBinding` folds it into the model
the session builds.

## Decision

1. **D383 — a definition declares its own output cap.** Subagent frontmatter and
   the settings API accept `maxTokens`, an optional non-negative integer.
2. **The ceiling is 200000 and the accepted range starts at 1.** The clamp is
   defensive, not policy: no published model accepts an output limit above 128k,
   so a larger number is a typo, and a limit of `0` would mean "no output" — a
   state the empty field already expresses.
3. **The cap overrides the model built for that delegate, and only that
   delegate.** `SubagentRun` already builds its own model and its own
   single-model provider registry, so the cap is applied as `{ ...builtModel,
   maxTokens }` on that object.
4. **The editor places it beside the turn limit, in the Advanced area that
   already exists.** Both are caps that belong to the definition rather than to
   the model; the pre-existing Advanced disclosure already carries model,
   thinking, turn limit and scope, so no new surface is created.
5. **Additive only.** No SQLite migration, protocol version bump, IPC method, or
   tool-result shape changes.

## Consequences

- A delegate's output can be bounded without changing the model binding, so
  sizing one worker no longer resizes the session or its siblings.
- A cap may be stricter than the model's own limit but never looser in effect:
  the provider still enforces its own maximum, and the ceiling keeps a typo from
  reaching it.
- Definitions gain a field that only matters when a delegate writes long
  answers; an existing document keeps following the model.
- The built-in definitions do not declare a cap, so their behavior is unchanged.

## Alternatives rejected

- **Reuse `ModelBinding.maxTokens`.** It is a per-model value, so it would cap
  the session and every delegate pinned to that model.
- **Make the cap a turn-level or session-level setting.** Both are coarser than
  the problem: the issue is one delegate's report length, and a session-wide cap
  would silently truncate the parent's answers.
- **Reject a value above the ceiling instead of clamping it.** A definition
  document is hand-editable, and refusing to load it over one typo would take
  the delegate out of the catalog.
- **Default the field to a concrete number.** A default would change existing
  delegates' requests on upgrade, which is exactly what an opt-in cap must not
  do.

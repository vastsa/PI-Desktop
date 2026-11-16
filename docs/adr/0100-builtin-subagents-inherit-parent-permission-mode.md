# ADR 0100: Make builtin subagents inherit the parent permission mode

- Status: Accepted
- Date: 2026-08-18
- Related: D115, D242, ADR 0057, ADR 0089

## Context

Proactive delegation gave the builtin `fixer` an explicit `permission:
accept-edits` scope, which overrode the parent's mode: under an `auto` parent a
`fixer` call to `Glob` or to a `Write` outside the workspace opened a card `auto`
is meant to allow. The external-path gate stays a capability boundary, and an
explicit scope on a user-owned definition must stay meaningful.

## Decision

Builtin subagent definitions use the default `permission: inherit`, so builtin
`fixer` no longer declares `permission: accept-edits` while its tools and
containment rules are unchanged. A delegate `tools.execute` call without a scope
resolves under the parent's effective mode: `ask` keeps approval for high-risk and
explicit external-path calls, `accept-edits` auto-allows only in-root `Write`/`Edit`,
and `auto` auto-allows what the parent could do. An explicit non-`inherit` scope
stays a deliberate override, and a project definition cannot escalate beyond the
session mode.

## Consequences

- An `auto` parent uses `fixer` without an unexpected card, and delegation never
  silently widens an `ask` or `accept-edits` parent.
- Builtin `fixer` may prompt for writes under `ask`; callers wanting another
  posture use an explicit user definition scope.

## Alternatives

- Keep `fixer` at `accept-edits`: reproduces the popup and lets a builtin ignore
  the user's posture.
- Ignore delegate scopes under `auto`: an explicit user `ask` scope is deliberate.

- Status: Accepted
- Date: 2026-08-18
- Deciders: PI-Desktop core
- Related: D115, D242, ADR 0057, ADR 0089

## Context

The proactive delegation decision gave the builtin `fixer` an explicit
`permission: accept-edits` scope. That made workspace `Write` and `Edit` calls
convenient when the parent session was in `ask`, but it also replaced the
parent's effective permission mode for every other call. In a parent session
set to `auto`, a `fixer` call to `Glob` or `Write` an explicit path outside the
session workspace therefore opened a permission card even though `auto` is
supposed to allow that path. The card correctly identified the request as
coming from `fixer`; the incorrect part was the builtin's unexpected narrower
override.

The external-path gate remains an intentional capability boundary. The
permission mode is what decides whether that boundary needs a card, and an
explicit scope on a user-owned definition must remain meaningful.

## Decision

Builtin subagent definitions use the default `permission: inherit` behavior.
The builtin `fixer` no longer declares `permission: accept-edits`; its
available tools remain `[Read, Glob, Grep, Edit, Write, Bash]` and its
workspace/path containment rules do not change.

With no scope attached to a delegate `tools.execute` call, host-core resolves
the call under the parent session's effective permission mode:

- `ask` keeps approval for high-risk and explicit external-path calls;
- `accept-edits` auto-allows only in-root `Write`/`Edit` and keeps the other
  approval boundaries;
- `auto` auto-allows the same calls the parent could make, including explicit
  external paths.

An explicitly declared non-`inherit` scope on an eligible builtin or user
subagent remains an intentional override. Project definitions still cannot
use a permission declaration to escalate beyond the session mode.

## Consequences

- A parent in `auto` can use builtin `fixer` without an unexpected subagent
  authorization card.
- A parent in `ask` or `accept-edits` is not silently made more permissive by
  delegation.
- The builtin fixer may prompt for its writes in `ask`; callers that need a
  different posture can use an explicit user definition scope.
- Host-core's external-path containment and permission evaluation do not need a
  special subagent exception.

## Alternatives considered

- **Keep `fixer` at `accept-edits`:** rejected because it reproduces the
  observed auto-mode popup and makes a built-in delegate ignore the user's
  selected permission posture.
- **Change `fixer` to `auto`:** rejected because it would bypass approval even
  when the parent session is `ask`.
- **Ignore every delegate scope when the parent is `auto`:** rejected because
  an explicit user-owned `ask` scope is a deliberate stricter policy and must
  remain enforceable.

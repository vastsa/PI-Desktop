# ADR 0100: Make builtin subagents inherit the parent permission mode

- Status: Accepted
- Date: 2026-08-18
- Deciders: PI-Desktop core
- Related: D115, D242, ADR 0057, ADR 0089

## Context

The proactive delegation decision gave the builtin `fixer` an explicit
`permission: accept-edits` scope. That made workspace `Write` and `Edit` calls
convenient when the parent session was in `ask`, but it also replaced the
parent's effective permission mode for every other call.

## Decision

Builtin subagent definitions use the default `permission: inherit` behavior. The
builtin `fixer` no longer declares `permission: accept-edits`; its available
tools remain `[Read, Glob, Grep, Edit, Write, Bash]` and its workspace/path
containment rules do not change.

With no scope attached to a delegate `tools.execute` call, host-core resolves
the call under the parent session's effective permission mode:

- `ask` keeps approval for high-risk and explicit external-path calls;
- `accept-edits` auto-allows only in-root `Write`/`Edit` and keeps the other
  approval boundaries;
- `auto` auto-allows the same calls the parent could make, including explicit
  external paths.

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
- **Ignore every delegate scope when the parent is `auto`:** rejected because an
  explicit user-owned `ask` scope is a deliberate stricter policy and must
  remain enforceable.

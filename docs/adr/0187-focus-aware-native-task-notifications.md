# ADR 0187: Focus-Aware Native Task Notifications

- Status: Accepted
- Date: 2026-09-08
- Related: D117, D350, ADR 0107, E2E-065, E2E-065a

## Context

Durable task completion rows exist for a focused background session, but one
native notification request was shared with interactive ask, permission, and plan
prompts, so suppressing by current session showed a banner while another session
was focused.

## Decision

The Electron-only native notification request carries an explicit `kind` of `task`
or `interactive`. A task completion never appears natively while the main window is
visible and focused, whichever session is selected, and stays eligible when hidden,
minimized, or unfocused; interactive prompts suppress only in the exact visible
focused session. Durable task insertion is unchanged, and plugin-native
notifications keep their permission-gated path.

## Consequences

- Focused-background completions produce the inbox row without a duplicate banner.
- Callers without a `kind` fail closed to the task behavior.

## Alternatives

- Relax the shared focus gate for all calls: hides actionable prompts.
- Add a second native IPC channel: `kind` keeps shared validation and activation.

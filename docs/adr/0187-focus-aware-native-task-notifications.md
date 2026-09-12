# ADR 0187: Focus-Aware Native Task Notifications

- Status: Accepted
- Date: 2026-09-08
- Related: ADR 0107, D117, D350, E2E-065, E2E-065a
- Note: The native IPC field is `kind` (`task` | `interactive`). A duplicate
  0187 that named the same field `source` was withdrawn.

## Context

Durable task completion rows are created for a focused background session, but
the renderer and Electron main shared one native notification request with
interactive ask/permission/plan prompts. Suppressing native output based only on
the current session therefore showed a completion banner while the app was
focused on another session, violating D117 and E2E-065.

## Decision

Add an explicit `kind` to the Electron-only native notification request:
`task` or `interactive`. A task completion is never shown natively while the
main window is both visible and focused, regardless of which session is
currently selected. It remains eligible when the window is hidden, minimized,
or unfocused. Interactive prompts retain their previous rule: suppress only the
exact visible focused session, while a focused background request remains
visible so the user can answer it.

The durable task insertion policy is unchanged: the exact visible focused
session suppresses the inbox row, while background, hidden, unknown, and
unfocused state creates it. Plugin-native notifications remain on their separate
permission-gated path.

## Consequences

- Focused-background completions produce the durable inbox row without a
  duplicate native banner.
- Interactive requests remain actionable when another session is selected.
- The behavior is unit-testable without launching Electron, and old callers
  without a kind fail closed to the task behavior.

## Alternatives considered

- Relax the shared focus gate for all calls: rejected because it would hide
  actionable interactive prompts.
- Add a second native IPC channel: rejected because an explicit kind keeps the
  shared validation and click activation path without duplicating host code.

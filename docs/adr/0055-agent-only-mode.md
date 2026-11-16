# ADR 0055: Agent-only mode; Chat becomes an internal read-only profile

- Status: Superseded by ADR 0052 / ADR 0053
- Date: 2026-08-05

> Superseded. The mode concept this ADR removed returned as the Plan
> operating state (ADR 0052, superseded in turn by ADR 0053), so the product
> again exposes an `Agent | Plan` selector and `chat` migrates to `plan`, not
> `agent`. Retained because the reasoning about a negative permission gate and
> about failing closed on an unknown `mode` value still holds, and because it
> records why the toggle was removed before it was reintroduced with a
> different contract.

## Context

Since D003/D004 a session carried one of two tool profiles.

1. A user who switched to Chat and later removed the toggle from their muscle
   memory could leave a session permanently unable to write files.
2. Every tool, prompt-composition, and permission change had to be reasoned
   about twice, and the lazy tool-activation core sets (D185) forked on mode.
3. The mode chip competed for space with the controls users do change — model,
   thinking level, permission mode.

## Decision

1. **`agent` is the only mode the product exposes.** The top-bar segmented
   toggle, the Settings default-mode row, both palette commands and their slash
   aliases, the `.ct-mode*` styles, and the `settings.mode*` i18n keys are
   removed. `newSession` always requests `agent`, and boot normalizes a stored
   `defaultMode` that is not `agent`.

## Consequences

Superseded (Superseded by ADR 0052 / ADR 0053). The full record is in git history.

# ADR 0347: A trusted extension can take over context management

- Status: Accepted
- Date: 2026-11-26
- Related: [ADR 0061](0061-imperceptible-background-context-compaction.md) ·
  [ADR 0214](0214-trusted-extensions.md) · issue #2596

## Context

Automatic compaction is always on (ADR 0061 §9): the Settings switch was removed
so a user who once disabled the guard is never left without one. Third-party
context managers (billion-context, magic-context, …) ship as trusted extensions
and shape every request through the `context` hook, but the native guard fought
them in three places:

1. The hard limit was checked against the raw history before `context` ran, so
   a request the extension had already shrunk was still refused or compacted.
2. Cancelling `session_before_compact` above the hard limit ended the turn with
   `CONTEXT_COMPACTION_FAILED`.
3. The `new_context` tool and the `<context_budget>` reminder competed with the
   extension's own instructions.

## Decision

1. A trusted extension calls `pi.setContextManagement("external")` while its
   factory runs. A call after the factory settled, or with any value other than
   `"native"` / `"external"`, is inert and reports a `rejected_registration`
   diagnostic, because the declaration shapes the tool catalog and request
   guards of the whole session.
2. While a loaded extension of the session declared `external`, the runtime does
   not register `new_context`, injects no context-budget reminder, runs no
   threshold compaction before a prompt or between turns, and does not recover a
   provider overflow by compacting.
3. The hard limit is still enforced, against the messages the `context` hook
   returns for each request. A request above it fails locally as
   `CONTEXT_TOO_LARGE` without reaching the provider.
4. Manual `/compact` and `ctx.compact()` keep working and still emit
   `session_before_compact`, so the extension decides what an explicit request
   does.
5. There is no user setting. The declaration lives and dies with the extension:
   disabling or uninstalling it disposes the runner, and the next runtime has
   native protection again.

## Consequences

- Context managers that trim in `context` work at any history length, and their
  prompts no longer meet Desktop's compaction tool or reminders.
- ADR 0061 §9 holds: no persisted switch can leave a session unguarded, and the
  request size guard stays on in both modes.
- A session's compaction behavior now depends on which extensions are enabled;
  the declaration is visible only in code and diagnostics, not yet on the plugin
  row.

## Alternatives

- Restore the Settings switch: reverses ADR 0061 §9 and leaves users without a
  guard after they forget the switch.
- Treat `{ cancel: true }` from `session_before_compact` as the takeover: it only
  applies once compaction is already due, so the tool and reminders stay, and a
  plain veto could no longer be told apart from a takeover.

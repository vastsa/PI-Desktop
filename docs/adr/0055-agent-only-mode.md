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

Since D003/D004 a session carried one of two tool profiles. `agent` got the
full coding surface (`read`/`bash`/`edit`/`write`/`glob`/`grep`/`browser_preview`
plus plugin tools); `chat` got a read-only subset (`read`/`glob`/`grep`) that
host-core hard-denies past every permission mode (D115).

The product is an agent desktop. `chat` was never a destination: it existed as
a safety valve, but the UI advertised it as a peer choice through a top-bar
segmented toggle, a Settings default-mode row, `/chat-mode` and `/agent-mode`
palette commands, and four localized labels. That had three costs:

1. A user who switched to Chat and later removed the toggle from their muscle
   memory could leave a session permanently unable to write files. With the
   toggle gone the session would have been stranded with no way back.
2. Every tool, prompt-composition, and permission change had to be reasoned
   about twice, and the lazy tool-activation core sets (D185) forked on mode.
3. The mode chip competed for space with the controls users do change —
   model, thinking level, permission mode.

Deleting the profile outright was not acceptable either: imported sessions and
rows written by older builds carry a `mode` string the current UI does not
produce, and the narrow tool surface is a security boundary worth keeping for
anything that is not explicitly `agent`.

## Decision

1. **`agent` is the only mode the product exposes.** The top-bar segmented
   toggle, the Settings default-mode row, both palette commands and their slash
   aliases, the `.ct-mode*` styles, and the `settings.mode*` i18n keys are
   removed. `newSession` always requests `agent`, and boot normalizes a stored
   `defaultMode` that is not `agent`.
2. **`chat` is renamed `read-only`.** The shared type becomes
   `Mode = "read-only" | "agent"`. Host-core's `SESSION_MODES` is
   `["agent", "read-only"]`, and `normalize_session_mode` folds the pre-D188
   `chat` spelling into `read-only` on every write path (`session.create`,
   `session.configure`, `session.import`), rejecting anything else. Callers
   store the normalized value, never the raw input.
3. **The permission gate is negative.** `PermissionManager` denies when
   `mode != "agent"` and the tool is outside `read_only_mode_allows`
   (`read`/`glob`/`grep` plus `plugin_*`). An unknown or legacy `mode` string
   therefore fails closed into the read-only surface instead of silently
   gaining write/edit/bash. The hard deny continues to outrank every D115
   permission mode, including `auto`.
4. **The error codes are renamed** to `BASH_DISABLED_IN_READ_ONLY` and
   `WRITE_DISABLED_IN_READ_ONLY`. Neither had a localized message, so the
   rename is confined to `packages/shared/src/errors.ts`, the host's code
   selection, and the specs.
5. **Existing `chat` rows are migrated to `agent` at open.** `boot_maintenance`
   runs `UPDATE sessions SET mode = 'agent' WHERE mode = 'chat'` and folds a
   stored `app.defaultMode` of `chat` into `agent` via `json_set`. Both
   statements are idempotent; after the first open nothing matches.

## Consequences

- No session can be stranded read-only: the only rows that can hold
  `read-only` are ones a future import or external writer produces, and they
  keep the narrow, host-enforced surface by design.
- `SCHEMA_VERSION` stays at 7. `Database::open` archives-and-resets anything
  below the current version (D119), so a version bump would have destroyed the
  very sessions this change exists to rescue. The fix-up is a data repair
  inside the existing schema instead.
- The mode string stays in the RPC contract (`tools.execute`,
  `session.configure`, `SessionSummary`) and in the `sessions.mode` column.
  Removing it would be a protocol break for no gain, and the host still needs
  it to pick a tool profile.
- The conversation top bar keeps only the model picker plus task actions; the
  composer chip row now leads with Thinking. `ModelSelect` remains the writer
  of the session thinking level on a model switch.
- Tool activation (D185) still has two core sets. The read-only one is simply
  unreachable from the UI.

## Alternatives

### Drop the `read-only` profile entirely

Rejected. It would leave imported and legacy rows with a `mode` the host does
not recognize, and the natural fallback for an unrecognized value would be the
full agent surface — a silent privilege widening at exactly the wrong moment.

### Keep the value spelled `chat`

Rejected. The name described a product mode that no longer exists and read as a
peer of Agent in code, logs, and error codes. `read-only` says what the profile
actually is, which is what the remaining host-side enforcement is for.

### Keep the toggle but hide it behind developer mode

Rejected. It preserves both the dual-toolset reasoning cost and the stranding
failure mode, and a debug-only path into a security-relevant profile is worse
than no path.

### Bump the schema version to carry the migration

Rejected. v7 is a breaking reset, not a migration chain (D119): opening a
pre-current database archives it and bootstraps a fresh file. A bump would
discard the user's sessions to fix one column value in them.

## References

- `packages/shared/src/types.ts`, `packages/shared/src/errors.ts`
- `packages/agent-runtime/src/runtime.ts`
- `crates/host-core/src/sessions.rs`, `crates/host-core/src/permissions.rs`
- `crates/host-core/src/db.rs`, `crates/host-core/src/rpc/mod.rs`
- `apps/desktop/src/components/ConversationTopbar.tsx`
- `apps/desktop/src/pages/SettingsPage.tsx`
- `apps/desktop/electron/main/builtin-commands.ts`
- `docs/spec/03-runtime/03-tools-and-permissions.md`
- `docs/spec/03-runtime/04-data-storage.md`
- `docs/spec/03-runtime/08-error-codes.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md` (E2E-018, E2E-088)
- Decision D191; amended D003, D004, D115; superseded by D188 / D189
- [ADR 0052](0052-plan-operating-state-and-approval-boundary.md),
  [ADR 0053](0053-plan-checkpoint-artifact-and-execution-epoch.md)

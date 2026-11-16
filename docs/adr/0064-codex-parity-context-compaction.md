# ADR 0064: Codex-parity context compaction

- Status: Accepted (automatic trigger amended by D623 / issue #970)
- Date: 2026-08-06
- Deciders: PI-Desktop core
- Amends: ADR 0061 / ADR 0030 / D158 / D200; amended by ADR 0136

## Context

ADR 0061 made compaction imperceptible and cited Codex as the reference for
doing so. Reading the Codex sources afterwards showed that four of its clauses
are the opposite of what Codex actually does, and that one factual claim in its
Context section is wrong:

| Codex | ADR 0061 |
| --- | --- |
| Compaction is synchronous only; there is no pre-computation anywhere | Checkpoints are pre-computed in provider-idle windows (clause 4) |
| The auto-compact threshold scope defaults to the whole context; `BodyAfterPrefix` is opt-in | The background trigger measures the increment since the last checkpoint (clause 2) |
| Every compaction emits a `ContextCompaction` turn item **and** an `EventMsg::Warning` | A successful compaction notifies nobody and leaves no row (clauses 7, 8) |
| `new_context` is a real model-facing tool, gated by `Feature::TokenBudget` | "Codex also has no model-side compaction tool at all" (line 31); the tool is removed (clause 6) |
| After compaction the model context keeps recent **user** messages (≤20k tokens) plus the summary | The retained tail keeps whole recent turns, assistant and tool messages included |
| Two families: LLM-summary compaction and a no-summary rollover into a fresh window | One family, always summarized |
| Two-tier budget reminders (`TokenBudgetReminder`, then `AutoCompactFallbackPrompt`), each once per window | No model-facing nudge at all (clause 6) |

- `core/src/compact.rs` — `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`;
  `build_compacted_history_with_limit()` walks history newest-first keeping only
  user messages, truncates the one that crosses the limit, `reverse()`s back
  into order, then appends the summary; `:384` raises `EventMsg::Warning` after
  every compaction.
- `core/src/compact_token_budget.rs` — the no-summary path runs the same
  compaction lifecycle, emits the same `ContextCompaction` turn item, and then
  calls `start_new_context_window()`.
- `session/mod.rs:3665 start_new_context_window()` — history is cleared to the
  initial context plus the turn context item, with `message: String::new()`.
- `session/turn.rs:423` — `should_roll_over = needs_follow_up &&
  (take_new_context_window_request() || token_limit_reached)`: the trigger is
  evaluated at a turn boundary, inline.

## Decision

Compaction follows Codex's mechanism. ADR 0030's hard boundary, ADR 0049's
retained-tail recovery, ADR 0061's model-window-derived budgets, and ADR 0061's
`buildCheckpoint` / `installCheckpoint` split all stay; ADR 0061 clauses 2, 4,
6, 7, and 8 are replaced.

1. **Inline only.** All background pre-computation is deleted:
   `pendingBackgroundCheckpoint`, `backgroundCompaction`, `backgroundAbort`,
   `checkpointBaselineTokens`, `backgroundLimit`, and the three call sites in
   `tool_execution_start`, `prompt()`, and the run `finally`.
2. **Codex's retained shape.** `codexShapedPreparation()` keeps
   `prepareCompaction()`'s cut point (and therefore its turn-boundary and
   split-turn handling), then folds `turnPrefixMessages` and `retainedTail` back
   into `messagesToSummarize` so the summary covers the entire compacted range,
   and rebuilds the retained tail as user messages only:
   `selectRetainedUserMessages()` walks the compacted range plus the previous
   checkpoint's retained users newest-first up to
   `COMPACTION_RETAINED_USER_MESSAGE_MAX_TOKENS = 20_000` (capped at half the
   hard budget so retention alone cannot fill a small window), truncates the
   message that crosses the limit instead of dropping it, and reverses back into
   chronological order.
3. **Two families behind an internal switch.** `CompactionStrategy = "summary" |
   "fresh_window"` resolves from a construction option, then
   `PI_DESKTOP_COMPACTION_STRATEGY`, defaulting to `"summary"`.
4. **`new_context` is back.** The tool is parameterless and carries Codex's
   description verbatim; executing it only sets `pendingModelCompaction` and
   returns the family's rollover message.
5. **Two-tier reminders, once each per window.** With `remaining = hardLimit -
   tokens`: tier one at `remaining <= clamp(hardLimit * 0.15, 8k, 32k)` states
   the remaining budget and asks the model to start closing out; tier two at
   `remaining <= 2_000` tells it to write down now whatever must survive.
6. **The whole checkpoint chain is durable.** `read_compactions()` and
   `write_transcript_with_compactions()` replace their latest-only predecessors;
   `sessions.rs` validates, forks, and remaps every record and adds
   `compactions: Vec<CompactionRecord>` to the session detail payload, keeping
   `compaction` as its last element.
7. **One transcript row per compaction, and a warning every time.**
   `compaction_end` carries `mark?: ContextCompactionMark` (`id`,
   `throughMessageId`, `generation`, `summaryTokens`, `summarized`) instead of
   ADR 0061's `status`, and drops `phase` entirely; the durable records supply
   the same marks on session open or fork.

Manual `/compact` is unchanged and remains fail-fast. Settings still exposes no
compaction controls and still ignores persisted `contextCompaction` values (ADR
0061 clause 9).

### Deliberate deviations from Codex

- **Summary position.** Codex appends the summary after the retained user
  messages.
- **Task boundary.** ADR 0136 narrows the retained tail: an active turn may
  retain only its latest user message, while a completed-turn checkpoint has an
  empty tail so the next prompt cannot be mistaken for a continuation of
  completed work.
- **`hardLimit` derivation.** Codex compacts at 90% of the window; we keep ADR
  0030's "window − output reserve".
- **Tool registration.** Codex gates `new_context` behind
  `Feature::TokenBudget`, so it exists only for the no-summary family.
- **Reminder thresholds and text.** Codex reads both from per-model metadata.
- **Reminder delivery.** Codex injects synthetic history items.

## Consequences

- Compaction is paid for at the moment the user is waiting again.
- Model context after a compaction is much smaller and much lossier: no
  assistant reasoning and no tool output survives except through the summary.
- The summary input covers the entire compacted range rather than the range
  minus the tail, so each summary request remains larger than under ADR 0061.
- The 90% safety trigger intentionally pays for some additional summaries to
  reduce provider-side context overflows; `hardLimit` remains the fail-closed
  backstop.
- Compaction is auditable from the transcript again, restoring ADR 0030's
  visibility property that ADR 0061 reversed.

## Alternatives

### Keep background pre-computation and add the visible row and warning

Rejected. The user asked for Codex's mechanism, not a superset of it, and a
pre-computed checkpoint that installs at an unrelated turn boundary makes the
row's position arbitrary.

### Filter the retained tail to user messages without folding it into the summary

Rejected as a correctness bug: `prepareCompaction()` summarizes only below the
cut point, so the dropped assistant and tool messages inside the tail would be
covered by nothing.

### Set `keepRecentTokens: 0` and let `prepareCompaction()` produce an empty tail

Rejected. When the last entry is a tool result, `findCutPoint()` falls back to
the earliest valid cut point, which discards far more than intended.

### Expose the family switch in Settings

Rejected. Codex does not expose it, and no user can judge "no summary at all"
against "one summary request" from a settings row.

## References

### Implementation note (2026-10-03)

The desktop runtime now owns the compaction preparation and context projection
described here because pi-agent-core removed its experimental harness APIs.
Cut-point, split-turn, retained-tail, and summary behavior remain governed by
this ADR and the runtime specification; durable checkpoint ownership remains
with Rust host-core.

- `docs/spec/03-runtime/01-ipc-protocol.md`
- `docs/spec/03-runtime/02-agent-runtime.md`
- `docs/spec/03-runtime/03-tools-and-permissions.md`
- `docs/spec/03-runtime/04-data-storage.md`
- `docs/spec/04-ux/08-component-spec.md`
- `docs/spec/04-ux/09-interaction-patterns.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md`
- `docs/spec/08-meta/decisions-log.md` (D158, D200, D203)
- `codex-rs/core/src/compact.rs`, `compact_token_budget.rs`,
  `session/token_budget.rs`, `tools/handlers/new_context_window_spec.rs`
  (behavioral reference)

## Amendment (2026-09-23, D623 / issue #970): Earlier inline compaction trigger

The inline-only lifecycle is unchanged. Automatic compaction now starts at 90%
of the derived safe budget from both new-prompt preflight and in-run
turn-boundary checks.

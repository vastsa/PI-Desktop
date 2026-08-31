# ADR 0064: Codex-parity context compaction

- Status: Accepted
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

Source anchors for each of the above:

- `core/src/compact.rs` — `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`;
  `build_compacted_history_with_limit()` walks history newest-first keeping only
  user messages, truncates the one that crosses the limit, `reverse()`s back into
  order, then appends the summary; `:384` raises `EventMsg::Warning` after every
  compaction.
- `core/src/compact_token_budget.rs` — the no-summary path runs the same
  compaction lifecycle, emits the same `ContextCompaction` turn item, and then
  calls `start_new_context_window()`.
- `session/mod.rs:3665 start_new_context_window()` — history is cleared to the
  initial context plus the turn context item, with `message: String::new()`.
- `session/turn.rs:423` —
  `should_roll_over = needs_follow_up && (take_new_context_window_request() || token_limit_reached)`:
  the trigger is evaluated at a turn boundary, inline.
- `session/token_budget.rs:66 maybe_record()` — tier one at
  `remaining <= reminder_threshold_tokens`, tier two at `remaining == 0 &&
  allow_fallback`, each claimed once per window.
- `tools/spec_plan.rs:994` and `tools/handlers/new_context_window_spec.rs` —
  `new_context`, parameterless, described as "Start a new context window. Does
  not clear, reset, or otherwise affect environment state."

The user asked for Codex parity explicitly, was told it reverses the
imperceptibility goal they had asked for one round earlier, and reaffirmed it.
Only one ADR 0061 clause survives on its own merits *and* matches Codex: hiding
the tuning knobs. Codex reads reserve and retention values from model metadata
and never asks the user either.

## Decision

Compaction follows Codex's mechanism. ADR 0030's hard boundary, ADR 0049's
retained-tail recovery, ADR 0061's model-window-derived budgets, and ADR 0061's
`buildCheckpoint` / `installCheckpoint` split all stay; ADR 0061 clauses 2, 4,
6, 7, and 8 are replaced.

1. **Inline only.** All background pre-computation is deleted:
   `pendingBackgroundCheckpoint`, `backgroundCompaction`, `backgroundAbort`,
   `checkpointBaselineTokens`, `backgroundLimit`, and the three call sites in
   `tool_execution_start`, `prompt()`, and the run `finally`.
   `prepareNextTurn()` re-estimates the budget and compacts synchronously when
   the total crosses `hardLimit`. The increment-scoped trigger goes with it —
   there is no longer a second threshold for it to guard.
2. **Codex's retained shape.** `codexShapedPreparation()` keeps
   `prepareCompaction()`'s cut point (and therefore its turn-boundary and
   split-turn handling), then folds `turnPrefixMessages` and `retainedTail` back
   into `messagesToSummarize` so the summary covers the entire compacted range,
   and rebuilds the retained tail as user messages only:
   `selectRetainedUserMessages()` walks the compacted range plus the previous
   checkpoint's retained users newest-first up to
   `COMPACTION_RETAINED_USER_MESSAGE_MAX_TOKENS = 20_000` (capped at half the
   hard budget so retention alone cannot fill a small window), truncates the
   message that crosses the limit instead of dropping it, and reverses back
   into chronological order. Folding the tail into the summary is not optional:
   `prepareCompaction()` only summarizes below the cut point, so filtering the
   tail without doing this would silently lose assistant and tool content that
   nothing summarized. Dropping assistant messages also drops their tool calls,
   so no orphaned `tool_use` can reach the provider.
3. **Two families behind an internal switch.**
   `CompactionStrategy = "summary" | "fresh_window"` resolves from a
   construction option, then `PI_DESKTOP_COMPACTION_STRATEGY`, defaulting to
   `"summary"`. `fresh_window` issues no summary request: it installs a
   checkpoint with an empty retained tail and the fixed
   `CONTEXT_ROLLOVER_SUMMARY` marker text, then continues through the identical
   lifecycle — budget re-estimation, `session.appendCompaction`,
   `compaction_end`, transcript row, warning — mirroring Codex modelling its
   token-budget rollover as an ordinary compaction. The switch reaches neither
   `AppSettings`, Settings, nor i18n.
4. **`new_context` is back.** The tool is parameterless and carries Codex's
   description verbatim; executing it only sets `pendingModelCompaction` and
   returns the family's rollover message. `prepareNextTurn()` compacts when
   `pendingModelCompaction || tokens >= hardLimit`, matching Codex's
   `should_roll_over`. The name is synchronized across `activeTools()`,
   `isCoreTool()`, the contract-mode allowlists, and the host-core
   no-confirmation allowlist (`crates/host-core/src/permissions.rs`), where it
   replaces `"CompactContext"`.
5. **Two-tier reminders, once each per window.** With
   `remaining = hardLimit - tokens`: tier one at
   `remaining <= clamp(hardLimit * 0.15, 8k, 32k)` states the remaining budget
   and asks the model to start closing out; tier two at `remaining <= 2_000`
   tells it to write down now whatever must survive. Each is claimed once and
   both claims reset when a checkpoint is installed. The reminder is appended to
   the current turn's system prompt and restored in `finally` — the same
   mechanism as `SILENT_TURN_NUDGE` — so it never enters the transcript or the
   durable history.
6. **The whole checkpoint chain is durable.** `read_compactions()` and
   `write_transcript_with_compactions()` replace their latest-only predecessors;
   `sessions.rs` validates, forks, and remaps every record and adds
   `compactions: Vec<CompactionRecord>` to the session detail payload, keeping
   `compaction` as its last element. One transcript row per compaction requires
   the chain to survive restart, late truncation, and forks.
7. **One transcript row per compaction, and a warning every time.**
   `compaction_end` carries `mark?: ContextCompactionMark`
   (`id`, `throughMessageId`, `generation`, `summaryTokens`, `summarized`)
   instead of ADR 0061's `status`, and drops `phase` entirely; the durable
   records supply the same marks on session open or fork.
   `buildTranscriptEntries()` inserts a `kind: "compaction"` entry after the
   anchor message, ending whatever assistant turn contains it, and discards a
   mark whose anchor no longer exists. A successful compaction also raises an
   unconditional warning toast; the fallback, overflow, and manual toasts stay,
   because each says something more specific. The context inspector keeps its
   line, now reading the newest mark.

Manual `/compact` is unchanged and remains fail-fast. Settings still exposes no
compaction controls and still ignores persisted `contextCompaction` values
(ADR 0061 clause 9).

### Deliberate deviations from Codex

- **Summary position.** Codex appends the summary after the retained user
  messages. `buildSessionContext()` in pi-agent-core emits
  `createCompactionSummaryMessage(summary)` before `entry.retainedTail`, and
  that order is not ours to choose. Both orders present the same content.
- **Task boundary.** ADR 0136 narrows the retained tail: an active turn may
  retain only its latest user message, while a completed-turn checkpoint has
  an empty tail so the next prompt cannot be mistaken for a continuation of
  completed work.
- **`hardLimit` derivation.** Codex compacts at 90% of the window; we keep
  ADR 0030's "window − output reserve". Codex can afford the looser number
  because it has a separate full-window guard; we do not, and an oversized
  request is a hard provider error.
- **Tool registration.** Codex gates `new_context` behind
  `Feature::TokenBudget`, so it exists only for the no-summary family. We
  register it in both, because the requirement was that the model has the tool.
  `get_context_remaining` is not implemented; the reminders carry the number
  instead.
- **Reminder thresholds and text.** Codex reads both from per-model metadata.
  We have no such feed, so the thresholds derive from the same `hardLimit` the
  guard uses and the wording is ours.
- **Reminder delivery.** Codex injects synthetic history items. We have no
  channel for a history entry that stays out of the transcript, so the reminder
  is a per-turn system-prompt append instead — equivalent in effect and with no
  persistence risk.

## Consequences

- Compaction is paid for at the moment the user is waiting again. That is the
  cost of parity; Codex pays it too. The zero-wait property from ADR 0061 is
  gone.
- Model context after a compaction is much smaller and much lossier: no
  assistant reasoning and no tool output survives except through the summary.
  The visible transcript is untouched, so nothing is lost to the user.
- The summary input is now the entire compacted range rather than the range
  minus the tail, so each summary request is larger than under ADR 0061 — but
  there are fewer of them, because the trigger is one hard edge again.
- Compaction is auditable from the transcript again, restoring ADR 0030's
  visibility property that ADR 0061 reversed.
- Every compaction interrupts the user with a warning. This is intended: only
  the user can decide to start a fresh session instead, and after several
  compactions that is usually the better answer.
- The model can compact early and deliberately, and can also ignore the
  reminders — the hard boundary is still there when it does.
- The no-summary family is implemented but unreachable in a shipped build. It
  exists so the mechanism is complete and testable, not as a product option.

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

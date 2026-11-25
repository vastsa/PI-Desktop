# ADR 0064: Codex-parity context compaction

- Status: Accepted (automatic trigger amended by D623 / issue #970)
- Date: 2026-08-06
- Amends: ADR 0061 / ADR 0030 / D158 / D200; amended by ADR 0136
- Related: [08-meta/decisions-log](../spec/08-meta/decisions-log.md) (D203)

## Context

ADR 0061 made compaction imperceptible and cited Codex as its reference, but
reading the Codex sources showed that four of its clauses describe the opposite of
what Codex does: Codex compacts synchronously with no pre-computation, measures the
whole context rather than an increment, announces every compaction with a turn item
and a warning, and keeps a model-facing `new_context` tool. The user was told that
parity reverses the imperceptibility goal and reaffirmed the request.

## Decision

Compaction follows Codex's mechanism. ADR 0030's hard boundary, ADR 0049's
retained-tail recovery, and ADR 0061's model-window budgets and `buildCheckpoint` /
`installCheckpoint` split stay; ADR 0061 clauses 2, 4, 6, 7, and 8 are replaced.

1. **Inline only.** All background pre-computation is deleted, and `prompt()` plus
   `prepareNextTurn()` re-estimate at their pre-request boundaries and compact
   synchronously once the estimate reaches the soft threshold, while `hardLimit`
   remains the safety guard no request may cross.
2. **Codex's retained shape.** Preparation keeps its cut point and turn-boundary
   handling, folds the prefix and retained tail into the summarized range so the
   summary covers everything compacted, and rebuilds the retained tail as user
   messages only, truncating the message that crosses the retention cap. Dropping
   assistant messages also drops their tool calls, so no orphaned `tool_use`
   reaches the provider.
3. **Two families behind an internal switch.** `CompactionStrategy` of `"summary"`
   or `"fresh_window"` resolves from a construction option and then
   `PI_DESKTOP_COMPACTION_STRATEGY`, where `fresh_window` issues no summary request
   and installs a checkpoint with an empty tail and a fixed rollover marker through
   the identical lifecycle. The switch reaches neither `AppSettings`, Settings, nor
   i18n.
4. **`new_context` is back.** The parameterless tool only sets the pending
   compaction and returns the rollover message, and its name is synchronized across
   `activeTools()`, `isCoreTool()`, the contract-mode allowlists, and the host-core
   no-confirmation allowlist.
5. **Two-tier reminders, once each per window.** A remaining-budget reminder asks
   the model to close out and a second tells it to write down what must survive,
   both claims reset when a checkpoint is installed, and the reminder is appended to
   the turn's system prompt and restored afterwards, so it never enters the
   transcript or durable history.
6. **The whole checkpoint chain is durable.** Transcript reads and writes cover
   every record, session detail carries `compactions` with `compaction` as its last
   element, and forks validate and remap every record.
7. **One transcript row per compaction, and a warning every time.**
   `compaction_end` carries `mark?: ContextCompactionMark` instead of a status and
   drops `phase`, a `kind: "compaction"` entry follows its anchor message, and a
   successful compaction always raises a warning toast.

Manual `/compact` stays fail-fast, and Settings still exposes no compaction
controls.

### Deliberate deviations from Codex

- **Summary position.** The pi-agent-core context builder emitted the summary
  before the retained tail. PI-Desktop now owns the projection and keeps that
  order for reasoning replay and fallback recovery. A successful active-turn
  checkpoint with one retained user message and no reasoning to replay places
  that request before the nonempty summary (issue #2512).
- **Task boundary.** ADR 0136 narrows the retained tail, so an active turn keeps
  only its latest user message and a completed-turn checkpoint has an empty tail.
- **`hardLimit` derivation.** We keep ADR 0030's window-minus-reserve number,
  because we have no separate full-window guard and an oversized request is a hard
  provider error.
- **Tool registration and reminders.** `new_context` is registered in both
  families, and reminder thresholds derive from `hardLimit` with our own wording,
  delivered as a per-turn system-prompt append rather than synthetic history.

## Consequences

- Compaction is paid for while the user waits, so ADR 0061's zero-wait property is
  gone and model context after a compaction is much smaller and lossier, while the
  visible transcript stays untouched.
- Compaction is auditable from the transcript again, restoring ADR 0030's
  visibility, and every compaction interrupts the user with a warning.
- The model may ignore the reminders, and the no-summary family ships unreachable,
  existing so the mechanism is complete and testable.

## Alternatives

- Keep background pre-computation and add the row and warning: rejected, a
  pre-computed checkpoint installs at an unrelated turn boundary.
- Filter the retained tail without folding it into the summary: rejected as a
  correctness bug, because the dropped content would be covered by nothing.
- Expose the family switch in Settings: rejected, no user can judge "no summary"
  against "one summary request".

## Amendment (2026-09-23, D623 / issue #970): Earlier inline compaction trigger

The inline-only lifecycle is unchanged, and automatic compaction now starts at 90%
of the derived safe budget from both new-prompt preflight and in-run turn-boundary
checks, leaving a deterministic margin for estimator drift during the preceding
turn. A failed soft-trigger compaction may proceed only while the context stays
below `hardLimit`, and no settings, background work, host protocol, or storage
semantics are added.

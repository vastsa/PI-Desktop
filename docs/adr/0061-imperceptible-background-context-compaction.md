# ADR 0061: Imperceptible background context compaction

- Status: Accepted (clauses 2, 4, 6, 7, 8 amended by ADR 0064)
- Date: 2026-08-06
- Related: ADR 0030, ADR 0047, ADR 0049, ADR 0064, D158, D200

## Context

The turn-boundary guard of ADR 0030 correctly refuses provider requests above the
hard budget, and ADR 0049 gives automatic failures a durable retained-tail
recovery, but none of it was invisible. Compaction raised a toast, flipped the run
state and spinner, spent a model turn on a `CompactContext` nudge, ran only at the
hard limit while the user was already waiting for a reply, and exposed tuning
knobs in Settings. Its fixed `reserveTokens` and `keepRecentTokens` defaults also
applied the same absolute counts to a 32k and a 1M window.

## Decision

Compaction becomes host-owned background work the user cannot perceive. The
blocking hard boundary is unchanged and remains the safety net.

1. The budget is tiered and derived from the model window. `contextBudget()` keeps
   `hardLimit` and `requestHeadroom` as ADR 0030 defined them, adds
   `backgroundLimit` as the pre-computation trigger, and derives
   `keepRecentTokens` from the hard budget. The soft boundary and its `softGap`
   are deleted.
2. The background trigger is incremental: it fires only when usage exceeds
   `backgroundLimit` and has grown by `keepRecentTokens` since the baseline of the
   newest checkpoint. The hard boundary keeps measuring the total, because that is
   the provider's actual constraint.
3. Generation is separated from installation. `buildCheckpoint()` runs the
   preparation and summary request without persisting anything or touching
   `activeCompaction`, while `installCheckpoint()` re-estimates, appends through
   host-core, updates the anchor, and emits `compaction_end`. The blocking path
   composes both back to back, so threshold, overflow, and manual behavior are
   unchanged.
4. Background requests start only in provider-idle windows, from
   `tool_execution_start` and the `finally` of `prompt()`. They never share the
   connection with a streaming turn, and they leave `compactionInProgress` unset
   because that flag feeds `getStatus().isRunning`.
5. A pre-computed checkpoint is installed only if its base checkpoint is still
   active, its `throughMessageId` anchor is still present, and it fits the current
   model's budget. Any miss discards it and falls back to the blocking path; a
   failed background build is dropped without persisting, without an event, and
   without the ADR 0049 fallback, which belongs to the hard boundary.
6. No model-facing compaction remains. `CompactContext`, the
   `<context_management>` nudge, and its no-confirmation allowlist entry are
   removed, so triggering is fully deterministic and host-driven.
7. The lifecycle events carry an optional `phase?: "background" | "blocking"`
   field, additive per ADR 0047. A successful automatic compaction notifies
   nobody: toasts remain only for a retained-tail fallback, an overflow retry, and
   a manual `/compact` result.
8. The inspector is the only visible trace. `compaction_end` carries
   `status: { generation, summaryTokens }`, and `SessionDetail.compaction`
   provides the same on session open or fork. The generation counter rides inside
   the checkpoint's opaque persisted `details`, so no record schema changes.
9. The Settings compaction card and its passthrough are removed, and persisted
   `contextCompaction` values are ignored, because a user who once disabled the
   guard would have no switch left. The type survives only as a
   construction-time override for tests.

## Consequences

- In the common case nobody waits for compaction: the summary overlaps a tool
  execution or an idle session and the turn boundary installs a finished
  checkpoint.
- Small and large windows get proportionate budgets, and losing the model-side
  tool removes a class of wasted turns and a transcript artifact.
- Compaction is no longer auditable from the transcript, which is an accepted
  reversal of ADR 0030, and users can no longer disable the guard.

## Alternatives

- Compact during the streaming turn: two requests on one connection invite rate
  limiting and double the visible cost.
- Keep the soft-boundary nudge: it adds only the failure modes it always had.

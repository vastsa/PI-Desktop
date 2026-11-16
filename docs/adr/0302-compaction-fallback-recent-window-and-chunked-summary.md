# ADR 0302: A failed compaction keeps the recent window, and an oversized summary is chunked

- Status: Accepted for implementation
- Date: 2026-09-22
- Amends: ADR 0049 (the retained tail is the recent window, not one user
  message; a prompt that does not fit is chunked rather than skipped) / ADR 0282
  (the reduced pass is no longer the last attempt before the fallback)
- Related: ADR 0064 (the `fresh_window` family, unchanged), issue #827

## Context

ADR 0049 installs a deterministic retained-tail checkpoint when automatic
compaction fails, and ADR 0282 retried the summary and reduced an oversized prompt
once before that fallback. The shipped contract was narrower: the tail was
rebuilt as at most the latest user message, so a failed summary left the model
without the decisions, paths, and unfinished work of the turn it continued while
the transcript and UI row looked healthy. A prompt that still did not fit was
skipped rather than summarized, and the checkpoint recorded no reason for the
degradation.

## Decision

A retained-tail fallback keeps the newest contiguous messages of the compacted
range across every role, bounded by the keep-recent target and by what the safe
budget leaves after the carried summary and recovery notice are paid for, and it
records `details.retainedTailShape` as `recent_window`. A checkpoint without that
marker still normalizes to its latest user message, so a restart cannot restore a
sequence of executable-looking old requests.

The fallback drops error, aborted, and deferred assistant messages and any tool
result whose call is outside the window, because a provider rejects an orphaned
result, and an `active_turn` fallback also keeps the active task's user message
ahead of the window when the window cannot hold it, so a continuation never loses
its goal.

A range too large for one prompt is split into contiguous chunks that each fit the
request budget, chained through pi's update-the-summary prompt and summarized once
for the whole range, with the summed usage of those requests reported. Only an
empty range, or one beyond the chunk bound, still falls back on budget grounds.

The checkpoint records `details.failureReason` from a closed vocabulary —
`no_new_history`, `summary_budget`, `summary_provider`, `checkpoint_oversized` —
instead of provider error text, which ADR 0049 keeps out of the persisted record.

## Consequences

- A failed summary no longer costs the active turn, because the degradation stays
  inside the same recent-context budget a successful checkpoint respects.
- Fallback checkpoints and their continuation requests are larger, and a summary
  of a very large range costs several provider requests and reports their sum.
- Provider validity is unchanged, manual `/compact` keeps its fail-fast contract,
  the `fresh_window` family still carries an empty tail, and no setting, protocol
  field, or persisted record schema changed.

## Alternatives

- Keep the one-user-message tail and rely on the carried summary: rejected because
  the carried summary is the one that failed, which is the reported defect.
- Skip the oversized summary: rejected because the failure is the summarizer's,
  not the window's, and only the chunked path still covers the range.

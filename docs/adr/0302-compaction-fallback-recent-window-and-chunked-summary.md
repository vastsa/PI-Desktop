# ADR 0302: A failed compaction keeps the recent window, and an oversized summary is chunked

- Status: Accepted for implementation
- Date: 2026-09-22
- Amends: ADR 0049 (the retained tail is the recent window, not one user
  message; a prompt that does not fit is chunked rather than skipped) / ADR 0282
  (the reduced pass is no longer the last attempt before the fallback)
- Related: issue #827 · ADR 0064 (the `fresh_window` family, unchanged) ·
  [03-runtime/02-agent-runtime](../spec/03-runtime/02-agent-runtime.md)

## Context

ADR 0049 decided that an automatic compaction failure installs a deterministic
retained-tail checkpoint, and described that checkpoint as preserving "the
recent provider-valid message tail". ADR 0282 then made the runtime retry a
failed summary and reduce an oversized prompt once before the fallback ran.

## Decision

A retained-tail fallback retains the real recent window: the newest contiguous
messages of the compacted range, every role, bounded by the keep-recent target
and by what the safe budget leaves once the carried-forward summary and the
recovery notice are paid for. It records `details.retainedTailShape` as
`recent_window`, and a checkpoint without that marker — every successful
checkpoint, and every record written before the marker existed — still
normalizes to its latest user message, so a restart cannot restore a sequence of
executable-looking old requests.

A budget too small for one prompt no longer skips the model. The range is split
into contiguous chunks that each fit the request budget — at most 16 requests,
each carrying the previous chunk's summary through pi's update-the-summary
prompt, with the range's file list appended on the last one — so the checkpoint
still covers every message behind its boundary, and the summary reports the
summed usage of the requests that produced it.

## Consequences

- A failed summary no longer costs the active turn: the degradation is bounded
  by the same recent-context budget a successful checkpoint respects.
- A fallback checkpoint is larger than it was, and so is the continuation
  request it authorizes.
- A summary of a very large range costs several provider requests and reports
  their summed usage.
- Provider validity is unchanged: a retained tail never carries an orphaned tool
  result or an unanswered tool call.
- Manual `/compact` keeps its fail-fast contract, the `fresh_window` family
  still carries an empty tail, and no setting, protocol field, or persisted
  record schema changed.

## Alternatives

### Keep the one-user-message tail and rely on the carried summary

Rejected: the failed summary is the carried one, so the range after it has no
representation at all.

### Retain the window only for `active_turn`

Rejected: a completed turn that fails loses the same delta, and the window ends
on a finished assistant message, so it reads as history rather than as a pending
request — which is what the older normalization guarded against.

### Summarize an oversized range by concatenating partial summaries with no
second request per chunk

Rejected: each chunk needs its own request regardless, and any merge step either
costs another request or leaves several sections that disagree.

### Raise the hard limit or keep skipping the shot summary

Rejected: the failure is the summarizer's, not the window's, and the guard is
what keeps the next request inside the provider limit.

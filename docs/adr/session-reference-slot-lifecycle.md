# ADR: Session reference plugin lifecycle

- Status: Proposed (stacked on the plugin-slot development branch)
- Date: 2026-09-22
- Related: #446, #447, #528, #545, #561; ADR 0291, 0294 and 0295

## Context

The old PR embeds session search, chip identity, transcript reading and prompt
rewriting into host Composer/store modules. The selected extension direction
instead calls for the existing completion and Before Send slots. Inspection of
`9b9dfcb` found that the completion component could not accept a candidate, recap
could not address another session/page, and the sidecar acknowledged before a
blocking input handler finished. A renderer-only imitation of a send button or
private database access would bypass those contracts rather than implement them.

## Decision

Keep feature logic in `examples/plugins/session-mentions`. Complete narrowly
scoped generic lifecycle contracts, without a second menu, file-chip subtype,
conversation store, A2A channel, or direct renderer IPC access by the plugin.

Completion gets optional `sessionId` and `acceptText`; the host applies its own
trigger math and refuses stale session/value/cursor/IME state. Existing callers
and built-in ordering remain unchanged. Reference registrations may provide
`validateSend`, called with an immutable draft snapshot and plugin-bound dispatch
before clearing or queue insertion. Error, invalid return, timeout or unload
refuses the pending send. A draft edited or switched while awaiting validation
is left untouched. The validator does not rewrite or send anything.

Recap's session scope accepts optional `sessionId` and `before`, still requiring
`runtime.turn.recap` and `runtime.session.read`. This explicitly includes
cross-session content; install-review language must be read accordingly. Reads
continue through host-core `session.get` and its bounded physical cursor domain.
Malformed cursors fail before I/O; missing sources are unavailable, not empty.
Own non-secret plugin settings cross the launch boundary as a snapshot, part of
runtime identity, and are copied on extension reads. No credentials are included.

Before Send remains the sole model-facing rewrite hook and keeps host audit.
The sidecar awaits admission before returning accepted, but provider execution
stays asynchronous. A private, one-use identity marker avoids a second transform
inside `prompt`. Abort/dispose cancels an in-flight preparation. Steering also
consults input and revalidates the current turn before enqueueing the result.

## Alternatives and consequences

A plugin-only patch cannot honestly provide missing lifecycle callbacks. Merging
the entire unmerged slot branch into a main-targeted feature diff obscures review;
this change is stacked on that branch instead, keeping PR #447 and its history.
It must be retargeted/revalidated after the dependency reaches main.

The existing reference position is below the editor. Native inline and historic
transcript chips are not reintroduced. Queued inputs are resolved at actual
admission rather than storing opaque context in a parallel plugin cache. A
queued source/budget can change after its renderer precheck; host queue recovery
handles a later refusal. This behavior difference from the old PR is explicit.
A refused admission may leave the durable original row/audit record, and plugin
uninstallation intentionally removes the capability. The existing runner-wide
handler-timeout policy is not silently changed; this plugin returns its own
bounded handled result. Token estimation remains approximate.

## Verification

Exercise the plugin entries, candidate metadata/read boundary, cross-page Q&A,
shared budgets, omission, cancellation and unload. Exercise the real host
reference registry, the real extension runner permission/cursor guards, and
runtime admission-to-provider handoff (one transform, no provider on rejection).
Record actual commands/results in the PR; a source-contract assertion or a
fixture adapter is not a real Windows/native-host/model end-to-end test.

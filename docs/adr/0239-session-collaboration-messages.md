# ADR 0239: Host-owned session collaboration messages

- Status: Accepted; amended by D446
- Date: 2026-09-13
- Decision: D409 (amended by D446)
- Amends: ADR 0237, ADR 0165, ADR 0213

## Context

Session Orchestrator must address existing durable sessions in both directions,
deliver completion callbacks, and expose reliable state, but polling assistant
text cannot establish a turn's outcome, and plugin settings must not become an
authority for session identity, authorization, or execution state.

## Decision

Rust host-core owns a durable session communication ledger keyed by message ID
and referencing the source and target Session IDs, where Session IDs remain the
only session identity and message IDs identify deliveries and idempotency
rather than a second work identity. Each delivery binds to its actual durable
turn before execution and derives results from that turn's persisted terminal
state, while the official plugin only composes reviewed desktop operations for
spawn, send, status, result, and cancellation. The host authenticates the
sending Session ID from a correlated plugin tool invocation, so a plugin cannot
forge a sender; existing targets keep their project, model, context, and
permissions, new sessions inherit the initiating project and permission mode,
and messaging can never raise a target above the initiating operation's
authorized ceiling. Messages carry explicit task, message, or completion
provenance, persist with the transcript, and render separately from human
input; they are not new user authorization and take no part in user-message
editing or regeneration, and a client-supplied `session_message` is stripped
(D597). A completion callback produces at most one durable completion message
referencing the original delivery and the real turn outcome, never requesting
another callback. The plugin resolves models through the host's public catalog
and returns candidates or a clear error rather than substituting an unrelated
model, and the session-list hover card gains a bounded on-demand host
projection of creation source, current task, recent exchanges, status, and
turn-bound result.

## Consequences

- The storage migration is additive: existing conversations, plugin settings,
  and the core Task family stay intact.
- This is a plugin-mediated exception to ADR 0165's withdrawn cross-session
  coordination; the old A2A broker, tools, and protocol are not restored, and
  ADR 0237's parent-only messaging and polling-based result inference are
  superseded.
- The host bounds autonomous communication chains, retains delivery failures for
  passive inspection, and preserves a cancelled session and its history.

## Amendment (2026-09-18, D446): a completion notice's own reply may stay silent

Issue #504 reported that a successful task ended in `EMPTY_MODEL_RESPONSE`
because silent-turn recovery retried the silence the completion prompt asked
for. The first settled assistant reply to a completion notice may now end with
no visible text and no tool call without silent-turn recovery, emitted as a
completed message, spent by that first settled response and revoked once an
accepted steering message enters the model context; only provenance Main
resolved from the queued Host ledger record (`kind: completion`, the current
target session, nonempty message and reply-to IDs) can enable it, so no
protocol field or caller authority is added. Main persists an accepted silent
reply as an empty completed row that the runtime keeps out of its entries and
pi's transcript state, so the next request carries no empty assistant message.

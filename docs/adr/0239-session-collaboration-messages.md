# ADR 0239: Host-owned session collaboration messages

- Status: Accepted; amended by D446
- Date: 2026-09-13
- Decision: D409 (amended by D446)
- Amends: ADR 0237, ADR 0165, ADR 0213

## Context

Session Orchestrator must address existing durable sessions in both directions,
reuse their context, deliver completion callbacks, and expose reliable state.
Polling assistant text cannot establish a turn's outcome.

## Decision

Rust host-core owns a durable session communication ledger keyed by message ID,
referencing the existing source and target Session IDs. Session IDs remain the
only session identity.

The official plugin composes reviewed desktop operations for spawn, send,
status, result, and cancellation. The host authenticates the sending Session ID
from a correlated plugin tool invocation; plugins cannot supply a forged sender.

## Compatibility and validation

The storage migration is additive. Existing conversations, plugin settings, and
the core Task family remain intact.

Validation covers concurrent senders, durable identity, reuse, queue admission,
source preservation across reload, exactly-once callback creation, failure and
cancellation results, permission ceilings, model resolution, hover lifecycle,
and the relevant host/Electron E2E journeys.

## Amendment (2026-09-18, D446): a completion notice's own reply may stay silent

Issue #504: the completion prompt states that a notice needs no acknowledgement,
yet the runtime's silent-turn recovery (spec 02-agent-runtime §5e) retried the
resulting silence and reported `EMPTY_MODEL_RESPONSE` after a task that had
succeeded. This amendment bounds one exception; every other decision above is
unchanged.

- The first settled assistant reply to a completion notice may end with no
  visible text and no tool call without silent-turn recovery or
  `EMPTY_MODEL_RESPONSE`.
- The exception covers exactly that reply.
- Only provenance that Main resolved from the queued Host ledger record can
  enable it: `kind: completion`, the current target session, and nonempty
  message and reply-to IDs.
- An accepted silent reply is still not worth resending.

Validation: runtime unit coverage for the accepted shapes, the trust boundary,
tool batches, provider retry, steering before and after the reply, and context
exclusion; `pnpm test:e2e:session-completion` against the real host ledger,
sidecar, and a local SSE provider. See
E2E-SESSION-completion-notice-allows-silence.

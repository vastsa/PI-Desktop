# ADR session-collaboration-current-turn: Opt-in current-turn session collaboration

- Status: Proposed
- Date: 2026-09-23
- Issue: #914
- Extends: ADR 0239, active-turn-steering

## Context

A worker's ordinary message or completion notice previously always entered
Agent Host's next-turn queue. A coordinator making further model requests in
its existing turn could not use the result. Human steering is not a substitute:
it has human provenance and may skip a tool batch's remaining work.

We considered pushing into the runtime's steering queue and changing the
existing one-delivery-per-turn ledger. Both would weaken existing cancellation,
provenance, or result-association invariants. Instead, the runtime pulls from a
separate host-owned receipt table at the existing safe next-request hook.

## Decision

`sessionMessagesInCurrentTurn` is a device-local, default-off application
setting, exposed in General settings. Desktop captures it when starting an
Agent turn; changing it does not promote already queued input. The host also
rechecks the setting at acceptance. Task instructions retain ordinary admission.

A fresh message/completion created while its target has a durable running turn
may receive an `offered` receipt bound to that exact turn. Main defers its normal
queue submission only while that runtime explicitly accepts this channel.
The runtime requests a batch only after the agent loop has decided to make
another actual model request and the current tool batch has completed.
Main checks the active turn/Stop fence, flushes prior transcript writes, and
rechecks the runtime's acceptance gate. The host revalidates the target, pending
approval, permission ceiling and enabled plugin registry.

The host commits `accepted` receipts keyed by a receiver-generated request ID
before acknowledging them. It then appends canonical session-origin inputs with
deterministic transcript IDs. A lost reply is retried with the same request ID;
a JSONL/index gap is repaired without writing another input. Compaction and
extension context shaping cannot silently drop newly received input. Source
framing remains identical to ordinary session-message history, never human
steering. Inputs are bounded to eight per receive and 128 per parent turn.

An offered receipt can transition to `fallback` only by host compare-and-set.
An accepted receipt cannot. Unclaimed offers become ordinary queued messages
when the parent ends; restart restores them through the existing held queue.
Accepted inputs remain in that parent's history after crash or Stop and are
not replayed as a new prompt. The original ledger's unique physical turn link
remains unchanged; projections additionally resolve accepted receipt turn IDs.

Acceptance is **durable adoption of input**, not proof that a remote model has
processed it. SQLite and a provider HTTP request cannot form one atomic
transaction. Stop after adoption or an unrecoverable transport failure may
prevent the next provider request; its receipt/history is preserved rather than
risking a duplicate task. Bounded uncertain-reply retries fail the current
request instead of claiming definite rejection. Inspectable terminal outcomes
continue to distinguish interruption from successful completion.

## Consequences

Schema 20 adds a receipt table after backing up schema 19. Existing messages,
queue entries, task inputs, default behavior, and plugin sending calls remain
unchanged. No renderer or plugin mutation endpoint is added. Headless embeddings
without a Stop/transcript-flush receiver do not enable this channel.

No in-flight HTTP request or executing tool is modified or interrupted. The
current model, workspace, permissions and turn ID do not change. Receiving a
result never cancels another worker. Already adopted messages cannot be
individually cancelled by their sender: that would stop unrelated parent work.
Cancellation returns `CONFLICT` and does not abort the parent turn.

The feature does not wake an indefinitely blocked tool. It uses the next actual
safe request, for example after a bounded SessionTask wait/poll interval.
Approval and Stop remain authoritative even if messages are waiting.

## Verification

Host tests exercise migration, provenance, receipt replay, JSONL repair,
permission changes, cancellation, hop limits, completions and restart. Runtime
and Main service tests exercise Stop/epoch fences, lost replies, queue fallback,
flush ordering and post-shaping inclusion. `test:e2e:session-current-turn` uses
real Host and sidecar processes, the production Main collaboration service,
a controlled external wait tool and a local SSE provider. It checks the actual
next request, unchanged turn ID, source IDs exactly once and worker09 remaining
running. It is not an Electron UI or live-provider test.

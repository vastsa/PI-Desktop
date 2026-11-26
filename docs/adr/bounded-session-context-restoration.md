# Bounded session context restoration

- Status: Accepted
- Date: 2026-11-26
- Amends: ADR 0030 (context checkpoint restoration), ADR 0049 (retained-tail recovery)

## Context

Display paging already bounded the conversation view, while cold Agent launch
still reconstructed every historical body. A single response could exceed the
JavaScript string limit and poison the shared Host stdout reader. Paging all
bodies into one runtime fixed the frame limit but still consumed memory in
proportion to the complete retained history.

## Decision

Keep complete transcripts under Rust ownership. Introduce internal bounded
context and logical history reads, preserving checkpoint carriers and tool
signatures. Daily model restoration reads the active checkpoint and tail;
archived task history is loaded on demand. Bound response serialization and
explicit Host frame reception, returning errors by request ID and resuming at
the next LF boundary. Keep existing import readers lossless by opting into
frame limits only where error correlation is implemented.

When the active range exceeds the restore budget, automatic recovery persists
an explicit retained-tail checkpoint before provider admission. Its notice
identifies unread older history as unsummarized, preserving the visible file.
Disabled recovery and failed persistence end the scoped operation. No fixed
limit is imposed on total session-file size.

## Consequences

Normal restoration body memory depends on the active context budget rather
than archived text volume. First-time indexing and explicit full-history
operations retain their proportional cost. A single oversized record may
still require a smaller or different read; its error leaves other requests
usable. Existing small fork replies stay complete; larger replies carry a
page and physical cursors. This changes no persisted schema or data ownership.

## Alternatives

Increasing string or heap limits preserves the failure mode. Paging all
history into one process preserves linear memory growth. Silently taking the
last N messages would lose checkpoint, tool-pair and delegation semantics.

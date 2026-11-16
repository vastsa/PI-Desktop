# ADR 0120: Bounded Session History Windows

- Status: Accepted
- Date: 2026-08-24
- Deciders: PI-Desktop core
- Related: D119, ADR 0041, `03-runtime/04-data-storage.md`,
  `03-runtime/06-host-rpc-protocol.md`

## Context

Opening a session previously read its complete JSONL transcript, projected every
message, and sent the complete result through host-core, Electron, and the
renderer. A single large pasted or tool-produced value could therefore make a 50
MB transcript allocation and block the desktop while a long session was being
opened.

## Decision

1. Renderer-facing `session.get` supports an additive read window with
   `messageBefore`, `messageLimit`, and `contentLimit`.
2. Host-core reads JSONL with a buffered sequential parser and projects only the
   requested page.
3. The desktop opens sessions with the newest 100 messages and a 64 KiB
   per-message display budget.
4. The uncapped default remains available to non-renderer callers, so model
   reconstruction and persistence semantics do not depend on UI pagination.

The original implementation scanned the transcript sequentially to find a
requested window. It now keeps a disposable per-session layout of physical
message and compaction line offsets, with a versioned disk cache when the
filesystem provides a reliable file identity.

## Alternatives considered

- **Only virtualize the message list:** rejected because the expensive full
  parse and IPC payload would still happen before rendering.
- **Store only a preview in the transcript:** rejected because it loses user
  data and changes model context semantics.
- **Use a database payload table for paging:** rejected for now; the JSONL
  transcript remains the lossless source and a streaming window avoids a schema
  migration while fixing the boundary that caused the stall.

## Consequences

- Session activation has bounded renderer memory and IPC work independent of the
  total visible history, apart from the sequential scan needed to locate the
  requested page.
- Older history is available on demand, and display-only truncation is clear to
  the user while the complete content remains available to the agent.
- Full-history edit, delete, revision-switch, and abort operations may perform a
  deliberate uncapped read before mutation; this preserves transcript data
  rather than allowing a partial UI window to overwrite older messages.

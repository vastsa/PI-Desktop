# ADR 0120: Bounded Session History Windows

- Status: Accepted
- Date: 2026-08-24
- Deciders: PI-Desktop core
- Related: D119, ADR 0041, `03-runtime/04-data-storage.md`,
  `03-runtime/06-host-rpc-protocol.md`

## Context

Opening a session previously read its complete JSONL transcript, projected
every message, and sent the complete result through host-core, Electron, and
the renderer. A single large pasted or tool-produced value could therefore
make a 50 MB transcript allocation and block the desktop while a long session
was being opened. Mount-time virtualization did not solve the problem because
the full payload had already crossed the process boundary.

## Decision

1. Renderer-facing `session.get` supports an additive read window with
   `messageBefore`, `messageLimit`, and `contentLimit`. The host returns
   `messageStart` and `hasMoreBefore` so the renderer can page toward older
   messages while preserving the newest view.
2. Host-core reads JSONL with a buffered sequential parser and projects only
   the requested page. `contentLimit` truncates only the derived display
   projection, with an explicit marker; the lossless transcript on disk and
   the uncapped sidecar/model path remain authoritative.
3. The desktop opens sessions with the newest 100 messages and a 64 KiB
   per-message display budget. Scrolling near the top fetches older pages and
   preserves the viewport's scroll position. Deliberate full-history rewrites
   first rehydrate the complete transcript before replacing it, so a partial
   renderer window cannot delete older messages.
4. The uncapped default remains available to non-renderer callers, so model
   reconstruction and persistence semantics do not depend on UI pagination.

The original implementation scanned the transcript sequentially to find a
requested window. It now keeps a disposable per-session layout of physical
message and compaction line offsets, with a versioned disk cache when the
filesystem provides a reliable file identity. Appends extend the layout; an
atomic transcript rewrite invalidates both cache layers. A cache is an
optimization only: old or invalid formats rebuild from the JSONL source, and
the bounded read can perform one full rebuild and retry after detecting an
invalid indexed boundary. This does not change the JSONL format, SQLite schema,
RPC contract or the bounded-window decision above.

## Alternatives considered

- **Only virtualize the message list:** rejected because the expensive full
  parse and IPC payload would still happen before rendering.
- **Store only a preview in the transcript:** rejected because it loses user
  data and changes model context semantics.
- **Use a database payload table for paging:** rejected for now; the JSONL
  transcript remains the lossless source and a streaming window avoids a schema
  migration while fixing the boundary that caused the stall.

## Consequences

- Session activation has bounded renderer memory and IPC work independent of
  the total visible history, apart from the sequential scan needed to locate
  the requested page.
- Older history is available on demand, and display-only truncation is clear
  to the user while the complete content remains available to the agent.
- Full-history edit, delete, revision-switch, and abort operations may perform
  a deliberate uncapped read before mutation; this preserves transcript data
  rather than allowing a partial UI window to overwrite older messages.

# ADR 0120: Bounded Session History Windows

- Status: Accepted
- Date: 2026-08-24
- Related: D119, ADR 0041, `03-runtime/04-data-storage.md`, `03-runtime/06-host-rpc-protocol.md`

## Context

Opening a session read its complete JSONL transcript, projected every message,
and pushed the result through host-core, Electron, and the renderer, so one
large pasted or tool-produced value could stall the desktop while a long session
opened. Mount-time virtualization did not help, because the full payload had
already crossed the process boundary.

## Decision

1. Renderer-facing `session.get` accepts an additive window with
   `messageBefore`, `messageLimit`, and `contentLimit`, and returns
   `messageStart` and `hasMoreBefore` so the renderer can page toward older
   messages while keeping the newest view.
2. Host-core parses JSONL sequentially and projects only the requested page;
   `contentLimit` truncates only the display projection, with an explicit
   marker, while the on-disk transcript and the uncapped sidecar/model path stay
   authoritative.
3. The desktop opens the newest page, fetches older pages on scroll while
   preserving scroll position, and rehydrates the complete transcript before any
   deliberate full-history rewrite so a partial window cannot delete older
   messages.
4. The uncapped default stays available to non-renderer callers, and window
   lookup uses a disposable per-session layout of message and compaction
   offsets, optionally cached on disk and rebuilt from the JSONL source whenever
   it is invalid. Format, schema, and RPC contracts are unchanged.

## Consequences

- Activation cost is bounded by the window instead of the whole history.
- Older history is available on demand, and display truncation is visible while
  the agent keeps the complete content.
- Full-history edit, delete, revision switch, and abort may read uncapped before
  mutating, which protects older messages.

## Alternatives

- Only virtualize the message list: rejected, the full parse and IPC payload
  still happen first.
- Store only a preview: rejected, it loses user data and changes model context.

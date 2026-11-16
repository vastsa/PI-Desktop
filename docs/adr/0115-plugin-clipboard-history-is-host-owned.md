# ADR 0115: Keep plugin clipboard history host-owned and in memory

- Status: Accepted (amended 2026-08-21)
- Date: 2026-08-21
- Related: Issue #9, ADR 0008, ADR 0059

## Context

Plugins can read and write the current clipboard, but a plugin process has no
Electron clipboard access. Clipboard-history plugins therefore used to poll
`readText()` and maintain a second store, while the host polled the native
clipboard to capture images.

## Decision

The Electron main process maintains one rolling, in-memory history and exposes
it to plugins as `pi.clipboard.getHistory()`. The API reuses `clipboard.read`,
returns newest-first text and image entries, and audits every call with the
entry count.

The host does not poll the system clipboard. It records text written through
`writeText` and records content from the Composer's user-initiated `paste`
event.

- 30 days retention;
- 500 entries and 256 MiB total payload;
- 100 KiB of UTF-8 text or 50 MiB of PNG image bytes per entry.

## Consequences

- Idle applications do not read or encode clipboard contents, and Composer paste
  handling does not perform a second native clipboard read.
- `getHistory()` contains host writes and content pasted into Composer; a copy
  that is never pasted is intentionally not captured.
- The history remains host-owned, in-memory only, and protected by the existing
  `clipboard.read` permission.

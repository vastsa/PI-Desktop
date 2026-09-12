# ADR 0115: Keep plugin clipboard history host-owned and in memory

- Status: Accepted (amended 2026-08-21)
- Date: 2026-08-21
- Related: Issue #9, ADR 0008, ADR 0059

## Context

Plugins can read and write the current clipboard, but a plugin process has no
Electron clipboard access. Clipboard-history plugins therefore used to poll
`readText()` and maintain a second store, while the host polled the native
clipboard to capture images. That work repeatedly read and encoded unchanged
screenshots, consumed resources while idle, and still missed copies between
samples.

Clipboard history is also more sensitive than the current clipboard: it may
retain screenshots, credentials, or private documents. Giving each plugin its
own recorder would duplicate data, make retention inconsistent, and weaken the
permission boundary.

## Decision

The Electron main process maintains one rolling, in-memory history and exposes
it to plugins as `pi.clipboard.getHistory()`. The API reuses `clipboard.read`,
returns newest-first text and image entries, and audits every call with the
entry count. Plugin processes receive only the typed result over the existing
broker; they do not receive Electron objects or a new capability.

The host does not poll the system clipboard. It records text written through
`writeText` and records content from the Composer's user-initiated `paste`
event. The renderer passes the bytes it already received from that event to the
host; the host never reads the OS clipboard again for the same paste. Images
are normalized to PNG during that paste request only.

Consecutive identical content is collapsed with a refreshed timestamp. The
history is cleared on application exit and is bounded to:

- 30 days retention;
- 500 entries and 256 MiB total payload;
- 100 KiB of UTF-8 text or 50 MiB of PNG image bytes per entry.

## Consequences

- Idle applications do not read or encode clipboard contents, and Composer
  paste handling does not perform a second native clipboard read.
- `getHistory()` contains host writes and content pasted into Composer; a copy
  that is never pasted is intentionally not captured. Content copied before the
  app starts is not recoverable.
- The history remains host-owned, in-memory only, and protected by the existing
  `clipboard.read` permission. This limits privacy exposure without changing
  the plugin API.

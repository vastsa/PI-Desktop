# ADR 0115: Keep plugin clipboard history host-owned and in memory

- Status: Accepted (amended 2026-08-21)
- Date: 2026-08-21
- Related: Issue #9, ADR 0008, ADR 0059

## Context

Clipboard-history plugins had no Electron clipboard access, so they polled
`readText()` and kept a second store while the host polled the native clipboard
for images. That repeated work read and encoded unchanged screenshots, burned
idle resources, and still missed copies between samples. History is also more
sensitive than the current clipboard, so per-plugin recorders would duplicate
data and weaken the permission boundary.

## Decision

The Electron main process keeps one rolling in-memory history and exposes it to
plugins as `pi.clipboard.getHistory()`, reusing the `clipboard.read` permission
and returning newest-first text and image entries. The host never polls the
system clipboard: it records text written through `writeText` and content from
the Composer's user-initiated `paste` event, whose bytes the renderer already
holds, normalizing images to PNG during that request only. Consecutive identical
content collapses with a refreshed timestamp, retention, entry count, and total
payload are bounded, and the history is cleared on application exit.

## Consequences

- Idle applications stop reading and encoding clipboard content, and a paste
  costs no second native read.
- `getHistory()` holds host writes and Composer pastes only; content copied
  before startup or never pasted is not recoverable.
- History stays host-owned, in memory, and behind the existing permission.

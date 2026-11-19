# ADR 0080: Prewarm the global plugin launcher after boot

- Status: Accepted
- Date: 2026-08-13
- Related: ADR 0072, D211, D217

## Context

The global plugin launcher was created lazily on the first Option/Alt+Space
invocation, so that press paid for a second `BrowserWindow`, a sandboxed renderer,
the shared renderer bundle, and React mount before anything appeared.

## Decision

Once Electron is ready, and in parallel with backend and plugin boot, Main starts
creating and loading the launcher window hidden. One shared in-flight promise
represents that creation, so a shortcut arriving during warm-up joins it instead of
raising a blank window or a duplicate renderer. A failed warm-up is logged,
destroys the incomplete window, clears the promise, and leaves the shortcut path
able to retry. Invocations still set display bounds, show, and focus the retained
window, and the launcher still refreshes its plugin catalog on every show, with no
IPC, host RPC, permission, protocol, or storage change.

## Consequences

- The first post-boot shortcut no longer pays window and renderer load time.
- One hidden sandboxed renderer stays resident for consistent latency.
- Boot never blocks on warm-up, and failure does not disable later launches.

## Alternatives

- Keep first-use lazy creation: rejected because it keeps the reported first-launch
  delay.
- Reuse the main renderer: rejected because a system-wide utility window must work
  while PI-Desktop is unfocused.

# ADR 0080: Prewarm the global plugin launcher after boot

- **Status:** Accepted
- **Date:** 2026-08-13
- **Related:** D211 · D217 · ADR 0072 · E2E-120

## Context

The global plugin launcher was created lazily on the first Option/Alt+Space
invocation. That path had to allocate a second Electron `BrowserWindow`, start
its sandboxed renderer, load the shared renderer bundle, mount React, and only
then reveal the launcher.

## Decision

As soon as Electron is ready, before backend/plugin boot completes, Electron
starts creating and loading the launcher window in the background while keeping
it hidden. This work runs in parallel with primary startup.

Window creation is represented by one shared in-flight promise. A shortcut
received while warm-up is still loading joins that promise, preventing a blank
window, a lost shown event, or duplicate renderer creation.

## Consequences

- The first post-boot shortcut no longer pays BrowserWindow and renderer load
  latency on its visible path; warm-up starts early enough to overlap backend
  startup.
- One hidden sandboxed renderer remains resident after boot, trading a bounded
  memory cost for consistent launch latency.
- Application boot is not blocked on launcher warm-up, and warm-up failure does
  not prevent a later shortcut from retrying.

## Alternatives considered

- Keep first-use lazy creation: preserves the smallest idle footprint but keeps
  the reported first-launch delay.
- Await warm-up as part of application boot: guarantees readiness before the app
  is marked booted but lengthens the primary window's critical startup path.
- Reuse the main renderer: avoids a second renderer but cannot provide the
  independent system-wide utility window while PI-Desktop is unfocused.

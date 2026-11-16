# ADR 0338: a user-supplied video owns the boot surface, served over a host-owned scheme

- Status: Accepted
- Date: 2026-11-03
- Related: D679, D348, D665, ADR 0248 (theme assets and window background), ADR 0332 (macOS window surface), issue #831 (startup watchdog), [E2E-076](../spec/06-delivery/04-e2e-test-plan.md)

## Context

The window has always shown one boot surface, `StartupSplash`, mounted until the
shell publishes its initial state and bounded by the watchdog hint and recovery
surfaces from issue #831. Letting users put their own launch video there touches
three boundaries at once: the renderer is sandboxed with no `file:` source in its
CSP, the video must be in the very first frame or the splash flashes first, and a
user-produced file can be unplayable or loop forever without ever firing `ended` or
`error`.

## Decision

A video in `<dataDir>/startup/` replaces the brand splash for that launch, plays to
its last frame, holds the window under the same opaque black until the shell is
ready, then fades that black out. `resolveStartupAnimation` reads only that
directory, keeps entries with a known container extension confined by realpath to
it, and picks the most-decodable container with a deterministic tie-break, dropping
dot-prefixed, non-file, empty, and oversized entries while creating nothing. The
bytes travel over the host-owned `pi-startup:` scheme with exactly one URL,
`pi-startup://animation`, which carries no caller-controlled path, host, or query,
is registered with `standard`, `secure`, and `stream` privileges and no CORS,
answers `Range`, and needs only `media-src pi-startup:` added to the CSP. The
descriptor arrives as a window creation argument readable before first paint and
carries the file's name, extension, length, and `skipWhenReady`, never a path, with
the preload re-validating every field. First-frame, whole-animation, watchdog, and
Escape bounds all end through the same clean transition, exactly one of the three
boot surfaces is mounted with the recovery surface ranked first, and the animation
plays once per process for the first window, with no replay from the tray or a
reload and no playback under reduced motion. `AppSettings.startupAnimation` holds
`enabled` and `skipWhenReady`, both read before window creation so a change lands
on the next launch.

## Consequences

- An installation with no `startup/` directory behaves exactly as before, so the
  feature is dormant rather than defaulted off.
- A launch with an animation reaches the shell later by design unless
  `skipWhenReady` is enabled, and the bounds cap that wait.
- The host gains a fourth privileged scheme whose attack surface is smaller than
  the plugin schemes', and the video plays over literal `#000` so letterboxing
  matches under either theme.

## Alternatives

- A dedicated splash `BrowserWindow`: rejected, it adds a second window with its
  own focus, z-order, and Dock behavior and cannot mask the main interface.
- `file://`, `data:`, or a reused `plugin-asset:` URL: rejected, `file:` is outside
  the page CSP and discloses the data directory, `data:` inflates a capped file,
  and `plugin-asset:` serves a caller-selected path.

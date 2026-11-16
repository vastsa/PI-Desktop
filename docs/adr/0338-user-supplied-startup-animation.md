# ADR 0338: a user-supplied video owns the boot surface, served over a host-owned scheme

- Status: Accepted
- Date: 2026-11-03
- Deciders: PI-Desktop maintainers
- Related: D679, D348, D665, ADR 0248 (theme assets and window background),
  ADR 0332 (macOS window surface), issue #831 (startup watchdog),
  `docs/spec/04-ux/09-interaction-patterns.md`,
  `docs/spec/06-delivery/04-e2e-test-plan.md` (E2E-076)

## Context

The window has always shown one boot surface: `StartupSplash`, a brand mark with
a tagline and an indeterminate bar, mounted until the shell publishes its
initial state and then faded out over 280ms after a 420ms minimum dwell. Issue
#831 added the two bounds that keep it from being permanent — a slow hint at 30s
and a recovery surface at 180s.

- **The file.** The renderer is sandboxed, `contextIsolation` is on, and the
  page CSP has no `file:` source.
- **The timing.** The animation has to be in the renderer's *first* frame or the
  user sees the splash flash before it.
- **The failure modes.** A splash is code the product controls; a video is a
  file a user produced.

## Decision

A video in `<dataDir>/startup/` replaces the brand splash for that launch, plays
to its last frame, then holds the window under the same opaque black it played
on until the shell is ready, then fades that black out over one second.

**Discovery is filesystem-only and creates nothing.** `resolveStartupAnimation`
reads `<dataDir>/startup/`, keeps entries whose extension is in
`STARTUP_ANIMATION_EXTENSIONS`, confines each by realpath to that directory, and
picks deterministically: most-decodable container first (`webm`, then `mp4`,
`m4v`, `mov`), ties broken by file name. Dot-prefixed entries, non-files, empty
files, and files over `STARTUP_ANIMATION_MAX_BYTES` (64 MB) drop out.

## Consequences

- An installation with no `startup/` directory behaves exactly as before: same
  splash, same dwell, same fade, same watchdog bounds.
- A launch with an animation is slower to reach the shell by design: the video
  plays to its last frame unless the user turns on `skipWhenReady`.
- The host now owns a fourth privileged scheme.
- `--motion-startup-reveal: 1000ms` is the one duration outside the motion ramp
  (150/200/300ms).
- The surface is literal `#000`, not `--ds-bg-primary`, so a video's own
  letterboxing and fades meet the same colour under either theme.

## Alternatives rejected

- **A dedicated splash `BrowserWindow`.** It would let the video appear before
  the main renderer boots at all, but it adds a second window with its own
  focus, z-order, Dock, and vibrancy behaviour; it conflicts with the main
  window's `ready-to-show` gate; and it cannot express what was asked for — a
  mask *over the main interface* that fades away — without cross-window
  choreography.
- **`file://` or a `data:`/`blob:` URL.** `file:` is not in the page CSP and
  would disclose the data directory; a `data:` URL means base64 (a third larger)
  for a file capped at 64 MB, read into memory before the first frame.
- **Reusing `plugin-asset:`.** That scheme takes a plugin id and an asset path
  from the URL, so it exists to serve a caller-selected file.
- **Letting a plugin contribute the startup animation.** This hands an untrusted
  source the full-window first paint before any UI exists.

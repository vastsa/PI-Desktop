# ADR 0338: a user-supplied video owns the boot surface, served over a host-owned scheme

- Status: Accepted
- Date: 2026-11-03
- Deciders: PI-Desktop maintainers
- Related: D679, D348, D665, ADR 0248 (theme assets and window background),
  ADR 0332 (macOS window surface), issue #831 (startup watchdog),
  `docs/spec/04-ux/09-interaction-patterns.md`,
  `docs/spec/06-delivery/04-e2e-test-plan.md` (E2E-076)

## Context

The window has always shown one boot surface: `StartupSplash`, a brand mark
with a tagline and an indeterminate bar, mounted until the shell publishes its
initial state and then faded out over 280ms after a 420ms minimum dwell. Issue
#831 added the two bounds that keep it from being permanent — a slow hint at
30s and a recovery surface at 180s.

Users asked to put their own launch video there. That request touches three
boundaries at once, and each has a wrong answer that looks easy:

- **The file.** The renderer is sandboxed, `contextIsolation` is on, and the
  page CSP has no `file:` source. A video cannot be referenced by path, and
  should not be: a path in the page discloses the user's data directory to
  anything that later runs in that renderer, including plugin renderer
  extensions.
- **The timing.** The animation has to be in the renderer's *first* frame or
  the user sees the splash flash before it. Anything fetched over IPC lands
  after that frame.
- **The failure modes.** A splash is code the product controls; a video is a
  file a user produced. It can be unplayable, truncated, 2 GB, or an infinite
  loop, and `<video>` reports none of those uniformly — a bad export fires
  neither `ended` nor `error`. A boot surface that waits for an event that
  never comes is a launch that never finishes.

## Decision

A video in `<dataDir>/startup/` replaces the brand splash for that launch,
plays to its last frame, then holds the window under the same opaque black it
played on until the shell is ready, then fades that black out over one second.

**Discovery is filesystem-only and creates nothing.** `resolveStartupAnimation`
reads `<dataDir>/startup/`, keeps entries whose extension is in
`STARTUP_ANIMATION_EXTENSIONS`, confines each by realpath to that directory,
and picks deterministically: most-decodable container first (`webm`, then
`mp4`, `m4v`, `mov`), ties broken by file name. Dot-prefixed entries, non-files,
empty files, and files over `STARTUP_ANIMATION_MAX_BYTES` (64 MB) drop out. No
directory is created on this path, so an installation that never uses the
feature is unchanged on disk and keeps the brand splash.

**The bytes travel over `pi-startup:`, a host-owned scheme with exactly one
URL.** `pi-startup://animation` carries no path, host, or query the caller
controls; the handler streams the single file the main process resolved at boot
and answers `Range` so media playback is not buffered whole. Because the URL
selects nothing, there is no traversal surface to confine — the realpath check
at discovery is the only place a file is chosen. The scheme is reserved in
`registerPluginSchemes`, the one `registerSchemesAsPrivileged` call, with
`standard`, `secure`, and `stream` and no CORS privileges: a `<video>` `src` is
a no-cors fetch and nothing else may read these bytes. `media-src pi-startup:`
is the only CSP change.

**The descriptor reaches the renderer as a window creation argument**, the same
mechanism the display locale already uses, so `window.piDesktop.startupAnimation`
is readable synchronously before the first paint. The descriptor carries the
file's name, extension, byte length, and the `skipWhenReady` preference — never
a path. The preload re-validates every field, because the argument vector is
process input.

**Three bounds make the surface recoverable**, and each is below the next:
first frame (2s), whole animation (15s), and the watchdog's stalled bound
(180s), which the animation plus its reveal must finish well inside. `Escape`
is a fourth, user-driven bound. Every one of them ends the animation through
the same transition a clean finish uses, so there is no failure-specific
rendering path.

**Three boot surfaces exist and exactly one is mounted**, ranked: the recovery
surface outranks both (a stalled launch must never sit behind an opaque mask),
and the animation outranks the brand splash it was dropped in to replace. The
mask stops taking input the moment the fade starts, so the shell and its window
controls are operable for the whole second rather than after it.

**The animation plays once per launch, for the first window of the process.**
Main claims it before `new BrowserWindow`, so reopening from the tray or the
Dock replays nothing; the renderer marks `sessionStorage`, so a manual reload
does not replay a cinematic over a window someone is working in. Reduced motion
drops the animation entirely rather than shortening it — a boot video is motion
the user cannot opt out of once it starts. The capture rig is skipped outright,
since every scene it records is a frame comparison.

`AppSettings.startupAnimation` holds the only two choices discovery cannot make:
`enabled` (absent means on, so dropping a file in is sufficient) and
`skipWhenReady` (absent means play it out). Both are read before the window is
created, so like ADR 0332's translucency switch a change lands on the next
launch.

## Consequences

- An installation with no `startup/` directory behaves exactly as before: same
  splash, same dwell, same fade, same watchdog bounds. The feature is dormant
  rather than defaulted off, which is what makes dropping a file in work with
  no further configuration.
- A launch with an animation is slower to reach the shell by design: the video
  plays to its last frame unless the user turns on `skipWhenReady`. This is the
  trade the feature asks for, and the bounds cap it at 15s.
- The host now owns a fourth privileged scheme. Its attack surface is smaller
  than the plugin schemes': no caller-supplied path, no CORS, and one file per
  process chosen by main.
- `--motion-startup-reveal: 1000ms` is the one duration outside the motion ramp
  (150/200/300ms). It is used only by `.startup-animation` and is documented as
  an exception rather than a new scale.
- The surface is literal `#000`, not `--ds-bg-primary`, so a video's own
  letterboxing and fades meet the same colour under either theme. It is opaque,
  so unlike the glass splash it needs no macOS rule hiding the shell beneath it.
- Settings gains a status line that names the resolved file and an action that
  opens (and creates) the folder. Without it, a feature configured by dropping
  a file into a hidden directory would be undiscoverable.

## Alternatives rejected

- **A dedicated splash `BrowserWindow`.** It would let the video appear before
  the main renderer boots at all, but it adds a second window with its own
  focus, z-order, Dock, and vibrancy behaviour; it conflicts with the main
  window's `ready-to-show` gate; and it cannot express what was asked for — a
  mask *over the main interface* that fades away — without cross-window
  choreography. One surface inside the existing shell keeps the watchdog and
  recovery contracts intact.
- **`file://` or a `data:`/`blob:` URL.** `file:` is not in the page CSP and
  would disclose the data directory; a `data:` URL means base64 (a third larger)
  for a file capped at 64 MB, read into memory before the first frame.
- **Reusing `plugin-asset:`.** That scheme takes a plugin id and an asset path
  from the URL, so it exists to serve a caller-selected file. Reusing it would
  widen a confined resolver for an unrelated owner; a pathless scheme has no
  such surface.
- **Letting a plugin contribute the startup animation.** This hands an
  untrusted source the full-window first paint before any UI exists. It is a
  different security level from a file the user placed in their own data
  directory and needs its own ADR, not an extension of this one.
- **Unmuted audio.** Chromium blocks unmuted autoplay without a user gesture;
  allowing it needs a process-wide `autoplayPolicy` that also affects plugin
  webviews. A launch jingle on every start is also poor default behaviour. The
  element is `muted` and the setting does not exist.
- **`object-fit: contain`.** Letterboxing is safer for a centred logo, but a
  filled frame is what reads as a launch sequence, and a user's export almost
  never matches the window aspect. `cover` is fixed, and the settings copy says
  to keep the subject centred.
- **Cutting the video short as soon as the shell is ready, by default.** This
  makes the animation feel truncated on a fast machine, which is the common
  case. It is offered as `skipWhenReady` for users who want the file to be a
  ceiling rather than a duration.
- **Shortening the animation under reduced motion.** A shorter cinematic is
  still a cinematic. The OS-level request is an opt-out, so the animation is
  not played.

## Evidence

- `packages/shared/src/startup-animation.test.ts` — the chooser, the container
  and MIME tables, the range parser, and the creation-argument codec including
  every malformed-descriptor rejection.
- `apps/desktop/test/startup-animation.test.mjs` — bound ordering against the
  watchdog, the phase machine (including monotonicity), the play/skip decision,
  discovery against temporary data directories (missing folder, empty folder,
  symlink escape, directory named like a video, the setting off), the surface
  and stylesheet contracts, and the boot-surface ranking.
- `pnpm test:e2e:startup-animation` (`scripts/e2e-startup-animation.mjs`) — the
  two properties no source assertion can reach: a real launch decodes a
  generated VP9 clip over `pi-startup:` under the page CSP (`readyState` 4,
  advancing `currentTime`) and then reveals an interactive shell, and an
  unplayable file of the same name yields the shell in about a second instead
  of holding the window.
- `apps/desktop/test/startup-watchdog.test.mjs` — the recovery surface still
  outranks both boot surfaces.
- `apps/desktop/test/plugin-renderer-protocol.test.mjs`,
  `apps/desktop/test/gen-ui-protocol.test.mjs` — the scheme is reserved in the
  single privileged registration.

# ADR 0090: User-Configurable Close Behavior with Close-to-Tray

- Status: Accepted for implementation
- Date: 2026-08-12
- Related: ADR 0021, ADR 0025, ADR 0078, ADR 0123, D230, D256

## Context

On Windows and Linux, closing the main window runs `app.quit()` through
`window-all-closed`, so the app exits and its taskbar entry disappears, while
minimize already hides the window into the tray D216 (ADR 0078) keeps resident.
Users with long-running chats expect close to keep the app available, and other
users expect close to quit; macOS is out of scope because its Dock lifecycle
already matches.

## Decision

The close behavior becomes a persisted user preference with three values: `ask`,
the transient unset state that prompts once, `tray`, which hides the window under
the resident tray icon and keeps the app running, and `quit`, the legacy exit. The
first close shows a themed in-app dialog (Cancel / Close to tray / Quit), a
non-cancel choice is remembered permanently, `closeBehavior/set` rejects `ask`, and
an unavailable renderer falls back to a bounded native dialog or allows Quit
rather than trapping the close.

Electron main stores the preference in `<data>/close-behavior.json` on the
`window-state.json` ownership pattern rather than in host-core settings, and
exposes it through the additive channels
`pi-desktop/window/closeBehavior/get`, returning `{ behavior, supported }`, and
`pi-desktop/window/closeBehavior/set`, which accepts only `tray` and `quit` and
fails with `INVALID_ARGUMENT` otherwise, including on macOS where `supported` is
`false` and the Settings row is hidden. Settings (General) renders a two-option
radio segment for Windows and Linux only, and the tray icon is never reconciled
with the preference because minimize-to-tray needs it either way.

The close handler intercepts every non-macOS close that is not an approved quit,
`before-quit` and macOS closes fall through, `quit` calls `app.quit()` itself, and
`window-all-closed` stays silent only under `tray`; a `tray` close without a tray
icon falls back to a real quit. Dialogs render in the main renderer, correlated by
request id after the readiness handshake, with a native fallback after ten
seconds, and the bounds watchdog skips minimized and hidden windows.

## Consequences

- Windows and Linux close either hides to tray or quits per a remembered choice
  that Settings can change, using the existing `@pi-desktop/i18n` catalogs.
- No host RPC, storage schema, or macOS close behavior changes.
- During Windows shutdown a close can be intercepted, but the OS still terminates
  the session without data loss.

## Alternatives considered

- Store the preference in host-core `AppSettings`: rejected; it would add a Rust
  schema field and RPC surface for pure shell lifecycle state.
- Always close to tray without a choice: rejected; it changes the meaning of the
  close button for users who expect exit.

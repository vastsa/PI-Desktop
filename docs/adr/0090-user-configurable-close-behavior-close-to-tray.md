# ADR 0090: User-Configurable Close Behavior with Close-to-Tray

- Status: Accepted for implementation
- Date: 2026-08-12
- Deciders: PI-Desktop core
- Related: D230, D256, ADR 0021, ADR 0025, ADR 0078, ADR 0123

## Context

On Windows/Linux, closing the main window calls `app.quit()`
(`window-all-closed`), so the app exits and its taskbar entry disappears.
Minimizing already hides the window into the tray that D216 (ADR 0078) keeps
resident on every platform, but users with long-running chats expect closing
the window to keep the app available too. Different users want different
defaults, and a fixed close-to-tray behavior would surprise users who expect
close to quit.

The app has no close interception and no user-facing choice for
this lifecycle decision. macOS is out of scope: the native Dock lifecycle
(close keeps the app in the Dock, `activate` recreates the window) already
matches the desired behavior.

## Decision

1. Windows/Linux close behavior becomes a persisted, user-configurable
   preference with three values, of which two are ever settable:
   - `ask`: the transient unset state — the first close prompts once. After
     a choice is made it is remembered permanently and cannot be reverted
     to prompting (`closeBehavior/set` rejects `ask`).
   - `tray`: closing the window hides it under the resident D216 system-tray
     icon and keeps the app running; the tray menu restores the window or
     quits the app.
   - `quit`: legacy behavior — closing the window exits the app.
2. The first close with an unset preference shows a native modal dialog
   (main process) with Cancel / Close to tray / Quit. Picking a non-cancel
   option persists it forever; Cancel keeps the window open and leaves the
   preference unset (so the next close prompts again).
3. The preference is stored by Electron main in
   `<data>/close-behavior.json` (same ownership pattern as
   `window-state.json`), NOT in host-core settings: it is app-shell
   lifecycle state, read and written only by the main process, and needs no
   host RPC or schema change.
4. Two additive IPC channels expose it to the renderer:
   `pi-desktop/window/closeBehavior/get` (returns `{ behavior, supported }`)
   and `pi-desktop/window/closeBehavior/set`, which accepts only `tray` and
   `quit` (`ask` and unknown values fail with `INVALID_ARGUMENT`).
   `supported` is `false` on macOS, where the Settings row is hidden and
   `set` itself fails with `INVALID_ARGUMENT` — the renderer is not the only
   caller, so the guard lives in main.
5. Settings (General tab) renders a two-option radio segment — Close to
   tray / Quit app — for Windows/Linux only; an unset preference shows no
   selection. Changing it applies immediately. The tray icon is not
   reconciled: D216 owns it and it stays resident under either choice,
   because minimize-to-tray needs it whatever close does.
6. The close handler intercepts every non-macOS `close` that is not already
   an approved quit; `before-quit` (`quitting`) and macOS closes always
   fall through, so an explicit quit, the tray Quit item, and the automated
   boot probe are unaffected. Under `quit` the handler calls `app.quit()`
   itself rather than leaning on `window-all-closed`, and
   `window-all-closed` keys off the preference — it stays silent only under
   `tray`, keeping the app alive when the window is tray-hidden or
   destroyed unexpectedly, and quits otherwise even though the D216 tray is
   present. A `tray` close whose tray icon does not exist falls back to a
   real quit rather than hiding the window with no way back.
7. The bounds watchdog (`ensureStableBounds`) skips minimized and hidden
   windows, so minimize always stays minimized and a tray-hidden window is
   never force-restored by the Stage-Manager shelf recovery.
8. Known limitation: on Windows system shutdown/logoff, the OS may deliver
   a `close` that is intercepted while the preference is `ask` or `tray`.
   Windows force-terminates the session after its shutdown timeout, so no
   data is lost, but shutdown is not accelerated by the app.

## Alternatives considered

- **Store the preference in host-core settings (`AppSettings`):** rejected
  because it would add a Rust schema field and host RPC surface for pure
  shell lifecycle state that only Electron main consumes.
- **Renderer-drawn first-close dialog:** rejected because the window is
  closing; a native modal keeps the decision in the process that owns the
  close lifecycle and works before the renderer has mounted.
- **Always close-to-tray without a choice:** rejected — it changes the
  meaning of the close button for users who expect exit.
- **Tray icon reconciled with the preference:** rejected; D216 keeps one
  tray icon resident on every platform for minimize-to-tray, so destroying
  it when close behavior is `quit` would break an unrelated feature. Close
  behavior decides what a close does, not whether the tray exists.

## Consequences

- Windows/Linux explicit minimize uses the normal taskbar transition; a close
  choice of `tray` still hides the window under the resident D216 tray icon.
  macOS native minimize remains tray-resident under D216.
- Close on Windows/Linux either hides to tray or quits, per user choice,
  remembered across launches and changeable in Settings.
- The tray menu and the first-close dialog reuse the existing
  `@pi-desktop/i18n` catalogs (English and Simplified Chinese).
- No host protocol, storage schema, or macOS behavior changes.

# 05. Onboarding

## 1. Decision

First-run help is a short, skippable **startup guide** modal (§3). The former
inline chat-home checklist is removed so users are not guided twice
(issue #2431). The host-side onboarding state (`app.getOnboarding`) is still
read but no longer rendered.

## 2. Non-goals

- account signup
- cloud sync setup
- long product tour overlays

## 3. Startup guide

A modal shown when the shell first becomes interactive (after the boot
splash). Implementation: `features/startup/` (`app-overlay-model.ts` holds the
rules, `AppOverlayHost.tsx` owns presentation).

- **Audience**: users with a usable chat model (an enabled, credentialed
  provider with at least one non-image model) are *returning* users; everyone
  else is *new*, even with other configuration or data. Decided once per
  launch; configuring a model during the guide does not switch the audience.
  - *New*: **Model** → **Plugin launcher**.
  - *Returning*: **Plugin launcher** only.
- **Model step** embeds the same Models destination as Settings
  (`SettingsDestinationContent tab="agent"`). It is optional: *Set up later* /
  *Skip* move on without a model; the footer shows whether one is ready.
- **Plugin launcher step** is two columns. Left: the resolved
  `openPluginLauncher` binding as keycaps (user overrides respected), a status
  line, *Open plugin launcher* and *Change shortcut* (ends the guide and opens
  Settings → Shortcuts). Right: a static thumbnail of the launcher panel.
  Keycaps start dimmed and turn active once the user opens the launcher — Main
  forwards `pluginLauncher/event/shown` to the main window, and a matching
  keydown that reaches the window counts too. The step can be skipped.
- **Automatic guide shows once**: Skip, close, `Escape` or Finish marks
  `STARTUP_GUIDE_VERSION` done in renderer `localStorage`
  `pi.desktop.startupGuide` `{ completedVersion }`. Bumping the version shows
  it again. A blocked store degrades to showing the guide.
- **Replay**: Settings → About → *Startup guide* opens the guide for the
  user's current state. A replay never writes the completion marker. While it
  is up, Settings waits underneath and returns when the guide ends.
- Not shown in screenshot capture (`window.__PI_CAPTURE__`) or after
  automation calls `window.__PI_DESKTOP__.skipStartupOverlays()` (the shared
  E2E renderer client does this on connect); suppression records nothing as
  seen and also keeps the announcement off.

## 4. Release announcement

A reserved, normally-off modal for a plain-language note about an important
release change. Content is Markdown (text + images) bundled with the release
under `features/startup/announcements/` (see its README); there is no server
component.

- Off while `RELEASE_ANNOUNCEMENT` is `null` (the default) or its English
  content is missing. Its id is the release version.
- Shown at most once per release: it is recorded as seen as soon as it is on
  screen and never repeats for that id. State: `localStorage`
  `pi.desktop.announcement` `{ shownIds }` (bounded).
- Locale fallback: exact locale → base language → English.
- Images must be bundled assets under the announcement's `assets/` folder;
  any other image reference is dropped. Links open in the system browser
  (`https://` only). Raw HTML is not rendered.

## 5. Modal priority

The startup guide, the release announcement and the Settings dialog share one
host and only one is mounted: **guide > announcement > settings**. At launch the
guide is decided first; when it ends, an enabled and not-yet-shown
announcement follows. A Settings request made while either is open is kept
and opens afterwards. The model configuration inside the guide is part of the
guide, not a Settings request.

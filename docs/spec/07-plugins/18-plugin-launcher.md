# 18. Plugin Launcher

> Status: Implemented for issue #2085 (rewrite of the global plugin launcher).
> Scope: the launcher surface, plugin trigger contributions, local-application
> discovery, and the IPC/security boundary around both.
> Related: [09-plugin-command-palette.md](09-plugin-command-palette.md),
> [02-plugin-manifest-schema.md](02-plugin-manifest-schema.md) §4,
> ADR [0034](../../adr/0034-merge-command-palette-into-global-search.md),
> ADR [0072](../../adr/0072-global-plugin-launcher.md),
> ADR [0080](../../adr/0080-prewarm-global-plugin-launcher.md),
> ADR [0090](../../adr/0090-user-configurable-close-behavior-close-to-tray.md),
> ADR [0339](../../adr/0339-plugin-launcher-local-apps.md).

## 1. Purpose and non-goals

The launcher is the app-wide "open something now" panel: one frameless,
always-on-top window that lists the panel plugins the user can open, the
applications installed on this machine, and the items they used or pinned last.
It is a *launcher*, not a search product.

In scope: opening a plugin panel, handing that panel the text the user typed,
and starting an installed application.

Out of scope: sessions, files, settings, commands. Those stay in the global
search dialog (`Cmd/Ctrl+K`) and in the command surface of
[09-plugin-command-palette.md](09-plugin-command-palette.md). §13 records the
split; the launcher never reads session or workspace data.

## 2. Entry point and window

- The accelerator is `Alt+Space` on Windows/Linux and `⌥+Space` on macOS. It is
  a configurable app keybinding (`openPluginLauncher`), so the user can rebind
  or disable it like any other shortcut.
- The window is created and prewarmed by the main process in
  `apps/desktop/electron/main/bootstrap/launcher.ts`: frameless, transparent,
  `alwaysOnTop`, unminimizable/unmaximizable, skipped from the taskbar, and (on
  macOS) joined to every Space above this app's own fullscreen window.
- It loads the ordinary renderer bundle with `?surface=plugin-launcher`; the
  renderer picks that surface in `apps/desktop/src/main.tsx` and mounts only
  `PluginLauncher` (`apps/desktop/src/components/PluginLauncher.tsx`).
- Focus loss hides the panel. It is hidden, never destroyed, so reopening is
  immediate and a dragged size survives.

The window prewarm and macOS activation rules are unchanged from ADR 0080 and
ADR 0086.

## 3. Layout

The panel renders one search field at the top, a results region, and a footer of
keyboard hints. The search field carries the shortcut hint (`⌥ Space` /
`Alt + Space`).

Grid geometry (`apps/desktop/src/lib/launcher-search.ts`):

| Region | Rows | Tiles | Header action |
|---|---|---|---|
| `Recently used` (empty input) | 2 | 16 | `Show all {count} →` — `count` is the true number of remembered items |
| `Pinned` (empty input) | 1 | 8 | `All →` — expands both sections to their full lists |
| Matches (non-empty input) | 3 | 24 | `{count} more — keep typing to narrow it down` |

Every row is eight columns; the column count does not change with the number of
results, so the grid does not reflow as the user types or resizes.

`Show all {count} →` / `All →` set an expanded view whose action becomes
`Collapse`. While the input is non-empty the panel shows the hit view only: the
total number of matches is reported in the header action so a query that had to
drop tiles still says so, instead of silently truncating.

Empty states: `Loading plugins…` while the catalog is loading, `Looking for
installed applications…` while the background application scan is still
running, `No plugins with panels are ready to open.` when nothing is
launchable, and `No matching plugins` for a query with no hit.

## 4. Tiles

Every tile shows an icon, a name, and one detail line:

- the reason it matched — `name {value}`, `pinyin {value}`,
  `initials {value}`, `alias {value}`, `about {value}`, `pinned`, `recent`, or
  `receives {value}` for a declared trigger (the text the plugin will receive);
- a source tag: `Plugin` or `App`.

Plugins render a square tile and applications a circular one, each with its
monogram or icon. A plugin and an application that share a name are therefore
both listed and visually distinguishable rather than deduplicated.

Each tile has a per-item menu button whose accessible label is
`More actions for {name}` (§8).

## 5. Matching and ranking

Implemented in `apps/desktop/src/lib/launcher-search.ts` as pure functions over
the host catalog plus the local store.

Score order, best first:

1. whole-input declared trigger match (§6)
2. exact name
3. exact alias
4. name prefix (an alias prefix shares this rank)
5. pinyin prefix
6. initials prefix
7. name substring
8. pinyin / initials substring
9. alias substring
10. description substring

Ties break on recency (most recently opened first), then plugins before
applications, then name, then catalog order, so a given catalog and store always
produce the same order.

Text is normalized (case, full-width forms, separators) before comparison, and
pinyin plus pinyin initials come from `pinyin-pro`
(`apps/desktop/src/lib/launcher-text.ts`). `wx`, `weixin` and `微信` therefore
reach the same application, and `pi` finds a plugin named `PI-Desktop` by name
as well as by pinyin and initials.

## 6. Declared triggers

A plugin claims launcher input with `contributes.launcherTriggers` (manifest
contract: [02-plugin-manifest-schema.md](02-plugin-manifest-schema.md) §4).

Rules enforced on the declaration:

- the pattern is matched against the **whole trimmed input**, never `includes`;
  the match must cover the entire string (`match[0] === input`);
- input longer than `LAUNCHER_TRIGGER_INPUT_MAX_LENGTH` (256) is never matched,
  so pasted text costs one length check instead of a regex run;
- a pattern longer than 200 characters is never compiled;
- a pattern that does not compile is inert — it matches nothing and does not
  break the panel.

A trigger hit ranks above every name match and shows the text the plugin will
receive as its detail line (`receives {value}`). This is what lets a plugin
declare an arithmetic or command-like shape (`1+1`) without competing with every
name that merely contains `1`.

## 7. Payload delivery

Only the tile the user chose receives the input, exactly once:

```text
tile click / Enter
  → pluginOpenPanel({ pluginId, triggerId, payload })   (main)
  → panel page finishes loading
  → webContents.send("pi-plugin-panel-event:launcher:payload", { triggerId, payload })
  → window.pluginBridge.consumeLauncherPayload()        (page, once)
```

- `pi-desktop/pluginOpenPanel` accepts either the bare plugin id (every existing
  caller) or `{ pluginId, triggerId, payload }`; the object form only carries a
  payload when a trigger produced it, so a plugin can tell "the user summoned me
  with this text" from "the user just opened my panel".
- The event is sent after `loadURL` settles and before the window is shown, so
  it cannot race the document. A panel that was already open receives it too
  when the launcher re-targets it.
- `consumeLauncherPayload()` clears the stashed value; a second call returns
  `null`. A payload is never delivered to a second plugin and never replayed.
- Payloads longer than `LAUNCHER_PAYLOAD_MAX_LENGTH` (512) are dropped: the panel
  opens with no payload instead of failing the open.

## 8. Pins, aliases, and recents

Per-item preferences live in the renderer's `localStorage` under
`pi.desktop.launcher.state` (`apps/desktop/src/lib/launcher-store.ts`). The first
read migrates the previous panel's `pi.desktop.pluginLaunchHistory` key so an
upgrade keeps the existing recency order.

| Item | Limit |
|---|---|
| Recents | one entry per item, capped at 60 |
| Pins | 24 |
| Aliases | 6 per item, 32 characters each |

Every read is defensive: an unreadable record is dropped, and stored ids are
pruned against the live catalog, so a plugin that was disabled or uninstalled
disappears from recents, pins, and matches. Hiding a plugin from the launcher is
a launcher-scope preference only — the plugin keeps loading and its commands keep
working.

The store is per renderer origin, which the launcher window and the main window
share, so pins and aliases written in one window are visible in the other
through the ordinary `storage` event.

## 9. Local applications

`apps/desktop/electron/main/local-apps.ts` discovers installed applications:

- Windows: `.lnk` shortcuts under the Start Menu program directories, resolved
  recursively (with a bounded walk).
- macOS: bundles under `/Applications`, `/System/Applications`, and their
  `Utilities` subdirectory.
- Linux: freedesktop `.desktop` entries under `/usr/share/applications`,
  `/usr/local/share/applications`, and `~/.local/share/applications`.

Bounds: the scan result is cached for 5 minutes, holds at most 600 entries,
extracts icons for the first 200 entries only (each data URL capped at 4 KiB),
and drops an entry whose target no longer exists.

The renderer receives a display name, an executable name, a source tag
(`start-menu` / `app-bundle` / `desktop-entry`), a small icon, and an opaque
`app:<slug>` id — never a path. Opening a tile sends that id;
`pi-desktop/pluginLauncher/openApp` resolves it against the host's own scan and
re-checks that the target still exists before launching, so the surface cannot be
turned into "start any program I name".
ADR [0339](../../adr/0339-plugin-launcher-local-apps.md) records this decision.

## 10. Window size, position, and state

- The window is resizable between 560×380 and 1280×940 DIP. The minimum width is
  the smallest width at which eight columns still fit without squeezing; the
  maximum keeps eight tiles scannable.
- Size and position persist in `<data dir>/plugin-launcher-state.json`, written
  best-effort and debounced by the main process
  (`apps/desktop/electron/main/plugin-launcher-state.ts`).
- A remembered position is applied only when the whole panel still fits inside
  the work area it is opening on; otherwise the panel re-centres there.
- This is main-process shell state, following ADR
  [0090](../../adr/0090-user-configurable-close-behavior-close-to-tray.md) and
  `window-state.json`: no host-core schema, no migration, no user data.

## 11. Keyboard

| Key | Action |
|---|---|
| `↑` / `↓` | move one grid row |
| `←` / `→` | move one tile |
| `Enter` | open the active tile |
| `Esc` | close the panel |

While an IME composition is active (`event.isComposing` or `keyCode === 229`) no
key is acted on, so a Chinese IME's candidate Enter or arrow keys never open or
move a tile.

## 12. IPC and security boundary

| Channel | Direction | Notes |
|---|---|---|
| `pi-desktop/pluginLauncher/catalog` | renderer → main | plugins + applications + `appsScanning` |
| `pi-desktop/pluginLauncher/openApp` | renderer → main | opaque `app:<slug>` id only |
| `pi-desktop/pluginLauncher/dismiss` | renderer → main | hide the panel |
| `pi-desktop/pluginLauncher/toggle` | main → renderer | show/hide request |
| `pi-desktop/pluginLauncher/event/shown` | main → renderer | reset the panel for a fresh open |
| `pi-plugin-panel-event:launcher:payload` | main → panel page | §7 |

The catalog and `openApp` handlers verify that the sender is the launcher
window's own `webContents`; any other sender is rejected with
`PERMISSION_DENIED`. Both are main-only capabilities:

- no plugin bridge exposes these channels, and no application-launch API exists
  in the plugin runtime;
- the launcher window itself runs with `contextIsolation`, `sandbox`, and no
  Node integration, like every other renderer surface.

The catalog contains only plugins that are enabled, `ready`, declare
`ui.panel`, and hold the `ui.panel` permission, so a disabled plugin cannot be
opened from here even if its id survives in local history.

## 13. Relationship to global search

The command palette was merged into global search (ADR 0034); that decision
stands and is unchanged by this surface. The launcher is a separate window with
a separate purpose:

| Surface | Shortcut | Content |
|---|---|---|
| Global search | `Cmd/Ctrl+K` | sessions, files, settings, commands |
| Plugin launcher | `Alt+Space` / `⌥+Space` | panel plugins, installed applications, recents/pins |

The command palette spec
([09-plugin-command-palette.md](09-plugin-command-palette.md)) keeps describing
the command list inside global search; this document describes the launcher.

## 14. Implementation map

| Concern | Evidence |
|---|---|
| Window, accelerator, bounds persistence, prewarm | `apps/desktop/electron/main/bootstrap/launcher.ts` |
| Bounds parsing/clamping (pure) | `apps/desktop/electron/main/plugin-launcher-state.ts`, `apps/desktop/test/plugin-launcher-state.test.mjs` |
| Catalog + `openApp` IPC, sender check, trigger sanitizing | `apps/desktop/electron/main/ipc/plugin-launcher-ipc.ts` |
| Application discovery and launch | `apps/desktop/electron/main/local-apps.ts`, `local-apps-platform.ts`, `local-app-parse.ts`, `apps/desktop/test/local-apps.test.mjs` |
| Matching, ranking, sections | `apps/desktop/src/lib/launcher-search.ts`, `apps/desktop/test/launcher-search.test.mjs` |
| Pins, aliases, recents, migration | `apps/desktop/src/lib/launcher-store.ts`, `apps/desktop/test/launcher-store.test.mjs` |
| Surface rendering and keyboard | `apps/desktop/src/components/PluginLauncher.tsx`, `apps/desktop/src/components/launcher/` |
| Payload transport | `apps/desktop/electron/main/plugin-panel-host.ts`, `apps/desktop/electron/preload/plugin-panel.ts` |
| Trigger validation (host) | `crates/host-core/src/plugins/validation/launcher_triggers.rs` |
| Shared contract | `packages/shared/src/types/launcher.ts` |

## 15. Acceptance

1. Opening the launcher with an empty input shows `Recently used` (two rows) and
   `Pinned` (one row) with eight tiles per row, and the recents header reports
   the real number of remembered items.
2. A plugin that declares a trigger receives the typed input as the first tile,
   and its panel shows the same text.
3. `wx`, `weixin`, and `微信` all reach the same application.
4. A plugin and an application with the same name both appear as separate tiles.
5. `pi` finds PI-Desktop by name, and the same item through pinyin and
   initials.
6. Dragging the window to resize keeps eight columns per row, and the new size
   survives an application restart.
7. A query with more than 24 matches does not grow the window; the header
   reports the dropped count and asks the user to keep typing.
8. Disabling or uninstalling a plugin removes it from recents, pins, and
   matches without leaving a broken tile.
9. A 500-character pasted input neither hangs the panel nor matches a trigger.
10. A pinned application is still pinned after a restart.

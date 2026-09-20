# Host-rendered Scenic Settings Design

## Status

Approved for implementation on 2026-09-17.

## Problem

Plugin-provided HTML Settings pages cannot meet the scenic compositing requirement. An Electron `WebContentsView` is an opaque native child surface; a sandboxed iframe is a separate Chromium document surface. Both introduce a solid rectangle between the host-owned scenic backdrop and the Settings controls.

## Decision

Replace generic plugin Settings HTML destinations with a host-rendered declarative `scenicThemes` destination. The host renders all DOM, styling, layout, focus behavior, selection state, slider, and Apply action in the normal React Settings tree. A plugin contributes only validated metadata and declared theme assets.

The first implementation supports the Nexus Scenic Themes pack. It is a deliberately narrow contract, not a general plugin Settings UI language.

## Manifest contract

`contributes.scenicThemes` is an optional object requiring a stable id, localized label, description, keywords, a host-supported icon token, and one to twelve theme cards in presentation order. Every card carries a plugin-owned declared theme id, localized name and description, and one preview asset declared by that theme.

The host verifies `ui.settings`, `ui.theme`, card ids, localization values, asset containment, ownership, and the declared typed `--nexus-backdrop-blur` length variable with whole-number `0..20` bounds. Other variables and plugin settings are not editable by this destination.

Generic `settingsDestinations` HTML entries are retired from the appearance extension capability. The plugin's `settings/` directory is removed; there is no iframe, custom page protocol, bridge, or second document canvas.

## Host surface and visual ownership

The host places the scenic destination under Extensions and renders it directly inside `.settings-content-inner`. The host canvas, content wrapper, and scenic destination wrapper are transparent under a scenic plugin theme so the one root backdrop remains visible throughout Settings.

- Preview cards use declared local `plugin-asset://` images, readable overlays, selected outline/checkmark, and host-owned focus behavior.
- Only individual cards and the blur control own material surfaces; the destination has no outer panel or full-page background.
- The host owns responsive grid layout, narrow-window reflow, native titlebar/control protection, drag regions, and reduced-transparency fallbacks.

## Behavior and data flow

1. Main validates scenic metadata from each loaded plugin.
2. The host renders cards and resolves the selected theme's persisted blur value.
3. Selecting a card immediately invokes the restricted plugin-owned theme selection API.
4. The range input accepts integer values from 0 to 20 and changes only local draft state plus its `npx` output.
5. Apply invokes the existing typed variable API for only `--nexus-backdrop-blur` on the selected owned theme.
6. The host refreshes active theme CSS after successful save; failures restore confirmed value and show a host toast.
7. Switching cards restores each theme's confirmed blur; base/other plugin themes follow existing theme cleanup.

## Security and lifecycle

Plugins cannot provide HTML, CSS, JavaScript, selectors, components, event handlers, arbitrary actions, or iframe content. They cannot change Settings geometry, navigation, drag regions, native controls, or the work panel. Unknown paths, URLs, variables, theme ids, and cross-plugin references fail closed. Disable, uninstall, or invalid metadata removes the destination and returns the active Settings view to General.

## Tests and validation

- SDK validation rejects malformed objects, unknown/cross-plugin theme ids, undeclared assets, duplicates, non-localized strings, unsupported variables, and card counts outside 1–12.
- Main/IPC tests prove eligible loaded plugins only, declared asset rewriting, typed variable ownership, and lifecycle cleanup.
- Renderer tests prove the host renders cards/range/Apply, transparent outer ownership, responsive layout, selected accessibility, no iframe, and no outer panel.
- Interaction tests prove immediate selection, draft-only slider updates, Apply-only persistence, restoration, failures, base/plugin isolation, reduced transparency, and native controls.

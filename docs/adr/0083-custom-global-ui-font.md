# ADR 0083: Custom global UI font

- Status: Superseded in part by ADR 0298
- Date: 2026-08-14
- Storage: optional `AppSettings.fontFamily` field

## Context

The shell typography was a single hardcoded token stack, and users wanted to
choose a global UI font in Settings. The renderer is sandboxed behind the
preload IPC allowlist and the font source must stay local, with no CDN or CSS
font service.

## Decision

### 1. Settings picker and persistence

Settings → Basics → Appearance gained a searchable **Font** row whose selection
persists as `AppSettings.fontFamily`, a CSS `font-family` stack string, where an
absent or empty value means the built-in stack and **System default** persists
`fontFamily: ""` rather than removing the key, because `settings.set` merges
supplied fields and an omitted key cannot clear a stored override.

### 2. Bundled open-licensed families (superseded by ADR 0298)

[ADR 0298](0298-remove-bundled-fonts.md) removed every bundled family, so the
picker offers System default plus installed families and loads nothing from
disk.

### 3. System font enumeration in Electron main

Electron main resolves installed families with platform tooling only and
without native modules — an `osascript` JXA bridge on macOS, PowerShell on
Windows, `fc-list` on Linux — deduplicates, sorts, and caches the result, and
exposes it to the renderer through one allowlisted IPC channel.

### 4. Application

The renderer overrides `--font-sans` on `document.documentElement` from
`AppSettings.fontFamily`, so `body` and every `var(--font-sans)` consumer
follow without a reload.

## Consequences

- Users pick a global UI font once; it persists across restarts and resolves
  through installed families, since [ADR 0298](0298-remove-bundled-fonts.md)
  ships no font files.
- CJK coverage stays correct because every stack appends a system CJK fallback
  tier, and the mono stack is unchanged.
- Enumeration no longer pays the multi-second `system_profiler` cost on macOS,
  and the installer no longer carries bundled font files.

## Alternatives

- `font_kit` in host-core: fast, but widens the host RPC surface for a
  renderer-only preference.
- The `font-list` npm package: its internal `require` does not survive
  electron-vite main bundling.

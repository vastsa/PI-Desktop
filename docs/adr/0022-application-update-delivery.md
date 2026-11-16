# ADR 0022: Application Update Delivery

- Status: Accepted (amended by D364 / D603 / D628 / ADR 0197, D450 / ADR 0289; issue #1098)
- Date: 2026-07-26
- Related: D010, D078, D120, D126, D164, D450, D603, D628, ADR 0021, ADR 0197, ADR 0289

## Context

PI-Desktop needs an update path that preserves the renderer sandbox, keeps feed
configuration out of untrusted UI code, and reflects what each platform's
installer can actually do. A single automatic-install policy cannot cover targets
whose signing and installer guarantees differ.

## Decision

Electron Main exclusively owns `electron-updater`, the fixed GitHub Releases
feed, polling, and the install lifecycle; renderer IPC exposes only allowlisted
check, state, release-link, and install operations, and no caller can supply a
feed URL. Development builds keep updates disabled. Packaged macOS, Windows NSIS,
and Linux AppImage download and install in-app, while deb/rpm Linux and Windows
ZIP builds (`piDistribution = "zip"`) use notify-and-link so an NSIS installer
cannot replace a no-install run; legacy portable executables stay manual when
`PORTABLE_EXECUTABLE_FILE` is present. The updater always sets
`allowPrerelease = false`, because electron-updater would otherwise pin a
prerelease install to its custom channel and never offer a newer stable release.
Checks run after startup and periodically: automatic failures stay ambient, while
explicit checks surface status and errors through the menu and Settings → Info,
and a downloaded update stays actionable until install or normal shutdown.
Manifests and artifact hashes come from electron-builder, the client ships no
GitHub credential, and it fails closed when the feed or package cannot be
validated. Dual-locale "what's new" text lives in `packages/shared` as EN + zh-CN
catalogs; Main formats notes for the discovered version with the product locale
and attaches them as `UpdateState.releaseNotes`, so the renderer never supplies a
notes URL. D126 lifts D010's macOS-only publication scope, and D450 / ADR 0289
qualifies the signed macOS in-app channel on that same feed.

### Amendments

D450 / ADR 0289 makes official GitHub tag macOS artifacts Developer ID-signed,
notarized, and stapled, so packaged macOS joins the in-app lane; unsigned local
packaging without a certificate stays available (D078). D603 replaces the
Windows self-extracting portable executable with a normal ZIP stamped
`piDistribution = "zip"`. Issue #1098 lets `PI_DESKTOP_UPDATE_CACHE_DIR` relocate
electron-updater's Windows download cache: Main reads the cache subdirectory from
the packaged `app-update.yml`, adopts existing baselines and staged updates from
`%LOCALAPPDATA%`, preserves unknown or already-populated destinations, and
removes the legacy directory only when empty. D628 adds a persisted per-install
`updatePreference` (`automatic` or `manual`) in Host-owned app settings, excluded
from portable configuration sync, plus a persisted banner dismissal that cancels
the download and install-on-quit for that version. D364 keeps the ambient banner
consistent with that stored state.

## Consequences

- Update state is process-owned and identical across the menu, Settings, and the
  banner; the sandboxed renderer cannot redirect traffic or install packages.
- NSIS, AppImage, and packaged macOS update in-app from published tag feeds; deb
  and ZIP users install from the release page after extracting the archive.
- Prerelease installs graduate to stable through the latest feed; rollback,
  staged rollout, and a dedicated RC channel remain operational follow-ups.

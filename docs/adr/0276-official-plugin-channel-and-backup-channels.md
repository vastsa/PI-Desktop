# ADR 0276: Official plugin channel and backup channels

> Amended 2026-10-08: the marketplace uses only the official channel and legacy
> source values are ignored; a resolve request is capped at three seconds and
> falls back to the catalog URL on timeout, rate limit, or `NO_DOWNLOAD_SOURCE`.

- Status: Accepted for implementation
- Date: 2026-09-17
- Related: ADR 0102, D238, E2E-024P, E2E-PLUGIN-official-channel-resolves-through-the-platform

## Context

The marketplace source was a three-value union — `official`, `mirror`, `custom` —
mapped to hardcoded catalog URLs, and `official` was indistinguishable from "never
set". Since ADR 0102 the plugin center at `plugins.aiuo.net` is the publishing
authority and owns the client download contract: `GET /catalog.json`,
`POST /api/v1/download/resolve`, and a byte route the marketplace page uses rather
than clients. The platform hosts no package bytes itself, returns an ordered
`downloads` list, counts one download per device and day, rate-limits per device,
and refuses withdrawn or archived plugins with stable error codes.

## Decision

### 1. The product uses the official channel

The product always reads `https://plugins.aiuo.net/catalog.json` and the Plugins
page has no source selector. `pluginMarketSource` and `pluginMarketCustomUrl`
remain readable in persisted settings without a migration, but host-core ignores
them, and the development-only `PI_DESKTOP_PLUGIN_MARKET_URL` override stays
available to tests and local development. A package URL never crosses providers:
the official catalog supplies it, and fallback downloads stay inside the official
channel.

### 2. The official channel resolves through the platform

Refresh the catalog, then `POST /api/v1/download/resolve` with
`{ deviceId, pluginId, version }` once per install or update, under a three-second
total deadline; POST rather than GET, because the platform documents that a device
id in a query string ends up in access logs. Try the returned `downloads` entries
in order, downloading each to a temporary file and extracting it only after
`sha256` and `sizeBytes` agree, and abandon a failing mirror for the next one.
When the request times out or fails at the transport boundary, the device is rate
limited, or the platform answers `503 NO_DOWNLOAD_SOURCE`, fall back immediately
to the catalog package URL (`artifactBaseUrl` plus the relative `url`) and leave
that install uncounted; a malformed response or an integrity failure never uses
that fallback. The answer is never cached, so two installs of one version are two
calls. The resolve digest is authoritative on the resolve path and the catalog
`shasum` on the fallback. Publication refusals are reported rather than papered
over: `403 NOT_PUBLISHED`, `403 PLUGIN_ARCHIVED` (which also hides the plugin from
install and update selection), and `404`. A fallback never changes the selected
channel.

### 3. A stable device identifier, sent as a digest

The resolve request carries a `deviceId` derived from the machine identity the
operating system exposes, sent only as
`sha256("pi-desktop.device.v1:" + <machine id>)` in 64-character lowercase hex:
the platform only compares two requests for equality, so a raw hardware identifier
in a third-party request would be a privacy downgrade with no functional gain, and
the fixed prefix domain-separates the digest from every other hash the app
computes. When no machine identity is readable, host-core generates one random id
on first use and persists it at `plugins/market/device.json`. Either way the value
is read once per process, stable across restarts, never shown in the UI, not a
setting, and a counting and rate-limit key rather than an account.

### 4. Legacy catalog-source settings are ignored

The legacy `github`, `mirror`, and `custom` values no longer select a catalog. The
platform may still return GitHub or CNB package mirrors for the official catalog;
those use its digest and the existing download allowlist. The cache stays keyed by
`sourceUrl`, so an older snapshot from another catalog is ignored rather than
deleted, and installed records are not rewritten.

### 5. Trust follows the official catalog

`verified` renders as written only from the official catalog. A v1 catalog's
boolean `verified` mapping is unchanged, and platform-returned package mirrors do
not change the trust source.

### 6. The download allowlist does not change

The allowlist stays `github.com`, `githubusercontent.com`, `cnb.cool`, and the host
that served the current catalog, which already covers every mirror the platform
names. A mirror on any other host is refused like any other package URL and the
next mirror is tried, so moving a mirror outside that set is a client-release
dependency rather than a platform-side change.

### 7. An install reports progress and can be cancelled while it downloads

`plugin.installProgress` carries `pluginId`, `version`, `phase` (`resolve`,
`download`, `verify`, `install`, `enable`), the mirror in use as `source` with its
1-based `attempt` and `attempts`, `receivedBytes` and `totalBytes` (`0` when the
size is unknown), the mirrors tried so far in `tried[]` as
`{ source, url, error }`, and `error` on the terminal report of a failure. Reports
are throttled to a bounded rate plus one per phase change and the terminal report,
so byte-level progress cannot flood the RPC channel. A manual install or update
shows the phase, `mirror n/N · name`, a determinate bar, and a cancel button
enabled only during `resolve` and `download`; a background auto-update stays
silent. `market.cancelInstall { id }` answers `{ cancelled, id }` and cancels only
an install running right now, honoured while bytes arrive, before each mirror is
tried, and at the last safe point before the package is written, because stopping
after unpacking would leave a state no later step can describe. A cancelled
install fails with `PLUGIN_CANCELLED` and the dialog closes quietly.

## Consequences

- The official channel gains per-mirror fallback, withdrawal and archive signals,
  and download counting, at the cost of a platform dependency that the catalog-URL
  fallback mitigates.
- Per-mirror digest verification absorbs a divergent mirror without failing the
  install, and a first third-party service now receives an installation-level
  digest, never an identity.
- No manifest, catalog parsing, permission-review, or storage-schema change;
  legacy source values are retained but ignored.

## Rejected alternatives

- Resolve from the catalog's declared base only: a static file cannot say which
  mirrors serve a version or refuse a withdrawn plugin.
- A per-request identifier: counting per device needs stability, or the limiter
  degrades to the source address.
- Exposing the identifier in Settings: it answers no user question and invites
  treating a counting key as an account.

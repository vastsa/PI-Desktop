# ADR 0276: Official plugin channel and backup channels

> Amended 2026-10-08: the marketplace UI and persisted settings now use only
> the official channel; legacy source values are ignored. The resolve request
> is capped at three seconds and falls back to the official catalog URL after
> a timeout, rate limit, or `NO_DOWNLOAD_SOURCE`. Publication refusals remain
> authoritative.

- Status: Accepted for implementation
- Date: 2026-09-17
- Deciders: PI-Desktop plugin and distribution maintainers
- Related: ADR 0102, D238, E2E-024P, E2E-PLUGIN-official-channel-resolves-through-the-platform

## Context

The client's marketplace source was a three-value union — `official`, `mirror`,
`custom` — mapped to hardcoded catalog URLs, and `official` was
indistinguishable from "never set": both landed on the GitHub default. A package
was fetched by joining the catalog's relative `url` onto `artifactBaseUrl` or
the catalog directory, and the `verified` trust tier was recognized only while
the catalog URL equaled one of two constants.

```text
GET  /catalog.json                  the catalog the client reads
POST /api/v1/download/resolve       JSON { deviceId, pluginId, version? }
                                    -> 200 { sha256, sizeBytes, downloads[] }
                                       Cache-Control: no-store
GET  /download/{id}/{version}       byte route for the marketplace page and
                                    console; not the client's path
```

## Decision

### 1. The product uses the official channel

The product always reads `https://plugins.aiuo.net/catalog.json`; the Plugins
page has no source selector. `pluginMarketSource` and `pluginMarketCustomUrl`
remain in persisted settings so older settings can be read without migration,
but host-core ignores them.

| Channel | Value | Catalog URL | Install path |
| --- | --- | --- | --- |
| Official channel | `official` | `https://plugins.aiuo.net/catalog.json` | Platform resolve |

`official` means the project's first-party plugin center. A package URL never
crosses providers: the official catalog supplies its package URL, and fallback
downloads remain inside the official channel.

### 2. The official channel resolves through the platform

1. Refresh the catalog, then `POST {center origin}/api/v1/download/resolve` with
   `{ deviceId, pluginId, version }` — once per install or update.
2. Try the returned `downloads` entries in order.
3. When the request times out or fails at the transport boundary, the platform
   rate-limits the device, or it answers `503 NO_DOWNLOAD_SOURCE`, the client
   immediately falls back to the catalog's own package URL (`artifactBaseUrl`
   plus the relative `url`).
4. The answer is never cached (`Cache-Control: no-store` is the platform's
   confirmation of this), so two installs of the same version are two calls.
5. The resolve digest is authoritative on the resolve path; the catalog's
   `shasum` stays authoritative on the catalog fallback.
6. Publication refusals are reported, not papered over: `403 NOT_PUBLISHED`,
   `403 PLUGIN_ARCHIVED` (hide the plugin from install and update selection),
   and `404` (the platform has no such version — including a `+`-suffixed
   version the byte route cannot carry).
7. A resolve fallback does not change the selected channel.

### 3. A stable device identifier, sent as a digest

The resolve request carries a `deviceId` that host-core derives from the machine
identity the operating system exposes — the Windows
`HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`, the macOS platform UUID, or
Linux `/etc/machine-id` (falling back to `/var/lib/dbus/machine-id` and
`/sys/class/dmi/id/product_uuid`). What leaves the machine is
`sha256("pi-desktop.device.v1:" + <machine id>)` as 64-character lowercase hex,
never the machine code itself: the platform only needs to compare two requests
for equality, so it has no use for the code, and a raw hardware identifier in a
third-party request is a privacy downgrade the counting feature does not
require.

When no machine identity is readable, host-core generates one random 64-hex id
on first use and persists it under the application data directory
(`plugins/market/device.json`), reusing it from then on. Either way the value is
read once per process, is stable for an installation across restarts, is never
shown in the UI, and is not a setting.

### 4. Legacy catalog-source settings are ignored

The legacy `github`, `mirror`, and `custom` settings no longer select a catalog.
The platform may still return GitHub or CNB package mirrors for the official
catalog; these use the platform's digest and the same download allowlist.

### 5. Trust follows the official catalog

`verified` renders as written only from the official catalog. A v1 catalog's
boolean `verified` mapping is unchanged.

### 6. The download allowlist does not change

The allowlist stays `github.com`, `githubusercontent.com`, `cnb.cool`, and the
host that served the current catalog. The platform's resolve answers name
mirrors on exactly those hosts today, so no entry is added.

### 7. An install reports progress, and can be cancelled while it downloads

An install or update is a single request, so a download that takes a minute is
otherwise indistinguishable from a frozen window. Host-core therefore reports
where the install is: `plugin.installProgress` carries `pluginId`, `version`,
`phase` (`resolve`, `download`, `verify`, `install`, `enable`), the mirror in
use (`source`) with its 1-based `attempt` / `attempts`, `receivedBytes` /
`totalBytes` (`0` meaning the size is unknown), every mirror tried so far
(`tried[]`, each `{ source, url, error }`), and `error` on the report that ends
a failed install.

The report goes to the interface rather than only to the log. A log line helps
an operator afterwards; the person waiting needs to see that the install moved
on to the second mirror and how far it is.

## Consequences

- The official channel gains per-mirror fallback, withdrawal and archive
  signals, and download counting, and it acquires a dependency: an install asks
  the platform.
- Per-mirror digest verification becomes the reason a divergent mirror cannot
  break an install.
- A first third-party service now receives an installation-level identifier.
- A resolve timeout is capped at three seconds.
- An install is no longer opaque: the interface sees the phase, the mirror being
  tried, and the byte count, and a user can stop a download without leaving a
  half-installed plugin.

## Rejected alternatives

- **Keep resolving the catalog's declared base on the client only.** The catalog
  is a static file, so it cannot say which mirrors currently serve a version, it
  cannot refuse an archived or unpublished plugin, and it is the same list for
  every install.
- **Send a per-request identifier.** The platform counts one download per
  device, version, and day and rate-limits per device, so a value that changes
  per call counts every call as a new installation and degrades the limiter to
  the source address.
- **Send the raw machine code, or hash it without a prefix.** The platform only
  compares values, so shipping the code itself would hand a third party a
  reusable hardware identifier for no functional gain, and an unprefixed digest
  could be correlated with other digests of the same machine.
- **Expose the identifier in Settings (show or reset it).** It answers no user
  question, it invites treating a counting key as an account, and a reset button
  would silently let one machine inflate the platform's counters.

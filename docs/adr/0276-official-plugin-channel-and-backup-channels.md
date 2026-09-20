# ADR 0276: Official plugin channel and backup channels

- Status: Accepted for implementation
- Date: 2026-09-17
- Deciders: PI-Desktop plugin and distribution maintainers
- Related: ADR 0102, D238, E2E-024P, E2E-PLUGIN-official-channel-resolves-through-the-platform

## Context

The client's marketplace source was a three-value union — `official`, `mirror`,
`custom` — mapped to hardcoded catalog URLs, and `official` was
indistinguishable from "never set": both landed on the GitHub default. A
package was fetched by joining the catalog's relative `url` onto
`artifactBaseUrl` or the catalog directory, and the `verified` trust tier was
recognized only while the catalog URL equaled one of two constants.

Since ADR 0102 the plugin center at `plugins.aiuo.net` is the publishing
authority, and it defines the client-facing download contract:

```text
GET  /catalog.json                  the catalog the client reads
POST /api/v1/download/resolve       JSON { deviceId, pluginId, version? }
                                    -> 200 { sha256, sizeBytes, downloads[] }
                                       Cache-Control: no-store
GET  /download/{id}/{version}       byte route for the marketplace page and
                                    console; not the client's path
```

The platform's own rules, verified against production: it never hosts the bytes
of a published package, only answers where they are; `downloads` is ordered and
never empty on `200`; a client calls resolve once per install or update, sends a
**stable** device identifier, never caches the answer, verifies `sha256` before
installing, and tries the next mirror when one fails; `counted: false` is normal;
rate limiting is per device identifier (otherwise per source address), 600
requests per minute by default, with `429` and `Retry-After`; refusals are
`400 PLUGIN_REQUIRED`, `403 NOT_PUBLISHED`, `403 PLUGIN_ARCHIVED`,
`404 NOT_FOUND`, `429`, and `503 NO_DOWNLOAD_SOURCE`; and a platform-unreachable
install falls back to the catalog's URL and is not counted. Counting identity is
the device identifier, the platform stores counts rather than identities, and
the optional `source` field is a statistics hint only.

Measured on the same day: the catalog declares
`artifactBaseUrl = raw.githubusercontent.com/AIUO-Net/pi-desktop-plugins/main`;
all three mirrors answered `200` and every mirror host is already inside the
client's download allowlist; the CNB mirror still served an older distribution
(22 plugins, and `pi.todo-0.6.5` at 92487 bytes where the other mirror served
92951 bytes). A version string may contain `+` (for example `0.3.0+0.2.0`), so
the platform's byte route cannot be assumed to carry every published version.

The client's source model therefore has to become "the center first, the two Git
hosts as backups", and the install path has to follow the platform's contract.

## Decision

### 1. Four channels, and `official` keeps its meaning

| # | Channel | Value | Catalog URL | Install path |
| --- | --- | --- | --- | --- |
| 1 | Official channel | `official` (default) | `https://plugins.aiuo.net/catalog.json` | Platform resolve |
| 2 | GitHub backup | `github` (new) | `https://raw.githubusercontent.com/AIUO-Net/pi-desktop-plugins/main/catalog.json` | Static relative URL |
| 3 | CNB backup | `mirror` (unchanged) | `https://cnb.cool/aixk/pi-desktop-plugins/-/git/raw/main/catalog.json` | Static relative URL |
| 4 | Custom | `custom` (unchanged) | user-provided | Static relative URL |

`official` keeps meaning "the project's own first-party channel" and now points
at the center, so an unset value and an unrecognized value resolve to it and no
persisted setting is migrated. `mirror` keeps meaning CNB; `github` is new
because the GitHub backup no longer is the default. Display names are
localized — Official channel / GitHub backup / CNB backup / Custom in English.
A package URL never crosses providers: whichever channel served the catalog also
serves the package.

### 2. The official channel resolves through the platform

1. Refresh the catalog, then `POST {center origin}/api/v1/download/resolve` with
   `{ deviceId, pluginId, version }` — once per install or update. POST rather
   than GET, because the platform documents that a device id in a query string
   ends up in access logs.
2. Try the returned `downloads` entries in order. Every attempt is downloaded to
   a temporary file, checked against the returned `sha256` and the announced
   `sizeBytes`, and extracted only when both agree. A mirror that fails —
   network error, HTTP error, digest mismatch, size mismatch — is abandoned and
   the next one is tried. Requests stay on the download allowlist.
3. Only when the platform could not be reached, or when no mirror in the list
   could serve the version, the client falls back to the catalog's own package
   URL (`artifactBaseUrl` plus the relative `url`). That is the fallback the
   platform defines, and that install is not counted.
4. The answer is never cached (`Cache-Control: no-store` is the platform's
   confirmation of this), so two installs of the same version are two calls.
5. The resolve digest is authoritative on the resolve path; the catalog's
   `shasum` stays authoritative on the fallback and on the backup channels.
   `sizeBytes` is a sanity check on both.
6. Refusals are reported, not papered over: `403 NOT_PUBLISHED` (no retry),
   `403 PLUGIN_ARCHIVED` (hide the plugin from install and update selection),
   `404` (the platform has no such version — including a `+`-suffixed version
   the byte route cannot carry), `429` (wait the `Retry-After` interval, retry
   once, then report), `503` (report the deployment problem; `NO_DOWNLOAD_SOURCE`
   means no mirror can serve the version).
7. Nothing switches the channel automatically. An unreachable platform is
   reported after the fallback, and the user switches through the existing
   selector.

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
require. The fixed prefix domain-separates the value from every other hash the
app computes, so a leaked digest cannot be matched against another digest of the
same machine.

When no machine identity is readable, host-core generates one random 64-hex id
on first use and persists it under the application data directory
(`plugins/market/device.json`), reusing it from then on. Either way the value is
read once per process, is stable for an installation across restarts, is never
shown in the UI, and is not a setting. It is a counting and rate-limit key, not
an account.

### 4. The backup channels and `custom` are unchanged

`github`, `mirror`, and `custom` keep the static relative-URL resolution,
including `artifactBaseUrl` precedence, the download allowlist, redirect
re-validation, and shasum verification, byte for byte. The persisted source
keeps working for existing users, the cache stays keyed by `sourceUrl` so a
switch ignores rather than deletes another channel's snapshot, and an installed
record's `providerId` now names the channel it actually came from — already
installed records are not rewritten.

### 5. Trust tiers follow the trusted channels

`verified` renders as written only from the three project channels (official,
GitHub backup, CNB backup). `custom` still degrades to `community`, and a v1
catalog's boolean `verified` mapping is unchanged. The predicate changes from
"is this the official source" to "is this a trusted channel".

### 6. The download allowlist does not change

The allowlist stays `github.com`, `githubusercontent.com`, `cnb.cool`, and the
host that served the current catalog. The platform's resolve answers name
mirrors on exactly those hosts today, so no entry is added. A mirror on any
other host is refused like any other package URL: the next mirror is tried, and
if every entry names such a host the install fails instead of widening the list.
Moving a mirror outside the table is therefore a client-release dependency, not
a platform-side change.

### 7. An install reports progress, and can be cancelled while it downloads

An install or update is a single request, so a download that takes a minute is
otherwise indistinguishable from a frozen window. Host-core therefore reports
where the install is: `plugin.installProgress` carries `pluginId`, `version`,
`phase` (`resolve`, `download`, `verify`, `install`, `enable`), the mirror in
use (`source`) with its 1-based `attempt` / `attempts`, `receivedBytes` /
`totalBytes` (`0` meaning the size is unknown), every mirror tried so far
(`tried[]`, each `{ source, url, error }`), and `error` on the report that ends
a failed install. Reports are throttled to at most one per 200 ms, plus one per
phase change and the terminal report, so byte-level progress cannot flood the
RPC channel or the interface.

The report goes to the interface rather than only to the log. A log line helps
an operator afterwards; the person waiting needs to see that the install moved
on to the second mirror and how far it is. Progress is therefore
observer-shaped, host-core emits it as a notification, and the RPC layer owns
the throttle.

`market.cancelInstall { id }` answers `{ cancelled, id }` and cancels only an
install that is running right now, never a queued or finished one. Cancellation
is honoured while bytes arrive, before each mirror is tried, and at the last
safe point before the package is written, so only a download is actually
interruptible: stopping after the package has been unpacked and the plugin's row
is being written would leave the plugin directory and the registry in a state
no later step can describe, which is worse than letting that step finish. A
cancelled install fails with `PLUGIN_CANCELLED` (code 1019), and the dialog closes quietly instead of reporting an error.

The dialog is for a manual install or update only; a background auto-update
stays silent. It shows the phase, `mirror n/N · name`, a determinate bar, and a
cancel button enabled only during `resolve` and `download`; success closes it
about two seconds after the install finishes, failure keeps it open with the
readable error, the mirrors that were tried with a copy action, and a retry
action.

## Consequences

- The official channel gains per-mirror fallback, withdrawal and archive
  signals, and download counting, and it acquires a dependency: an install asks
  the platform. The documented catalog-URL fallback and the two backup channels
  are the mitigation.
- Per-mirror digest verification becomes the reason a divergent mirror cannot
  break an install. The measured CNB divergence (`pi.todo-0.6.5` at 92487 bytes
  versus 92951) is exactly the case this absorbs.
- A first third-party service now receives an installation-level identifier.
  Only a digest is sent, the platform stores counts rather than identities, and
  the privacy policy and the decisions log state it.
- `429` costs at most one `Retry-After` wait per install; a batch update makes
  one call per plugin, not one per mirror.
- An install is no longer opaque: the interface sees the phase, the mirror being
  tried, and the byte count, and a user can stop a download without leaving a
  half-installed plugin. The cost is progress notifications on the RPC channel,
  bounded by the 200 ms throttle and the per-phase reports.
- No `.piplug` or manifest change, no catalog v1/v2 parsing change, no
  permission-review change, no storage schema change, no migration of persisted
  source values, and no change to the two backup install paths.
- Still open, deliberately: signature verification (optional as before), any
  automatic channel switching, and the center's own byte route, which stays the
  marketplace page and console path.

## Rejected alternatives

- **Keep resolving the catalog's declared base on the client only.** The catalog
  is a static file, so it cannot say which mirrors currently serve a version, it
  cannot refuse an archived or unpublished plugin, and it is the same list for
  every install. The client would also keep trusting a publisher-influenced base
  without any per-mirror signal, and the platform would lose the counting and
  rate-limit identity its contract depends on.
- **Send a per-request identifier.** The platform counts one download per
  device, version, and day and rate-limits per device, so a value that changes
  per call counts every call as a new installation and degrades the limiter to
  the source address. The requirement is stability.
- **Send the raw machine code, or hash it without a prefix.** The platform only
  compares values, so shipping the code itself would hand a third party a
  reusable hardware identifier for no functional gain, and an unprefixed digest
  could be correlated with other digests of the same machine.
- **Expose the identifier in Settings (show or reset it).** It answers no user
  question, it invites treating a counting key as an account, and a reset button
  would silently let one machine inflate the platform's counters. The fallback
  file is documented instead.
- **An automatic fallback between channels.** A channel switch changes which
  catalog, versions, trust verdicts, and bytes the user sees, so doing it
  silently would attribute an install to a source the user did not choose. The
  only automatic fallback stays inside the official channel, to the catalog URL
  that channel served, and it is not counted.
- **Cache the resolve answer.** The platform marks it `no-store` because mirrors
  and availability change; a cached answer would pin a dead mirror and could
  serve a version the platform has since withdrawn.

# 07. Plugin Marketplace

## 1. Positioning

The plugin marketplace is a **distribution layer**, not a runtime core.

Principle:

> Get the local plugin system working first, then integrate the marketplace.

The marketplace is responsible for:
- Discovery
- Search
- Displaying metadata
- Download
- Update checking

The host is responsible for:
- Validation
- Authorization
- Install
- Run
- Security isolation

## 2. Phase strategy

### Phase A ✅
- Protocol and data model
- Local official market provider (`plugins/market/catalog.json`)

### Phase B ✅
- Browse/search + download install are implemented against the official provider
- Official provider: the plugin center, `plugins.aiuo.net` (Phase B originally pointed at the GitHub repository `vastsa/pi-desktop-plugins`; see "Catalog source" below and [ADR 0276](../../adr/0276-official-plugin-channel-and-backup-channels.md))
- Default catalog URL: `https://plugins.aiuo.net/catalog.json`
- Package URLs may be absolute `https://` / `http://` / `file://`, or a relative path resolved against the catalog's `artifactBaseUrl` when it declares one, and otherwise against the catalog URL
- HTTPS fetch uses `curl` in host-core
- curl diagnostics are decoded as UTF-8 first and as the active Windows ANSI
  code page when needed; a network failure remains `PLUGIN_NETWORK`, but its
  localized message must not cross the RPC boundary as replacement characters

### Catalog source

Plugins → Marketplace always uses the official plugin center catalog at
`https://plugins.aiuo.net/catalog.json`. The page has no source selector.
Persisted `pluginMarketSource` and `pluginMarketCustomUrl` values from older
versions are retained for settings compatibility but ignored; no data migration
is needed. `PI_DESKTOP_PLUGIN_MARKET_URL` remains available to development and
test runs without making the catalog configurable in the shipped interface.

Marketplace catalog and package downloads follow Settings → General → Network.
System mode sends host-core `curl` through Electron's authenticated loopback
SOCKS relay, which resolves each destination using the active OS proxy/PAC
configuration. Direct mode forces the marketplace request direct; Custom uses
the configured proxy and bypass list. The relay credential is runtime-only and
is not inherited by workspace shell commands. On Windows, host-core uses
Schannel's best-effort revocation mode when the installed `curl` supports it,
so an unavailable revocation distribution point does not block the HTTPS
request; certificate verification and package size/hash checks remain enabled.

The official catalog is the generated `catalog.json` the center publishes, and
an install asks the platform where the package is instead of joining a relative
path onto a base URL. If resolve is slow or unavailable, the client downloads
from the official catalog's own package URL and verifies its catalog digest.
Packages on the official resolve path can still come from approved GitHub and
CNB mirrors returned by the platform. These are package mirrors inside the
official channel; they do not change the catalog source. Each mirror's bytes
are checked against its announced digest.

Cached catalogs are keyed to their source in `plugins/market/cache-meta.json`.
The official catalog cache remains the marketplace snapshot. Any cache left by
an older selected source is ignored and not deleted. `settings.set` keeps the
host's marketplace selection pinned to official; remote fetching remains an
explicit `market.refresh` operation so a settings write never holds the host
RPC state lock behind a marketplace timeout.

### Device identifier

The official channel's resolve call carries a `deviceId`. host-core derives it
from the machine identity the operating system exposes: the Windows
`HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`, the macOS platform UUID, or
Linux `/etc/machine-id` (falling back to `/var/lib/dbus/machine-id` and
`/sys/class/dmi/id/product_uuid`). What is sent is
`sha256("pi-desktop.device.v1:" + <machine id>)` as 64-character lowercase hex,
so the machine code itself never leaves the machine and the digest is
domain-separated from every other hash the app computes. When no machine
identity is readable, host-core generates one random 64-hex id and persists it
under the application data directory (`plugins/market/device.json`), reusing it
from then on. The value is read once per process, is stable for the installation
across restarts, is never shown in the UI, and is not a setting the user can
edit or reset. It is the platform's counting and rate-limit key (see
[15-plugin-center.md](15-plugin-center.md) §10), not an account or a login.

### Resolve-based install (official channel)

Every install or update from the official channel resolves its package through
the platform after the catalog has been refreshed:

1. Refresh the catalog and pick the plugin and version, exactly as for any other
   channel.
2. `POST {center origin}/api/v1/download/resolve` — the origin that served the
   official catalog — with a JSON body of `{ deviceId, pluginId, version }`,
   where `version` is present when the user picked one. POST is used rather than
   GET because the platform's own contract notes that a device id in a query
   string lands in access logs. The metadata request has a three-second total
   deadline and is made once; a slow endpoint cannot hold the install on
   `resolve` for the download timeout or a `Retry-After` interval.
3. Try every entry of the returned `downloads` array in order: download, verify
   the returned `sha256` and the announced `sizeBytes`, then hand the bytes to
   the installer. A mirror that fails — network error, HTTP error, digest
   mismatch, size mismatch — is abandoned and the next one is tried. Requests
   stay on the allowlisted hosts below.
4. If the resolve request times out or fails at the transport boundary, or
   returns `429` / `503 NO_DOWNLOAD_SOURCE`, use the catalog's own package URL
   (`artifactBaseUrl` plus the relative `url`) immediately. The catalog digest
   and size are still checked, and the install is not counted. If all usable
   returned mirrors fail at the transport boundary, use the same fallback. A
   malformed resolve response or an integrity failure does not take this path.
5. One resolve call per install or update. The answer is never cached, which is
   why the platform sends `Cache-Control: no-store`; `counted: false` is a
   normal reply and never an error.

A `200` response always carries a non-empty `downloads` array. Publication
refusals are reported, never papered over:

- `403 NOT_PUBLISHED` — the version is not published. Report it and do not
  retry.
- `403 PLUGIN_ARCHIVED` — the plugin is archived. Hide it from install and
  update selection.
- `404` — the platform has no such version. Report it; a version string the
  byte route cannot carry (a `+` build-metadata suffix, for example) is a
  missing version, not a URL to guess at.
- `429` — the platform rate-limits per device id (600 requests per minute by
  default). Do not wait or retry; use the catalog URL, whose package is checked
  against the catalog digest.
- `503 NO_DOWNLOAD_SOURCE` — use the catalog URL because no platform mirror can
  serve the version. Other `503` deployment failures use the same fast fallback.

The resolve digest is authoritative when mirrors are used; the catalog's
`shasum` stays authoritative on the fallback. An explicit `403` or `404`
publication refusal never falls through to a different package source. Nothing
here switches the catalog source: the fallback stays inside the official
channel.

### Install progress and cancellation

An install or update is one request, so while it runs it reports where it is.
The `plugin.installProgress` notification carries `pluginId`, `version`, `phase`
(`resolve`, `download`, `verify`, `install`, `enable`), `source` (the mirror in
use) with its 1-based `attempt` / `attempts`, `receivedBytes` / `totalBytes`
(`0` total means the size is unknown), and `tried[]` — every mirror tried so
far, each `{ source, url, error }`. The report that ends a failed install also
carries `error`. Reports are throttled to at most one per 200 ms, plus one per
phase change and the terminal report, so byte progress cannot flood the
interface.

`market.cancelInstall { id }` answers `{ cancelled, id }` and cancels only an
install that is running right now. Only a download can actually be interrupted:
the request is honoured while bytes arrive, before each mirror is tried, and at
the last safe point before the package is written. A cancelled install fails
with `PLUGIN_CANCELLED` (JSON-RPC code 1019), and the dialog closes quietly
instead of reporting an error.

The dialog opens for a manual install or update, never for a background
auto-update. It shows the current phase, `mirror n/N · name`, a determinate bar
from `receivedBytes` / `totalBytes` with the transfer speed, and a cancel button
enabled only during `download` and `resolve`. A successful install closes the
dialog about two seconds after it finishes, and that countdown pauses while the
dialog is hovered. A failed install keeps it open with the readable error and
the mirrors that were tried, offering a copy action for them and a retry action.

### Client-visible catalog policy

Development-only sample entries whose stable ID starts with `demo.` remain
available as offline fixtures and direct install targets for plugin development,
but the desktop client filters them before updating its marketplace state. They
do not appear as cards, categories, or search results. An already-installed
sample remains visible in Installed so it can still be disabled or uninstalled.

### Bundled plugins in the catalog

An entry whose ID a build also ships from `resources/plugins` stays visible: the
card resolves against the bundled row, reports the installed version, and offers
an update when the catalog has a strictly newer one. That is the supported way
for a user to take a newer upstream release without waiting for an app update
(ADR 0241). Only a strictly newer version counts as an update — equality is not
one, and neither is an older catalog entry, which would be a downgrade wearing
the update affordance.

Updating a bundled plugin keeps it bundled. Removal stays refused by ID against
what the build ships, not by the row's `source`, so an updated plugin is still
not the user's to uninstall; and the installed version survives the next launch
unless this build ships a strictly newer one, so an app update still reaches a
user who never installed anything.

### Phase C (partial ✅)
- Auto-update policy + permission-diff gating implemented
- Ratings / mandatory signing still planned

### Phase D (in progress)

Plugin source moves to the publisher's own repository and the catalog gains
schema v2 (ADR 0102). The client reads v1 and v2 from the same code path; v2
adds source provenance, review verdicts, yank state, and a declared artifact
base. See [15-plugin-center.md](15-plugin-center.md) for the publishing side.

## 3. Market Provider abstraction

```ts
interface MarketProvider {
 id: string
 list(query: MarketQuery): Promise<MarketSearchResult>
 get(pluginId: string): Promise<MarketPluginDetail>
 getDownloadInfo(pluginId: string, version?: string): Promise<MarketDownloadInfo>
 checkUpdates(installed: InstalledPluginRef[]): Promise<MarketUpdateInfo[]>
}
```

The shipped client currently exposes the `official` provider only. The
development-only `PI_DESKTOP_PLUGIN_MARKET_URL` override supports local test
catalogs without adding a source control to the product UI.

## 4. Data model

### Catalog schema v2

A catalog without `schemaVersion` is v1 and keeps its current meaning. `schemaVersion: 2`
adds the fields below; every one of them is optional so a v1 catalog parses
unchanged, and the client treats a missing field as "not asserted" rather than
as a default-allow.

Catalog `author` is a string in both v1 and v2. The plugin-manifest form
`{ name, url?, email? }` is valid on `manifest.json` and invalid in
`catalog.json`; host-core fails the whole refresh with `PLUGIN_MARKET_INVALID`
if it receives a map there.

```jsonc
{
  "schemaVersion": 2,
  "providerId": "official",
  "catalogId": "pi-plugin-center",
  "generatedAt": "2026-08-18T02:00:00Z",
  "policyVersion": "2026.08.1",
  // Optional. The official source omits it: relative package URLs resolve
  // against the catalog directory, so GitHub and the CNB mirror each serve
  // their own packages without crossing providers. A mirror or enterprise
  // source that stores packages elsewhere declares its own base here.
  "artifactBaseUrl": null,
  "plugins": [
    {
      "id": "acme.todo",
      "publisherId": "acme",
      "trust": "verified | community | unknown",
      "repository": "https://github.com/acme/pi-plugin-todo",
      "versions": [
        {
          "version": "1.2.0",
          "url": "packages/acme.todo-1.2.0.piplug",
          "shasum": "<sha256 hex>",
          "sizeBytes": 40960,
          "permissions": ["fs.read"],
          "minPiDesktop": "0.8.0",
          "yanked": false,
          "yankedReason": null,
          "provenance": {
            "sourceRepository": "https://github.com/acme/pi-plugin-todo",
            "sourceRef": "refs/tags/v1.2.0",
            "sourceCommit": "<40-hex commit>",
            "sourcePath": ".",
            "builder": "pi-plugin-center-builder@1.0.0",
            "builtAt": "2026-08-18T01:55:00Z"
          },
          "review": {
            "decision": "approved",
            "risk": "low",
            "policyVersion": "2026.08.1",
            "reviewedAt": "2026-08-18T01:58:00Z"
          },
          "signature": "<base64>",
          "signatureAlg": "ed25519",
          "keyId": "pi-center-2026"
        }
      ]
    }
  ]
}
```

Client rules for v2:

- `artifactBaseUrl` takes precedence over the catalog directory when resolving a
  relative package URL. An absolute package URL is used as given and must still
  pass the download host allowlist.
- `trust` is display-only and is never derived from publisher-supplied text. A
  value the client cannot attribute to the configured official source renders as
  `unknown`. See [15-plugin-center.md](15-plugin-center.md) §11.
- `yanked: true` removes the version from install and update selection. It stays
  visible in version history with its reason, and an installed copy of a yanked
  version is surfaced as needing attention.
- `minPiDesktop` blocks install when the running app is older, before download.
- `provenance` is stored with the installed plugin and shown in the detail sheet,
  so an installed marketplace plugin can be traced back to a repository and
  commit.
- `signature` verification is specified in
  [08-plugin-signing-updates.md](08-plugin-signing-updates.md) and remains
  optional until the center's signing phase lands. An unverifiable signature is
  never treated as a valid one.

### MarketPluginSummary
```ts
type MarketPluginSummary = {
 id: string
 name: string
 description: string
 author: string
 iconUrl?: string
 latestVersion: string
 downloads?: number
 updatedAt: string
 categories?: string[]
 permissionSummary: string[]
 verified?: boolean
 installable?: boolean
}
`i18n` is display metadata, not a summary field: the host resolves a card's
`name` / `description` and a detail view's `safetyNotes` against the app
language and falls back per field to the entry's own values, so a translated
plugin reads in the user's language (ADR 0267). A catalog entry declares the
same block as a manifest — `{ en: { name, description, safetyNotes }, "zh-CN":
{ … } }`. Search matches every locale, not only the one currently displayed; a
malformed block fails the catalog parse, while unknown locales and unknown
fields inside an entry are ignored.

```

### MarketPluginDetail
```ts
type MarketPluginDetail = MarketPluginSummary & {
 readmeMarkdown?: string
 versions: Array<{
 version: string
 publishedAt: string
 changelog?: string
 minPiDesktop?: string
 shasum?: string
 url?: string
 sizeBytes?: number
 }>
 screenshots?: string[]
 homepage?: string
 repository?: string
 permissions: string[]
 safetyNotes?: string
}
```

Version entries are an unordered catalog input. The host parses semantic
versions and selects the highest valid version as `latestVersion`; it does not
assume the first array entry is newest. Detail responses order versions newest
first, and an install without an explicit version targets that same latest
version. Invalid version strings are lower priority than valid semantic
versions. A version without `shasum` or `url` remains visible for discovery
but is not installable until the publisher completes its package metadata.

`installable` reports whether `latestVersion` carries that package metadata.
Marketplace rows and the detail sheet disable their install action and label
the version as not yet published rather than starting a download the host will
refuse; a batch update skips such a version instead of failing the whole run.

### Catalog release gate

Before publishing or diagnosing a release, run the repository preflight:

```bash
pnpm check:marketplace -- \
  --url https://plugins.aiuo.net/catalog.json \
  --plugin <plugin-id>
```

The preflight is intentionally stricter than discovery. Every published
version must have a valid semantic version, a unique version within its
plugin, a 64-character SHA-256 checksum, a package URL, a positive package
size, and a permissions array. A catalog that fails this gate must be fixed in
the marketplace publisher before client update behavior is changed.

### MarketDownloadInfo
```ts
type MarketDownloadInfo = {
 pluginId: string
 version: string
 url: string
 sizeBytes: number
 shasum: string // sha256
 signature?: string // mandatory later
 signatureAlg?: "ed25519"
 publishedAt: string
}
```

## 5. Install path (marketplace)

```text
browse/search
 → detail
 → install
 → download to cache
 → verify shasum/(signature)
 → hand to local packaging installer
 → permission review
 → enable?
```

On any validation failure: abort and optionally clean up the cache.

### Download host allowlist

A v1 catalog kept every package under one known repository, so the host could
follow any redirect and rely on the checksum alone. Once package URLs describe a
publisher-influenced release, the host must also constrain *where the request
goes*, not only what comes back.

Before a marketplace package is fetched, host-core resolves the URL and rejects it
unless it satisfies all of:

1. The scheme is `https`, or `file://` for a local development catalog.
2. The URL carries no embedded credentials.
3. The host is on the allowlist below, or is the same host that served the
   catalog currently in effect.

| Host | Why |
|---|---|
| `github.com` | Release asset download entry point |
| `objects.githubusercontent.com` | Where GitHub redirects release assets |
| `release-assets.githubusercontent.com` | Current release asset origin |
| `raw.githubusercontent.com` | Catalog and repository-hosted packages |
| `codeload.github.com` | Repository archive downloads |
| `cnb.cool` | Mirror catalog and mirrored assets |

Redirects are restricted to HTTPS and re-checked: the effective URL after
redirection must satisfy the same rules as the initial URL. A custom or
enterprise catalog is trusted for its own host only — pointing the client at a
private catalog does not widen the allowlist for arbitrary third-party hosts.

The official channel's resolve response names mirrors rather than a free-form
URL list, and those mirrors are the distribution hosts above: the GitHub raw
repository and the CNB mirror the platform already publishes from. A mirror
entry on any other host is refused exactly like a package URL on that host, so
the next mirror in the list is tried; if every entry names such a host the
install fails instead of widening the list. Moving a mirror to a host outside
this table therefore needs a client release, not a platform-side change.

An off-allowlist package URL fails with `PLUGIN_MARKET_UNTRUSTED_HOST` before any
network request is made, and the failure names the rejected host so an operator
can tell a misconfigured private source apart from a hostile catalog entry.

The host refreshes the catalog immediately before a marketplace download so
the package URL and checksum come from the same current catalog snapshot. This
prevents a short-lived UI/catalog cache from being paired with a newer package
at a mutable release URL. If the refresh is unavailable, the host may use the
last valid catalog for an offline install, but it still verifies the downloaded
bytes against that catalog checksum.

`.piplug` packages are now producible locally: `pnpm pi-plugin pack <dir>`
(equally, the `PluginPack` agent tool) writes `dist/<id>-<version>.piplug` and
prints its sha256, and the plugins page installs that file through the same
validation and permission review as a marketplace download. Distribution through
the marketplace is therefore optional — a plugin written for personal use never
has to leave the machine. See
[Plugin developer experience](10-plugin-devex.md).

A catalog entry whose plugin declares `contributes.skills` must also declare
`agent.prompt.inject` in `permissions`; without it the skills are inert and the
permission review will not mention them. `pi-plugin check` warns on that
combination.

## 6. Update path

1. `checkUpdates` when Extensions opens or on a schedule
2. Compare installed version with latest
3. UI shows the list of available updates
4. Download and upgrade after user confirmation

Strategy:
- Installed update metadata is checked silently when Extensions opens using
  only the last valid local catalog; this cache-only check must not hold the
  host RPC state lock behind a marketplace network timeout.
- An explicit check refreshes the remote catalog and falls back to the last
  valid cache when offline.
- Optional auto-update remains per-plugin and never silently accepts a new
  permission.

## 7. Marketplace UI information architecture

```text
Extensions
├─ Installed
│ ├─ Search + result count
│ └─ Groups: Needs attention · Updates available · Active · Turned off
├─ MCP
├─ Skills
├─ Marketplace
│ ├─ Search
│ ├─ Categories
│ └─ Card grid
├─ Detail sheet (shared by both tabs)
└─ Permission dialog (install / upgrade)
```

All five surfaces live under one segmented control that carries relevant
per-tab counts. There is no separate numeric overview band; the update alert,
tab counts, and installed group counts retain the actionable state without
duplicating it in a static card row (D196). The header keeps a single
contextual primary action (Browse marketplace / Refresh marketplace) and moves
Check for updates, Apply automatic updates, Install package, and Load local
plugin into an overflow menu (D169).

Installed rows intentionally default to a quiet two-line summary containing the
plugin name, optional local-source marker, id, and version. The state group
heading carries Active / Turned off / Updates available / Needs attention, and
load errors remain inline. Capabilities, resident service status, and
risk-tinted permission chips are rendered inside a collapsed native Details
disclosure; expanding it exposes the existing full readout without making every
row tall. Installed rows use one current-state scope trigger; opening it shows
the three scope choices with their explanations, and choosing This project
opens the existing project picker. Row icon actions remain visible at rest and
show their labels on hover and keyboard focus. This is a renderer-only
presentation choice; plugin
permissions and activation contracts are unchanged.

The Detail sheet must show:
- Permissions, grouped and labeled by risk tier
- Author
- Version (selectable version list)
- Update time
- Risk description (safety notes callout)
- Install button

The Extensions list page keeps its overview copy compact: the page header and
tab labels identify the surface, while section headers and empty states use
direct labels and actions without explanatory paragraphs. Explanations remain
where they help a decision — permission review, detail sheets, editors, and
error states.

Marketplace cards render a monogram glyph rather than fetching `iconUrl`; the
renderer performs no remote image loads (D169).

Closing a detail sheet with Escape clears focus from its marketplace opener,
matching pointer dismissal: no line or focus ring remains on the card.
Subsequent Tab navigation still shows a complete focus ring inside the rounded
detail button in both themes, without clipping above the install footer.

## 8. Trust model

| Level | Meaning |
|---|---|
| verified | Official or certified publisher |
| community | Community plugin |
| unknown | Custom source / uncertified |

The UI must make the trust level visible.
Community must not be disguised as verified.

Under catalog v2 the level is issued by the plugin center, not asserted by a
publisher. The client renders `unknown` for any entry whose level it cannot
attribute to the configured official source, and never promotes a level because
the catalog says so. A v1 catalog's boolean `verified` maps to `verified` /
`community` unchanged, because a v1 catalog is only writable by marketplace
maintainers.

## 9. Private sources (future enterprise support)

The shipped client does not expose or persist a private catalog source. The
`PI_DESKTOP_PLUGIN_MARKET_URL` override is limited to local development and
tests; it is not a product setting. Enterprise source support requires a
future product decision and explicit security and authorization design.

## 10. Remote API draft (HTTP)

> Draft (post-MVP). Not a final implementation binding; protocol draft only.

- `GET /v1/plugins?query=&category=&page=`
- `GET /v1/plugins/:id`
- `GET /v1/plugins/:id/versions`
- `GET /v1/plugins/:id/download?version=`
- `POST /v1/updates/check`

All download metadata must include `shasum`.

## 11. Explicitly not doing (marketplace v1)

- In-app paid checkout
- Remote plugin code hot patching
- Silent auto-install
- Unverified download-and-execute
- Comment/social system (can be deferred)

## 12. Acceptance (marketplace read-only + install)

1. Can browse the plugin list
2. Can view permissions and versions
3. Can download and install
4. Cannot install if validation fails
5. Appears in Installed after install


## 12. Implementation status

Desktop Extensions page now includes a Marketplace tab that calls:

- `market.search`
- `market.getDetail`
- `market.install`
- `market.checkUpdates`
- `market.applyUpdates`

Installs always pass through checksum verification and permission review before enable.


## 13. Official marketplace repository

The distribution repository
([vastsa/pi-desktop-plugins](https://github.com/vastsa/pi-desktop-plugins)) holds the published
`catalog.json` and the `packages/*.piplug` artifacts it references. Plugin sources are neither
hosted nor reviewed there: the center packs, audits, records the SHA-256 and publishes from each
publisher's own repository, then publishes the official catalog and package references
([15-plugin-center.md](15-plugin-center.md),
[ADR 0276](../../adr/0276-official-plugin-channel-and-backup-channels.md)).

### Retired source layout (catalog v1)

```text
catalog.json               # published catalog, generated by the center
packages/*.piplug          # published artifacts
plugins/<id>/              # removed — sources live in each publisher's repository
scripts/pack_plugin.py     # removed — the center packs
scripts/rebuild_catalog.py # removed — the center generates the catalog
```

The per-plugin maintenance flow this section used to describe (edit `plugins/<id>`, pack, rebuild
the catalog, commit) is gone. A release is published on the center — tag the publisher's
repository, bind it to the plugin, submit the version — and `catalog.json` arrives by mirror.

### Who writes it (catalog v2)

Repository: [vastsa/pi-plugin-center](https://github.com/vastsa/pi-plugin-center)

This repository stays the distribution source. What changes is who writes to it:
the plugin center takes over generating `catalog.json` and publishing
`packages/*.piplug`, and third-party plugin source stays in the publisher's own
repository rather than under `plugins/`.

The default catalog URL, the mirror URL, and the relative package URLs are all
unchanged, so no client release or user action is needed. Because the catalog and
packages are static files here and on the CNB Git mirror, browse, install, and
update keep working even when the center's API is unavailable.

See [15-plugin-center.md](15-plugin-center.md).

An explicit update check performs a fresh remote catalog fetch and falls back
to the last valid local catalog when offline. Opening the Extensions page also
performs a cache-only silent update check so installed rows can refresh without
making the Marketplace surface wait for a remote request. The Marketplace
header refresh action remains the explicit remote-refresh path.

Override catalog URL with env:

```text
PI_DESKTOP_PLUGIN_MARKET_URL=https://raw.githubusercontent.com/<owner>/<repo>/<ref>/catalog.json
```


## 14. Marketplace detail UX

The Extensions destination opens details as a right-side sheet (scrim + Escape + outside
click dismiss) that loads `market.getDetail` and shows:

- about text, author, and repository / homepage links (opened in the work
  panel browser, never the system browser)
- safety notes as a warning callout
- permissions grouped by risk tier, each with its plain-language explanation
- version list as selectable rows, with the picked version driving the sticky
  install / update action
- README markdown

Installing from either tab routes through the permission dialog, which groups
requests into High / Medium / Low risk sections and tags entries that are new
relative to the installed version, so an upgrade cannot silently widen access
(D169).

Authoring documentation lives with the host, and publishing happens on the center:

- Host guide: `docs/plugin-development.md`
- Publishing: [plugins.aiuo.net](https://plugins.aiuo.net) — console, or the publish skill over MCP
- Built-in templates: `panel-basic`, `agent-tool-basic`, `skill-pack`, `full-demo`
- Distribution-side contribution guide: `vastsa/pi-desktop-plugins` `CONTRIBUTING.md`

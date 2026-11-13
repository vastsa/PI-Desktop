# ADR: Native Desktop DNS over HTTPS

- Status: Implemented candidate
- Date: 2026-10-31
- Integration: 2026-11-08
- Related: ADR 0177, ADR 0272, ADR 0321, ADR 0348

## Context

Desktop has separate Chromium, Node provider, and Rust Host transports. A
Chromium-only setting would leave provider traffic on the system resolver.
Installed sidecar patches duplicate DNS and lifecycle ownership and can disappear
on upgrade. The existing native-network implementation is integrated with the
independent subagent controls so both behaviors share one source candidate.

## Decision

1. Keep optional, device-local `AppSettings.networkDns`: `mode` is `system`
   by default or `doh`; `serverUrl` is an HTTPS RFC 8484 POST endpoint and
   `allowSystemFallback` defaults false. Validate writes at renderer, Main, and
   Host boundaries. Invalid stored settings normalize to system mode. Disabling
   retains endpoint/fallback preferences; omission preserves saved values.
2. Electron owns configuration through `app.configureHostResolver`, using its
   built-in resolver in `secure` mode, or `automatic` only with explicit fallback.
   The default is `https://1.1.1.1/dns-query`; custom hostname endpoints may need
   system bootstrap resolution. TLS and hostname verification remain enabled.
   Credentials, fragments, URI templates, and oversized endpoints are rejected.
3. With no opt-in, do not change Chromium startup defaults. Disabling an active
   override restores platform defaults. Never change OS DNS, trust stores,
   interfaces, the user's proxy/VPN, or installed plugin settings.
4. Supply the Desktop resolver to the existing authenticated loopback relay.
   Local provider and Host marketplace requests use the relay in every proxy
   mode while DoH is enabled. Proxy and bypass policy remain authoritative;
   proxied destination hostnames stay with the proxy. Missing required relay
   configuration fails closed. No global `dns.lookup` replacement is introduced.
5. Apply settings in order from the Host's persisted merged snapshot, not an
   incoming partial patch or settings-write acknowledgement. `bootBackends`
   restores networking before sidecar admission; later UI bootstrap cannot replay
   stale settings. Publish a sidecar only after configuration succeeds against
   the same Host and latest network settings. Failed, replaced, or quitting
   candidates are disposed. Plugin restoration still precedes agent startup.
6. Effective DNS changes invalidate resolver caches and the lookup generation.
   Old results cannot start new connections; timeout/cancellation/disposal observe
   late native completion. Failed application blocks lookups until recovery.
   Existing connected requests are not interrupted just to clear cached state.
7. Public-fetch checks use the same resolver and retain address, redirect, TLS,
   and pinned-address guards. The optional `desktopDnsEnabled` runtime field
   defaults false for legacy callers and is validated as boolean when supplied.
   Host curl uses `socks5h` and an empty `--noproxy` while Desktop owns DNS.
8. DNS remains excluded from portable config sync. Workspace Bash, external
   browsers, independent headless/remote hosts, and transports with a separate
   pinned-DNS policy are not reconfigured. Retry preferences and child execution
   ownership retain their existing contracts.

## Alternatives and consequences

Chromium-only configuration leaves the main provider path uncovered. Per-process
DNS implementations duplicate caches and cancellation; sidecar monkey patches
require installed-file mutation. Changing OS DNS affects unrelated applications.
The native resolver plus existing authenticated relay avoids those ownership
changes, at the cost of requiring the relay while secure DNS is active.

Settings persist before live application. An apply error can leave the preference
saved; retrying or disabling is supported rather than transactional rollback.
Strict outages block new app-owned connections; fallback remains a user choice.
Proxy-side DNS and TUN routing remain outside Desktop's control.

## Validation and qualification

Shared contracts, native resolver/controller tests, relay tests, settings IPC,
startup races, sidecar RPC, and temporary Host database/config-sync tests cover
separate boundaries. The renderer fixture exercises real controls with mocked
IPC/persistence. The native Electron fixture uses real resolver APIs, loopback
RFC 8484 servers, the authenticated relay, and only the test certificate's SPKI;
there is no global TLS bypass or resolver-rule override.

Source and isolated-process checks are not deployment, installed-client, signed
release, or PR-integration acceptance. No installer or plugin package is created
for this integration task. See the native DNS scenario in the E2E test plan.

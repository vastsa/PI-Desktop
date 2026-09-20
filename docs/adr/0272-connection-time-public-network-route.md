# ADR 0272: Judge a public-network address on the route the request will dial

- Status: Accepted for implementation
- Date: 2026-09-17
- Deciders: PI-Desktop core
- Related: ADR 0177, ADR 0243, ADR 0245, D413, D414, issue #419, PR #473

## Context

`createPublicHttpsClient` guards every credential-free public HTTPS fetch the
skill market makes from Electron main (ADR 0243). Before each hop it classified
the target host with **Node's local resolver** (`node:dns`) and refused any hop
whose answers were not public.

The request itself never used that answer. `fetchImpl` is `net.fetch`, which
dials through Chromium's proxy stack, and ADR 0177 points that stack at the
configured proxy (System, or a Custom `http`/`https`/`socks` URL). Under an
HTTP/HTTPS proxy the hostname travels in the `CONNECT` line and the *proxy*
resolves it; nothing in this app resolves or dials the destination.

The pre-check therefore judged an address no request would ever use, and a whole
class of working setups was refused for it. Clash, Mihomo and Surge answer DNS
with a synthesized fake-IP (`198.18.0.0/15` by default) while their TUN device or
proxy carries the real connection: `classifyIpLiteral` reads `198.18.0.1` as
`benchmark`, which is not public, so every catalog source failed with "the
catalog source was blocked by the app's address check" even though the in-app
browser and the transport itself worked (issue #419, reported on 0.14.8).

PR #473 made that refusal legible — structured `reason`, `addressKind`,
`NETWORK_RESOLVE_FAILED`, the market's `unresolved` kind — and left the boundary
alone, because moving the classification out of the pre-check is a security
boundary change. This ADR is that change.

## Decision

1. **The address verdict follows the route the request will actually take.** For
   every hop, immediately before that hop is dialed, the client asks the session
   that carries `fetchImpl` for its own proxy decision on exactly that URL
   (`Session.resolveProxy`, wired beside `net.fetch` in `skill-market-catalog.ts`).
   The shared `classifyProxyRoute` reduces the answer to `proxied`, `direct`, or
   `unknown`.

2. **A proxied route replaces the local address verdict; it does not remove it.**
   On `proxied`, the shared `isAcceptableResolvedAddress` tolerates exactly one
   class the old rule refused: `benchmark` — the RFC 2544 range a TUN fake-IP
   resolver synthesizes, i.e. the resolver's own artifact rather than a target.
   Every other non-public class (`private`, `loopback`, `link-local`, `cgnat`,
   `multicast`, `reserved`, `documentation`, `ula`, `site-local`, `invalid`,
   `unspecified`) still refuses, and an unanswered resolver still refuses as
   `resolve-failed`. A local answer naming a real internal target stays evidence
   of a split-horizon or hostile resolver, and this app cannot see what the proxy
   would dial for it.

3. **`direct` and `unknown` keep the pre-ADR rule byte for byte.** The app dials
   the resolved address itself there, so only `public` passes. `unknown` covers no
   route resolver wired at all, a resolver that throws, an empty or unparsable
   answer, and a list that offers `DIRECT` anywhere — Chromium may fall back to a
   direct connection, so an offered direct hop is never read as proxied. Fail
   closed, exactly as before.

4. **The syntactic guard is untouched.** `isSafePublicHttpsUrl` still runs first
   for every hop and still refuses non-HTTPS, credential-bearing, non-public
   literal, and `localhost` / `.local` / `.internal` URLs. Redirects stay
   `manual` with a five-hop cap, and **every hop** re-runs the whole check, route
   included.

5. **The route travels with the refusal.** `PublicNetworkRefusal` /
   `PublicNetworkRefusalDetail` gain `route`, so the diagnostics line and the
   market's `failureDetails` say which route the address was judged on. A
   `benchmark` refusal on a `direct` route means "the transport sees no proxy for
   this URL and the app would dial the synthesized address itself"; the same
   refusal on `unknown` means no route could be read at all.

## Threat model

What the guard stopped before this ADR:

- Non-HTTPS, credential-bearing, and non-public-literal URLs — unchanged.
- A hop whose **local** resolver answers with a private, loopback, link-local,
  CGNAT, ULA, site-local, multicast, reserved, or documentation address. On a
  direct route that is the address the app dials, so this was real protection and
  stays exactly as it was.

What changes:

- **Still stopped:** everything above on `direct` / `unknown`, plus every address
  class except `benchmark` on `proxied`.
- **Weakened, precisely:** on a `proxied` route, a public hostname whose *local*
  answer is inside `198.18.0.0/15` is no longer refused. Consequences:
  - **SSRF to an internal service through the proxy.** If the proxy — or the TUN
    capture behind a fake-IP answer — resolves that name to an internal address,
    the app will have carried the request to it. The app cannot observe that hop:
    the only peer it ever dialed is the proxy. Reaching internal targets is now
    bounded by the proxy's own rule set (Clash's default rule set rejects LAN
    targets; a permissive or corporate proxy will not).
  - **Cloud metadata endpoints.** `169.254.169.254`, `fd00:ec2::254` and similar
    are still refused whenever the *local* answer names them (link-local / ULA),
    on both routes. The new hole is indirect: a name whose local answer is a
    fake-IP address, which the proxy then resolves to a metadata endpoint, is no
    longer judged.
  - **`198.18.0.0/15` as an intranet range.** The range is reserved for
    benchmarking and is not publicly allocated, but a lab or VPN could address
    hosts there; a name answering from it is no longer refused on a proxied
    route, and the TUN/proxy decides where it goes.
  - **Chromium proxy fallback.** The route is read as the *resolved* proxy list.
    Chromium may still retry a failed hop without the proxy, so `proxied` is a
    property of the configured route, not a proof about the socket that was used.
    A `DIRECT` entry anywhere in the list is therefore read as `unknown`.
  - **Who controls the route.** The user does, through Settings → Network
    (ADR 0177) or the OS/browser proxy configuration. Nothing in the renderer,
    in a catalog entry, or in a plugin can influence it, and nothing in the
    market path can write it.

Why that is acceptable:

- The property the guard protects is "this app never dials an internal address by
  itself". On a proxied route that property is *stronger* than before rather than
  weaker: the app's only possible peer is the user-configured proxy, and the
  destination is chosen by that proxy instead of by a name whose resolution an
  attacker may control. What the pre-check actually enforced on a proxied route
  was a claim about a resolver the request did not use — it produced the false
  positive in #419 without ever inspecting the dialed peer.
- The one class now tolerated is *by construction* the signature of local
  interception rather than of an internal target: `198.18.0.0/15` is RFC 2544
  benchmarking space and hosts no service.
- Everything the guard can still verify in-process — URL shape, per-hop
  re-validation, every real internal address class, an unanswered resolver — is
  still verified, and the verdict is now made about the object the request will
  actually use.

When to roll this back:

- If Electron ever exposes the peer a request actually connected to, and it is
  not the proxy, replace the route verdict with that peer check. The route
  verdict exists only because the dialed peer is not observable.
- If a report shows a proxied hop reaching a private or metadata target through a
  fake-IP answer, or Chromium falling back to a direct connection the route list
  did not advertise, restore the strict verdict for that case and keep the
  fake-IP case behind an explicit user setting instead.
- If `Session.resolveProxy` stops reporting the configured proxy, the route
  collapses to `unknown` and the guard returns to the strict behavior by itself.
  That failure direction — the pre-#419 false positive returns rather than a
  private target being dialed — is the intended one.

## Consequences

- A proxied or fake-IP user's skill market works: no source is refused for an
  address the request would never dial (issue #419).
- A `direct`-route user keeps the old verdicts, so the change cannot be used to
  reach an internal address by not being behind a proxy.
- The MCP market is **not** covered by this change. It dials a pinned public
  address with Node HTTPS (ADR 0245), so its guard already checks the address it
  connects to, and it does not consult Chromium's proxy route; a fake-IP
  environment still refuses MCP market sources. Fixing that means giving that
  path a proxy-aware pinned dispatcher, which ADR 0245 already lists as open
  work.
- A TUN user who configured no proxy the app can see is still refused: the
  transport reports `DIRECT` while the local resolver answers fake-IP. That case
  is deliberately left strict (clause 3), and its remedy is to enable the system
  proxy or set the app's Custom proxy, after which the route is proxied and the
  market works.
- The route is read once per hop, so the market pays one extra `resolveProxy`
  round trip per hop — bounded by the same five-hop cap.

## Alternatives

- **Delete the DNS gate for every request.** Rejected: it removes the SSRF guard
  for direct users too, and the guard would no longer stop a private answer from
  being dialed by the app itself.
- **Relax `198.18.0.0/15` unconditionally.** Rejected: it accepts an answer the
  app cannot attribute to an interception layer, and it silently allows a
  connection to a host addressed in that range on a direct route.
- **Let the user allowlist a source.** Rejected: it moves a security decision to
  a user who cannot see what the address would be used for, needs new settings
  and UI for a case the app can decide, and would not have helped in #419, where
  every source was refused at once.
- **Check the peer after connecting.** Unavailable, and the honest reason this
  ADR exists: Electron's `net.fetch` performs proxy resolution and dialing inside
  the network service and exposes no peer address afterwards. The pre-ADR guard
  could not do this either, which is why its proxied verdict was noise.
- **Read the route from the app's own proxy settings only.** Rejected as
  incomplete: it would miss PAC and OS-level proxy configuration, which is
  exactly what a Clash-style "system proxy" setup uses. `Session.resolveProxy`
  reports what the session will really use, PAC included.

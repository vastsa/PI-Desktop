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

## Decision

1. **The address verdict follows the route the request will actually take.** For
   every hop, immediately before that hop is dialed, the client asks the session
   that carries `fetchImpl` for its own proxy decision on exactly that URL
   (`Session.resolveProxy`, wired beside `net.fetch` in
   `skill-market-catalog.ts`).

2. **A proxied route replaces the local address verdict; it does not remove
   it.** On `proxied`, the shared `isAcceptableResolvedAddress` tolerates
   exactly one class the old rule refused: `benchmark` — the RFC 2544 range a
   TUN fake-IP resolver synthesizes, i.e. the resolver's own artifact rather
   than a target.

3. **`direct` and `unknown` keep the pre-ADR rule by default.** The app dials
   the resolved address itself there, so only `public` passes.

4. **The syntactic guard is untouched.** `isSafePublicHttpsUrl` still runs first
   for every hop and still refuses non-HTTPS, credential-bearing, non-public
   literal, and `localhost` / `.local` / `.internal` URLs.

5. **The route travels with the refusal.** `PublicNetworkRefusal` /
   `PublicNetworkRefusalDetail` gain `route`, so the diagnostics line and the
   market's `failureDetails` say which route the address was judged on.

## Threat model

What the guard stopped before this ADR:

- Non-HTTPS, credential-bearing, and non-public-literal URLs — unchanged.
- A hop whose **local** resolver answers only with a private, loopback,
  link-local, CGNAT, ULA, site-local, multicast, reserved, or documentation
  address.

What changes:

- **Still stopped:** every refused address when it is the only possible direct
  target; everything above on `unknown`; plus every address class except
  `benchmark` on `proxied`.
- **Weakened, precisely:** on a `proxied` route, a public hostname whose *local*
  answer is inside `198.18.0.0/15` is no longer refused.
  - **SSRF to an internal service through the proxy.** If the proxy — or the TUN
    capture behind a fake-IP answer — resolves that name to an internal address,
    the app will have carried the request to it.
  - **Cloud metadata endpoints.** `169.254.169.254`, `fd00:ec2::254` and similar
    are still refused whenever the *local* answer names them (link-local / ULA),
    on both routes.
  - **`198.18.0.0/15` as an intranet range.** The range is reserved for
    benchmarking and is not publicly allocated, but a lab or VPN could address
    hosts there; a name answering from it is no longer refused on a proxied
    route, and the TUN/proxy decides where it goes.
  - **Chromium proxy fallback.** The route is read as the *resolved* proxy list.
  - **Who controls the route.** The user does, through Settings → Network (ADR
    0177) or the OS/browser proxy configuration.

- The property the guard protects is "this app never dials an internal address
  by itself".
- The one class now tolerated is *by construction* the signature of local
  interception rather than of an internal target: `198.18.0.0/15` is RFC 2544
  benchmarking space and hosts no service.
- Everything the guard can still verify in-process — URL shape, per-hop
  re-validation, every real internal address class, an unanswered resolver — is
  still verified, and the verdict is now made about the object the request will
  actually use.

- If Electron ever exposes the peer a request actually connected to, and it is
  not the proxy, replace the route verdict with that peer check.
- If a report shows a proxied hop reaching a private or metadata target through
  a fake-IP answer, or Chromium falling back to a direct connection the route
  list did not advertise, restore the strict verdict for that case and keep the
  fake-IP case behind an explicit user setting instead.
- If `Session.resolveProxy` stops reporting the configured proxy, the route
  collapses to `unknown` and the guard returns to the strict behavior by itself.

## Consequences

- A proxied or fake-IP user's skill market works: no source is refused for an
  address the request would never dial (issue #419).
- A `direct`-route user keeps the old verdicts by default.
- The MCP market now applies the same route-aware verdict before each hop.
- A TUN user who configured no proxy the app can see is still refused: the
  transport reports `DIRECT` while the local resolver answers fake-IP.
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
  ADR exists: Electron's `net.fetch` performs proxy resolution and dialing
  inside the network service and exposes no peer address afterwards.

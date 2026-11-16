# ADR 0321: Pin an acceptable address for mixed direct DNS answers

- Status: Accepted
- Date: 2026-10-06
- Deciders: PI-Desktop core
- Related: ADR 0243, ADR 0272

## Context

The Skill Market validates every address the local resolver returns and then uses
Chromium `net.fetch`. On a direct route a response carrying a usable public IPv4
address plus a synthetic ULA IPv6 address is rejected even though Main could use the
IPv4 one, and under a TUN fake-IP resolver `net.fetch` can select a rejected IPv6
placeholder after the guard accepted an IPv4 result.

## Decision

1. On a `direct` route only, when at least one result is rejected and an acceptable
   one exists, the Skill Market may select one acceptable result and pin the request
   to that address. Third-party content prefers a public address; the `benchmark`
   range is eligible only under the existing fake-IP opt-in, and a user-supplied
   first-hop endpoint keeps its own address policy.
2. The pinned transport keeps the original hostname for TLS SNI and HTTP `Host`,
   disables automatic redirects, respects the abort signal, and re-checks and repins
   at every redirect.
3. A ULA-only answer or any answer without an acceptable address stays refused, and
   proxied or `unknown` routes keep ADR 0272's verdict.

## Consequences

- Dual-stack and transparent-proxy answers no longer fail because an unused ULA
  result accompanies a usable address, and Main never connects to the ignored one.
- Direct mixed-answer requests use Node's HTTP(S) transport while proxied requests
  stay on Chromium's `net.fetch`, and no persisted network policy, URL, or redirect
  rule changes.

## Alternatives

- Permit all ULA answers on a direct route: ULA can name a real LAN or VPN service.
- Keep `net.fetch` after accepting one address: Chromium may resolve again and
  connect to the rejected address.
- Require users to disable IPv6 or change proxy DNS: Main can pin an already
  acceptable address.

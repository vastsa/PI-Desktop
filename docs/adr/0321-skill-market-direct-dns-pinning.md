# ADR 0321: Pin an acceptable address for mixed direct DNS answers

- Status: Accepted
- Date: 2026-10-06
- Deciders: PI-Desktop core
- Related: ADR 0243, ADR 0272

## Context

The Skill Market validates each address returned by the local resolver, then
uses Chromium `net.fetch`. On a direct route, a DNS response that contains a
usable public IPv4 address plus a synthetic ULA IPv6 address is rejected, even
though Main can safely connect to the public IPv4 address.

## Decision

1. On a `direct` route only, if at least one DNS result is rejected and an
   acceptable result exists, the Skill Market may select one acceptable result
   and pin the direct request to that exact address.
2. The pinned transport preserves the original hostname for TLS SNI and the HTTP
   `Host` header, disables automatic redirects, and respects the existing
   request abort signal.
3. A ULA-only DNS result, or any other answer with no acceptable address,
   remains refused.

## Consequences

- Dual-stack and transparent-proxy answers no longer fail solely because an
  unused ULA result accompanies a public address or an explicitly permitted
  benchmark fake-IP.
- Direct mixed-answer requests use Node's HTTP(S) transport with the selected
  address pinned.
- This does not permit internal destinations, alter the persisted network
  policy, or change the URL/redirect rules.

## Alternatives

- Permit all ULA answers on a direct route: rejected because ULA can name a real
  LAN or VPN service and would weaken the third-party network boundary.
- Keep using `net.fetch` after accepting one address: rejected because Chromium
  may resolve the hostname again and connect to the rejected address.
- Require users to disable IPv6 or change proxy DNS: rejected as the sole fix
  because Main can safely pin an already acceptable address without requiring
  system network changes.

# ADR 0272: Judge a public-network address on the route the request will dial

- Status: Accepted for implementation
- Date: 2026-09-17
- Related: ADR 0177, ADR 0243, ADR 0245, ADR 0321, D413, D414, issue #419, PR #473

## Context

`createPublicHttpsClient` guards every credential-free public HTTPS fetch the skill
market makes from Electron main and classified each hop with Node's local resolver.
The request itself dials through Chromium's proxy stack, where a proxied hostname
is resolved by the proxy, so the pre-check judged an address no request would use
and refused working setups: a TUN resolver answering with a synthesized fake-IP in
the RFC 2544 range failed every catalog source even though the transport worked
(issue #419). PR #473 made that refusal legible without moving the boundary, and
this record moves it.

## Decision

1. **The address verdict follows the route the request will actually take.** Before
   each hop is dialed, the client asks the session carrying `fetchImpl` for its
   proxy decision on exactly that URL (`Session.resolveProxy`), and the shared
   `classifyProxyRoute` reduces the answer to `proxied`, `direct`, or `unknown`.
2. **A proxied route replaces the local address verdict; it does not remove it.**
   On `proxied`, `isAcceptableResolvedAddress` tolerates only the `benchmark` class
   that a TUN fake-IP resolver synthesizes, while every other non-public class and
   an unanswered resolver still refuse.
3. **`direct` and `unknown` keep the pre-ADR rule by default.** Only `public`
   passes there; an explicit `allowFakeIp` setting may additionally permit the
   `benchmark` placeholder class for transparent router or TUN deployments and
   never another non-public class, a mixed answer may pin one acceptable address
   (ADR 0321), and `unknown` fails closed.
4. **The syntactic guard is untouched.** `isSafePublicHttpsUrl` still runs first,
   redirects stay `manual` under a hop cap, and every hop re-runs the whole check.
5. **The route travels with the refusal.** `PublicNetworkRefusal` and its detail
   gain `route`, so diagnostics state which route the address was judged on.

## Consequences

- Proxied and fake-IP users get a working skill market, and direct-route users keep
  the old verdicts with an opt-in limited to benchmark placeholders.
- On a proxied route the app's only peer is the user-configured proxy, so reaching
  internal targets is bounded by that proxy's own rule set.
- The MCP market applies the same route-aware verdict and pays one extra
  `resolveProxy` round trip per hop, and a TUN user with no proxy the app can see
  is still refused.

## Alternatives

- Delete the DNS gate for every request: rejected, it removes the SSRF guard for
  direct users too.
- Relax the benchmark range unconditionally: rejected, it accepts an answer the app
  cannot attribute to an interception layer.
- Check the peer after connecting: unavailable, because Electron's `net.fetch`
  exposes no peer address.

# ADR 0304: Trust the network endpoints the user enters themselves

- Status: Accepted for implementation
- Date: 2026-09-22
- Related: ADR 0142, ADR 0177, ADR 0243, ADR 0245, ADR 0247, ADR 0257, ADR 0272, ADR 0300

## Context

ADR 0243, ADR 0245, ADR 0247 and ADR 0272 built one public-network boundary and
applied it to every request the app makes on its own behalf: a market source, a
redirect hop, a git remote, a resolved address. That boundary is load-bearing.

## Decision

1. A **user-supplied endpoint** may reach loopback, RFC1918, CGNAT, link-local,
   ULA, site-local and `.local` addresses, as well as any public address.
2. One host-owned switch, **Relaxed network mode**
   (`settings.networkPolicy.mode`, `relaxed` | `strict`), **defaults to
   `relaxed`**.
3. **Third-party content keeps the strict policy.** A registry record, a market
   catalog body, a document URL inside a catalog, and every HTTP redirect target
   are still judged by the public-only rule, with the resolved address pinned to
   the connection.
4. An OAuth authorization server reached over plaintext is trusted only when it
   sits on the same host as the MCP server the user typed.
5. `unspecified`, `multicast`, `reserved`, `documentation`, `invalid` and cloud
   metadata stay refused on **every** input, including a user-supplied one.
6. The default proxy bypass list gains the private ranges, so a configured proxy
   does not swallow the user's own LAN services.
7. The syntactic judgement stays in `packages/shared`, and the authoritative one
   stays at the connection: a DNS answer outside the policy is refused before
   the socket, and an acceptable address is pinned to it (ADR 0245, ADR 0272).

## Consequences

- A model endpoint, an MCP server, a market source, a git remote and a
  generated-image URL can all point at the user's own machine or LAN from inside
  the app, instead of only from a shell next to it.
- The main process gains an SSRF-shaped capability whose targets the user typed
  on purpose.
- A plaintext hop to a LAN service is on by default and announced once: whatever
  credentials that endpoint accepts travel unencrypted across the local network,
  so the user is told the first time it happens and can turn the mode off.
- ADR 0247's consequence — "clone a private-host repository with an
  application-external git remote" — no longer applies.

## Rejected alternatives

- **Keep refusing LAN addresses for user-supplied endpoints, and document the
  workaround.** Rejected: the workaround is the same request from a different
  process, so the refusal buys no security and costs the feature.
- **Trust every address everywhere, including third-party content.** Rejected:
  that is the SSRF path the guard exists for — a catalog body, a registry record
  or a redirect is content the app received from someone else, and DNS rebinding
  makes a pre-flight check alone insufficient (ADR 0245).
- **Permit cloud metadata as well, since the user typed it.** Rejected: the
  metadata service returns instance credentials to anything that asks, it is
  never a service a user runs, and an address that appears in a settings field
  is far more likely to be an injected payload than a deliberate choice.
- **Per-source acknowledgement stored with the source list.** Rejected: the
  source list lives in renderer storage, where a flag is exactly as trustworthy
  as the URL next to it, so it would add UI without adding a boundary.

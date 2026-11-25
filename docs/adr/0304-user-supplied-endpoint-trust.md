# ADR 0304: Trust the network endpoints the user enters themselves

- Status: Accepted for implementation
- Date: 2026-09-22
- Related: ADR 0142, ADR 0177, ADR 0243, ADR 0245, ADR 0247, ADR 0257, ADR 0272, ADR 0300

## Context

ADR 0243, 0245, 0247, and 0272 built one public-network boundary for every
request the app makes on its own behalf, which is load-bearing and must stay. The
same boundary also refused addresses the user typed into a settings field — a
self-hosted GitLab, a LAN ComfyUI, an MCP OAuth server on a private address —
which removed the request without removing the work and left three surfaces
(ADR 0142, ADR 0300, ADR 0257) already making the distinction, so one boundary
carried two meanings.

## Decision

1. A user-supplied endpoint may reach loopback, RFC1918, CGNAT, link-local, ULA,
   site-local, and `.local` addresses as well as public ones; it is an address
   the person typed, such as a model base URL, an MCP server, a market source, a
   git remote, or a generated-image URL.
2. One host-owned switch, relaxed network mode (`settings.networkPolicy.mode`,
   `relaxed` | `strict`), defaults to `relaxed`, which allows those resolutions,
   plain `http`, and a transparent proxy's fake-IP answers; per-surface
   acknowledgements fold into it and a stored
   `allowInsecureUserEndpoints: false` migrates to `strict`, with the first
   plaintext hop to a user endpoint announced once.
3. Third-party content keeps the strict policy: a registry record, a catalog
   body, a document URL inside a catalog, and every redirect target are still
   public-only with the resolved address pinned to the connection, so the shared
   client records whether each hop's origin is `user` or `third-party`.
4. An OAuth authorization server over plaintext is trusted only on the same host
   as the MCP server the user typed, since every other endpoint in that flow
   arrives inside server metadata; loopback stays allowed (RFC 8252).
5. `unspecified`, `multicast`, `reserved`, `documentation`, `invalid`, and cloud
   metadata stay refused on every input, including a user-supplied one.
6. The default proxy bypass list gains the private ranges, and the syntactic
   judgement stays in `packages/shared` while the authoritative one stays at the
   connection (ADR 0245, ADR 0272).

## Consequences

- A model endpoint, MCP server, market source, git remote, and generated-image
  URL can point at the user's own machine or LAN from inside the app.
- The main process gains an SSRF-shaped capability aimed at addresses the user
  typed, while paths the user did not type stay public-only and refusals still
  name the address class (issue #419).
- ADR 0247's external-git-remote consequence no longer applies; the
  user-supplied items in ADR 0243, 0245, and 0247 are amended here, and their
  third-party rules stand.

## Rejected alternatives

- Keep refusing LAN addresses and document the workaround: the workaround is the
  same request from another process, so the refusal buys no security.
- Trust every address everywhere: that is the SSRF path the guard exists for,
  and a pre-flight check alone cannot stop DNS rebinding (ADR 0245).
- Permit cloud metadata as well: the metadata service returns instance
  credentials and is never a service a user runs.

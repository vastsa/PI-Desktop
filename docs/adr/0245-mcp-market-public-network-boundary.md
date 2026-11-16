# ADR 0245: Harden the MCP market public-network boundary

- Status: Accepted
- Date: 2026-09-14
- Related: ADR 0142, ADR 0177, PR #285

## Context

The MCP market fetches user-configurable Registry and catalog sources from Electron
Main. A syntactic HTTPS check plus a separate DNS lookup cannot enforce a
public-network boundary, because a DNS-rebinding source can resolve publicly during
validation and privately when the client connects, and unbounded responses can
exhaust the main process. Dropping the Registry's published versions and launcher
arguments would also make an install resolve mutable latest content.

## Decision

1. URL validation accepts credentials-free HTTPS only and rejects loopback,
   unspecified, private, CGNAT, link-local, multicast, reserved, documentation,
   benchmark, ULA, site-local, IPv4-mapped, and IPv4-compatible ranges, including
   URL-normalization and trailing-dot forms.
2. Main asks the Electron session for its proxy route immediately before connecting.
   On a `direct` or `unknown` route it pins the selected public address to the HTTPS
   socket while keeping the original host as TLS SNI and HTTP `Host`; on a `proxied`
   route it uses that session's `net.fetch`, tolerating the resolver's `benchmark`
   class under ADR 0272 while still rejecting real private targets.
3. Redirects are manual, HTTPS-only, revalidated at every hop, and capped at five.
4. Responses are bounded to 4 MiB, DNS and HTTP share an eight-second deadline, at
   most 16 sources are processed per call, and caches are bounded.
5. npm packages map to `identifier@version` and PyPI to `identifier==version`, with
   runtime and package arguments preserved in order; only `streamable-http` remotes
   with public HTTPS endpoints are installable.
6. Catalog entries must be public HTTPS, while manual MCP configuration keeps the
   existing local/LAN policy; MCP HTTP redirects never forward authorization, cookie,
   proxy-authorization, or API-key headers to another origin.

## Consequences

- Public market data cannot use DNS rebinding to turn the Main fetcher into a
  private-network request, and slow, oversized, or malformed sources fail as one
  source without unbounded growth.
- A Registry or catalog entry is not a shortcut to a private MCP endpoint, which
  users can still add through the explicit MCP editor (ADR 0142).

## Alternatives

- Preflight DNS then ordinary fetch: the two resolutions leave a rebinding race.
- Allowlist only the official Registry hostname: user-hosted sources are supported.
- Install the Registry's latest package: ignores the published version.

# ADR 0245: Harden the MCP market public-network boundary

- Status: Accepted
- Date: 2026-09-14
- Related: ADR 0142, ADR 0177, PR #285

## Context

The MCP market fetches user-configurable Registry and catalog sources from
Electron Main. A syntactic HTTPS check and a separate DNS lookup are not enough
to enforce a public-network boundary: a DNS-rebinding source can resolve to a
public address during validation and to a private address when the HTTP client
connects.

## Decision

1. Shared renderer and Main URL validation accepts credentials-free HTTPS only.
2. Main asks the Electron session carrying each request for its proxy route
   immediately before connecting.
3. Redirects are manual, HTTPS-only, and revalidated at every hop, with a
   maximum of five redirects.
4. Market source responses are bounded to 4 MiB, DNS and HTTP requests share an
   eight-second deadline, at most 16 sources are processed per call, and the
   in-memory catalog/search caches are bounded.
5. Registry npm packages are mapped as `identifier@version` and PyPI packages as
   `identifier==version` when a version is present.
6. Market HTTP catalog entries are restricted to public HTTPS endpoints.

## Consequences

- Public market data cannot use DNS rebinding to turn the Main fetcher into a
  private-network request, subject to the operating system and proxy's own
  network behavior.
- Slow, oversized, malformed, or excessively configured sources fail as one
  source and do not grow the Main process without bound.
- Installs are reproducible with respect to the Registry package version and
  preserve the launch semantics that the publisher supplied.
- A Registry/catalog entry cannot be used as a market shortcut for a private MCP
  endpoint; users can still add such endpoints through the explicit MCP editor
  permitted by ADR 0142.
- Direct and unknown routes keep pinned Node HTTPS sockets and the strict
  public-address rule.

## Alternatives considered

- **Preflight DNS followed by ordinary fetch:** rejected because the two
  resolutions leave a DNS-rebinding race.
- **Allowlist only the official Registry hostname:** rejected because the
  product supports user-hosted catalog and Registry sources.
- **Install the Registry's latest package:** rejected because it ignores the
  version selected and published by the Registry.

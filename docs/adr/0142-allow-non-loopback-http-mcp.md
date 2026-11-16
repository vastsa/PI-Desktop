# ADR 0142: Allow non-loopback HTTP MCP endpoints with explicit risk disclosure

- Status: Accepted
- Date: 2026-09-01
- Related: [ADR 0038](0038-plugin-mcp-bridge.md), [ADR 0056](0056-extension-activation-scope.md), Issue #25

## Context

Self-hosted MCP servers are often deployed on a private LAN and expose only a
plain HTTP endpoint. The existing MCP client already speaks streamable HTTP, but
validation rejects every non-loopback `http://` URL.

## Decision

1. User-owned and plugin-declared MCP servers accept absolute `http://` and
   `https://` URLs.
2. The user MCP editor displays an explicit warning for non-loopback HTTP:
   credentials and tool calls may be intercepted.
3. A plugin-declared HTTP MCP server still requires `mcp.server.remote` and its
   host must be covered by `manifest.net.domains`.
4. The MCP HTTP client disables automatic redirect following, limits redirects
   to five hops, permits only HTTP(S) redirect targets, and invokes the optional
   endpoint policy for every hop.
5. Marketplace catalog and package download policy is unchanged.

## Consequences

- LAN-hosted self-developed MCP servers work without requiring TLS termination.
- The network allowlist remains authoritative for plugin-owned egress, including
  redirect targets.
- Users and plugin reviewers can see when a connection is unencrypted, but the
  host cannot make a plain HTTP server safe against network interception.
- SDK, renderer, host-core, client tests, security documentation, and E2E
  scenarios must describe the same HTTP policy.

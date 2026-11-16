# ADR 0142: Allow non-loopback HTTP MCP endpoints with explicit risk disclosure

- Status: Accepted
- Date: 2026-09-01
- Related: [ADR 0038](0038-plugin-mcp-bridge.md), [ADR 0056](0056-extension-activation-scope.md), Issue #25

## Context

Self-hosted MCP servers often sit on a private LAN behind plain HTTP, and the MCP
client already speaks streamable HTTP, yet validation rejected every non-loopback
`http://` URL, including servers the user had deliberately configured. Removing
that restriction must not remove the plugin permission or the egress boundary,
because an HTTP endpoint observes credentials, tool arguments, and results without
confidentiality or integrity.

## Decision

1. User-owned and plugin-declared MCP servers accept absolute `http://` and
   `https://` URLs; unsupported schemes and malformed URLs stay invalid.
2. The user MCP editor warns that credentials and tool calls may be intercepted,
   and saving a user-owned endpoint is that user's consent.
3. A plugin-declared HTTP MCP server still requires `mcp.server.remote` and a host
   covered by `manifest.net.domains`, with the same warning in review surfaces.
4. The MCP HTTP client follows no redirect automatically, allows five hops, only
   HTTP(S) targets, and applies the endpoint policy to every hop.
5. Marketplace catalog and package download policy is unchanged; non-loopback HTTP
   package downloads stay refused.

## Consequences

- LAN-hosted MCP servers work without TLS termination.
- The network allowlist stays authoritative for plugin egress, redirect targets
  included.
- The host can disclose an unencrypted connection but cannot make it safe, so
  trusted network placement remains an operational requirement.

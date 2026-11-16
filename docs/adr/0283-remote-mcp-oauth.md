# ADR 0283: Remote MCP Server OAuth 2.1 Authentication

- **Status**: Accepted
- **Date**: 2026-09-18
- **Related**: [ADR 0038](0038-plugin-mcp-bridge.md) · [ADR 0098](0098-multiple-vendor-oauth-accounts.md) · [ADR 0142](0142-allow-non-loopback-http-mcp.md)

## Context

Remote HTTP MCP servers such as Notion, Linear, or an enterprise server often
protect endpoints with OAuth 2.1 instead of static tokens, and MCP specifies
authorization discovery through RFC 9728 and RFC 8414, dynamic registration
through RFC 7591, and resource indicators through RFC 8707. PI-Desktop supported
only static HTTP headers, so users had to obtain bearer tokens by hand or could not
connect at all.

## Decision

OAuth login runs in Electron main inside `McpOAuthManager`, mirroring the
non-blocking vendor pattern of ADR 0098: `mcp/oauth/start` returns
`{ ok: true, loginId }` immediately and streams progress, the authorization URL,
completion, and failure through `pi-desktop/mcp/oauth/event`, while
`pi-desktop/mcp/oauth/cancel` closes the loopback listener and aborts the login.
The callback server binds strictly to IPv4 loopback on an ephemeral port with an
RFC 8252 redirect URI, escapes every inbound query parameter on its completion
page, and uses `redirect: "manual"` for discovery and token requests per ADR 0142.
RFC 8707 `resource` indicators are sent on the authorization and token requests,
dynamic-registration credentials are reused for the same registration endpoint, and
`expires_in` is parsed from numbers or strings. Tokens never reach the renderer:
they live in host-core encrypted secrets under `secret:mcp:<serverId>:oauth`,
refresh is serialized per server because refresh tokens rotate, and `mcp.transfer`
migrates the secret to the new id. `UserMcpRuntime` injects
`Authorization: Bearer <token>` into live connections and drops stale entries when
a token refreshes, and a `401` marks the server `authRequired: true` with
`state: "failed"`.

## Consequences

- OAuth-protected remote servers can be authorized from Settings, and a long
  browser interaction blocks no IPC channel or leaves an orphan listener on
  reload or quit.
- Token material stays out of the renderer and ordinary logs.
- Endpoints must be HTTPS except for loopback, so a local or LAN-loopback
  authorization server still works while the MCP resource may stay `http://`.

## Amendment (2026-09-18) — landing hardening

Registration prefers the RFC 8252 portless loopback redirect and reuses a stored
client only when that URI is on file or the exact current redirect matches.
`/callback` validates `state` before reading `error` or `code`, a mismatched
`state` does not abort the login, and a replay of a consumed callback returns
409. `invalid_grant` on refresh deletes the stored secret while a transient 5xx
keeps the access token, and `mcp/oauth/start` passes the `McpServerRecord` through
to `onAuthorized` so a project-level server can handshake after login.

## Amendment (2026-09-29) — issuer discovery and resource scopes (#1221)

Issuer paths are preserved during discovery by trying OAuth path insertion, then
OIDC path insertion, then OIDC path appending, with root issuers keeping the root
URLs. Scopes come from the initial 401 Bearer challenge, otherwise from
`scopes_supported` in protected-resource metadata, and `scope` is omitted when
neither supplies one, because an authorization-server scope catalog does not
describe the resource.

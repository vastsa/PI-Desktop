# ADR 0283: Remote MCP Server OAuth 2.1 Authentication

- **Status**: Accepted
- **Date**: 2026-09-18
- **Related**: [ADR 0038](0038-plugin-mcp-bridge.md) ·
  [ADR 0098](0098-multiple-vendor-oauth-accounts.md) ·
  [ADR 0142](0142-allow-non-loopback-http-mcp.md) ·
  [03-runtime/01-ipc-protocol](../spec/03-runtime/01-ipc-protocol.md) ·
  [03-runtime/06-host-rpc-protocol](../spec/03-runtime/06-host-rpc-protocol.md)

## Context

Remote HTTP MCP servers (such as Notion, Linear, or custom enterprise servers) often protect endpoints with OAuth 2.1 authorization rather than static tokens. Model Context Protocol specifies authorization discovery via RFC 9728 (OAuth Protected Resource Metadata) and RFC 8414 (Authorization Server Metadata), dynamic registration via RFC 7591, and resource indicators via RFC 8707.

Previous MCP implementations in PI-Desktop supported only static HTTP headers. Users had to manually obtain Bearer tokens or were unable to connect to OAuth-protected servers.

## Decision

1. **Authentication Architecture**:
   - OAuth login runs in the Electron main process via `McpOAuthManager`, mirroring the `VendorOAuth` non-blocking pattern (ADR 0098): `mcp/oauth/start` returns `{ ok: true, loginId }` immediately and streams progress, authorization URL, completion, or failure events via `pi-desktop/mcp/oauth/event`.
   - IPC calls are never blocked during the user's browser interaction. A user or UI cancellation triggers `pi-desktop/mcp/oauth/cancel`, which closes the loopback listener and aborts the login.
2. **Loopback & Security Boundaries**:
   - The loopback callback server binds strictly to IPv4 loopback `127.0.0.1` on an ephemeral port (`port 0`), and the redirect URI is formatted as `http://127.0.0.1:<port>/callback` per RFC 8252 (preventing IPv6 loopback resolution mismatches).
   - Inbound query parameters (`error`, `error_description`, `code`, `state`) rendered on the loopback HTML completion page are strictly HTML-entity escaped to eliminate reflected XSS.
   - Per ADR 0142, discovery and token requests use `redirect: "manual"` to prevent silent cross-host redirect attacks.
3. **MCP Protocol Compliance**:
   - RFC 8707 `resource` indicators are passed on both the authorization endpoint and token exchange/refresh requests, pointing to the protected resource URI discovered via RFC 9728.
   - Dynamic Client Registration (RFC 7591) credentials (`clientId`, `clientSecret`) are cached and reused for subsequent logins against the same registration endpoint.
   - Token lifetimes (`expires_in`) are parsed as numbers or strings (e.g. `"3600"`), computing an absolute expiry time.
4. **Token Storage & Isolation**:
   - OAuth tokens never reach the renderer. They are stored in host-core encrypted secrets under `secret:mcp:<serverId>:oauth`.
   - Token refresh operations are serialized per server to prevent race conditions with rotating refresh tokens.
   - Moving or renaming an MCP server (`mcp.transfer`) migrates the corresponding `secret:mcp:<serverId>:oauth` to the new ID.
5. **Runtime Integration**:
   - `UserMcpRuntime` injects the valid OAuth access token as `Authorization: Bearer <token>` into live HTTP MCP connections.
   - Token refreshes or re-authorizations invalidate stale connection entries so live clients immediately adopt updated credentials.
   - If a tool invocation returns a 401 Unauthorized status, the server is marked with `authRequired: true` and `state: "failed"`.

## Consequences

- Remote HTTP MCP servers requiring OAuth 2.1 PKCE can be authorized securely from the Settings UI.
- Long-running browser interactions do not block IPC channels or leave orphan HTTP listeners upon window reload or quit.
- Token material is kept out of the renderer process and ordinary logs.

## Amendment (2026-09-18) — landing hardening

- Authorization-server endpoints (`authorization_endpoint`, `token_endpoint`, `registration_endpoint`, discovered `authorization_servers`, and `resource_metadata`) must be HTTPS. Loopback `http://127.0.0.1` / `localhost` / `::1` remains allowed so local mock and LAN-loopback AS still work. The MCP resource URL itself may still be `http://` (ADR 0142).
- Dynamic client registration prefers RFC 8252 portless `http://127.0.0.1/callback` plus the current exact URI. Stored clients are reused only when that portless URI is on file, or the exact current redirect matches. Otherwise a new client is registered. Login also tries to rebind the previously used loopback port so strict AS that require an exact URI keep working.
- Loopback `/callback` validates `state` before looking at `error` or `code`. A mismatched `state` is a stray request and does not abort the login. A matching callback is consumed once (replay returns 409).
- `invalid_grant` on refresh deletes the stored secret; transient 5xx keeps the existing access token.
- `mcp/oauth/start` passes the listed `McpServerRecord` through to `onAuthorized` so a project-level server that is not in the current workspace runtime can still handshake after login.
- Scope selection remains an MVP heuristic (`default` if advertised, else `scopes_supported[0]`). There is no per-server scope picker, device-code flow, or DPoP.

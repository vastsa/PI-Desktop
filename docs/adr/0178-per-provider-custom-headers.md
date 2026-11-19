# ADR 0178: Per-provider custom HTTP headers

- Status: Accepted
- Date: 2026-09-08
- Related: ADR 0095, ADR 0156, ADR 0176, D621
- Amends: ADR 0176 / ADR 0095 / ADR 0156
- Supersedes the User-Agent-only surface of ADR 0176

## Context

ADR 0176 added a per-row User-Agent override because gateways inspect that header
and Codex overwrites it after extra headers. Users needed the same last-writer path
for other non-secret request headers such as routing, tenant, or client
identification, and the provider schema already listed a `headers` map that ADR
0176 left unimplemented.

## Decision

Each provider row, API-key service or OAuth account, may store an optional
`headers` map in `config_json.headers`. An empty or omitted map keeps the adapter
defaults; a non-empty map is the last writer on that row's outbound HTTP, covering
session turns, subagents, prompt enhancement, plugin one-shots, `/models`
discovery, connection tests, and OAuth token refresh. A fetch wrapper applies it
so Codex and the Anthropic SDK cannot overwrite it, and the same values ride
pi-ai stream-option headers so OpenCode's caller-wins rule stays true. A stored
`config_json.userAgent` migrates to `headers["User-Agent"]` on read, and writing
`headers` drops the leftover field. Host validation trims keys and values, makes
keys case-insensitively unique, and rejects CR/LF, oversized keys or values, and
reserved names that would smash signing or hop-by-hop framing: `authorization`,
`host`, `content-type`, `content-length`, `cookie`, `connection`,
`transfer-encoding`, and the provider auth keys such as `x-api-key` and
`chatgpt-account-id`. Values are folded to half-width and must stay within the
ByteString range, because Han text or an emoji makes `Headers.set` throw mid-turn
(D621). The map is not a secret, so no storage or protocol version changes. The
UI is an Advance
d settings button that opens a compact modal with common presets including
`User-Agent`, JSON copy and import of the normalized record, and
case-insensitive merge. First OAuth login does not collect headers.
`AgentRuntime.matches()` includes the map, so editing it rebuilds the warm
runtime.

## Consequences

- Users can attach gateway-specific headers per service or account without a
  global dump, and can override the Anthropic OAuth User-Agent even though Claude
  Pro/Max may then reject the request.
- OAuth login traffic keeps pi-ai defaults until the row is saved.
- A previously saved User-Agent applies until the next save, after which it lives
  only in `headers`.

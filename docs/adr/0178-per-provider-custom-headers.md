# ADR 0178: Per-provider custom HTTP headers

- Status: Accepted
- Date: 2026-09-08
- Deciders: PI-Desktop core
- Amends ADR 0176 / ADR 0095 / ADR 0156
- Supersedes the User-Agent-only surface of ADR 0176

## Context

ADR 0176 added a per-row User-Agent override because gateways inspect that
header and Codex overwrites it after extra headers. Users then needed the same
last-writer path for other non-secret request headers (routing, tenant, or
client identification), not a dedicated User-Agent field. The provider schema
already listed `headers`; 0176 left that map unimplemented and said User-Agent
would win if both existed.

The Advanced editor for a single User-Agent field sat in a two-column grid and
looked sparse.

## Decision

Each provider row — API-key AI service and OAuth vendor account — may store an
optional `headers` map in `config_json.headers`.

- Empty, omitted, or update `{}` keeps today's adapter defaults.
- A non-empty map is last-writer on that row's outbound HTTP: session turns,
  builtin subagents, prompt enhancement, plugin one-shots, `/models` discovery
  (including unsaved form values), connection tests, and OAuth token refresh.
- A fetch wrapper is the last writer so Codex and the Anthropic SDK cannot
  overwrite the map. The same values are also placed on pi-ai stream-option
  headers so OpenCode's caller-wins rule stays true.
- Stored `config_json.userAgent` migrates to `headers["User-Agent"]` on read.
  Writing `headers` drops leftover `userAgent`. If both exist, `headers` wins
  for a User-Agent key already in the map.
- Host validation: trim keys and values; case-insensitive unique keys; at most
  32 headers; key ≤ 256 bytes; value ≤ 4096 bytes; no CR/LF; header names are
  alphanumeric plus hyphen. Reserved keys are rejected so this cannot smash
  signing or hop-by-hop framing: `authorization`, `proxy-authorization`,
  `host`, `content-type`, `content-length`, `cookie`, `set-cookie`,
  `connection`, `transfer-encoding`, `te`, `trailer`, `upgrade`, `keep-alive`,
  `x-api-key`, `api-key`, `chatgpt-account-id`, `x-opencode-session`.
- Not a secret. No SQLite or host-protocol version bump.
- UI is an explicit Advanced settings button in the upper-right dialog actions
  (named, custom, and vendor account) that opens a separate compact modal. The
  modal offers common header presets including `User-Agent`, Copy JSON of the
  same normalized record used for persistence, JSON import for either a direct
  header object or `{ "headers": { ... } }`, and case-insensitive merge without
  duplicate rows. At most two header rows are visible; additional
  rows scroll inside the editor. Named display name stays above the header
  controls. First OAuth login does not collect headers; they are edited after
  the account exists.
- `AgentRuntime.matches()` includes the header map so editing it rebuilds the
  warm runtime.

Overriding Anthropic OAuth's `claude-cli/…` User-Agent can make Claude Pro/Max
reject the request. That is the user's choice.

## Consequences

- Users can impersonate another client and attach gateway-specific headers per
  service or account without a global header dump or an auth-bearing editor.
- OAuth login HTTP uses the row map only after it is saved; first-login traffic
  keeps pi-ai defaults.
- A previously saved User-Agent still applies until the row is next saved, at
  which point it is stored only in `headers`.

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
client identification), not a dedicated User-Agent field.

## Decision

Each provider row — API-key AI service and OAuth vendor account — may store an
optional `headers` map in `config_json.headers`.

- Empty, omitted, or update `{}` keeps today's adapter defaults.
- A non-empty map is last-writer on that row's outbound HTTP: session turns,
  builtin subagents, prompt enhancement, plugin one-shots, `/models` discovery
  (including unsaved form values), connection tests, and OAuth token refresh.
- A fetch wrapper is the last writer so Codex and the Anthropic SDK cannot
  overwrite the map.
- Stored `config_json.userAgent` migrates to `headers["User-Agent"]` on read.
- Host validation: trim keys and values; case-insensitive unique keys; at most
  32 headers; key ≤ 256 bytes; value ≤ 4096 bytes; no CR/LF; header names are
  alphanumeric plus hyphen.
- Values are folded to half-width before that validation, and again on read: the
  fullwidth block (U+FF01–U+FF5E) and the ideographic space (U+3000) become
  their ASCII counterparts, because that is what an IME or a fullwidth-formatted
  page produces for plain ASCII.
- Not a secret. No SQLite or host-protocol version bump.
- UI is an explicit Advanced settings button in the upper-right dialog actions
  (named, custom, and vendor account) that opens a separate compact modal.
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

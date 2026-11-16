# ADR 0176: Per-provider User-Agent override

- Status: Accepted; the `config_json.userAgent` store is superseded by ADR 0178
- Date: 2026-09-07
- Related: ADR 0095, ADR 0156, ADR 0178

## Context

Some gateways and vendor subscriptions inspect `User-Agent`, but each adapter
stamps its own, no per-row override existed, and the provider schema listed a
`headers` map that was never implemented.

## Decision

Each provider row — API-key AI service and OAuth vendor account — may store an
optional `userAgent` in `config_json.userAgent`, where empty or omitted keeps the
adapter default and a non-empty trimmed value is sent as `User-Agent` on that row's
outbound HTTP: session turns, subagents, prompt enhancement, plugin one-shots,
`/models` discovery, connection tests, and OAuth token refresh. A fetch wrapper is
the last writer so no SDK overwrites it, `""` clears the value, CR/LF are rejected,
and `AgentRuntime.matches()` includes the field so an edit rebuilds the warm
runtime. It is not a secret and needs no SQLite or protocol change; overriding
Anthropic OAuth's `claude-cli/…` value can make Claude Pro/Max reject the request,
which is the user's choice.

## Consequences

- Users can present as another client per service or account without a global
  User-Agent or a custom-header editor.
- OAuth login traffic uses the row value only once saved.

# ADR 0176: Per-provider User-Agent override

- Status: Accepted
- Date: 2026-09-07
- Deciders: PI-Desktop core
- Amends ADR 0095 / ADR 0156

## Context

Some gateways and vendor subscriptions inspect `User-Agent`. pi-ai stamps
`pi (<platform> …)`, Anthropic OAuth inference sends `claude-cli/<version>`,
OpenCode Go sends `pi-desktop/<APP_VERSION>`, and Codex overwrites User-Agent
after extra headers. Settings had no way to set a per-row value. The provider
schema listed a `headers` map that was never implemented.

## Decision

Each provider row — API-key AI service and OAuth vendor account — may store
an optional `userAgent` in `config_json.userAgent`.

- Empty or omitted keeps today's adapter default.
- A non-empty trimmed value is sent as `User-Agent` on that row's outbound
  HTTP: session turns, builtin subagents, prompt enhancement, plugin
  one-shots, `/models` discovery (including an unsaved form value), connection
  tests, and OAuth token refresh.
- A fetch wrapper is the last writer so Codex and the Anthropic SDK cannot
  overwrite it. The same value is also placed on pi-ai stream-option headers
  so OpenCode's caller-wins rule stays true.
- Update with `""` clears the override. Max 256 bytes; CR/LF are rejected.
- Not a secret. No SQLite or host-protocol version bump.
- UI lives in Advanced on the AI-service dialog (named and custom) and the
  vendor-account editor. First OAuth login does not collect a User-Agent; it
  is edited after the account exists.
- `AgentRuntime.matches()` includes `userAgent` so editing it rebuilds the
  warm runtime.
- The unused `headers` map stays unimplemented. If added later, `userAgent`
  remains the UI alias and wins over `headers["User-Agent"]`.
  **Superseded by ADR 0178:** `config_json.headers` is the supported override;
  leftover `userAgent` migrates into `headers["User-Agent"]`.

Overriding Anthropic OAuth's `claude-cli/…` User-Agent can make Claude
Pro/Max reject the request. That is the user's choice.

## Consequences

- Users can impersonate another client per service or account without a
  global User-Agent or a full custom-header editor.
- OAuth login HTTP uses the row value only after it is saved; first-login
  traffic keeps pi-ai defaults.

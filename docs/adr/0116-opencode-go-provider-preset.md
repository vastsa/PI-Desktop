# ADR 0116: Add OpenCode Go as a Fixed Provider Preset

- Status: Accepted
- Date: 2026-08-24
- Deciders: PI-Desktop core
- Updates ADR 0012 and ADR 0020

## Context

The OpenCode Go service exposes an OpenAI-compatible Chat Completions API, but
its endpoint is service-owned and should not be edited like a generic gateway.
Users should be able to configure it without copying an endpoint from separate
documentation, while the existing provider studio must continue to support
arbitrary OpenAI-compatible services.

## Decision

Add `opencode_go` as a persisted API-style value and expose it in the custom
provider dialog. Selecting it applies these immutable connection defaults:

```text
name:    OpenCode Go
baseUrl: https://opencode.ai/zen/go/v1
```

The renderer keeps the name and endpoint visible but read-only, accepts the
API key as the only editable connection field, and continues to use the normal
discovered-model selector. Save-time normalization also enforces the fixed
values so stale or manually constructed form state cannot override them.

The runtime maps `opencode_go` to pi-ai's OpenAI Chat Completions adapter unless a model-level catalog entry pins another wire API (see #105). Model
discovery calls `/models` with a Bearer key. Secrets remain owned by the
existing Rust host secret store; no OpenCode-specific secret or database table
is introduced.

OpenCode Go requires a stable `x-opencode-session` header on LLM requests so
the gateway can pin a conversation to one backend. pi-ai does not emit that
header. Agent-runtime injects it (plus `x-opencode-client: pi-desktop` and a
PI-Desktop `User-Agent`) on session, subagent, prompt-enhancement, and plugin
one-shot streams, using the durable conversation id. Detection matches
`apiStyle: opencode_go`, vendor/provider ids `opencode` / `opencode-go`, or
an `opencode.ai` base URL so a UUID provider row and a custom Completions
row pointed at Go both work. This stays in the agent layer, matching the
official Pi coding-agent attribution helper.

## Consequences

- OpenCode Go is recognizable in the provider row and durable configuration.
- The service cannot be accidentally pointed at a different endpoint while the
  preset is selected.
- Generic OpenAI-compatible configuration remains available as a separate API
  style for user-controlled gateways.
- The preset does not create a second wire adapter or constrain the service's
  model list to a hardcoded catalog.
- OpenCode Go chat, subagent, and one-shot requests carry a stable session
  routing header without waiting on a pi-ai change.

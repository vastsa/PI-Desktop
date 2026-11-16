# ADR 0116: Add OpenCode Go as a Fixed Provider Preset

- Status: Accepted
- Date: 2026-08-24
- Updates ADR 0012 and ADR 0020

## Context

OpenCode Go exposes an OpenAI-compatible Chat Completions API whose endpoint is
service-owned, so users should not copy it from separate documentation as they
would for a generic gateway, while the provider studio must keep supporting
arbitrary OpenAI-compatible services.

## Decision

Add `opencode_go` as a persisted API-style value selectable in the custom
provider dialog, applying immutable connection defaults (`OpenCode Go` at
`https://opencode.ai/zen/go/v1`). The renderer shows name and endpoint read-only,
accepts the API key as the only editable connection field, keeps the normal
discovered-model selector, and save-time normalization enforces the fixed
values. The runtime maps `opencode_go` to pi-ai's OpenAI Chat Completions
adapter unless a model catalog entry pins another wire API, discovers models
from `/models` with a Bearer key, and leaves secrets in the existing Rust host
secret store. Agent-runtime injects the `x-opencode-session` routing header plus
`x-opencode-client` and a PI-Desktop `User-Agent` on session, subagent,
prompt-enhancement, and plugin one-shot streams, detecting the service by
`apiStyle: opencode_go`, `opencode` / `opencode-go` vendor ids, or an
`opencode.ai` base URL.

## Consequences

- The service is recognizable in the provider row and durable configuration.
- The preset cannot be pointed at another endpoint while generic
  OpenAI-compatible configuration stays a separate API style.
- Requests carry a stable session routing header without a pi-ai change.

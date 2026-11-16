# ADR: Model reasoning effort override

- Status: Proposed
- Date: 2026-10-23
- Related: issue #1821, issue #1701

## Context

DeepSeek-family Chat Completions compatibility disables `reasoning_effort` for
endpoints that reject the field, but model-name detection also matches custom relays
that support it, so choosing High can silently omit the parameter while changing the
automatic default would regress the endpoints issue #1701 protects.

## Decision

Add optional `supportsReasoningEffort: boolean | null` to the persisted model
binding: missing or null keeps automatic compatibility, true and false explicitly
allow or disallow the parameter. Provenance stays separate from catalog
compatibility and applies last, only when building a Chat Completions model, and the
setting neither turns reasoning on nor overrides the selected thinking level. The
per-model settings offer Auto, Send, and Do not send; host normalization and
configuration synchronization preserve the value, and other APIs ignore it.

## Update (2026-10-23)

Official `deepseek.com` endpoints now leave `supportsReasoningEffort` to pi-ai
detection, so the selected level reaches the wire by default (D672, #1821). The
explicit override is unchanged and still wins in both directions.

## Consequences

- Legacy JSON needs no migration, and clearing a choice restores automatic
  compatibility.
- A user enabling Send must pick a gateway that accepts the parameter, and provider
  errors stay visible; no retry or silent fallback is added.

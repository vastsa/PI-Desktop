# ADR: Ordered subagent model fallback

- Status: Accepted for implementation
- Date: 2026-09-14
- Related: ADR 0062, ADR 0063, ADR 0202, ADR subagent-model-opt-in

## Context

A subagent can select only one model. Its existing bounded provider retries
cannot recover when that model remains unavailable.

## Decision

Add optional `fallbackModels` to a definition, the user-subagent record/input,
and the existing internal launch definition. It is an ordered list of
`provider/model` strings in managed Markdown and host RPC, parsed into model
pins in Shared.

Electron resolves alternatives through the same credential, provider-count, and
model-capability boundaries as primary pins. These bindings are scoped to their
owning definition, even when Task explicitly overrides its primary.

## Settings example

The Advanced section keeps one primary model and lists fallback models in
priority order. Each fallback can be moved up/down or removed.

![Subagent editor showing the primary model and two ordered fallback
models](../public/screenshots/app/zh/subagent-model-fallback.png)

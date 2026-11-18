# ADR 0114: Persist Provider Model Bindings and Thinking Configuration

- Status: Accepted
- Date: 2026-08-21
- Related: ADR 0020, ADR 0027

## Context

The provider studio stored one `defaultModelId` and kept context, output, and
thinking capability in runtime and catalog code, so a provider could not retain
settings for more than one model and a custom model was indistinguishable from an
unconfigured default.

## Decision

`ProviderPublic`, `ProviderCreateInput`, and `ProviderUpdateInput` expose
`models: ModelBinding[]`, each binding carrying `id`, `contextWindow`, `maxTokens`,
`thinkingLevels`, and `defaultThinkingLevel`; host-core persists the array under
`providers.config_json.models`, and `default_model_id` remains a compatibility
field mirroring the first binding. The pi-ai catalog stays authoritative for
known-model metadata, so Settings offers its values as initial inputs while edits
land in the binding, and unknown custom models start at 128,000 context, 8,192 max
output, no thinking levels, and a null default. A stored provider without
`config_json.models` is materialized as one binding from `default_model_id`, and
Electron main resolves `models[0]?.id` before the legacy field. Thinking levels
fall back in the order `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`,
and no thinking support is `thinkingLevels: []` with a null default, never a fake
`off`. The storage contract changes additively with no new table or migration
version.

## Consequences

- Multiple model configurations survive restart and provider edits.
- Known-model metadata stays pinned to pi-ai while a user override is durable;
  conversation model switching and routing stay out of scope.

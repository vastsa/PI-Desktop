# ADR 0114: Persist Provider Model Bindings and Thinking Configuration

- Status: Accepted
- Date: 2026-08-21
- Deciders: PI-Desktop core
- Updates ADR 0020 and ADR 0027

## Context

The provider studio previously stored one `defaultModelId` and kept context,
output, and thinking capability decisions in runtime/catalog code. That made a
provider unable to retain settings for more than one model and made custom
models indistinguishable from an unconfigured default.

## Decision

`ProviderPublic`, `ProviderCreateInput`, and `ProviderUpdateInput` expose a
`models: ModelBinding[]` field. A binding contains:

```ts
type ModelBinding = {
  id: string
  contextWindow: number
  maxTokens: number
  thinkingLevels: ThinkingLevel[]
  defaultThinkingLevel: ThinkingLevel | null
}
```

Rust host-core persists the array under `providers.config_json.models`, which
keeps provider-specific settings additive and inside the existing storage owner.
`default_model_id` remains a compatibility field and mirrors the first binding
on new writes.

## Migration and compatibility

When a stored provider has no `config_json.models` array, host-core materializes
one binding from `default_model_id` with the custom fallback values. The
materialized binding is returned by `providers.list` / `providers.get`; the next
provider create/update writes the new array.

## Consequences

- Multiple model configurations survive restart and provider edits.
- Thinking-level fallback is deterministic: the canonical order is `off`,
  `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
- Empty thinking support is represented by `thinkingLevels: []` and
  `defaultThinkingLevel: null`, rather than a fake `off` selection.
- The provider storage contract changes additively without a new SQLite table or
  migration version.
- Conversation model switching and routing policies remain explicitly out of
  scope; the first binding is the current runtime default.

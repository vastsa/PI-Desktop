# ADR: Persist provider display order independently of configuration

- Status: Accepted
- Related: Issue #587, ADR 0114, ADR 0259

## Context

Provider rows are listed in creation order. Users need to move frequently used
services ahead of others in settings and model selection menus.

## Decision

Rust host-core stores the ordered IDs under the existing `kv` key
`providers.order` and applies them to `providers.list`. The additive
`providers.reorder` RPC moves one ID before or after another under the host
state lock.

Provider cards use pointer-driven dragging with a live slot preview and edge
scrolling. Keyboard moves share the list-order transformation with model
ordering.

## Alternatives

- Renderer-only storage would make order depend on which consumer lists
  providers.
- A sort field in provider configuration would mix user placement with
  plugin-managed fields and require editing multiple provider records per move.

## Consequences

No SQL schema or protocol-version migration is needed.

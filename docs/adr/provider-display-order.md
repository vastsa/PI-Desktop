# ADR: Persist provider display order independently of configuration

- Status: Accepted
- Related: Issue #587, ADR 0114, ADR 0259

## Context

Provider rows list in creation order, but users need frequently used services
ahead of others in settings and model menus, and list placement must survive the
manifest reconciliation that owns provider configuration.

## Decision

Host-core stores ordered IDs under the existing `kv` key `providers.order` and
applies them to `providers.list`, and the additive `providers.reorder` RPC moves
one ID before or after another under the host state lock, so the renderer sends a
move rather than a replacement list and a provider created during a drag stays
present. Cards use pointer dragging with a live slot preview, keyboard moves share
the list-order transformation with model ordering, and a failed save restores the
accepted order.

## Consequences

- No SQL schema or protocol-version migration is needed, and older clients ignore
  the metadata.
- New providers append in creation order and stale saved IDs are ignored, so
  sorting a plugin row grants no permission to edit its fields.

## Alternatives

- Renderer-only storage: rejected; order would depend on which consumer lists
  providers.
- A sort field in provider configuration: rejected; it would mix user placement
  with plugin-managed fields.

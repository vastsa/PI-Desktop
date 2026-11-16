# ADR 0322: Plugin providers appear in Add Service

- Status: Accepted for implementation
- Date: 2026-10-08
- Decision: D650
- Related: ADR 0259, ADR 0320, `07-plugins/02-plugin-manifest-schema.md`, `07-plugins/03-plugin-api.md`, `07-plugins/04-plugin-security.md`

## Context

ADR 0259 lets plugins declare Host-owned provider rows, but users must leave the
ordinary Add Service flow and find each row in the provider list before entering
an API key, and community catalogs need to group several services under a
category beside built-in ones.

## Decision

1. `PluginProviderContrib` gains an optional `category` accepting a non-empty
   string or an `{ en, "zh-CN" }` pair, falling back to the plugin name.
2. The Host projects metadata from loaded plugins whose `provider.register`
   grant is active, and only API-key declarations with an endpoint and no saved
   key appear in Add Service; OAuth and no-auth rows do not.
3. The chooser groups rows under the declared category, shows the provider name
   with an optional one-sentence `description` in a tooltip, and searches
   category, provider name, plugin name, endpoint, model ids, and description.
4. Selecting a row opens a Host-owned key form that stores the key through the
   existing provider secret API and, when `models` is empty, triggers Host-owned
   endpoint model discovery. Plugin code receives no key and gains no permission.
5. A saved row leaves Add Service and stays in the provider list, with provider
   ownership, reconciliation, credential retention, and uninstall cleanup
   unchanged.

## Consequences

- Community providers are discoverable during ordinary service setup.
- Existing manifests stay valid, because `category` is optional display metadata
  that falls back to the plugin name.
- A category does not make an endpoint trustworthy; the key form keeps plugin
  and endpoint visible for review.

## Alternatives

- Let plugins inject chooser UI: rejected, it adds a renderer boundary and
  duplicates the Host credential flow.
- Create a new provider row from a catalog tile: rejected, it forks row identity,
  credential migration, and uninstall cleanup.

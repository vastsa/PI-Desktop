# ADR 0322: Plugin providers appear in Add Service

- Status: Accepted for implementation
- Date: 2026-10-08
- Decision: D650
- Related: ADR 0259, ADR 0320, `07-plugins/02-plugin-manifest-schema.md`, `07-plugins/03-plugin-api.md`, `07-plugins/04-plugin-security.md`, `07-plugins/13-plugin-permissions-matrix.md`, `04-ux/06-settings-ia.md`

## Context

ADR 0259 lets plugins declare Host-owned provider rows, but a user must leave
the ordinary Add Service flow and find each row in the provider list before
entering its API key. Community catalogs need to group several API services
under a category and make them discoverable in the same place as built-in
services.

## Decision

1. Add an optional `category` field to `PluginProviderContrib`.
2. The Host projects metadata from loaded plugins whose `provider.register`
   grant is active.
3. The chooser groups rows under the declared category.
4. Selecting a row opens a Host-owned key form for the existing provider row.
5. Once a key is saved, the row stays in the provider list and is removed from
   Add Service.

## Consequences

- Users can discover community provider entries during ordinary service setup
  and group them with localized custom categories.
- Existing manifests remain valid because the new field is optional.
- A provider may omit model declarations only when it is an API-key provider
  with a `baseUrl`.
- The same Host-owned row and secret lifecycle remains authoritative; saving a
  key does not create a duplicate provider or require data migration.
- A category or description does not make an endpoint trustworthy.

## Alternatives considered

### Let plugins inject arbitrary chooser UI

Rejected: executing plugin UI in the provider setup dialog would add a new
renderer boundary and duplicate the Host's credential and validation flow.

### Create another provider row when a user selects a catalog tile

Rejected: that would fork row identity, credential migration, model selection,
and uninstall cleanup from the existing manifest-owned provider lifecycle.

### Require a new permission for chooser visibility

Rejected: `provider.register` already approves the plugin's authority to
contribute provider rows.

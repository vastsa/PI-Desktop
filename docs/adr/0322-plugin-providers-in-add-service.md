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
services. Plugin providers already have stable row ids, Host-owned credentials,
and an explicit high-risk `provider.register` grant.

## Decision

1. Add an optional `category` field to `PluginProviderContrib`. It accepts a
   non-empty string or an `{ en, "zh-CN" }` pair, with each label limited to
   128 characters. A missing category uses the plugin name.
2. The Host projects metadata from loaded plugins whose `provider.register`
   grant is active. Only API-key declarations with an endpoint and no saved key
   appear in Add Service. OAuth and no-auth rows do not appear.
3. The chooser groups rows under the declared category. Tiles show the provider
   name; an optional one-sentence `description` appears in a tooltip on hover or
   keyboard focus. Search includes category, provider name, plugin name,
   endpoint, model ids, and description. The provider count is not capped per
   plugin; the existing package size cap bounds the manifest.
4. Selecting a row opens a Host-owned key form for the existing provider row.
   It stores the key through the current provider secret API. If the provider's
   `models` list is empty, saving the key triggers Host-owned endpoint model
   discovery and caches the response for the provider row. Plugin code receives
   no key and no new permission or runtime API is added.
5. Once a key is saved, the row stays in the provider list and is removed from
   Add Service. Provider ownership, row reconciliation, credential retention,
   and uninstall cleanup stay as defined by ADR 0259 and ADR 0320. The optional
   category is display metadata and does not alter existing rows or credentials.

## Consequences

- Users can discover community provider entries during ordinary service setup
  and group them with localized custom categories.
- Existing manifests remain valid because the new field is optional. An
  omitted category falls back to the plugin name.
- A provider may omit model declarations only when it is an API-key provider
  with a `baseUrl`. Endpoint discovery starts only after the user explicitly
  saves a key; failure leaves the key saved and reports that models could not
  be loaded.
- The same Host-owned row and secret lifecycle remains authoritative; saving a
  key does not create a duplicate provider or require data migration.
- A category or description does not make an endpoint trustworthy. The key
  form keeps the plugin and endpoint visible for review, and users still decide
  whether to send prompts and code to that service.

## Alternatives considered

### Let plugins inject arbitrary chooser UI

Rejected: executing plugin UI in the provider setup dialog would add a new
renderer boundary and duplicate the Host's credential and validation flow. The
manifest already contains the data needed for a safe Host-rendered tile.

### Create another provider row when a user selects a catalog tile

Rejected: that would fork row identity, credential migration, model selection,
and uninstall cleanup from the existing manifest-owned provider lifecycle.

### Require a new permission for chooser visibility

Rejected: `provider.register` already approves the plugin's authority to
contribute provider rows. A separate display permission would not narrow what
the plugin can do and would create a second approval state for the same rows.

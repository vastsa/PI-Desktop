# ADR 0259: Plugin-declared providers are Host-owned rows

- Status: Accepted for implementation
- Date: 2026-09-15
- Decision: D427
- Related: ADR 0011, `07-plugins/02-plugin-manifest-schema.md`, `07-plugins/13-plugin-permissions-matrix.md`, `03-runtime/04-data-storage.md`, `03-runtime/12-provider-config-schema.md`

## Context

A plugin that integrates an LLM service has two surfaces today: an agent tool,
or a session-scoped agent implementation registered through the
trusted-extension API (ADR 0258). Neither puts the service in the native
provider list, so the user cannot select it for a session and the plugin ends up
keeping a private provider registry beside the Host's one.

## Decision

1. Add `contributes.providers[]` to the plugin manifest.
2. The Host materializes each declaration as a real row in `providers`, not in a
   plugin-side registry.
3. Schema v17 adds the nullable `providers.owner_plugin_id` column and its
   partial index.
4. The declaration is re-read from the manifest on every plugin load and is
   authoritative for the fields it declares (name, vendorKey, baseUrl, authKind,
   apiStyle, models).
5. Credentials stay in the Host secret store under the same refs as any
   provider: `secret:provider:<id>:api_key` and `secret:provider:<id>:oauth`.
6. The user path refuses a plugin-owned row.
7. Disabling a plugin keeps its rows and sets `enabled = 0`, so re-enabling
   restores the credential the user already stored.
8. A non-empty declaration requires the new high-risk `provider.register`
   permission.
9. Reconciliation runs on `plugins.enable`, `plugins.disable`,
   `plugins.loadDev`, `plugins.uninstall`, and once at host startup for every
   registered plugin.
10. OAuth contributions use the host-owned account UI and callback protocol in
    ADR 0320.
11. The plugin SDK mirrors the same authoring-time rules, requires
    `provider.oauth` for OAuth declarations, and derives the `providers`
    capability token for the plugin row.

## Consequences

- A plugin-provided service is a first-class provider: it lists, discovers
  models, and resolves through the same Host path as a user row, with no new
  wire adapter.
- Provider rows now have an owner, so every Host path that mutates a row must
  respect `owner_plugin_id`; the user path can no longer assume it owns the row
  it is editing or deleting.
- An unreviewed manifest can add rows to the user's provider list.
- A credential is only as durable as the declaration: dropping an entry from the
  manifest, or uninstalling the plugin, deletes the stored key or token.
- The plugin-side surface is deliberately narrow: OAuth code runs only in the
  isolated plugin process for its own provider, while host-owned UI and secret
  storage retain account and renderer ownership.

## Alternatives considered

### A sidecar-only provider registry

Rejected: the same service would exist twice, with a private identity the UI,
the model catalog cache, the session binding, and the Host secret store cannot
address.

### Let the plugin write provider rows through `providers.create`

Rejected: the plugin host is not a second provider author.

### Store plugin providers outside the database

Rejected: a JSON file in the plugin data directory cannot participate in the
relational state a provider row anchors.

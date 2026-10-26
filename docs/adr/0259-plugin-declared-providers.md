# ADR 0259: Plugin-declared providers are Host-owned rows

- Status: Accepted for implementation
- Date: 2026-09-15
- Decision: D427
- Related: ADR 0011, `07-plugins/02-plugin-manifest-schema.md`, `07-plugins/13-plugin-permissions-matrix.md`, `03-runtime/04-data-storage.md`, `03-runtime/12-provider-config-schema.md`

> Model-editing amendment: [Plugin provider user model preferences](plugin-provider-user-model-preferences.md)
> supersedes the blanket update refusal and manifest-authoritative model/name
> fields below. Plugin transport identity and lifecycle ownership remain intact.

## Context

A plugin that integrates an LLM service has two surfaces today: an agent tool, or
a session-scoped agent implementation registered through the trusted-extension
API (ADR 0258). Neither puts the service in the native provider list, so the user
cannot select it for a session and the plugin ends up keeping a private provider
registry beside the Host's one.

The Host is the single owner of provider rows, provider credentials, the model
catalog cache, and the Settings provider list. Duplicating that state in a
plugin-side registry would give the same service two identities and two
lifecycles, and would hide a service the user installed from the settings surface
that manages every other endpoint.

Ownership is the part that needs a decision: a provider row is no longer only
"the user's", and the Host must be able to tell whose row it is.

## Decision

1. Add `contributes.providers[]` to the plugin manifest. The entry shape is fixed
   by `07-plugins/02-plugin-manifest-schema.md` §5.4: `id`, required `name`,
   optional `vendorKey`, `baseUrl`, `apiStyle`, `authKind`, and 1..64 `models`.
2. The Host materializes each declaration as a real row in `providers`, not in a
   plugin-side registry. The row id is `plugin:<pluginId>:<declaredId>`, it is
   owned by that plugin, and it appears in the native Settings → Provider list, so
   it is selectable for a session like any user-created row.
3. Schema v17 adds the nullable `providers.owner_plugin_id` column and its
   partial index. The migration is additive: every pre-v17 row is a user row and
   keeps a NULL owner. The public provider payload carries `ownerPluginId`.
4. The declaration is re-read from the manifest on every plugin load and is
   authoritative for the fields it declares (name, vendorKey, baseUrl, authKind,
   apiStyle, models). Values the declaration does not own — stored headers and
   the OAuth account label — are preserved across a refresh.
5. Credentials stay in the Host secret store under the same refs as any provider:
   `secret:provider:<id>:api_key` and `secret:provider:<id>:oauth`. API-key
   credentials are never handed to the plugin. OAuth credentials are accessible
   only through the plugin's own `onProviderOAuth` callback with the separate
   high-risk `provider.oauth` grant (ADR 0320). The row remains an ordinary
   runtime row for model resolution, discovery, and connection tests.
6. The user path refuses a plugin-owned row. `providers.update` and
   `providers.delete` fail with a `PROVIDER_OWNED_BY_PLUGIN` error, because the
   manifest declaration would overwrite a user edit on the next load and only the
   plugin's own lifecycle can decide the row is gone.
7. Disabling a plugin keeps its rows and sets `enabled = 0`, so re-enabling
   restores the credential the user already stored. Uninstalling the plugin, or
   dropping an entry from the declaration, deletes the row together with both
   credential references, so a later re-declaration can never inherit a stale
   token.
8. A non-empty declaration requires the new high-risk `provider.register`
   permission. A manifest that declares providers without it fails validation,
   and the permission matrix and the manifest schema document the grant.
9. Reconciliation runs on `plugins.enable`, `plugins.disable`, `plugins.loadDev`,
   `plugins.uninstall`, and once at host startup for every registered plugin. A
   provider sync failure is logged as a warning; it never changes plugin
   enablement.
10. OAuth contributions use the host-owned account UI and callback protocol in
    ADR 0320. Each declaration has one encrypted OAuth credential at a time;
    sign-out clears it while the manifest-owned row remains. Multi-account
    provider rows are not part of this contract.
11. The plugin SDK mirrors the same authoring-time rules, requires
    `provider.oauth` for OAuth declarations, and derives the `providers`
    capability token for the plugin row.

## Consequences

- A plugin-provided service is a first-class provider: it lists, discovers
  models, and resolves through the same Host path as a user row, with no new wire
  adapter.
- Provider rows now have an owner, so every Host path that mutates a row must
  respect `owner_plugin_id`; the user path can no longer assume it owns the row it
  is editing or deleting.
- An unreviewed manifest can add rows to the user's provider list. The high-risk
  permission, the install confirmation, and the local-import and
  development-plugin limit for v1.1 bound that exposure.
- A credential is only as durable as the declaration: dropping an entry from the
  manifest, or uninstalling the plugin, deletes the stored key or token.
- The plugin-side surface is deliberately narrow: OAuth code runs only in the
  isolated plugin process for its own provider, while host-owned UI and secret
  storage retain account and renderer ownership. The manifest still owns the
  provider row and users cannot edit it.
- The v15→v16 session-collaboration step now stamps its own version `16` instead
  of the latest schema constant, so a v15 file can walk v15→v16→v17 in one
  launch.

## Alternatives considered

### A sidecar-only provider registry

Rejected: the same service would exist twice, with a private identity the UI, the
model catalog cache, the session binding, and the Host secret store cannot
address. Only the plugin's own panel could select it, and every Host feature that
iterates `providers` — default model, subagent catalog, connection test, model
discovery — would need a second code path.

### Let the plugin write provider rows through `providers.create`

Rejected: the plugin host is not a second provider author. It would have to hold
provider-write authority, the user's own edit and the declaration would fight over
the same row on every load, and the row would not be tied to the plugin's
lifecycle, so an uninstall would leave an orphan. A manifest declaration plus Host
reconciliation keeps ownership explicit and the plugin write path one-way.

### Store plugin providers outside the database

Rejected: a JSON file in the plugin data directory cannot participate in the
relational state a provider row anchors. The model catalog cache, session
provider/model bindings, credential metadata, and audit rows all reference
`providers.id`; a file would also move provider identity out of the single-writer
store (ADR 0011) and make the Settings list depend on whether a plugin's file was
readable.

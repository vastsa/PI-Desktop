# ADR 0259: Plugin-declared providers are Host-owned rows

- Status: Accepted for implementation
- Date: 2026-09-15
- Decision: D427
- Related: ADR 0011, ADR 0320, `07-plugins/02-plugin-manifest-schema.md`,
  `07-plugins/13-plugin-permissions-matrix.md`, `03-runtime/12-provider-config-schema.md`

## Context

A plugin integrating an LLM service can offer an agent tool or a session-scoped
agent implementation (ADR 0258); neither puts the service in the native provider
list, so the plugin keeps a private provider registry beside the Host's. The Host
owns provider rows, credentials, the model catalog cache, and the Settings list,
and duplicating that state would give one service two identities and hide it from
the surface that manages every other endpoint.

## Decision

1. Add `contributes.providers[]` to the plugin manifest, shaped per the manifest
   schema §5.4: `id`, required `name`, optional `vendorKey`, `baseUrl`,
   `apiStyle`, `authKind`, and 1..64 `models`.
2. The Host materializes each declaration as a real `providers` row with id
   `plugin:<pluginId>:<declaredId>`, owned by that plugin and listed in native
   Settings → Provider like a user row.
3. Schema v17 adds the nullable `providers.owner_plugin_id` column and its
   partial index; pre-v17 rows stay user rows with a NULL owner, and the public
   payload carries `ownerPluginId`.
4. The declaration is re-read on every plugin load and is authoritative for the
   fields it declares, while values it does not own — stored headers and the
   OAuth account label — survive a refresh.
5. Credentials stay in the Host secret store as `secret:provider:<id>:api_key`
   and `secret:provider:<id>:oauth`; API keys never reach the plugin, and OAuth
   is reachable only through `onProviderOAuth` with the `provider.oauth` grant
   (ADR 0320).
6. `providers.update` and `providers.delete` fail with
   `PROVIDER_OWNED_BY_PLUGIN` for a plugin row, because the declaration would
   overwrite a user edit and only the plugin lifecycle can remove the row.
7. Disabling a plugin keeps its rows with `enabled = 0`, so re-enabling restores
   the stored credential, while uninstalling it or dropping an entry deletes the
   row with both credential references.
8. A non-empty declaration requires the high-risk `provider.register`
   permission, and a manifest that declares providers without it fails
   validation.
9. Reconciliation runs on `plugins.enable`, `plugins.disable`,
   `plugins.loadDev`, `plugins.uninstall`, and once at host startup, and a sync
   failure is logged as a warning without changing enablement.
10. OAuth contributions use the host-owned account UI and callback protocol of
    ADR 0320, with one encrypted credential per declaration and no multi-account
    rows.
11. The plugin SDK mirrors these authoring rules, requires `provider.oauth` for
    OAuth declarations, and derives the `providers` capability token.

## Consequences

- A plugin-provided service is a first-class provider that lists, discovers
  models, and resolves through the same Host path with no new wire adapter.
- Every Host path that mutates a row must respect `owner_plugin_id`, and a
  credential lasts only as long as the declaration that introduced it.
- An unreviewed manifest can add rows to the provider list; the permission, the
  install confirmation, and the local-only limit for v1.1 bound that exposure.

## Alternatives considered

- A sidecar-only provider registry: rejected; the service would exist twice with
  a private identity the catalog, session binding, and secret store cannot
  address.
- Let the plugin write rows through `providers.create`: rejected; user edits and
  the declaration would fight over the row, and uninstall would leave an orphan.

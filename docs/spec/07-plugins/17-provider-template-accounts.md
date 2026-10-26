# Provider templates and native accounts

## Add a reusable service integration

Use `contributes.providerTemplates`, not `contributes.providers`, when a user
should be able to add several accounts. Both arrays can coexist, but IDs must
be unique across them. Installing/enabling a template adds a native chooser
entry, **not** an account. Official services remain independent and unchanged.
The setup and account editor display plugin attribution and the endpoint.

This minimal fixture declares a compatible API-key transport; its reserved
`.test` address is documentation only and cannot serve real requests:

```json
{
  "schemaVersion": 1,
  "id": "example.gateway",
  "name": "Example Gateway",
  "version": "1.0.0",
  "main": "main.cjs",
  "permissions": ["provider.register"],
  "contributes": {
    "providerTemplates": [{
      "version": 1,
      "id": "gateway",
      "name": "Example compatible service",
      "authKind": "api_key",
      "baseUrl": "https://api.example.test/v1",
      "apiStyle": "chat_completions",
      "models": [{ "id": "example-chat" }]
    }]
  }
}
```

`main.cjs` can export an empty object. No OAuth or inference hook is needed for
this declaration, and the standard transport does not deliver its key to plugin
code. As with all trusted Node plugins, loading arbitrary entry code itself is
not an OS-sandbox guarantee.

## V1 closed contract

`PluginProviderTemplateV1` reuses provider display/transport/model fields and
adds `version: 1`. Unknown fields are rejected recursively in templates,
localized labels, models, adapters and OAuth. Internal ownership, account IDs
and secret references are never accepted as template/create fields. Legacy
`contributes.providers` validation and fixed identities remain compatible.

- Template IDs: `[a-zA-Z][a-zA-Z0-9_-]{0,63}`; model IDs: 1..256 UTF-16 units,
  unique after trimming; at most 64 models.
- Name/vendor key/model name/category: 128 units; description: 280. Localized
  category/description use exactly `en` and `zh-CN`. Control characters are rejected.
- `baseUrl`: absolute HTTP(S), at most 2048 units, no userinfo, fragment,
  whitespace or backslash. Syntax does not grant network access: existing Host
  endpoint/DNS/proxy policies still apply.
- Model limits are positive uint32 integers; thinking levels are at most 16
  strings of 64 units. Adapter operations bound model capability; preferences
  cannot add unsupported chat/images operations.
- `models: []` supports endpoint discovery where the compatible transport permits
  it; discovery failure retains the saved account and allows retry.

## Declarative OAuth

Set `authKind: "oauth"` and `oauth.flow` to `authorization_code` or `device_code`.
Both require public `clientId` (1..512 units) and HTTPS `tokenUrl`. Authorization
code requires HTTPS `authorizationUrl`; device code requires HTTPS
`deviceAuthorizationUrl`. Endpoints use the same 2048-unit URL bounds and public
HTTPS policy. `scopes` is an optional array of at most 64 unique RFC 6749 scope
tokens, each 1..256 ASCII characters. `redirectPath` is authorization-code-only,
defaults to `/callback`, and permits a single-leading-slash path of at most 256
characters containing ASCII letters, digits, `/`, `_`, `-`.

Host performs PKCE S256, random state validation, an ephemeral IPv4 loopback
callback, token exchange/refresh, and RFC 8628 pending/slow-down/expiry handling.
Responses map only `access_token`, `refresh_token`, `expires_in`; no executable
field mapping, client secret, JWT decoding or arbitrary server header mapping
is accepted. Requests/responses, polling and callback lifetime are bounded and
cancellable. Secrets are encrypted through the existing account secret store.
No custom OAuth grant or callback is required for these standard flows.
The loopback listener validates state and code/error shape before accepting a
callback. Invalid or duplicate parameters return a fixed rejection response but
do not consume the login; a later valid callback may still complete within the
original timeout. State-bound denial responses terminate login without token
exchange. Callback results are independently revalidated after external I/O.

Omitted flow or `custom` uses `onProviderOAuth` and requires `provider.oauth`.
Custom flow accepts only flow/display fields, not declarative endpoints. Custom
inference additionally requires `provider.inference` and a V1 adapter export.
Both permissions disclose trusted code access; neither is implied by registration.
The optional OAuth request `accountId` identifies a Host-selected template
account; `providerId` remains the manifest contribution ID. Inference binding
adds account/template identity to the existing plugin/runtime/session/model
checks. Inference credentials never include refresh tokens.

## Host APIs and persistence

- `providers.getTemplate({pluginId, templateId})` returns the authoritative active,
  granted definition. Main uses it; it is not an arbitrary manifest write API.
- `providers.createFromTemplate({pluginId, templateId, name?, secretValue?})`
  creates a UUID account. `secretValue` is API-key-only. Renderer forwards this
  closed request through `providersCreateFromTemplate`; Rust owns validation.
- `providers.completeTemplateOAuth({id})` is Main-to-Host only: it revalidates the
  template and stored credential before completing a pending OAuth account.
- Public rows expose optional `pluginTemplateId`, `pluginTemplateVersion: 1`
  alongside authoritative `ownerPluginId`; secrets are never public fields.
- Schema 26 adds `provider_template_bindings(provider_id PRIMARY KEY REFERENCES
  providers(id) ON DELETE CASCADE, template_id, version CHECK(version=1),
  definition_json)`. `definition_json` is the validated prior manifest definition,
  not credentials. `config_json.pluginTemplate.pending` marks unfinished login.
  Migration backs up schema25, preserves old rows/secrets/preferences, and does
  not convert legacy singleton rows into template accounts. Schema24 first
  receives the model discovery v25 migration. Both historical v25 layouts
  (discovery-only and template-only) upgrade safely; missing discovery state is
  initialized only when adding the column, never overwriting saved membership.

## Native user path and lifetime

Chooser key `plugin-template:<pluginId>:<templateId>` is directory-only. It
remains available after adding any number of accounts. New login allocates an
account; login by native account ID reauthenticates only that account. Pending
OAuth accounts are disabled and excluded from usable models. Failure/cancel
cleans the pending account/secrets; cleanup failures are logged without secret
material and startup retries abandoned pending-account cleanup.

Accounts reuse native names, key editing, enablement and model selection,
including aliases, limits, reasoning, delegation opt-in and explicit empty
selection. Discovery and refresh are account-scoped. Sensitive auth, endpoint,
protocol, client/scopes/adapter changes invalidate old credentials and discovery;
ordinary display updates preserve preferences. Reauthentication can recover an
invalidated template account without creating another account.

- Disable/revoke: retain accounts/secrets/preferences; reject new work and cancel
  the plugin runtime's in-flight work. Re-enable revalidates and restores user choice.
- Template removed: retain account, mark unavailable; restore only after valid
  source reconciliation. User may remove unavailable accounts.
- Account removed: cancel its login/refresh/inference; delete its secrets and
  discovery. Other accounts and the reusable entry remain.
- Uninstall: remove all owned accounts, secrets, discovery and pending login
  state. Historical sessions/messages are not deleted or rebound.
  Before registry/secret removal, atomically disable every owned account and
  persist Host-only `config_json.pluginCleanupPending: true`. Attempt every
  account and both credential channels even when one removal fails. Any cleanup
  or registry persistence failure returns RPC `INTERNAL` (1000) with a safe retry
  diagnostic, never success or raw storage paths. Pending rows cannot be enabled,
  completed or adopted by reconciliation. Startup, repeated uninstall and same-ID
  registration retry cleanup; successful recovery deletes old grants before
  reconciliation. If the intent transaction fails, abort before registry/secret
  mutation. This adds no database schema or public plugin-manifest field.
- Late callbacks cannot recreate removed accounts or return stale model output.

Native chat/subagents/images keep their current authorization, execution and
persistence owners. Image eligibility requires actual adapter operations and
account readiness; image-only models never become chat defaults. A custom
adapter without a safe non-billable probe returns `UNSUPPORTED`/`network: skipped`
for connection testing, without refresh or paid generation. No implicit custom
retry or paid-service fallback is added.

Custom callback exceptions and stream error events become Host-owned fixed
codes/messages, not raw exception text in events/logs. This protects error
channels; it does not stop malicious trusted code deliberately exfiltrating
through raw Node I/O. Historical audit probes remain pre-remediation evidence.

## Executable acceptance (no real service)

From the request worktree after building JS:

```sh
node --test apps/desktop/test/provider-template-*.test.mjs
# Actual Rust Host + plugin child; build the Host first (no release packaging):
cargo build -p host-core --locked
node --test apps/desktop/test/provider-template-native-host.e2e.mjs
```

- `provider-template-user-path`: native chooser/setup/edit, two key accounts,
  no-auth discovery and OAuth ID/cancellation interaction.
- `provider-template-accounts`: real plugin child, public OAuth orchestration,
  native chat/delegate/image tools, refresh, reauth, delete and secret isolation.
- `provider-template-declarative-account`: public native-account OAuth entry,
  real loopback PKCE/device engine, synthetic HTTPS boundary, refresh and late
  cancellation/unload cleanup; no custom OAuth hook/grant.
- `provider-template-inference`: actual plugin child, source/account binding and
  safe errors. `provider-template-image-lifecycle`: per-account image cancellation.
- `provider-template-oauth`: protocol/security bounds; `provider-template-connection`:
  truthful unsupported probes.
- Rust template/plugin/RPC/migration tests cover actual storage, lifecycle,
  ownership rejection and legacy upgrades. SDK tests cover closed manifests.
- `provider-template-native-host.e2e`: real Rust Host process/database/encrypted
  secret store plus plugin child and native executors; verifies independent
  login/refresh, preferences, chat/delegate/images, deletion, restart and uninstall
  with historical-session retention. Tools not used by the fixture remain stubbed.

Some fixtures fake external service/Host RPC boundaries where stated; the native
Host fixture uses real storage. None claims whole-window Electron acceptance or
real Antigravity interoperability.
See [E2E plan](../06-delivery/04-e2e-test-plan.md) and
[decision rationale](../../adr/plugin-provider-template-accounts.md).

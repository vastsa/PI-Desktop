# 12. Provider Config Schema

## 1. Storage location

Owned by Rust host DB/settings store.

Tables (canonical DDL in [04-data-storage](04-data-storage.md) §4.3–4.4, §4.11):

- `providers`
- `models` (single catalog table; `source: bundled | discovered | user` replaces the old `provider_models` / `model_catalog_cache` split)
- `secrets_meta` (no raw secret values)
- recent-model MRU lives in `kv(ns='cache')`, not a table

## 2. Provider record JSON schema (logical)

```json
{
  "$id": "pi-desktop.provider.v1",
  "type": "object",
  "required": ["id", "name", "vendorKey", "type", "protocol", "enabled", "authKind"],
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "name": { "type": "string", "minLength": 1 },
    "vendorKey": { "type": "string", "minLength": 1 },
    "type": { "enum": ["native", "openai_compatible", "custom"] },
    "protocol": {
      "enum": ["openai", "anthropic", "google", "openai_compatible", "bedrock", "custom_http"]
    },
    "enabled": { "type": "boolean" },
    "baseUrl": { "type": "string" },
    "authKind": {
      "enum": [
        "api_key",
        "api_key_and_base_url",
        "bearer",
        "azure_api_key",
        "aws_sdk_default",
        "custom_headers",
        "oauth",
        "none"
      ]
    },
    "secretRef": { "type": "string" },
    "headers": {
      "type": "object",
      "additionalProperties": { "type": "string" }
    },
    "apiStyle": {
      "enum": [
        "chat_completions",
        "opencode_go",
        "responses",
        "anthropic_messages",
        "google_generative_ai",
        "openai_codex_responses",
        "pi_messages",
        "auto"
      ]
    },
    "compatibility": {
      "type": "object",
      "properties": {
        "supportsTools": { "type": "boolean" },
        "supportsVision": { "type": "boolean" },
        "supportsStreaming": { "type": "boolean" },
        "supportsReasoning": { "type": "boolean" },
        "supportedThinkingLevels": {
          "type": "array",
          "items": {
            "enum": ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
          },
          "uniqueItems": true
        }
      }
    },
    "defaultModelId": { "type": "string" },
    "models": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "contextWindow", "maxTokens", "thinkingLevels", "defaultThinkingLevel"],
        "properties": {
          "id": { "type": "string", "minLength": 1 },
          "contextWindow": { "type": "integer", "minimum": 1 },
          "maxTokens": { "type": "integer", "minimum": 1 },
          "thinkingLevels": {
            "type": "array",
            "items": { "enum": ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
            "uniqueItems": true
          },
          "defaultThinkingLevel": {
            "type": ["string", "null"],
            "enum": ["off", "minimal", "low", "medium", "high", "xhigh", "max", null]
          },
          "supportsImages": { "type": ["boolean", "null"] },
          "supportsDocuments": { "type": ["boolean", "null"] },
          "availableForSubagents": { "type": "boolean", "default": false }
        }
      }
    },
    "createdAt": { "type": "string" },
    "updatedAt": { "type": "string" }
  }
}
```

`compatibility.supportsReasoning` and
`compatibility.supportedThinkingLevels` remain readable for stored-record and
older-client compatibility, but Electron main ignores them during runtime
model resolution. The public provider shape is enriched from the local
models.dev snapshot. Unknown free-form models initially expose
`supportsReasoning=false` and `supportedThinkingLevels=["off"]`; Settings may
still persist an explicit thinking-level binding for an endpoint that supports
it. The raw secret and internal compatibility JSON remain hidden.

For OpenAI-compatible Chat Completions models, the runtime defaults
`compat.supportsDeveloperRole` to `false`, so system instructions are sent as
`role: "system"` even when the selected model supports reasoning. A resolved
model record may explicitly set it to `true` for an upstream that accepts
`role: "developer"`; this override is model-scoped.

`authKind: "oauth"` marks a vendor-account row (ADR 0095, D237, D240): the credential
is an OAuth grant under `secret:provider:<id>:oauth` rather than a pasted key,
so the row carries no `secretRef` for it and launches with an empty key. The
last two apiStyle values are vendor-account wire APIs — `openai_codex_responses`
(the Codex conversation envelope) and `pi_messages` (the radius gateway) — and
are not offered in the custom-provider dialog because neither works against a
hand-typed base URL with a pasted key. A vendor row's style is not fixed by the
vendor: GitHub Copilot serves Anthropic, Chat Completions, and Responses
models, so the style follows the selected model and is rewritten on each model
change. The vendor account editor uses the same multi-model binding controls as
an AI service: authenticated catalog models and custom IDs can be selected,
and each binding persists its context window, max output tokens, thinking levels,
and default thinking level in `models`. `config_json.oauth.accountLabel` holds the non-secret display label for
the signed-in account.
Each successful login creates a new row even when another row has the same
`vendorKey`; the row id scopes the credential and runtime binding. The vendor
catalog exposes these rows as an `accounts` array with `providerId`, an optional
non-secret `accountLabel`, and a `connected` flag. The custom-provider dialog
does not edit or delete OAuth rows; the Vendor accounts card calls
`providers.delete` for the selected row.

`models` is the provider's selected model binding array. Each binding owns its
context/output limits and explicit thinking configuration. Published catalog
levels seed a newly selected known model, but the binding may enable any
canonical level so a proxy or newly released endpoint is configurable before
the catalog is updated. `defaultModelId` remains a
read compatibility field and is kept equal to the first binding when a new
provider is saved. When an older record has only `defaultModelId`, the host
materializes one binding on read with a 128,000 context window, 8,192 max
output, no enabled thinking levels, and a null default. The settings editor
still renders all canonical choices for that legacy binding, and the next write
stores the explicit binding array in `config_json.models`.

For context resolution, that 128,000 value is a backward-compatible generic
seed, not a reason to hide a published long-context limit. If models.dev now
publishes a positive `limit.context`, the effective runtime and inspector window
follow it; a non-default value entered in the model's Advanced controls remains
an explicit per-model override. Unknown IDs continue to use 128,000.

`availableForSubagents` is an optional, persisted opt-in on each model binding.
Host read/write and normalization preserve `true`; records created before this
field existed remain disabled by default. This flag is what Electron main uses
to build the delegation model catalog, so changing it survives provider edits
and application restarts.

`apiStyle: "opencode_go"` is a first-class OpenCode Go preset layered on the
OpenAI-compatible provider type. It persists as its own style so the UI can
identify the service, but runtime requests use the OpenAI Chat Completions
wire adapter. The preset always uses `name: "OpenCode Go"` and
`baseUrl: "https://opencode.ai/zen/go/v1"`; the settings dialog displays both
fields as read-only and accepts only the API key as connection input. Model
discovery calls the fixed `/models` endpoint with a Bearer key, and the raw key
continues to follow the normal secret-store path.

## 3. Built-in vendor presets

Presets only prefill form defaults; they are not a closed world.

| vendorKey | default protocol | authKind | baseUrl required |
|---|---|---|---|
| openai | openai | api_key | no |
| anthropic | anthropic | api_key | no |
| google | google | api_key | no |
| openrouter | openai_compatible | api_key_and_base_url | yes |
| deepseek | openai_compatible | api_key_and_base_url | yes |
| groq | openai_compatible | api_key_and_base_url | yes |
| together | openai_compatible | api_key_and_base_url | yes |
| fireworks | openai_compatible | api_key_and_base_url | yes |
| mistral | openai_compatible or native | api_key | optional |
| xai | openai_compatible | api_key_and_base_url | yes |
| azure_openai | openai_compatible | azure_api_key | yes |
| bedrock | bedrock | aws_sdk_default | no |
| ollama | openai_compatible | none | yes |
| lmstudio | openai_compatible | none | yes |
| custom | openai_compatible | api_key_and_base_url | yes |

### Fixed API-style presets

| apiStyle | provider type | authKind | name | baseUrl |
|---|---|---|---|---|
| `opencode_go` | `openai_compatible` | `api_key_and_base_url` | `OpenCode Go` | `https://opencode.ai/zen/go/v1` |

### Named endpoint presets (Zhipu / Z.AI)

These rows are created from the add-provider **Service** select, not from a
new `apiStyle`. They remain `type: "openai_compatible"` with
`apiStyle: "chat_completions"`. The dialog locks the endpoint; the display
name stays editable. `vendorKey` is the models.dev provider key so catalog
enrichment follows the exact API vs Coding Plan record.

| vendorKey | name | baseUrl | notes |
|---|---|---|---|
| `zhipuai` | Zhipu AI | `https://open.bigmodel.cn/api/paas/v4` | China standard API |
| `zhipuai-coding-plan` | Zhipu AI Coding Plan | `https://open.bigmodel.cn/api/coding/paas/v4` | China GLM Coding Plan. pi-ai `zai-coding-cn` is an alias. |
| `zai` | Z.AI | `https://api.z.ai/api/paas/v4` | International standard API |
| `zai-coding-plan` | Z.AI Coding Plan | `https://api.z.ai/api/coding/paas/v4` | International GLM Coding Plan |

pi-ai names its international Coding Plan transport `zai`, while models.dev
uses `zai` for the standard API. PI-Desktop persists the models.dev key and
the exact URL so the two cannot be confused. When the configured URL or
`vendorKey` matches one of these presets, the Completions adapter receives
`thinkingFormat: "zai"` and `zaiToolStream: true`.

### Vendor-account presets

These rows are created by signing in (Settings -> Model configuration ->
Vendor accounts), not by the custom-provider dialog. The list is derived at
runtime from `models.getProviders().filter(p => p.auth.oauth)`, so it tracks
pi-ai rather than this table; every login creates a separate row, and
`baseUrl`, `apiStyle`, and `defaultModelId` are filled in from that account's
own catalog after login. Matching models.dev records provide the binding
metadata; an account model absent from the snapshot remains generic.

| vendorKey | subscription | typical apiStyle | login shape |
|---|---|---|---|
| anthropic | Claude Pro/Max | anthropic_messages | PKCE + local callback |
| openai-codex | ChatGPT Plus/Pro | openai_codex_responses | PKCE + local callback, or pasted code |
| github-copilot | Copilot | varies by model | device code |
| openrouter | account credit | chat_completions | PKCE + local callback |
| kimi-coding | Kimi | chat_completions (headers-only auth) | device code |
| xai | xAI | chat_completions | device code |
| radius | Radius | pi_messages | PKCE + local callback |

## 4. Model catalog cache record

```ts
type ModelCatalogCacheRecord = {
  providerId?: string // empty for global bundled
  modelId: string
  displayName: string
  vendorKey: string
  capabilities: string[]
  contextWindow?: number
  source: "bundled" | "discovered" | "user"
  /** Renderer annotation for a row resolved from the bundled models.dev snapshot. */
  catalogSource?: "models.dev"
  updatedAt: string
  raw?: unknown
}
```

## 5. Bundled models.dev snapshot

The raw public catalog is checked into the release resource at
`apps/desktop/resources/models.dev/api.json` and packaged at
`resources/models.dev/api.json`. `scripts/release.mjs` fetches and validates
`https://models.dev/api.json`, then atomically replaces the checked-in file
before creating a release tag. Electron main reads this bundled snapshot at
startup without network I/O. Settings → Model configuration can refetch the
URL, but a successful response updates only the current process's in-memory
catalog; it never writes the packaged resource or a user cache. Cache reads
never send provider credentials to models.dev. The Rust `models` table continues
to store only normalized provider selection rows; it does not need a schema
change for the raw snapshot.

## 6. IPC / host methods (provider domain)

- `providers.list`
- `providers.get`
- `providers.create`
- `providers.update`
- `providers.delete`
- `providers.testConnection`
- `providers.listModels`
- `providers.cacheModels` (internal Electron-main to host persistence bridge)
- `providers.refreshModels`
- `providers.upsertUserModel`
- `providers.deleteUserModel`

## 6. Security constraints

1. raw secrets never returned by list/get provider APIs
2. `headers` must not store `Authorization: Bearer <secret>` if secret store can be used
3. export settings excludes secrets by default

## 7. Migration

- schema version via `PRAGMA user_version` (04-data-storage §7)
- provider records additive-evolved; per-provider extension fields land in `config_json`
- unknown future protocol values should not crash older app versions (ignore/disable with warning)

## 8. SQL (Rust-owned SQLite)

The canonical DDL lives in [04-data-storage](04-data-storage.md) (D086). Summary of the provider-domain tables:

```sql
-- providers: id/name/vendor_key/type/protocol/api_style/auth_kind/base_url/
--            enabled/secret_ref/default_model_id + config_json (headers,
--            compatibility, future knobs), INTEGER ms timestamps
-- models:    PK(provider_id, model_id), display_name, source
--            (bundled|discovered|user), capabilities_json, context_window,
--            max_output_tokens, deprecated — refresh upserts never overwrite
--            source='user' rows
-- secrets_meta: secret_ref PK, owner_kind/owner_id, kind, backend
```

> Raw secret material is **not** stored in these tables.

## 9. Host method contracts (v1)

### `providers.list`
- in: `{ includeDisabled?: boolean }`
- out: `{ providers: ProviderPublic[] }`
- `ProviderPublic` excludes raw secrets; includes `hasSecret: boolean` (true
  for **either** credential), `hasOauth: boolean`, and the non-secret
  `oauthAccountLabel?: string`

### `providers.create` / `providers.update`
- in: provider fields + optional `secretValue` + optional `oauthAccountLabel`
  (merged into `config_json.oauth`, cleared with an empty string); legacy
  clients may still send `supportsReasoning` / `supportedThinkingLevels`; new
  clients send `models: ModelBinding[]`
- behavior: persist config; if secretValue present, write secret store and set
  `secretRef`; legacy thinking fields may remain in
  `config_json.compatibility` but do not affect runtime resolution
- out: `ProviderPublic`

### `providers.delete`
- in: `{ id, deleteSecret?: boolean }` default `deleteSecret=true`
- behavior: clears both credential refs (`:api_key` and `:oauth`) and their
  metadata rows, so a re-created provider can never inherit a stranger's
  refresh token. The renderer uses this same operation for removing one OAuth
  account, so deleting one row cannot remove another account with the same
  `vendorKey`
- out: `{ ok: true }`

### `providers.testConnection`
- in: `{ id, modelId?: string }`
- out: `{ ok: boolean, latencyMs?: number, error?: AppError, sampleModelId?: string }`
- an `authKind: "oauth"` row proves itself by resolving vendor auth (refreshing
  the token if it expired) instead of probing the network with a key it does
  not have

### `providers.listModels`
- renderer IPC in: `{ providerId, source?: "cache"|"refresh" }`; `cache`
  returns the durable catalog without provider network access, while `refresh`
  reads the local models.dev snapshot and runs provider endpoint discovery only for IDs absent from it
- host RPC in: `{ providerId?: string }`; reads only the Rust-owned `models`
  table
- for an `authKind: "oauth"` row Electron main reads the authenticated catalog
  (`models.getAvailable`, which applies the vendor's own `filterModels`, so a
  Copilot account lists what its subscription includes) instead of calling
  `/models`; each returned model carries the apiStyle its wire API implies
- out: `{ models: ModelCatalogItem[] }`; each known model carries the complete
  models.dev metadata including `reasoning`, `supportedThinkingLevels`, limits,
  modalities, output types, and capability tags. Cached/provider claims cannot
  override the local catalog record.

### `providers.cacheModels` (internal host RPC)
- in: `{ providerId, models: DiscoveredModelInput[] }`
- behavior: transactionally upsert successful live discovery into `models` as
  `source='discovered'`; never overwrite `source='user'` rows and never delete
  prior cache rows on a failed or partial refresh
- out: `{ cached: number, models: ModelCatalogItem[] }`
- raw secrets and authorization headers are never part of this call

### `providers.refreshModels`
- in: `{ id }`
- out: `{ added: number, updated: number, removed: number, models: ModelCatalogItem[] }`

### `providers.upsertUserModel` / `providers.deleteUserModel`
- manage free-form / override model entries

## 10. Validation rules

1. API/custom `name` unique (case-insensitive) among editable providers;
   OAuth rows may share a vendor display name because `providerId` is their
   account identity
2. `openai_compatible` / local gateways require absolute `baseUrl` unless preset says optional
3. `apiStyle=opencode_go` requires the fixed OpenCode Go name and endpoint; clients must not accept overrides
4. `authKind=none` forbidden for cloud presets that require keys
5. headers keys are case-insensitive unique
6. secretValue max length enforced (e.g. 8KB)
7. modelId must be non-empty trimmed string; allow `/`, `.`, `:`, `-`
8. unknown protocol on older clients => provider shown disabled with warning, not crash
9. Legacy `supportsReasoning`, when present, must still validate as boolean but
   has no runtime effect
10. Legacy `supportedThinkingLevels`, when present, must still validate as an
  array of canonical thinking levels but has no runtime effect

## 11. Secret ref format

```text
secret:provider:<providerId>:api_key
secret:provider:<providerId>:oauth
```

The two refs are independent, so one row may hold a key, a vendor account, or
both; see [14-secrets-storage](14-secrets-storage.md) §10. Future multi-secret
providers may add further suffixes (`:client_secret`, etc.).

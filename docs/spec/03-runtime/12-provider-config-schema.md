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
    "ownerPluginId": { "type": ["string", "null"] },
    "headers": {
      "type": "object",
      "additionalProperties": { "type": "string" },
      "maxProperties": 32
    },
    "userAgent": {
      "type": "string",
      "maxLength": 256,
      "description": "legacy; migrates into headers.User-Agent"
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
        "required": ["id"],
        "properties": {
          "id": { "type": "string", "minLength": 1 },
          "alias": { "type": "string", "maxLength": 60 },
          "contextWindow": { "type": "integer", "minimum": 0 },
          "contextWindowSource": { "enum": ["catalog", "user"] },
          "maxTokens": { "type": "integer", "minimum": 0 },
          "thinkingLevels": {
            "type": "array",
            "items": { "enum": ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
            "uniqueItems": true
          },
          "defaultThinkingLevel": {
            "type": ["string", "null"],
            "enum": ["off", "minimal", "low", "medium", "high", "xhigh", "max", "omit", null]
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

`models[].alias` is an optional display label (ADR 0192). `models[].id`
remains the identity sent to the provider and the alias is never used for
provider or model resolution; UI naming and clearing rules are specified in
[04-ux/08-component-spec](../04-ux/08-component-spec.md). Host-core trims the
alias, drops a blank one, and enforces the 60-character limit by rejecting an
over-long alias with `MODEL_ALIAS_TOO_LONG`.

`models[].contextWindowSource` records where the stored `contextWindow` came
from. `catalog` marks a models.dev snapshot that a later catalog correction may
replace (a lookup that falls back to the generic shape is not a correction);
`user` marks a number entered in Settings and is never replaced. The
property is optional, so a config written before the marker stays readable and
older clients ignore it. Host-core keeps only those two values and drops anything
else, so an unreadable marker cannot turn into a third state. The resolution rule
is specified in [13-model-catalog-and-selection](13-model-catalog-and-selection.md) §9.1.

`compatibility.supportsReasoning` and
`compatibility.supportedThinkingLevels` remain readable for stored-record and
older-client compatibility, but Electron main ignores them during runtime
model resolution. The public provider shape is enriched from the local
models.dev snapshot. Unknown free-form models initially expose
`supportsReasoning=false` and `supportedThinkingLevels=["off"]`; Settings may
still persist an explicit thinking-level binding for an endpoint that supports
it. The raw secret and internal compatibility JSON remain hidden.
A hand-typed custom model id is matched against that snapshot before its
binding is seeded (`providers.lookupModel`, §9), so a published record supplies
the binding's context window, max output tokens, and thinking levels even
though the id is absent from every discovered list; an unpublished id keeps the
generic seed.

Anthropic Messages providers may store either the service root or a URL ending
in `/v1`. Model discovery preserves that configured path and requests
`/v1/models` exactly once; runtime request setup removes the trailing `/v1`
before invoking pi-ai, whose Anthropic SDK adds `/v1` to the messages route.
Both forms therefore send messages to the configured service's
`/v1/messages` endpoint rather than a doubled `/v1/v1/messages` path.

For OpenAI-compatible Chat Completions models, the runtime defaults
`compat.supportsDeveloperRole` to `false`, so system instructions are sent as
`role: "system"` even when the selected model supports reasoning. A resolved
model record may explicitly set it to `true` for an upstream that accepts
`role: "developer"`; this override is model-scoped.

`authKind: "oauth"` marks a vendor-account row (ADR 0095, D237, D240): the credential
is an OAuth grant under `secret:provider:<id>:oauth` rather than a pasted key,
so the row carries no `secretRef` for it and launches with an empty key. The
two account-only apiStyle values are vendor-account wire APIs — `openai_codex_responses`
(the Codex conversation envelope) and `pi_messages` (the radius gateway) — and
are not offered in the custom-provider dialog because neither works against a
hand-typed base URL with a pasted key. New custom services offer only
Chat Completions, Responses, Anthropic Messages, and Google Generative AI;
OpenCode Go remains a named service. Existing non-OAuth rows with either
account-only style remain editable: their current format is shown as a disabled
legacy option with an explanation and can be saved unchanged. Merely opening
the editor does not derive another protocol, name, or URL from a matching
endpoint preset. Selecting another format is an explicit change. Copying such
a row preserves its draft format for review, but saving and discovery remain
disabled with a visible explanation until a supported format is explicitly
chosen. No existing authentication kind or credential is migrated. A vendor row's style is not fixed by the
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

`models[].contextWindow` and `models[].maxTokens` are optional on the wire. An
absent key, or an explicit `0`, is not a per-model choice: the host reads it as
zero and seeds the generic default (128,000 / 8,192) — the same value the
legacy binding above is materialized with, and the same value a plugin
manifest that declares no limits already produces. The stored array and the
manifest therefore agree on what a model without limits means (D610).

Each entry of a stored `models` array is decoded on its own. An entry that no
longer matches the schema is skipped and reported on the host log with the
provider id, its index and the reason, instead of discarding the whole array.
The read remains usable, but it is marked degraded: invalid JSON, a non-object
config, a non-array `models` value, or any unreadable entry is reported. An
absent `models` key and an empty array remain legal legacy states; an array
whose entries are all unreadable still falls back to the legacy binding and is
reported. To prevent a partial settings view from erasing stored data,
`providers.update` rejects an explicit model-array replacement with
`MODEL_BINDINGS_DEGRADED` while the stored value is degraded. Updates to
unrelated provider fields remain allowed.

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
wire adapter. The Service select offers OpenCode Go next to named Zhipu
endpoints. The preset always uses `name: "OpenCode Go"` and
`baseUrl: "https://opencode.ai/zen/go/v1"`; the common path is Service + API
key, with the host shown as a summary. Model discovery calls the fixed
`/models` endpoint with a Bearer key, and the raw key continues to follow the
normal secret-store path.

OpenCode Go (and any `opencode.ai` host) requires a stable
`x-opencode-session` header on LLM requests. Agent-runtime sends that header
plus `x-opencode-client: pi-desktop` and `User-Agent: pi-desktop/<APP_VERSION>`
on session turns, subagent turns, prompt enhancement, and plugin one-shots.
Caller-supplied headers override the client and User-Agent values; a missing
or empty session header is always restored from the conversation id.

`headers` is an optional per-row map stored in `config_json.headers`. Empty,
omitted, or update `{}` keeps the adapter default (pi-ai's `pi (…)` string,
Anthropic OAuth's `claude-cli/<version>`, or OpenCode's
`pi-desktop/<APP_VERSION>`). A non-empty map is last-writer on that row's
outbound HTTP — session turns, subagents, prompt enhancement, plugin one-shots,
`/models` discovery (including unsaved form values), connection tests, and
OAuth token refresh. A fetch wrapper is the last writer so Codex and the
Anthropic SDK cannot overwrite it; pi-ai's Google adapters receive the same
values on stream-option headers instead, because they reject any other `fetch`
(issue #1072). The same values are also placed on stream-
option headers so OpenCode's caller-wins rule stays true. Keys are
case-insensitive unique, at most 32 entries, name ≤ 256 bytes, value ≤ 4096
bytes, no CR/LF, names alphanumeric plus hyphen. Values are folded to
half-width first — the fullwidth block (U+FF01–U+FF5E) and the ideographic
space (U+3000) become their ASCII counterparts — then trimmed, then checked:
HTAB, printable ASCII and the Latin-1 supplement may travel, while Han, emoji,
curly quotes, NUL and every other control character are refused with
`HEADERS_INVALID` naming the character and its index. Folding is what covers
the case users actually hit: a fullwidth character is what an IME or a
fullwidth-formatted page produces, and an unfixed value makes `Headers.set`
throw `Cannot convert argument to a ByteString` mid-turn. A full NFKC pass is
deliberately not used — it would rewrite halfwidth katakana into code points
above U+00FF and produce combining marks. The Advanced editor also says, next
to the rows, when a value will be folded and when it will be refused.

The same rule is applied at three boundaries with three different failure
modes, deliberately: **the editor's save** refuses an unusable row with the
character and its index (`HEADERS_INVALID`), because a user is there to fix it;
**a stored map** is folded on read and the unusable rows dropped, so a store
written before the rule cannot fail a turn; and **a sync bundle** is folded and
dropped before it is deserialized into a write input, so a row a peer on an
older build (or a pre-rule backup) still carries cannot fail a whole revision.
The read path and the sync path therefore agree, and only the interactive write
reports an error. Reserved keys
(`authorization`, `proxy-authorization`, `host`, `content-type`,
`content-length`, `cookie`, `set-cookie`, `connection`, `transfer-encoding`,
`te`, `trailer`, `upgrade`, `keep-alive`, `x-api-key`, `api-key`,
`chatgpt-account-id`, `x-opencode-session`) are rejected so this cannot smash
signing or app routing. This is not a secret. Leftover `config_json.userAgent`
migrates into `headers["User-Agent"]` on read; writing `headers` drops it.
Overriding Anthropic OAuth's `claude-cli/…` User-Agent can make Claude Pro/Max
reject the request. First OAuth login does not collect headers; they are
edited on the account after it exists. Advanced UI is a compact key/value
editor, not a dedicated User-Agent field.

Copilot OAuth rows also retain the static IDE identity headers from the pinned
pi-ai transport model (`Editor-Version`, `Editor-Plugin-Version`, and
`Copilot-Integration-Id`) even though runtime models use the local row id for
account isolation. Agent-runtime supplies Copilot's context-sensitive request
headers per call; a saved custom header with the same name overrides the
default.


A row a plugin declared through `contributes.providers` carries
`ownerPluginId` (its row id is `plugin:<pluginId>:<declaredId>`), and it is a
normal provider row for model resolution, discovery, connection testing, and
session binding. It is read-only for the user path: `providers.update` and
`providers.delete` refuse it with a `PROVIDER_OWNED_BY_PLUGIN` error. The
declaration is re-read from the plugin manifest on every plugin load and is
authoritative for its own fields, while stored `headers`, the OAuth account
label, and a credential the user entered are kept. Disabling the plugin keeps
the row and turns it off; uninstalling it, or removing the declaration, deletes
the row and both credential refs (ADR 0259,
`07-plugins/02-plugin-manifest-schema.md` §5.4).
### Copy a provider into an independent draft

Model configuration offers **Copy** on ordinary non-OAuth provider rows. The
action normally opens a new custom-service draft with an editable API format,
allowing the same endpoint and model bindings to be reused for another
protocol. OpenCode Go is the exception: its copy retains the named service and
fixed `opencode_go` format; selecting Custom service first makes the ordinary
API formats editable. OAuth account rows do not offer this action.

The draft is built from an explicit allowlist: the source name, `baseUrl`,
`apiStyle`, and declared `models` binding fields. Model objects and nested
`thinkingLevels` arrays are copied independently so draft edits cannot mutate
the source. A copy label may distinguish the suggested name; the user can edit
it before saving. No source `id`, credential or credential reference,
`hasSecret` state, OAuth metadata, custom `headers`, or unknown fields are
copied. All custom headers are omitted because an otherwise permitted header
may contain a token. The dialog explains that credentials and custom headers
must be supplied again when needed.

A malformed Base URL, a non-HTTP(S) scheme, or a URL containing user info,
query parameters, or a fragment is left blank in the draft so legacy URL
credentials are not copied.

The draft uses the normal new-provider discovery path: it must not pass the
source provider id to model discovery or connection testing to resolve that
provider's stored key. Any authenticated discovery uses only credentials
explicitly supplied for the new draft. Copying does not read or duplicate
secret-store values.

Canceling the draft performs no provider/configuration persistence. Saving
uses the existing `createProvider` / `providers.create` flow and assigns a new
provider identity and, when a new key is entered, that provider's own secret
reference. The source provider and global default provider/model selections
remain unchanged. The first selected model remains the new provider's own
default through the existing create behavior. Copying adds no IPC method,
storage schema, or permission boundary.

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

### Named endpoint presets

These rows are created from the add-provider **Service** select, not from a
new protocol. They remain `type: "openai_compatible"`. The common path is
Service + API key; the published host is a summary, and the display name is
editable in Advanced. Custom endpoint shows Name beside Base URL, then API key
beside API format. `vendorKey` is the models.dev provider key.

International: OpenAI (`responses`), Anthropic (`anthropic_messages`), Google
Gemini (`google_generative_ai`), OpenRouter, Groq, xAI, Mistral, Together AI,
Fireworks, OpenCode Go (`opencode_go`), Z.AI / Z.AI Coding Plan, Ant Ling,
Baseten, Cerebras, Hugging Face (`huggingface`, aliases `hugging-face` / `hf`),
Meta (`responses`), MiniMax (International) (`anthropic_messages` at
`https://api.minimax.io/anthropic/v1`), Moonshot AI (International)
(`moonshotai` at `https://api.moonshot.ai/v1`), NVIDIA (alias `nim`), OpenCode
Zen (`opencode` at `https://opencode.ai/zen/v1`, alias `opencode-zen`), Vercel
AI Gateway (`vercel` at `https://ai-gateway.vercel.sh/v1`, alias
`vercel-ai-gateway`).

`builtinProviders()` from pi-ai is the source for this list: every built-in
provider is either reachable through one of the presets above or is an
intentional exception with a recorded reason — Amazon Bedrock, Azure OpenAI,
Cloudflare AI Gateway, Cloudflare Workers AI, and Google Vertex AI (their URLs
carry account, region, project, or deployment ids), GitHub Copilot and OpenAI
Codex (vendor-account rows), and Radius (`pi_messages` is account-only in this
app). `packages/agent-runtime/src/pi-ai-provider-sync.test.ts` fails when a new
built-in provider is neither covered nor excepted.

China: DeepSeek, Qwen DashScope (`alibaba-cn`), Moonshot (`moonshotai-cn`),
Zhipu AI / Coding Plan, SiliconFlow (`siliconflow-cn`), Volcengine Ark,
MiniMax (`anthropic_messages` at `https://api.minimaxi.com/anthropic/v1`),
MiniMax (OpenAI) (`chat_completions` at `https://api.minimaxi.com/v1`, aliases
`minimax-openai` / `minimax-compatible`), Kimi For Coding (`anthropic_messages`),
Qwen Token Plan (`alibaba-token-plan`, aliases `qwen-token-plan` /
`qwen-token-plan-individual`), Qwen Token Plan (China)
(`alibaba-token-plan-cn`, alias `qwen-token-plan-cn`), Xiaomi Token Plan
(`xiaomi-token-plan-cn` / `-ams` / `-sgp`).

Zhipu / Z.AI Completions requests still receive `thinkingFormat: "zai"` and
`zaiToolStream: true`. pi-ai `zai-coding-cn` remains an alias of
`zhipuai-coding-plan`. DeepSeek-family Completions requests receive
`requiresReasoningContentOnAssistantMessages: true` when the vendor key, URL,
model id, or catalog family identifies DeepSeek. `thinkingFormat` is unchanged.

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
- `providers.reorder`
- `providers.get`
- `providers.create`
- `providers.update`
- `providers.delete`
- `providers.testConnection`
- `providers.listModels`
- `providers.lookupModel`
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
- an unknown or legacy `apiStyle` remains editable: the provider editor uses
  `chat_completions` as its safe UI fallback, and a subsequent save repairs the
  stored style instead of crashing while normalizing the base URL

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
  for **either** credential), `hasOauth: boolean`, the non-secret
  `oauthAccountLabel?: string`, and optional `headers?: Record<string, string>`

### `providers.reorder`
- in: `{ id: string, targetId: string, placement: "before" | "after" }`
- out: `{ ok: true }`
- Atomically move the source relative to the target in the current host list.
  A missing source/target or invalid placement returns `INVALID_PARAMS` without
  writing. Moving to the current position is a successful no-op.
- Persist ordered provider IDs in `kv` at `providers.order`. `providers.list`
  applies that order before returning rows; absent metadata preserves creation
  order. New providers follow saved rows in creation order, deleted IDs are
  ignored, and disabled rows keep their relative position when filtered out.
- This is a display preference, including for plugin-owned rows. Provider
  configuration, credentials, enabled state, timestamps and the default model
  remain unchanged. Plugin configuration write restrictions still apply.
- Uses the existing `kv` extension boundary; no database migration or protocol
  version bump. Older applications ignore this metadata.

### `providers.create` / `providers.update`
- in: provider fields + optional `secretValue` + optional `oauthAccountLabel`
  (merged into `config_json.oauth`, cleared with an empty string) + optional
  `headers` (merged into `config_json.headers`, cleared with `{}`); leftover
  `config_json.userAgent` migrates into `headers["User-Agent"]` on read; legacy
  clients may still send `supportsReasoning` / `supportedThinkingLevels`; new
  clients send `models: ModelBinding[]`
- behavior: persist config; if secretValue present, write secret store and set
  `secretRef`; legacy thinking fields may remain in
  `config_json.compatibility` but do not affect runtime resolution
- a plugin-owned row is refused with `PROVIDER_OWNED_BY_PLUGIN`; its declaration
  is the only writer of its own fields (§2)
- out: `ProviderPublic`

### `providers.delete`
- in: `{ id, deleteSecret?: boolean }` default `deleteSecret=true`
- behavior: clears both credential refs (`:api_key` and `:oauth`) and their
  metadata rows, so a re-created provider can never inherit a stranger's
  refresh token. The renderer uses this same operation for removing one OAuth
  account, so deleting one row cannot remove another account with the same
  `vendorKey`
- a plugin-owned row is refused with `PROVIDER_OWNED_BY_PLUGIN`; the owning
  plugin's lifecycle removes it
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
- for an `authKind: "oauth"` row Electron main reads the signed-in account's
  model list (see `03-runtime/11-provider-model-system.md`) instead of the
  pinned catalog. pi-ai `models.getAvailable` is used only when that request
  fails. Each returned model carries the apiStyle its wire API implies.
  `openai-codex` calls `GET {base}/codex/models`, so an account id such as
  `gpt-6-luna` appears without a pin update; models.dev does not invent those
  IDs. Copilot still hides models the account did not enable.
- out: `{ models: ModelCatalogItem[] }`; each known model carries the complete
  models.dev metadata including `reasoning`, `supportedThinkingLevels`, limits,
  modalities, output types, and capability tags. Cached/provider claims cannot
  override the local catalog record.

### `providers.lookupModel`
- renderer IPC in: `{ modelId, baseUrl?, providerId?, vendorKey? }`
- out: `{ info: ModelInfo | null }`
- reads only the local models.dev snapshot: `ensureLoaded` then `findModel`,
  with no provider network access and no host RPC. `vendorKey` and `baseUrl`
  only disambiguate which published provider owns a duplicate id; `providerId`
  is echoed back on the returned record for the settings surface.
- exists because `providers.listModels` only describes a saved or reached
  provider's catalogue: a hand-typed custom id has no other channel to its
  published limits before the provider is saved.
- a hit seeds the new binding exactly like a picked model
  (`bindingFromModelInfo`): published context window, max output tokens, and
  thinking levels, with `contextWindowSource: "catalog"`, while the stored id
  stays exactly what the user typed (`bindingForCustomModelInfo`). A miss
  (`null`) keeps today's behavior: the picker seeds the custom binding with the
  generic 128,000 / 8,192 defaults and no thinking levels
  (`bindingForCustomModel`). The row is written first and upgraded in place, so
  a slow, failed, or unpublished lookup still leaves exactly one usable row and
  never overwrites an edit or delete made while it was in flight.

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
5. headers keys are case-insensitive unique, at most 32 entries; names
   alphanumeric plus hyphen; values folded from fullwidth to half-width, then
   trimmed, at most 4096 bytes, no CR/LF, printable Latin-1 only — a character
   above U+00FF or a control character is refused with the character and its
   index named
6. reserved header names (`authorization`, `host`, `content-type`,
   `x-api-key`, `x-opencode-session`, and the rest listed above) are rejected
7. secretValue max length enforced (e.g. 8KB); a fullwidth value folds to
   half-width on write and on read, because the key is signed into an HTTP
   header. A key that is still not Latin-1 is **not** refused: some auth kinds
   do not put the key in a header (a query parameter, a SigV4 signature), so
   the writer cannot know. Such a key keeps failing at request time.
8. modelId must be non-empty trimmed string; allow `/`, `.`, `:`, `-`
9. unknown protocol on older clients => provider shown disabled with warning, not crash
10. Legacy `supportsReasoning`, when present, must still validate as boolean but
   has no runtime effect
11. Legacy `supportedThinkingLevels`, when present, must still validate as an
  array of canonical thinking levels but has no runtime effect

## 11. Secret ref format

```text
secret:provider:<providerId>:api_key
secret:provider:<providerId>:oauth
```

The two refs are independent, so one row may hold a key, a vendor account, or
both; see [14-secrets-storage](14-secrets-storage.md) §10. Future multi-secret
providers may add further suffixes (`:client_secret`, etc.).

### Endpoint format guidance and native search

A provider keeps one saved service entry. Enabling `ModelBinding.nativeWebSearch`
does not rewrite its URL, API style, name, credential reference, or other models.
The UI and runtime share `nativeWebSearchTransport`: for exact published HTTPS
origins and paths, an opted-in Chat Completions request uses an existing search
adapter. DeepSeek (`api.deepseek.com`, root or `/v1`) uses `/anthropic/v1/messages`;
xAI and OpenAI (`api.x.ai/v1`, `api.openai.com/v1`) use Responses at the same
origin. Turning search off uses the original configured transport again.
Existing Responses, Codex, Anthropic and explicitly selected other protocols
retain their behavior. Vendor/model names never cause routing; proxies, custom
ports, unrelated paths, userinfo, queries and fragments do not match.

No extra DeepSeek preset, search service, interface-switch action, migration or
new IPC field is introduced. Unknown connection formats stay unavailable in
this app; that is not a claim about a vendor website or other API. Some official
search APIs require distinct adapters; see the native search provider audit.

#### Endpoint resolution

A typed Base URL is resolved before anything is probed. Resolution is one pure
shared layer (`@pi-desktop/shared/provider-endpoint`) that the settings dialog
and Electron main both call, so the address shown, the address probed and the
address saved cannot disagree:

- A bare host is completed with `https://` inside the origin the user named.
  Credentials, queries and fragments are still refused.
- A pasted operation suffix (`/chat/completions`, `/responses`, `/messages`)
  names the format and is stripped from the base endpoint; `/models` only marks
  a discovery URL. A suffix belonging to another format is kept in place — the
  mismatch is the user's to resolve, not a silent retarget of the row.
- The format comes, in order, from the user's own choice, the pasted operation,
  an exact published endpoint, a known host, and the publisher's `npm` adapter,
  falling back to Chat Completions. A model ID never participates: a gateway
  serving `gpt-*`, `claude-*` and `gemini-*` behind one Chat Completions route
  keeps that route.
- When the endpoint decided the format, the custom form says
  "Auto detected: …" next to the selector. A format picked by hand — or a named
  preset's own — outranks every inference from that point on.

Discovery then probes the resolved candidates: at most four, deduplicated, in
confidence order, all on the origin the user typed. The first candidate that
publishes models wins, and the address it answered on becomes the Base URL the
form shows and saves. The sweep shares one 12-second budget rather than giving
each candidate its own, and it runs candidates serially because every request
carries the user's API key. That key never reaches another origin, including
across a redirect: a cross-origin redirect is refused instead of followed.
Provider-specific paths (`/v1beta`, `/compatible-mode/v1`) come from the
endpoint registry, never from a blanket heuristic, and are offered only when the
host was named without a path: a typed path is that deployment's own answer, so
a `/api/v1` that publishes nothing is reported instead of being swapped for the
registry's `/api/paas/v4` sibling. The only generic extra path is `/v1` for an
unknown OpenAI-compatible endpoint. Every published model-list shape is read —
`data[].id`, Google's `models[].name`, and the `models[].slug` rows Zhipu's
OpenAI Responses endpoint returns — so an endpoint that answers is never treated
as empty. Connection testing reuses
the same request builder, so "the model list loaded" and "the connection test
passed" always describe the same URL, auth header and format.

### Which publisher a row is read against

A row that names no publisher of its own is read against the publisher its
endpoint identifies, in this order: the catalog entry whose published base URL
matches, the endpoint registry for a known host, then the catalog's own host
when exactly one provider publishes from it. That is what keeps a custom row on
a vendor's alternative API path — `https://open.bigmodel.cn/api/v1` for Zhipu's
OpenAI Responses endpoint — from showing generic 128k / 8k / text-only defaults
for models the catalog describes in full.

When nothing identifies a publisher at all — a relay, or a host the catalog does
not know — the publishers this app ships a provider for answer first: they are
the vendors and gateways behind the first-class presets, so their records
describe the model, while a reseller's own flags describe its own deployment of
it. Only when none of them states the ID does the pool widen to every publisher
that does, because an ID a relay alone carries would otherwise be shown as a
generic 128k text-only row. Within that pool the publishers' agreement is
claimed: the lower median of their limits and, for every capability but tool
support, only what all of them state, so the answer can only under-claim. Tool
support follows the majority of the publishers that state it: an ID a relay lists
can be stated by a hundred publishers, and one dissenting reseller must not decide
— or void — the claim for a deployment it does not describe. An even split states
no majority and claims nothing. Two routes that merely share a name leaf
(`provider-a/foo` vs `gateway/foo`) are not one model, so an ID whose identity is
genuinely unknown still resolves to nothing. A record borrowed this way states no
reasoning wire shape — that is a property of the deployment — and an Anthropic
Messages row keeps Anthropic's own shape. A model ID never decides which
publisher is read.

The lookup answers for the IDs a row already lists, so a served ID whose published
record is an audio model — a TTS or ASR sibling — resolves to that record too.
Only the catalog listing is scoped to text/agent models, because it decides which
models a row offers.

Metadata matching may follow a release stamp: `mify/mimo-v2.5-pro-0731` borrows
the published record of `mimo-v2.5-pro`, and a record the catalog publishes
under exactly the requested ID still wins over such an alias. The alias is
metadata only: a configured binding keeps the wire ID the service served.

Invalid or credential-bearing URLs still give no advice, and Cancel still does
not persist draft changes.

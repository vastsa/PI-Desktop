# 11. Provider & Model System

## 1. Goal

PI-Desktop must support **all major market model vendors and models** that users commonly need, without hardcoding a tiny allowlist as product ceiling.

Strategy:

> **Universal provider coverage via models.dev model metadata + pi-ai transport adapters + OpenAI-compatible escape hatch.**

We do **not** re-implement every vendor SDK ourselves.  
We standardize on pi’s multi-provider layer and add product-level configuration, catalog, and UX.

## 2. Coverage principle

### Must support
1. First-party major vendors
2. Popular aggregators / gateways
3. Any OpenAI-compatible endpoint
4. User-defined custom providers
5. Continuous model catalog refresh

### Product promise
- Users can connect practically any mainstream vendor/model available through:
  - native pi provider integrations
  - OpenAI-compatible APIs
  - custom provider definitions

### Explicit non-promise
- Guaranteeing every obscure vendor’s proprietary non-standard protocol without an adapter
- Shipping offline full world-model matrix forever without catalog updates

## 3. Architecture

```text
Settings / UI
  → ProviderConfigStore (Rust host DB)
  → AgentRuntime (Node/pi)
      ├─ built-in vendor providers (via pi-ai)
      ├─ openai-compatible provider
      └─ custom provider definitions
  → ModelCatalogService
      ├─ models.dev snapshot (sole model metadata source)
      ├─ runtime/provider discovery (IDs only for custom/dynamic models)
      └─ Rust-owned provider cache
```

## 4. Provider types

| type | description | examples |
|---|---|---|
| `native` | first-class vendor integration via pi-ai | openai, anthropic, google, bedrock, mistral, etc. |
| `openai_compatible` | any OpenAI Chat Completions/Responses compatible gateway | OpenRouter, Together, Groq, Fireworks, DeepSeek, local gateways, corporate proxies |
| `custom` | user-defined provider based on known protocol profile | private deployments, regional gateways |

Protocol profiles (MVP):

1. `openai`
2. `anthropic`
3. `google`
4. `openai_compatible`
5. `bedrock` (if enabled by runtime support)
6. `custom_http` (advanced/experimental later)

OpenCode Go is exposed as a named `opencode_go` API-style preset. It remains
inside the `openai_compatible` provider path: the preset fixes the endpoint to
`https://opencode.ai/zen/go/v1`, uses Bearer API-key authentication, discovers
models from `/models`, and sends chat turns through pi-ai's OpenAI Chat
Completions adapter. It does not create a second transport or a closed model
allowlist.

## 5. Built-in vendor matrix (ship intent)

> Model metadata follows the bundled/in-memory models.dev catalog. Provider adapters remain
> available through pi-ai, and the OpenAI-compatible path stays open for models
> that models.dev does not list.

### Tier A — always exposed in UI
- OpenAI
- Anthropic
- Google Gemini
- OpenAI-Compatible (generic)

### Tier B — expose when runtime supports / enable by default if present in pi-ai
- AWS Bedrock
- Azure OpenAI / OpenAI on Azure
- Mistral
- xAI
- DeepSeek
- Groq
- Together
- Fireworks
- Cohere
- Perplexity
- OpenRouter
- Moonshot / Kimi
- Zhipu / GLM
- MiniMax
- Baichuan
- Qwen / DashScope
- 01.AI / Yi
- SiliconFlow
- NVIDIA NIM
- Ollama (local)
- LM Studio (local OpenAI-compatible)
- vLLM / TGI / LocalAI / LiteLLM gateways (via OpenAI-compatible)

### Tier C — user custom
Any vendor not listed but reachable by:
- OpenAI-compatible base URL
- custom headers
- custom auth scheme

## 6. Model support policy

### 6.1 No hard model allowlist ceiling
PI-Desktop must not permanently restrict users to a short fixed model list.

### 6.2 Catalog responsibilities
1. **models.dev** (`https://models.dev/api.json`) is the sole model metadata
   source. Electron main reads the checked-in release resource at
   `apps/desktop/resources/models.dev/api.json` in development and the
   packaged `resources/models.dev/api.json` path in released builds. It never
   sends provider credentials to the catalog.
2. The checked-in snapshot is refreshed by `scripts/release.mjs` before a
   release tag is created. At runtime, Settings → Model configuration may
   explicitly refetch `https://models.dev/api.json`; a successful response
   replaces only the in-memory catalog for the current process. A failed fetch
   keeps the last valid in-memory catalog and never writes user data.
3. **Runtime/provider discovery** and the Rust-owned cache supply model IDs for
   custom, local, or authenticated account-specific endpoints. Provider matching
   accepts the configured vendor key, normalized API URL, models.dev provider
   identity, and vendor-prefixed IDs such as `deepseek/deepseek-v4`; a provider
   model ID without the catalog prefix is matched to the exact unprefixed
   suffix only when the provider identity is unambiguous. They cannot invent or
   replace model metadata. A configured free-form ID remains selectable with
   the generic text-only, non-reasoning shape when it is absent from models.dev.
4. The models.dev record maps `id`, `name`, `description`, `family`,
   `attachment`, `reasoning`, `reasoning_options`, `tool_call`,
   `structured_output`, `temperature`, `knowledge`, `release_date`,
   `last_updated`, `modalities.input/output`, `open_weights`,
   `limit.context/input/output`, `cost`, `interleaved`, `status`,
   `experimental`, and `provider` into the shared model surfaces.
5. pi-ai remains only the request/OAuth implementation layer. Its bundled model
   catalog and model capability functions are not read for names, limits,
   pricing, modalities, reasoning, or other model configuration.
6. Input and output modality arrays retain `text`, `image`, `audio`, `video`,
   and `pdf`. The text agent picker exposes models that can handle text while
   preserving all raw records in the file for future surfaces. Image input is
   sent as a transient image content block only when the model accepts image
   input. PDF capability is surfaced and retained in model metadata; because
   pi-ai 0.84 has no native PDF content block, PDF attachments remain bounded
   file references rather than being incorrectly encoded as images.
7. User-edited `ModelBinding` values remain explicit provider configuration:
   they control selected request limits, enabled thinking levels, the default
   thinking level applied to a new session, and the attachment capability
   overrides, while models.dev controls published defaults and capability
   metadata.
8. `defaultThinkingLevel` is chosen from the levels the binding enables, so a
   stored default can never be a level the runtime would clamp away. When a
   binding enables one level or none, there is nothing to choose and the field
   follows the enabled set.
9. `supportsImages` and `supportsDocuments` are three-state overrides. Absent
   or `null` follows the published models.dev modality, so a catalog correction
   still reaches a saved binding; `true` or `false` is the user's explicit
   answer and survives catalog changes. Unlike thinking levels these overrides
   are not narrowed to the published capability, because a proxied or
   self-hosted endpoint routinely accepts input its catalog entry omits.
   Enabling image input turns on the transient image content block; enabling PDF
   input records the capability but does not change the encoding, since pi-ai
   0.84 has no PDF content block and PDFs stay bounded file references.
10. The settings checkboxes show the effective answer against the published
    baseline, and setting one back to the published value stores "follow the
    catalog" rather than an equal-valued override. Agreeing with models.dev is
    therefore the reset, and no separate reset control or per-capability
    explanatory copy is required.
11. `ModelInfo.modalities` is the published record the settings surface compares
    against, so a stored binding must not shape it. Limits, reasoning and
    thinking levels are still resolved through the binding; only the modality
    arrays stay as models.dev published them.
12. A model the user has configured keeps its published record even when live
    discovery no longer lists it, so its capabilities remain visible and
    editable. Only ids already present in the provider's `models` are re-added,
    never the catalog at large, and only the rows discovery actually returned
    are written to the model cache.

### 6.3 Model families to cover
Catalog and custom model entry must support common capability classes:

- text chat / coding models
- reasoning / thinking models
- long-context models
- vision / multimodal input models
- tool-calling capable models
- JSON/structured output capable models (where provider supports)

## 7. Configuration schema

```ts
type ProviderAuthKind =
  | "api_key"
  | "api_key_and_base_url"
  | "bearer"
  | "azure_api_key"
  | "aws_sdk_default"
  | "custom_headers"
  | "oauth" // vendor subscription account, credential owned by Electron main
  | "none" // local no-auth

type ProviderConfig = {
  id: string                    // uuid/ulid
  name: string                  // display name
  vendorKey: string             // openai/anthropic/google/openrouter/custom/...
  type: "native" | "openai_compatible" | "custom"
  protocol: "openai" | "anthropic" | "google" | "openai_compatible" | "bedrock" | "custom_http"
  enabled: boolean
  baseUrl?: string
  authKind: ProviderAuthKind
  secretRef?: string            // pointer into secret store
  headers?: Record<string, string> // non-secret headers only
  apiStyle?:
    | "chat_completions"
    | "opencode_go"
    | "responses"
    | "anthropic_messages"
    | "google_generative_ai"
    | "openai_codex_responses" // vendor account only
    | "pi_messages"            // vendor account only
    | "auto"
  compatibility?: {
    supportsTools?: boolean
    supportsVision?: boolean
    supportsStreaming?: boolean
    supportsReasoning?: boolean
    supportedThinkingLevels?: ThinkingLevel[]
  }
  defaultModelId?: string
  models: ModelBinding[]        // selected models and per-model settings
  createdAt: string
  updatedAt: string
}

type UserModelConfig = {
  id: string                    // provider-local model id/slug
  displayName: string
  providerId: string
  contextWindow?: number
  maxOutputTokens?: number
  capabilities?: Array<"text" | "tools" | "vision" | "reasoning" | "json">
  pricingHint?: string
  hidden?: boolean
}

type ModelBinding = {
  id: string
  contextWindow: number
  maxTokens: number
  thinkingLevels: ThinkingLevel[]
  defaultThinkingLevel: ThinkingLevel | null
}

type SelectedModelRef = {
  providerId: string
  modelId: string
}

type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
```

The compatibility fields above are retained as a persisted-schema compatibility
surface for older clients. PI-Desktop no longer reads them as runtime model
overrides. Reasoning support and supported thinking levels come from the
resolved models.dev record; unknown free-form ids use the generic shape and
expose no inferred reasoning capability.

The provider dialog persists one `ModelBinding` for every selected model. The
first binding is the effective model for current conversations and legacy
runtime consumers. Conversation-level model switching and routing across the
array remain future work. A legacy provider with only `defaultModelId` is
materialized as one fallback binding on host read and upgraded to `models` on
the next provider write.

## 8. Secrets

- API keys stored via secure storage (`SECRET_*` APIs)
- Provider config stores only `secretRef` / hasSecret boolean
- Renderer never receives raw key in list APIs
- Optional key validation call: `providers.testConnection`
- A vendor-account row stores an OAuth grant instead of a key; `hasSecret`
  covers either credential and `hasOauth` distinguishes them (§8a)

## 8a. Vendor-account (OAuth) providers

A provider row can be authenticated by a vendor subscription — Claude Pro/Max,
ChatGPT Plus/Pro, Copilot and the rest of pi-ai's OAuth vendors — instead of a
pasted key (ADR 0095, D237, D240). The offered vendors are derived from
`models.getProviders().filter(p => p.auth.oauth)`, so the list follows the pin
rather than a hardcoded table, and `registerBunOAuthFlows()` runs once at
startup because pi-ai loads flows through a dynamic import electron-vite
cannot bundle.

Electron main owns the login conversation and the credential; the renderer sees
only events and a non-secret account label. Every login creates a fresh provider
row with `authKind: "oauth"`; the row id is the account identity even when
several rows share the same `vendorKey`. Electron main creates one pi-ai model
collection and one `CredentialStore` scope per row, mapping the vendor id to
`secret:provider:<rowId>:oauth`. It then fills `baseUrl`, `apiStyle` and
`defaultModelId` from that account's own catalog. A vendor catalog response
contains every local row as an account, including disconnected/orphaned rows so
the user can remove them explicitly.

Request auth is resolved **per request**, not at launch:

```text
sidecar request
  → runtime provider binding (`resolveAuth` injected at launch)
  → host-proxy `provider.resolveAuth` { sessionId, providerId }
  → Electron main (answered locally, never forwarded to host-core)
      · binding table check → PROVIDER_NOT_BOUND on a mismatch
      · row-scoped pi-ai `models.getAuth(vendorKey)` → refresh under that row's lock only if expired
  → short-lived ModelAuth { apiKey?, headers?, baseUrl? }
```

Two consequences worth stating: a vendor access token lives about an hour, so
nothing may be cached in the payload or the runtime; and because the row's
`apiKey` stays `""` and the injected resolver is a function, runtime identity
(`matches()`) is stable, so an OAuth session reuses its warm runtime across
turns instead of rebuilding it. The sidecar therefore never holds the refresh
token, and holds an access token only for the provider its session is bound to.

Model discovery for such a row reads the authenticated catalog
(`models.getAvailable`, which applies the vendor's own `filterModels`) rather
than probing `/models`, and the connection test proves the account by resolving
auth. A vendor may span wire APIs — Copilot serves Anthropic, Chat Completions
and Responses models — so the row's `apiStyle` follows the selected model.
Deleting a row calls the normal host `providers.delete` path, which removes its
OAuth secret and metadata; it never logs out or deletes another row with the
same vendor key.

## 9. Model catalog service

```ts
interface ModelCatalogService {
  listProviders(): Promise<ProviderDescriptor[]>
  listModels(filter?: ModelQuery): Promise<ModelDescriptor[]>
  refreshCatalog(options?: { providerId?: string }): Promise<RefreshResult>
  resolveModel(ref: SelectedModelRef): Promise<ResolvedModel>
  upsertUserModel(model: UserModelConfig): Promise<void>
}
```

### ModelDescriptor

```ts
type ModelDescriptor = {
  providerId: string
  vendorKey: string
  modelId: string
  displayName: string
  source: "bundled" | "discovered" | "user"
  catalogSource?: "models.dev"
  capabilities: Array<"text" | "tools" | "vision" | "reasoning" | "json">
  contextWindow?: number
  maxOutputTokens?: number
  deprecated?: boolean
  tags?: string[]
  supportedThinkingLevels?: ThinkingLevel[]
}
```

## 10. UI requirements

### Settings → Agent → Providers
- add built-in vendor quickly
- add OpenAI-compatible endpoint
- add custom provider
- edit base URL/headers
- set/replace/delete key
- sign in to / out of a vendor account, and see which account a row uses
- edit a vendor account's non-secret label and default model
- enable/disable provider
- test connection
- select multiple models and edit each binding's context window, output limit,
  and enabled thinking levels; catalog metadata supplies the initial values for
  both API providers and signed-in vendor accounts. A binding may only enable
  levels the resolved models.dev record publishes, because the runtime
  intersects the binding with that published set before it builds a request;
  offering the full canonical ladder here would let a user enable a level the
  Composer reasoning menu never renders. Both surfaces present this through the
  same picker, so a vendor account editor offers the same per-binding editing
  and applies the same narrowing to the published levels as an API provider
  editor
- keep model cards compact by default, expand metadata/configuration on demand,
  and keep dialog actions outside the independently scrollable content
- do not expose raw catalog compatibility internals or provider secrets

### Model selector
- search all models across enabled providers
- group by provider/vendor
- show capability badges (tools/vision/reasoning)
- allow “refresh models”
- allow custom model id entry

### Empty/error states
- no provider configured
- key missing
- model not found
- provider unauthorized
- catalog refresh failed (still allow manual model id)

## 11. Runtime resolution algorithm

When starting a turn with `(providerId, modelId)`:

1. load provider config from host
2. if missing/disabled → fail (`MODEL_NOT_CONFIGURED`; reserved detail: `PROVIDER_DISABLED`)
3. resolve the credential: for a keyed row read the secret via `secretRef`
   (never log it; missing → `PROVIDER_SECRET_MISSING`); for an `oauth` row skip
   this entirely and launch with an empty key, because auth is resolved per
   request (§8a)
4. resolve the models.dev record by matched provider key/API URL and exact model
   id
5. copy its complete model configuration — name, description, family,
   attachment/reasoning/tool/structured-output/temperature flags, knowledge and
   release dates, input/output modalities, weights, status, interleaving,
   limits, cost data, and thinking options — into the runtime model snapshot;
   when absent, use the generic text-only, non-reasoning shape
6. derive vision transport from models.dev `modalities.input`; provider
   discovery/cache/user capability claims cannot promote an unresolved model
7. clamp the session thinking level against models.dev's supported levels and
   build the runtime provider adapter by replacing only provider/model identity,
   selected API adapter, auth, and an explicitly configured endpoint URL
8. execute stream with abort handle and separate answer/thinking events
9. translate vendor errors into shared `AppError` codes (§15)

If the model is absent from models.dev, still allow it when the user explicitly
enters a model id and the provider accepts unknown ids. Cached/provider
capability fields do not promote that fallback into a known runtime model.

## 12. Compatibility tiers

| tier | meaning |
|---|---|
| full | tools + streaming + vision verified/expected |
| standard | chat streaming expected |
| limited | best-effort via compatible gateway |
| unknown | user custom, no guarantees |

UI may show tier hints, but must not hard-block unknown models by default.

## 13. Refresh & update policy

1. Electron main reads the bundled release resource before serving model
   metadata: `apps/desktop/resources/models.dev/api.json` in development and
   `resources/models.dev/api.json` in packaged builds.
2. `scripts/release.mjs` fetches `https://models.dev/api.json`, validates it,
   and atomically replaces the checked-in resource before creating a release
   tag.
3. Settings → Model configuration can force a remote refresh at any time; a
   successful response updates only the current process's in-memory catalog.
4. Provider endpoint discovery supplies IDs only for models absent from the
   bundled/in-memory models.dev snapshot; unknown IDs use generic metadata.
5. Refresh failure must not wipe the bundled file, Rust-owned provider cache, or
   configured bindings.

## 14. Local / offline model support

Supported via OpenAI-compatible local servers:

- Ollama (native if pi supports it, otherwise OpenAI-compatible proxy)
- LM Studio
- vLLM / TGI / LocalAI / LiteLLM proxies
- other local gateways

Requirements:

- custom base URL
- auth may be `none`
- manual model id entry always available
- catalog refresh may use `/v1/models` when available; otherwise user-defined models

## 15. Failure taxonomy (provider domain)

Canonical codes live in [08-error-codes](08-error-codes.md); reserved detail
codes map to a canonical parent until emitted (§3.7 there).

| code | status | meaning | user-facing guidance |
|---|---|---|---|
| `PROVIDER_UNAUTHORIZED` | live | invalid/expired key or denied auth | re-enter secret / check account |
| `PROVIDER_RATE_LIMITED` | live | 429 / quota | retry later / switch model |
| `PROVIDER_SECRET_MISSING` | live | enabled provider without secret | complete setup |
| `MODEL_NOT_CONFIGURED` | live | no selected model or provider rejects selected model with 404 | select or configure an available model |
| `PROVIDER_ERROR` | live | other upstream provider failure | retry / inspect details |
| `NETWORK_ERROR` | live | provider endpoint cannot be reached | check network and base URL |
| `STREAM_FAILED` | live | stream dropped mid-turn | retry turn |
| `PROVIDER_BASE_URL_INVALID` | reserved → `PROVIDER_ERROR` | malformed or unreachable base URL | fix endpoint |
| `PROVIDER_PROTOCOL_MISMATCH` | reserved → `PROVIDER_ERROR` | wrong protocol for endpoint | switch protocol profile |
| `PROVIDER_MODEL_NOT_FOUND` | reserved → `MODEL_NOT_CONFIGURED` | model id unknown for provider | refresh catalog or custom id |
| `PROVIDER_TIMEOUT` | reserved → `TIMEOUT` | network or server timeout | retry / check network |
| `PROVIDER_UNSUPPORTED_CAPABILITY` | reserved → `PROVIDER_ERROR` | tools/vision/reasoning unsupported | switch model or disable feature |
| `PROVIDER_DISABLED` | reserved → `MODEL_NOT_CONFIGURED` | provider exists but disabled | enable provider |

## 16. OpenAI-compatible first-class path

Any vendor can be onboarded without a native SDK if it exposes OpenAI-compatible APIs.

Required fields:
- `baseUrl`
- auth (`api_key` / `bearer` / `none` / custom headers)
- model id (catalog or free-form)

Optional:
- `apiStyle` (`chat_completions` | `opencode_go` | `responses` | `auto`)
- compatibility flags
- custom headers (non-secret)

This is the **universal escape hatch** guaranteeing market coverage beyond native integrations.

## 17. Multi-provider product rules

1. Multiple providers of the same `vendorKey` are allowed and independent (for
   example, two OpenRouter accounts); each row has its own OAuth secret scope.
2. Provider `name` is user-editable and unique for API/custom services. OAuth
   rows may share the vendor display name; their stable identity is `providerId`
   and their non-secret account label is presentation metadata.
3. Default app model is a `(providerId, modelId)` pair, not modelId alone.
4. Session stores its own `(providerId, modelId)` binding.
5. Deleting a provider blocks new turns that reference it; historical sessions keep the ids for audit/display.
6. Export settings never includes raw secrets.
7. Import settings can recreate provider shells and prompt for secrets.
8. Reasoning capability is model-specific unless the provider has an explicit
   compatibility override; provider defaults must not override a session's
   selected model during turn resolution.

## 18. Validation rules

- `name` required
- `vendorKey` required
- `protocol` required
- `baseUrl` required for openai_compatible/custom when endpoint not implicit
- secret required when `authKind` needs key
- headers must not contain raw api keys (use secret store)
- model id non-empty

## 19. Acceptance criteria

- [ ] Add OpenAI / Anthropic / Google / OpenAI-Compatible providers from UI
- [ ] Add arbitrary OpenAI-compatible custom provider with base URL + key
- [ ] Select models via catalog search across providers
- [ ] Free-form model id accepted when catalog misses it
- [ ] Catalog refresh populates models for at least one native and one compatible provider, without destroying existing providers
- [ ] Connection test returns structured success/failure without secret leakage
- [ ] Two accounts from the same vendor can be signed into from Settings, used
      independently for turns, and removed one at a time; the sidecar never
      receives either refresh token
- [ ] Session can switch model between turns
- [ ] Reasoning-capable models expose only supported thinking levels and the
      selected level reaches pi; unsupported providers resolve to `off`
- [ ] Missing key/model blocks run with stable, actionable error codes
- [ ] At least one local provider path (Ollama or LM Studio style) documented and testable
- [ ] No product hard-limit like “only 3 vendors / 10 models”

## 20. Non-goals (MVP)

- Building our own full provider SDK ecosystem
- Guaranteeing identical tool/vision quality across all vendors
- Marketplace of providers (not needed; config is local)
- Full multi-modal attachment studio beyond model capability flags
- Automatic paid-plan discovery for every vendor portal
- Proprietary non-HTTP SDKs without pi-ai support
- Cloud-synced provider profiles

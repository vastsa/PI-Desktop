# 11. Provider & Model System

## 1. Goal

PI-Desktop must support **all major market model vendors and models** that users commonly need, without hardcoding a tiny allowlist as product ceiling.

Strategy:

> **Universal provider coverage via pi-ai + OpenAI-compatible escape hatch + refreshable model catalogs.**

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
      ├─ models.dev remote catalog (primary)
      ├─ pi-ai bundled catalog (fallback)
      ├─ runtime discovery (custom/dynamic fallback)
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

> Exact availability follows the models.dev catalog when it has a provider record;
> pi-ai remains the local fallback, and the product keeps the OpenAI-compatible
> path open for providers absent from both catalogs.

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
1. **models.dev** (`https://models.dev/api.json`) is the primary remote catalog
   for known providers and models. Electron main fetches it with a bounded
   timeout, parses only the documented provider/model fields, and never sends
   provider credentials to the catalog.
2. **pi-ai's bundled catalog** is the local fallback when models.dev is
   unavailable or has no matching provider/model. Its complete model snapshot
   remains available for adapter-specific compatibility and native provider
   coverage.
3. **Runtime-native/provider discovery** and the Rust-owned cache remain
   supplemental for custom or account-specific endpoints. They never replace
   a matching models.dev field; a configured free-form model ID is always kept
   selectable.
4. The source precedence for a known configured provider/model is:
   `models.dev` → `pi-ai` → provider endpoint discovery → generic defaults.
   models.dev matches the provider key first and a normalized API URL second;
   pi-ai uses the exact API-aware provider/model lookup and its bounded aliases.
5. For image transport, models.dev `modalities.input` is authoritative when
   present; pi-ai `input` is the fallback. `image` is the only signal that
   enables visual blocks. Renderer discovery, cached badges, and user-entered
   claims cannot promote an unknown model. The fallback is a path reference so
   the normal file-tool workflow remains available.
6. The Settings provider dialog uses the same precedence for initial
   context/output/thinking defaults. A models.dev model's `limit.context`,
   `limit.output`, `modalities`, `reasoning_options`, `tool_call`, and
   `structured_output` are mapped to the shared `ModelInfo`; the canonical
   thinking-level mapping is defined in `models-dev-catalog.ts`.
7. User-edited `ModelBinding` values remain explicit provider configuration:
   they control the selected binding's request limits and enabled thinking
   levels, while the catalog controls defaults and capability metadata.
   Unknown free-form IDs use the generic text-only, non-reasoning defaults.

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
resolved models.dev record, then the pi-ai fallback record; unknown free-form
ids expose no inferred reasoning capability.

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
  catalogSource?: "models.dev" | "pi-ai"
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
  and enabled thinking levels; catalog metadata supplies the initial values
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
   id; if absent, resolve the complete pi-ai model record by exact vendor/id or
   a compatible gateway alias with a separator-bounded suffix
5. when models.dev resolves the model, use its name, reasoning flag, thinking
   options, input modes, pricing, context window, and output limit; retain
   pi-ai's adapter-specific compatibility fields when available. Otherwise use
   the complete pi-ai snapshot; when both catalogs miss, accept the raw model
   id with the generic text-only, non-reasoning fallback
6. derive vision transport from models.dev `modalities.input` when present and
   from pi-ai `input` otherwise; discovery/cache/user capability claims cannot
   promote an unresolved model
7. clamp the session thinking level against the selected catalog's supported
   levels and build the runtime provider adapter by replacing only
   provider/model identity, selected API adapter, auth, and an explicitly
   configured endpoint URL
8. execute stream with abort handle and separate answer/thinking events
9. translate vendor errors into shared `AppError` codes (§15)

If the model is absent from both models.dev and pi-ai, still allow it when the
user explicitly enters a model id and the provider accepts unknown ids.
Cached/discovered capability fields do not promote that fallback into a known
runtime model.

## 12. Compatibility tiers

| tier | meaning |
|---|---|
| full | tools + streaming + vision verified/expected |
| standard | chat streaming expected |
| limited | best-effort via compatible gateway |
| unknown | user custom, no guarantees |

UI may show tier hints, but must not hard-block unknown models by default.

## 13. Refresh & update policy

1. Electron main loads the models.dev catalog once per process with a bounded
   timeout
2. User/provider refreshes revalidate models.dev before provider-specific
   discovery
3. If models.dev is unavailable, use the pinned pi-ai catalog, then provider
   endpoint discovery, then the persisted configured bindings
4. Refresh failure must not wipe the Rust-owned provider cache or the last
   successful models.dev snapshot

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

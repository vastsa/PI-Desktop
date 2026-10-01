# 11. Provider & Model System

## 1. Goal

PI-Desktop must support **all major market model vendors and models** that users commonly need, without hardcoding a tiny allowlist as product ceiling.

Strategy:

> **Universal provider coverage via Pi catalog model metadata + pi-ai transport adapters + OpenAI-compatible escape hatch.**

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
      ├─ Pi catalog snapshot (sole model metadata source)
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
allowlist. Agent-runtime injects OpenCode routing headers on every LLM
request (session turns, subagents, context-compaction summaries, prompt
enhancement, and plugin one-shots): `x-opencode-session` is the durable
conversation id (or a per-call UUID when the caller has no session),
`x-opencode-client` is `pi-desktop`, and `User-Agent` is
`pi-desktop/<APP_VERSION>` unless the row sets `headers["User-Agent"]`. A custom OpenAI-compatible row whose base URL
host is `opencode.ai` receives the same headers. pi-ai is not relied on to
emit `x-opencode-session`. Each provider row (AI service or OAuth account)
may set optional `headers`; empty keeps adapter defaults. A fetch wrapper is
the last writer so Codex and Anthropic cannot overwrite them. pi-ai's Google
adapters (`google-generative-ai`, `google-vertex`) reject any `fetch` that is
not `globalThis.fetch`, so a request bound for them carries none — the merged
`headers` still reach the SDK client — and a caller-supplied `fetch` is cleared
rather than wrapped (issue #1072). Because those adapters never see the wrapper and never call
`onResponse`, such a row reports no captured HTTP status and no captured
transport cause: `Retry-After` falls back to the bounded backoff ladder, and
the issue-234 transport diagnostics and rebuild do not fire for it.

When an OAuth vendor is rebuilt around a local provider-row id, runtime keeps
the native pi-ai transport metadata instead of treating the row as a generic
OpenAI endpoint. GitHub Copilot requests retain the pinned model's IDE identity
headers, including `Editor-Version`, `Editor-Plugin-Version`, and
`Copilot-Integration-Id`; agent-runtime adds the context-sensitive
`X-Initiator`, `Openai-Intent`, and image-request header. The local row id still
owns auth binding and transcript identity, and user-supplied provider headers
remain the final override.

Copilot Anthropic Messages (Claude) requests carry the per-request OAuth token
as `Authorization: Bearer` with `X-Api-Key` removed, because pi-ai
only selects Copilot Bearer auth when `model.provider` is `github-copilot`.
OpenAI-style Copilot wire APIs keep signing the token as the request key; all
wires retain per-request auth resolution and the account-specific `baseUrl`.

Zhipu / GLM and Z.AI are named OpenAI-compatible endpoint presets among a
short Pi catalog-backed Service list of first-party vendors (including
Xiaomi). The add-provider Service picker persists the matching Pi catalog
`vendorKey` and uses the published endpoint without
showing Name, Base URL, or API format on the named-service path. Chat turns
still use the selected pi-ai adapter (`chat_completions`, `responses`,
`anthropic_messages`, `google_generative_ai`, or `opencode_go`). Zhipu / Z.AI
Completions requests use `thinkingFormat: "zai"` and `zaiToolStream: true`.
DeepSeek-family Completions requests set
`requiresReasoningContentOnAssistantMessages: true` when the row's `vendorKey`,
base URL, model id, or catalog `family` identifies DeepSeek. pi-ai only
auto-detects `provider === "deepseek"` or a `deepseek.com` URL, and PI-Desktop
stores a UUID as `model.provider`, so aggregators and custom gateways would
otherwise omit `reasoning_content` on assistant turns that produced no thinking.
Non-official DeepSeek endpoints also set `requiresNonEmptyReasoningReplay` so
missing reasoning is filled with a documented placeholder instead of `""`
(OpenCode / third-party relays reject empty echoes after compaction; see
ADR 0256 / #296). Official `deepseek.com` rows keep empty-string fill (#223).
The overlay does not change `thinkingFormat`.

Anthropic Messages requests set `forceAdaptiveThinking: true` when the
Pi catalog record publishes a reasoning `effort` option and no
`budget_tokens` option (for example Opus 4.7+, Opus 5.x, Fable). Those models
reject `thinking.type=enabled` with HTTP 400, and Pi catalog carries no pi-ai
compat record, so without the flag pi-ai would fall back to budget thinking.
Models that still publish `budget_tokens`, including those that also publish
`effort`, keep budget thinking by default. The catalog uses this same rule
for the protocol displayed in model settings. An explicit
`ModelBinding.thinkingProtocol` selection (`legacy` or `adaptive`) overrides
the default; an absent field preserves the existing inference. An explicit
catalog `compat` record is preserved.

An Anthropic Messages row the catalog cannot identify (for example a custom
gateway URL serving an id several publishers list) still falls back to the
generic model shape, but takes `reasoning_options` and the derived
`thinkingLevelMap` from Anthropic's own Pi catalog record when that record
has exactly the same model id. Which thinking shape a Claude id accepts is a
property of the model, not of the deployment, so only those two fields
transfer; limits and modalities stay generic, and aliases, renamed ids, other
wire APIs, and non-Claude ids served over the Anthropic protocol are unchanged
(#990).

## 5. Built-in vendor matrix (ship intent)

> Model metadata follows the bundled/in-memory Pi catalog catalog. Provider adapters remain
> available through pi-ai, and the OpenAI-compatible path stays open for models
> that Pi catalog does not list.

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

1. pi-ai 0.99.1 Providers/Models own published metadata, transport, thinking
   support and native operation types. Electron's historically named
   `ModelsDevCatalog` is an account-aware adapter over this public API.
2. Startup is cache-only and disables ambient environment/file credentials.
   Each configured account has its own Models collection and Host credential
   store. Same-vendor rows cannot borrow one another's credentials.
3. OAuth live entitlement IDs are published through the account provider's
   refresh/filter boundary. A successful list governs available chat models;
   discovery failure preserves the pinned catalog. Live-only IDs may inherit
   same-tier adapter/thinking metadata, with unknown prices retained as unknown.
4. Settings exposes published metadata separately from explicit binding
   overrides. Effective chat limits, inputs, thinking and request shape are
   projected once at the account boundary and reused for ordinary sessions,
   delegates, compaction and image lookup. Pi's unsupported/null effort mappings
   cannot be re-enabled by stale persisted settings. No saved data is rewritten.
5. Chat, image and classifier models are selected by operation type even when
   they share a model ID. A small display-only operation metadata supplement
   preserves settings visibility for image/audio/video/embedding records that
   Pi does not publish. It supplies no runtime auth, dispatch, price or entitlement.
6. Free-form IDs remain configurable. Conservative generic metadata applies
   when no published model matches; explicit user overrides remain supported.
   Unknown relay metadata uses exact final-segment matching and an unambiguous
   official publisher. Known endpoint aliases cannot borrow past an ambiguous
   same-endpoint miss. No deployment/date/thinking suffix is removed.
7. Settings catalog refresh calls Pi's public refresh API. Release scripts no
   longer fetch or package the independent Pi catalog JSON catalog. Pi version
   pins provide the reproducible catalog baseline.
8. PDF capability remains metadata; attachments use bounded file references
   until the runtime supports a native PDF content block. Image capability is
   resolved against the effective selected binding before transport.

### 6.3 Model families to cover
Catalog and custom model entry must support common capability classes:

- text chat / coding models
- reasoning / thinking models
- long-context models
- vision / multimodal input models
- tool-calling capable models
- JSON/structured output capable models (where provider supports)

### Hosted-search message and budget contract

- Search content and progress events are declared adapter types, not disguised
  client tool calls. A search result or Responses search item does not require
  `name` or `arguments`. Existing replay records remain compatible: a stored
  record this app wrote without replay ids degrades to "no replay" for that
  message instead of failing the turn, so pre-upgrade history stays usable.
- Replay and token estimation share the search-phase interpretation. Valid
  usage covers its prefix once; zero or invalidated usage triggers a complete
  estimate which includes search replay data. Display rounds and streaming
  scratch must not duplicate that data. Estimates are not billing guarantees.
  This applies to main-agent and native pi-session compaction as well as output
  budgets. When a target model is known, estimates follow that adapter's existing
  model-switch replay boundary. Compaction serialization includes search replay
  projections in the summary request, without treating them as client tool calls.
  The compacted prefix becomes a generated text summary; raw search in the
  retained tail follows the existing replay policy. No lossless summary is promised.
- Rebuilding an unchanged context must preserve system-prefix semantics.
  Actual instruction or tool-declaration changes remain visible to usage
  validation. System sections and tool additions/removals cannot be discarded.
- Search followed by a local tool, Task, a new user prompt, or restart recovery
  must exercise the same contract. Dependency upgrades must run the offline
  adapter and bundled-sidecar continuation regressions, not only UI tests.

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
  headers?: Record<string, string> // optional outbound headers; empty keeps adapter defaults
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
  /** Where `contextWindow` came from; absent on records older than the marker,
   * which then resolve through the historical rule (see
   * `13-model-catalog-and-selection.md` §9.1). */
  contextWindowSource?: "catalog" | "user"
  maxTokens: number
  thinkingLevels: ThinkingLevel[]
  defaultThinkingLevel: SessionThinkingLevel | null
  thinkingProtocol?: "legacy" | "adaptive"
  availableForSubagents?: boolean // opt-in for AI-driven delegation
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
overrides. `ModelInfo` reasoning support and supported thinking levels describe
the resolved Pi catalog record; effective provider/session capability comes from
the exact `ModelBinding`. Unknown free-form ids start with the generic shape and
no inferred reasoning capability; an empty binding level array is the generic
seed, while a non-empty explicit binding may opt into or disable levels.

The provider dialog persists one `ModelBinding` for every selected model. The
first binding is the effective model for current conversations and legacy
runtime consumers. Conversation-level model switching and routing across the
array remain future work. A legacy provider with only `defaultModelId` is
materialized as one fallback binding on host read and upgraded to `models` on
the next provider write.

`ModelBinding.availableForSubagents` (boolean, default false): opt-in flag that
makes the model available for AI-driven subagent delegation. When enabled, the
model appears in the delegation catalog injected into the parent agent's system
prompt. The parent agent can then select it via the Task tool's `model`
parameter. Resolving a model for a definition pin does not imply this opt-in.
The launch payload carries the permitted override keys separately as
`subagentModelKeys`; definition-only bindings remain available solely through
normal pin resolution, including when `Task.model` repeats that definition's
own pin key. On-demand matching uses unique provider id/vendor/name lookup and
must not overwrite a pin with another account's credentials. If vendor/model aliases collide across accounts, the
opted-in account uses its exact provider ID as the override key. Selection priority remains Task.model → definition pin
→ session model (D278; ADR subagent-model-opt-in). The opt-in governs every entry point that lets the AI pick a model
for delegated work, not only `Task.model`: a `session/collaboration/spawn` `modelKey` naming a model without it is
refused with `PERMISSION_DENIED`, while omitting the key, or naming the default model's own key, still inherits.

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

Model discovery for such a row reads the signed-in account's own model list,
and the connection test still proves the account by resolving auth. pi-ai
(`models.getAvailable`, including that vendor's `filterModels`) is the fallback
when the account request fails or the payload is not a model list. The probe
is the endpoint that vendor actually publishes:

- ChatGPT Plus/Pro (`openai-codex`): `GET {base}/codex/models?client_version=…`,
  with the account id taken from the access token. The endpoint requires
  `client_version` and hides models whose minimum Codex client is newer, so
  the value is a pinned Codex CLI version (`CODEX_MODELS_CLIENT_VERSION`) that
  is bumped when an account model goes missing. A `{ data: [...] }` payload is
  not accepted. A newly published id such as `gpt-6-luna` is selectable
  without a client update when that response includes it.
- GitHub Copilot: `GET {base}/models` with the pinned IDE identity headers and
  `X-GitHub-Api-Version`. Only ids with `model_picker_enabled === true` (and
  not policy-disabled) are kept. An id the pin does not know is added only when
  its family already maps to one wire API.
- Anthropic: `GET {base}/v1/models` with the Claude Code OAuth headers
  (`x-app: cli`, OAuth beta) when the token is an OAuth access token.
- Kimi, Meta, xAI and OpenRouter: `GET {base}/models` (Anthropic-style `/v1`
  for Kimi). xAI still drops image and video generators.
- Radius keeps its gateway catalog refresh and is not probed again.

A failed account request logs the HTTP status and a short, single-line
excerpt of the response body with the request's credentials and any
token-shaped value removed, so an upstream contract change is diagnosable
from the provider log.

Image, video, speech and embedding ids are dropped. A model Pi catalog does
not know yet inherits limits, reasoning, adapter compatibility, and the wire
effort mapping from a pinned sibling of the same tier; xAI uses an explicit
newest-first sibling (`grok-4.7`, then `grok-4.6`, then `grok-4.5`, then
`grok-4.3`) so pin order cannot select an older Grok. A different tier is not
used. Existing model metadata takes precedence over borrowed compatibility and
effort mappings. Supported thinking levels follow pi-ai's mapping contract:
missing entries retain adapter defaults, `null` disables a level, and `xhigh`
or `max` requires an explicit mapping. Non-reasoning siblings remain off-only.
Without a stored user binding, runtime configuration preserves these inferred
restrictions instead of reopening every generic thinking level. An all-disabled
effort map remains non-reasoning. Truly unclassified generic models and explicit
user overrides retain their existing effective-thinking policy.
The same effective mapping determines both the supported levels and wire
effort, so a sparse map cannot silently promote `high` to `xhigh` or lose the
adaptive protocol. Published Pi catalog records bypass this fallback entirely.
Pi catalog still cannot add an id the account list did not return. A vendor
may span wire APIs — Copilot serves Anthropic, Chat Completions and Responses
models — so the row's `apiStyle` follows the selected model.
Deleting a row calls the normal host `providers.delete` path, which removes its
OAuth secret and metadata; it never logs out or deletes another row with the
same vendor key.

### Anthropic token endpoint rate limits

The pinned pi-ai 0.99.1 patch gives Anthropic authorization-code exchange and
refresh a shared, bounded token-request policy: retry only an explicit HTTP
429, at most three total requests. Wait at least 1 s then 2 s, or longer when
`Retry-After` gives delta seconds or an HTTP date. A server delay beyond the
remaining budget ends the attempt; it is never shortened to fit. Malformed or
missing hints use the bounded exponential fallback.

One 30 s helper deadline covers requests, response-body reads and waits, and
all use the original caller signal. An earlier caller deadline wins; pi-ai's
existing refresh operation has a 15 s limit inside the credential-store lock.
Cancellation also stops pending waits. The patch does not move refresh outside
that lock: failed attempts leave the stored credential unchanged, and a
successful rotated grant is written once.

Network failures, interrupted bodies, 5xx and `invalid_grant` are not replayed:
the result of a non-idempotent token request may be ambiguous. An explicit
`invalid_grant` stops even if a response is labelled 429. HTTP/token-JSON
failures expose a bounded recovery message rather than raw response bodies,
URLs or embedded stacks. Login guidance tells the user to wait, close the
failed dialog and start sign-in again; refresh guidance suggests waiting before
retrying and signing in again if the problem continues. HTTP 429 alone does
not prove whether a code was consumed, so no expiry claim is made.

This uses the existing repository dependency-patch mechanism; OAuth endpoints,
PKCE, credential ownership, IPC and storage schemas are unchanged.

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
  catalogSource?: "pi"
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
- set optional custom headers in Advanced (empty keeps adapter defaults);
  copy the same normalized JSON used for persistence
- sign in to / out of a vendor account, and see which account a row uses
- edit a vendor account's non-secret label, custom headers, and default model
- enable/disable provider
- test connection
- select multiple models and edit each binding's context window, output limit,
  and enabled thinking levels; catalog metadata supplies the initial values for
  both API providers and signed-in vendor accounts. The picker always exposes
  the seven canonical levels: published levels seed known models, while any
  explicit selection is retained for a proxy or newly released model. Both
  surfaces present this through the same picker, so a vendor account editor
  offers the same per-binding editing as an API provider editor
- keep model cards compact by default, expand metadata/configuration on demand,
  and keep dialog actions outside the independently scrollable content
- do not expose raw catalog compatibility internals or provider secrets
- Settings → Import can copy provider/model rows from Claude Code, Codex,
  OpenCode, Pi, and CC Switch. The scan is explicit. Stored API keys are
  copied into the host secret store; OAuth/subscription grants are not.
  An equivalent provider (normalized URL + API style + same credential) is
  skipped on re-import. Different credentials at one endpoint remain
  independent providers. No protocol or schema version bump
  (D342 / ADR 0179 / ADR 0188).

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

1. Load the Host provider row; fail for a missing or disabled explicit account.
2. Resolve credentials only for that account. OAuth refresh remains per request.
3. Resolve the typed chat model from the account Pi collection, with conservative
   generic fallback for explicitly configured unknown compatible IDs.
4. Apply the central effective binding projection and clamp thinking with Pi's
   public capability helper. Preserve native costs and unknown-price provenance.
5. Build the transport with the actual vendor/model identity and the configured
   endpoint. Anthropic roots normalize a trailing `/v1` because its adapter
   appends `/v1/messages`. Delegates use the same account/binding resolution.
6. Stream with cancellation and separate answer/thinking events. Attribute usage
   to each physical request operation, including retries, and translate errors
   to shared AppError codes. Replay aggregation deduplicates operation IDs.

An unavailable saved account never silently falls back to the default account.

## 12. Compatibility tiers

| tier | meaning |
|---|---|
| full | tools + streaming + vision verified/expected |
| standard | chat streaming expected |
| limited | best-effort via compatible gateway |
| unknown | user custom, no guarantees |

UI may show tier hints, but must not hard-block unknown models by default.

## 13. Refresh & update policy

1. Use the pinned Pi catalog at startup without network or ambient credentials.
2. Settings may explicitly refresh Pi provider catalogs in memory.
3. Provider endpoint discovery preserves configured IDs and Host caches; OAuth
   live discovery publishes account entitlements through the same Models owner.
4. Failed refresh retains available metadata and configured bindings.
5. Release catalog changes arrive through reviewed Pi pins and patches; the
   release script does not fetch a second model catalog.

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
- `headers` (optional outbound HTTP headers; empty keeps adapter defaults)

For the OpenAI Chat Completions adapter, system instructions use the
standard `system` role by default. This keeps arbitrary compatible gateways
interoperable because some upstream routes reject the newer `developer` role,
including reasoning-model routes. A resolved model record may explicitly set
`compat.supportsDeveloperRole: true` when its endpoint is known to accept that
role; this override is model-scoped and does not change other providers.

A catalog entry may additionally pin a model-level wire API (for example,
`api: "openai-responses"`). When present it wins over the provider-wide
`apiStyle`, so responses-only models under an `opencode_go` provider are sent
through the Responses adapter instead of Chat Completions. Without a
model-level pin the provider-wide style applies unchanged.

This is the **universal escape hatch** guaranteeing market coverage beyond native integrations.

### 16.1 Responses stream termination (pi-ai patch)

The OpenAI Responses adapter must treat `response.completed` (and
`response.incomplete`) as the end of the stream: after finalizing the
response, it stops consuming the stream instead of awaiting the server's
TCP FIN. Upstream pi-ai keeps iterating until the server closes the
connection, which hangs the turn behind reverse proxies that hold the idle
connection open. Until the fix ships upstream, `patches/` carries a pnpm
patch on `@earendil-works/pi-ai@0.99.1` that breaks the event loop on the
terminal event (the OpenAI SDK aborts the underlying request when the
consumer stops iterating). Drop the patch once a pi-ai release includes the
fix.

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
- [ ] Known reasoning levels seed a binding, while all seven canonical levels
      remain explicitly selectable and the selected level reaches pi;
      bindings with no non-`off` level resolve to `off`
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

### Search setup guidance

The search checkbox uses the same request-only transport resolver as the
runtime. An opted-in official DeepSeek, xAI or legacy OpenAI Chat Completions
model can use its published search interface without another service entry or
changes to stored connection settings. Other models and search-off requests
keep their configured transport. Search is off by default. Known routes match
exact origins and paths, never display names or model substrings.
The resolved adapter remains authoritative for search extraction and replay.
Unknown connection formats are described as not integrated by this app rather
than unsupported by the vendor. See the provider configuration specification.

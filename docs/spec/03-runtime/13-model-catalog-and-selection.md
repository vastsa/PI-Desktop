# 13. Model Catalog & Selection

## 1. Product rule

Users must be able to use **market-available models broadly**, not only a curated demo subset.

Therefore:

1. Catalog is refreshable
2. Custom model IDs are always allowed
3. OpenAI-compatible gateways are first-class
4. Search is global across enabled providers

## 2. Selection UX

### Model picker fields
- search box
- provider filter
- capability filters: tools / vision / reasoning
- sort: recent / provider / name

### Item display
- model display name
- model id
- provider name
- capability badges
- optional context window

### Advanced
- “Use custom model ID”
- “Refresh catalog”

## 3. Recent models

Persist recent selected model refs:

```ts
type RecentModelRef = {
  providerId: string
  modelId: string
  usedAt: string
}
```

Show top N in picker.

## 4. Session model binding

Each session stores:

- `providerId`
- `modelId`
- `thinkingLevel` (`off|minimal|low|medium|high|xhigh|max`)

Changing model or thinking level mid-session affects subsequent turns only.
The stored thinking preference survives restart; the effective request level
is capability-clamped for the selected model at execution time.

For a newly created session, the renderer resolves the app default provider's
current default-model capability. A reasoning-capable model starts at the
highest canonical level in its published `supportedThinkingLevels`; a
non-reasoning model or missing capability metadata starts at `off`. This is a
creation default only and never rewrites an existing session's stored choice.

## 5. Capability warnings

If user selects model tagged without tools while in Agent mode:

- show non-blocking warning
- do not hard-block (vendor tags may be incomplete)

## 6. Refresh behavior

The bundled `apps/desktop/resources/models.dev/api.json` snapshot is the
startup baseline. It is refreshed by `scripts/release.mjs` before a release tag
is created; application startup does not fetch or write a catalog. Settings
invokes the Electron-only `providers.refreshModelCatalog` channel to refetch
`https://models.dev/api.json`; a successful response replaces only the
current process's in-memory models.dev catalog and never writes user data.

Provider model loading remains stale-while-revalidate:

1. `source: "cache"` hydrates a saved provider's normalized discovery rows from
   Rust-owned SQLite without provider network access.
2. The renderer can show those rows immediately in the Composer and provider
   dialog.
3. `source: "refresh"` uses the bundled/in-memory models.dev catalog first and
   probes a provider endpoint only to discover IDs that models.dev does not
   expose.
4. Successful provider discovery may update the Rust-owned normalized cache;
   it cannot replace a matching models.dev record or its metadata.
5. Configured `ModelBinding` IDs are retained when discovery is partial or
   unavailable, and an ID absent from models.dev receives generic metadata.

## 7. Offline behavior

If refresh fails / offline:

- use cached catalog
- never clear an already-rendered cached list or flash an empty picker
- allow custom model id
- still allow providers with known model ids
- when a saved provider cache is empty or partial, append every configured
  model binding before applying models.dev metadata decoration, so multi-model
  settings remain editable and per-model capability state stays aligned
- if the bundled release snapshot is absent or invalid during an offline
  release, keep the configured IDs visible with generic text-only metadata

## 8. Catalog item schema

```ts
type ModelCatalogItem = {
  providerId: string
  vendorKey: string
  modelId: string
  displayName: string
  source: "bundled" | "discovered" | "user" | "recent"
  capabilities: Array<
    | "tools"
    | "vision"
    | "reasoning"
    | "streaming"
    | "json"
    | "long_context"
  >
  contextWindow?: number
  maxOutputTokens?: number
  deprecated?: boolean
  notes?: string
  supportedThinkingLevels?: Array<
    "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
  >
  /** Which known catalog supplied metadata for this row. */
  catalogSource?: "models.dev"
}
```

## 9. Selection resolution order

When UI/search requests models for picker:

1. recent models for enabled providers
2. user-defined models
3. models.dev records for the matching provider/API URL
4. provider discovery/cache for custom or account-specific models
5. always include "custom model id" entry action

Deduplicate by `(providerId, modelId)` with priority:
`user > models.dev > provider-discovered > recent-only`. The `catalogSource`
field records a models.dev match; a provider cache stores only normalized
selection fields and is re-decorated from the local raw catalog on the next
read.

### 9.1 Conversation Composer scope

The conversation Composer is a configured-model picker, not a raw discovery
catalog. For each enabled, runnable provider it renders only the model IDs in
that provider's persisted `models` bindings (or the legacy
`defaultModelId` fallback). Cached or freshly discovered records may enrich
those rows with display names and metadata, but a discovered model that is not
configured is not shown in the conversation list. When discovery is missing,
the configured IDs remain visible by themselves.

The Settings provider dialog continues to use discovery to add and configure
models; saving a model binding is what makes it eligible for the Composer.

## 10. Default model policy

App-level default:
- first successfully tested provider + its default/recommended model
- if none configured, onboarding checklist requires provider setup before first agent run

Session-level:
- inherits app default at creation
- initializes thinking to the highest level published by the inherited model
  when it supports reasoning, otherwise `off`
- can override independently

## 11. Capability gating

| mode/feature | required capability |
|---|---|
| Agent mode tools | `tools` (warn if missing; hard-block only if runtime cannot function) |
| image input | `vision` |
| reasoning UI affordances | `reasoning` |
| structured repair helpers | `json` optional |

Warnings are non-blocking unless execution is impossible.

### 11.1 Reasoning capability resolution

1. Resolve the models.dev metadata for the matching provider/API URL and exact
   `modelId`.
2. The models.dev record is authoritative for `reasoning` and
   `reasoning_options`; cached/provider capability claims cannot replace it.
3. A free-form ID absent from models.dev is an unknown generic model and
   exposes only `off`; the UI cannot promote it to reasoning-capable.
4. The Composer renders the selector only when the models.dev record says the
   model supports reasoning and lists only its supported canonical levels.
5. If a stored/requested level is unavailable, choose the nearest supported
   level by scanning upward first and then downward. Non-reasoning models
   always resolve to `off`.
6. Changing to a non-reasoning provider persists `off`; no unsupported level
   leaks into the next request.

### 11.2 Vision capability resolution

1. Resolve models.dev `modalities.input` for the matching exact model.
2. Mark the model `vision` only when the models.dev record includes `image`
   input.
3. A provider endpoint, cached, or user-defined capability flag may remain
   useful as selection metadata, but it cannot promote an unknown model to
   image transport. Unknown/custom models therefore show the path-fallback
   status in Composer.
4. The main process prepares pasted images as content-addressed refs. A
   vision-capable model receives images within the 20 MiB app-side inline
   bound as transient image blocks; other cases receive a safe `@path`.

### 11.3 Settings model-add metadata

When the provider dialog adds a discovered model, its initial context window,
output limit, capability badges, and thinking defaults use this lookup:

1. A matching models.dev provider is preferred by `vendorKey`, then by
   normalized provider API URL; its exact model record supplies the fields.
2. A provider endpoint may add custom/account-specific IDs, but cannot replace
   models.dev metadata. A free-form miss receives the fixed generic defaults
   from `modelDraftFromInfo`.
3. The lookup does not send API keys to models.dev. Runtime model resolution
   uses the same models.dev record and the selected pi-ai transport adapter.

## 12. Refresh strategy

- manual refresh button in settings/model picker
- optional refresh on provider create/test success
- no aggressive background polling in MVP
- refresh failures keep previous cache and surface non-fatal error

Electron decorates cached and freshly returned model rows from the local
models.dev snapshot. Runtime model resolution passes the same full models.dev
configuration to the selected pi-ai transport adapter. Provider discovery
remains an ID-only fallback for custom/account-specific models absent from the
snapshot.

## 13. Search behavior

- case-insensitive match on displayName, modelId, provider name, vendorKey
- capability filters are AND
- provider filter is exact providerId
- empty query shows recents + popular/bundled first

## 14. Acceptance criteria

- [ ] search finds models across multiple providers
- [ ] custom model id path works without catalog hit
- [ ] recent models surface in the picker
- [ ] refresh merges into cache and picker (never destructively replaces)
- [ ] restart hydrates the prior catalog before live refresh, and offline
      refresh keeps the cached picker populated
- [ ] capability badges visible
- [ ] session model change applies to next turn only
- [ ] a new session defaults a reasoning-capable inherited model to its highest
      published thinking level and otherwise defaults to `off`
- [ ] reasoning selector is capability-gated and models.dev-published sparse
      levels clamp the same way in Composer, Electron main, and the pi sidecar
- [ ] models.dev metadata wins for a matching provider/model; an ID absent from
      it uses the generic shape while pi-ai supplies only transport/OAuth
- [ ] provider settings and cached discovery cannot replace known catalog
      capabilities; explicit binding edits remain persisted configuration
- [ ] unknown free-form models remain runnable without invented capabilities
- [ ] a models.dev record and an unknown generic record resolve through the same
      selected transport without sending provider credentials to the remote catalog

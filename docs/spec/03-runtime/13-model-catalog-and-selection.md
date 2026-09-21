# 13. Model Catalog & Selection

## 1. Product rule

Users must be able to use **market-available models broadly**, not only a curated demo subset.

Therefore:

1. Catalog is refreshable
2. Custom model IDs are always allowed
3. OpenAI-compatible gateways are first-class
4. Search is global across enabled providers

## 2. Selection UX

Model configuration is **discovery-first**: the AI service is the authority on
which models it serves, so the service's own endpoint is asked first and
models.dev is used only to enrich what came back. The bundled catalog is never
presented as a browsable list of every published model — a deployment does not
necessarily host everything its vendor publishes, and a key is not necessarily
entitled to it.

### Settings: one provider form

`ProviderSetupDialog` is a single form, not a wizard:

- **Name**, **Base URL** and **API Key** are all on screen at once. An empty key
  when editing means “keep the stored one”; `secretValue` is only sent when the
  user typed something.
- The models section lists what the service returned. `useProviderModels`
  debounces edits by 600 ms, guards against out-of-order replies with a
  monotonic request sequence, and needs no API key so local and no-auth
  gateways still resolve. A saved provider paints its cached list immediately
  and then replaces it with the live answer.
- Filtering that list is client-side: it is a short live list, not a catalog, so
  no host search is involved.
- The list header has a checkbox that selects or clears every currently visible
  row in one step, so a long service list does not have to be ticked one by one.
  While a search filter is active, "all" means the matching rows only; models
  already chosen outside the filter stay chosen. Newly added rows adopt
  `bindingFromModelInfo` (or the custom-model defaults); existing bindings keep
  their advanced overrides. The checkbox is checked when every visible row is
  chosen, unchecked when none are, and indeterminate when the visible set is
  mixed.
- The same header has a Fetch list action that probes the service immediately,
  skipping the 600 ms edit debounce and the cache-first paint. Existing rows
  stay visible while it loads. Automatic discovery on credential edits is
  unchanged. The control is disabled when no discoverable endpoint is ready,
  while a probe is in flight, or while the form is saving. Idle-with-a-valid-URL
  (the edit debounce) stays enabled so Fetch list can skip that window.
- Context window, output limit and initial thinking levels come from
  `bindingFromModelInfo` over the enriched record; per-model overrides live
  behind a per-row **Advanced** disclosure. `publishedThinkingLevels` describes
  the catalog baseline and seeds known-model bindings. The dialog always offers
  the seven canonical levels, including for unknown or non-reasoning records,
  and the runtime uses the binding's explicit set. A model that publishes no
  level list and no level map but does claim reasoning still seeds
  `low`/`medium`/`high`.
- Limit values render through one shared compact formatter
  (`formatCompactTokenCount`): up to two decimals at the `M` scale and one at
  the `K` scale, trailing zeros dropped, and a `K` mantissa that would round up
  to 1000 promoted to the `M` scale. Published windows on the 1M line therefore
  stay distinguishable — 1000000 reads `1M`, 1048576 and 1050000 read `1.05M`,
  1100000 reads `1.1M` — instead of collapsing into one rounded `1M`/`1.1M`, and
  a limit the service never published reads as an em dash. The settings rows,
  the Composer picker, the context inspector and the transcript all call this
  one implementation, while usage counters keep a real `0` instead of the dash.
- When an explicit binding enables `xhigh` or `max` without a catalog wire
  mapping, the runtime sends that canonical value through to the adapter rather
  than letting the adapter clamp it to `high`. Existing non-null catalog
  mappings remain authoritative for providers that translate the level.
- The wire API is derived from the provider's published `npm` adapter
  (`apiStyleForAdapter`) and is only editable inside **Advanced**.
- A custom model ID is always accepted, so a gateway without a `/models` route
  stays usable.

### Settings: selected model order

The AI service and OAuth vendor-account editors share the selected-model pane.
Each selected row has a dedicated reorder handle: drag it before or after
another visible row, or focus it and press the Up or Down arrow key to move it
past the neighboring visible row. Reordering is disabled while the form is
busy or fewer than two selected rows are visible. Dragging text still selects
it for copying; checkbox, Advanced, and Remove actions keep their existing
behavior and do not start a reorder.

The complete `models` binding array owns the order. Filtering only hides rows:
a move inserts the existing binding before or after the visible target in that
complete array, preserving hidden bindings and their relative order. Model IDs,
aliases, and advanced overrides travel with their bindings. A canceled drag or
a drop outside a selected row does not change the draft.

Saving persists the new order through the existing provider update flow, and
reopening either editor displays it again. Canceling the editor discards its
unsaved order. The provider's compatibility `defaultModelId` still mirrors the
first binding on save, so moving a model to the head changes that provider
default. When the edited service or account is the app's default provider,
saving also synchronizes the app-level default model to that first binding,
as the existing save flow does. The app default is unchanged when editing
another provider, and an explicitly bound session keeps its stored model
choice. No storage schema or IPC contract changes are required.

### Discovery precedence

`providers.listModels` resolves in this order, and the order is load-bearing:

1. The stored secret is resolved, so an edit needs no retyped key.
2. `discoverProviderModels` asks the service (`/models` or the per-style
   equivalent). A non-empty answer wins, is enriched per model through
   `modelsDevCatalog.findModel`, is written back to the model cache, and is
   reported as `source: "remote"`.
3. Only if the endpoint published nothing usable —no route, an auth error, or an
   empty list— does `modelsForProvider` supply the vendor's published models,
   reported as `source: "catalog"` together with any discovery error so the UI
   can say the service did not answer. This result is **not** cached, so a
   catalog guess never becomes indistinguishable from a real probe.
4. Last resort: the provider's configured model, `source: "fallback"`.

An OAuth vendor account skips step 2 — it has no key to probe with, and pi-ai
already knows which models the subscription allows.

The picker never dumps the raw host error into the model list. A failed probe
with no rows shows a classified one-line summary (auth, missing list, rate
limit, timeout, network, invalid response, or HTTP status) plus a short hint
to add an ID manually. A failed probe that still has cached rows keeps those
rows and shows the same summary as a compact banner.

### Subagent editor

The Subagents create/edit sheet reuses the configured, runnable models the
Composer already offers (enabled providers with a credential or `authKind:
none`). The control is a searchable, provider-grouped menu anchored to its
trigger rather than a native `<select>`: a definition may pin any configured
model, so the list can run to dozens of rows, and only an anchored surface
scrolls inside itself and accepts a filter. Inherit-session is the empty value,
options are `vendorKey-or-name/modelId` grouped by provider display name, and a
pin that is no longer configured stays as an extra row so an edit cannot
silently drop it. Every option comes from the configured provider catalog, so a
saved pin is always resolvable; the sheet deliberately offers no free-text
model id, and when no provider has a runnable model it shows an empty state with
an action that opens Models instead of a hand-typed field. Only the slash in a
pin is structural: the provider half is matched by a normalized alias, and a
custom endpoint's display name may contain spaces, so the picker and the draft
check share one splitter and can never disagree about what is saveable. The
thinking selector offers inherit-session (empty), do-not-send, and the
seven canonical levels; inherit keeps the session level, while do-not-send
leaves the provider adapter's own default untouched. When a generic or duplicate
vendor key would be ambiguous, the option uses a unique provider display name;
if the names also collide, it uses the stored provider id so no configured
provider disappears from the picker.

The sheet also offers an ordered **Fallback models** list using that same
configured-model picker. Users can add, move up/down, or remove alternatives.
Already-selected models are excluded from the add menu. Saved pins that become
unavailable stay visible and removable; reopening or editing another field
must not drop them. Clearing the list saves `fallbackModels: []`. Inherit-session
remains a primary-only choice. The hint explains that alternatives run after
model retries fail, completed tool results are kept, and Stop cancels the whole
task. See runtime §5f and ADR subagent-model-fallback.

### Advanced
- “Use custom model ID”
- “Refresh catalog”
- per-provider wire API override
- per-model context window, output limit and thinking-level overrides

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
- `thinkingLevel` (`off|minimal|low|medium|high|xhigh|max|omit`)

Changing model or thinking level mid-session affects subsequent turns only.
The stored thinking preference survives restart; the effective request level
is clamped against the selected model binding's enabled levels at execution
time, except `omit`, which is preserved on a reasoning model and sends no
thinking override. An empty binding or a binding containing only `off`
resolves to `off`.

For a newly created session, the renderer resolves the selected (or app-default)
model's `ModelBinding`. A reasoning model starts at that binding's
`defaultThinkingLevel` (`omit` is preserved; other values are clamped onto the
enabled levels). When the default is unset it falls back to the highest enabled
level seeded from published `supportedThinkingLevels`. A non-reasoning or
unknown model starts at `off` until the user enables a non-`off` level. This is
a creation default only and never rewrites an existing session's stored choice.

Unpinned sessions still advertise that inherited default model's reasoning
capability on session list/get/create/fork/configure. Enrichment does not pin
`providerId`/`modelId`; desktop session create does, by writing the then-current
app default (or Composer draft override) into the durable ids. Later Settings
default-model changes do not rewrite an already created session. Opening a
legacy row whose ids are still empty snapshots the last used turn, else the
current default, so it stops following Settings. The Composer never treats a
`supportsReasoning: false` or empty thinking-level snapshot as authoritative
when the selected catalog/binding model exposes levels, so a mid-turn thinking
or model pick cannot collapse the menu to Off-only.

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

Repeated metadata lookups use a bounded process-local cache keyed by the
configured vendor key, base URL, and case-insensitive, trimmed model ID. Both
matches and misses are cached; the original provider preference, alias
matching, and candidate ranking remain unchanged. Replacing the catalog after
a successful bundled load or Settings refresh invalidates the cache. A failed
refresh preserves the previous catalog and its results. Session capability
enrichment resolves a matching catalog record once per session and then applies
the current provider/model binding and session defaults, so user overrides are
never retained as stale cached capabilities. Refreshing a large session list
must not repeat a full catalog scan for every occurrence of the same lookup.

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

### 9.1 Effective context window

The runtime, the context inspector and the settings surface resolve one effective
model window. Every binding records where its `contextWindow` came from
(`contextWindowSource`):

- `catalog` — the number is a models.dev snapshot, so a later correction to the
  published `limit.context` replaces it. A refreshed record such as
  `gpt-5.6-luna` (`1,050,000` tokens) stops appearing as a 128k model, and a limit
  that models.dev corrects reaches the binding without deleting and re-adding the
  model.
- `user` — the number was entered through the per-model Advanced control (or the
  preset ladder in it) and is never replaced by the catalog, including the
  `128,000` value that is otherwise the generic seed.

Bindings written before the marker name no source. They keep the historical rule,
deterministically: a published `limit.context` replaces exactly the generic
`128,000` seed, and every other stored value stays the explicit value. Unknown
models still use the conservative 128k generic window and are never promoted from
an ID pattern alone. The marker is optional in the persisted record, so a config
written by an older version stays readable and a downgrade ignores it.

The configured user value remains persisted and visible in Advanced settings, but
provider safety does not trust an enlarged override beyond a known published
window. Outbound output caps, automatic compaction, and overflow classification
use the smaller of the configured and published windows; a smaller user value
continues to narrow the runtime budget.

### 9.2 Conversation Composer scope

The conversation Composer is a configured-model picker, not a raw discovery
catalog. For each enabled, runnable provider it renders only the model IDs in
that provider's persisted `models` bindings (or the legacy
`defaultModelId` fallback). Cached or freshly discovered records may enrich
those rows with display names and metadata, but a discovered model that is not
configured is not shown in the conversation list. When discovery is missing,
the configured IDs remain visible by themselves.

The Settings provider dialog continues to use discovery to add and configure
models; saving a model binding is what makes it eligible for the Composer.

When the combined Composer menu opens, the renderer starts provider-model
hydration before the Model submenu is entered. The first visible rows therefore
come from the cached catalog or configured bindings; live discovery remains a
background update. A configured non-empty alias is resolved from the binding
for every equivalent model ID and remains the sole visible model name while
the catalog is refreshed.

Vision badges in the Composer use the effective image-input capability for the
exact provider/model binding. An explicit `supportsImages: true` or `false`
wins over the published record; an absent or `null` value follows it. This lets
a configured custom or proxied model show the capability the endpoint was
explicitly configured to use without shaping the published `ModelInfo`.
An OAuth provider heading uses its non-secret account label when present, so
duplicate accounts from one vendor remain distinguishable; model rows still
use the configured model alias or published model name.

## 10. Default model policy

App-level default:
- first successfully tested provider + its default/recommended model
- the Settings default-model picker lists every configured model under its provider; selecting an entry persists both the owning provider and that exact model ID
- saving that provider preserves the selected app-default model while it remains configured; removing it falls back to the first remaining binding
- the picker supports local search across provider name and model ID; its result list scrolls within the floating surface and shows an explicit empty state when no model matches
- the picker uses concise settings-specific search copy; each result gives visual priority to the model ID and keeps the provider as secondary metadata
- results are grouped by provider so a provider name is shown once per group rather than repeated on every model row
- if none configured, onboarding checklist requires provider setup before first agent run

Session-level:
- inherits app default at creation and stores that `providerId`/`modelId` pair
- later Settings default-model changes apply only to new sessions and the
  unpersisted home draft, not to already created sessions
- initializes thinking to the highest level enabled by the inherited model's
  binding; published levels seed a new binding, while an empty or `off`-only
  binding starts at `off`
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
   `modelId`. Matching also accepts a catalog vendor prefix when the configured
   provider uses an unprefixed ID (for example `deepseek-v4` matches
   `deepseek/deepseek-v4` only under the matching provider identity).
2. The models.dev record is authoritative for published `reasoning` and
   `reasoning_options`; cached/provider capability claims cannot replace it.
3. The provider's exact `ModelBinding.thinkingLevels` is authoritative for the
   user's effective selection. It may explicitly enable a canonical level that
   the catalog does not publish.
4. A free-form ID absent from models.dev starts as an unknown generic model and
   exposes only `off`; Settings can promote it only after an explicit binding
   selection, never through discovery or an automatic inference.
5. The Composer renders the effective binding levels in canonical order. If no
   binding exists, it falls back to the published model levels and provider
   defaults.
6. If a stored/requested level is unavailable, choose the nearest enabled
   binding level by scanning upward first and then downward. A binding with no
   non-`off` level resolves to `off`.
7. Changing to a provider/model with no enabled reasoning level persists `off`;
   no unconfigured level leaks into the next request.
8. For explicitly enabled `xhigh`/`max`, an absent or null catalog mapping is
   materialized as an identity adapter mapping; a non-null catalog mapping is
   preserved.

### 11.2 Vision capability resolution

1. Resolve the published image-input baseline from the matching model record.
2. Apply the exact configured binding's `supportsImages` value to that
   baseline. An absent or `null` value follows the published capability;
   `true` enables image input for a configured endpoint even when its published
   record is text-only, and `false` disables a published image capability.
3. The Composer model-row vision badge and the main attachment transport gate
   use this same effective result. An unknown or custom model without an
   explicit binding override remains on the conservative path-fallback route;
   discovery or cache metadata alone cannot promote it to image transport.
4. The main process prepares pasted images as content-addressed refs. A
   vision-capable model receives images within the 10 MB app-side inline
   bound as transient image blocks; other cases receive a safe `@path`.

### 11.3 Settings model-add metadata

When the setup form adds a model the service returned, its initial context
window, output limit, capability badges and thinking defaults come from
`bindingFromModelInfo` over the enriched record, so the common path needs no
manual token entry. The enrichment lookup is:

1. A matching models.dev provider is preferred by `vendorKey`, then by
   normalized provider API URL, including explicit native-adapter aliases
   such as `openai-codex` → `openai`; its exact model record supplies the fields.
2. A provider endpoint may add custom/account-specific IDs, but cannot replace
   models.dev metadata. A free-form miss receives the fixed generic defaults
   from `bindingForCustomModel`.
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

There is no catalog search channel. The models a user chooses from are the ones
their service returned, and that list is short enough to filter in the renderer:
the provider form matches the typed text against model id and display name with
a plain case-insensitive substring test.

The Composer picker likewise searches the **configured** models only, matching
model id, display name, published family and the account-aware provider display
name (`composerModelMatchesQuery`).

Model ids are compared case-insensitively wherever a chosen model is matched
against a returned one, so a hand-typed `GPT-5` and a published `gpt-5` are the
same model to the check mark, the toggle and the duplicate guard.
## 14. Acceptance criteria

- [ ] the model list a user chooses from is the one their service returned; the
      bundled catalog is never offered as a browsable list of every published
      model
- [ ] the catalog is consulted only when the endpoint publishes nothing usable,
      and that result is reported as `catalog`, is not cached, and carries the
      discovery error
- [ ] adding an AI service is one form, with no stages to step through, and the
      wire API is derived from the published adapter instead of being asked for
- [ ] adding a discovered model requires no manual context-window or
      output-token entry; overrides stay behind a per-model Advanced disclosure
- [ ] the API-key path and the OAuth vendor-account path use the same live model
      list and the same binding shape
- [ ] selected models can be reordered by drag handle or Up/Down arrow keys in
      both editors; saving and reopening preserves the order, aliases, and
      overrides, and a filtered move preserves hidden bindings and their order
- [ ] canceling a drag or the editor preserves the previous applicable order;
      busy forms disable reordering, and text-copy and row actions still work
- [ ] an unsaved provider can be probed from the form before it is persisted,
      and a saved one reuses its stored secret without a retyped key
- [ ] custom model id path works without catalog hit
- [ ] recent models surface in the picker
- [ ] refresh merges into cache and picker (never destructively replaces)
- [ ] restart hydrates the prior catalog before live refresh, and offline
      refresh keeps the cached picker populated
- [ ] capability badges visible
- [ ] session model change applies to next turn only
- [ ] a newly created session stores the then-current default provider/model, and later default-model changes do not rewrite that session
- [ ] a new session defaults a reasoning-capable inherited model to that
      binding's stored default thinking level (clamped onto the enabled set;
      strongest-enabled only when unset) and otherwise defaults to `off`
- [ ] the settings picker always exposes the canonical thinking ladder;
      published levels seed known models and explicit binding levels clamp the
      same way in Composer, Electron main, and the pi sidecar
- [ ] models.dev metadata wins for a matching provider/model; an ID absent from
      it uses the generic shape while pi-ai supplies only transport/OAuth
- [ ] provider settings and cached discovery cannot replace known catalog
      capabilities; explicit binding edits remain persisted configuration
- [ ] a models.dev limit correction reaches an already saved `catalog` binding
      without deleting and re-adding the model, while a number the user entered in
      Advanced (`user`) survives every correction, a hand-entered `128,000`
      included
- [ ] a binding saved before the provenance marker resolves deterministically:
      the generic 128k seed follows the catalog and every other value stays as
      stored
- [ ] the provenance marker survives a provider save/read round trip and an
      unmarked record keeps working
- [ ] unknown free-form models remain runnable without invented capabilities
- [ ] a models.dev record and an unknown generic record resolve through the same
      selected transport without sending provider credentials to the remote catalog
- [ ] compact limit text never reads above the published value, keeps the
      neighbouring 1M-line windows apart (`1M` / `1.05M` / `1.1M`), and never
      renders a `K` mantissa at or above 1000

### StepFun Step 5 Preview

The service picker exposes only StepFun Plan for StepFun, selecting
`https://api.stepfun.com/step_plan/v1` and Chat Completions. Ordinary API
services remain usable as custom configurations; existing saved endpoints
are never rewritten or relabelled as subscription services.
Discovery still determines which models the key can use. For exactly
`step-5-preview` at the plan endpoint or a saved ordinary API endpoint, a reviewed first-party metadata supplement
provides a 1,024,000-token context/input window, a conservative 64,000-token
output cap, image and tool support, and low/medium/high reasoning when the
first-party models.dev record is absent. Third-party catalog records do not
override that supplement. A first-party record supersedes it after refresh.

The metadata source is `provider`, distinct from `models.dev`; user binding
overrides keep their existing precedence. Other endpoints and model IDs are
unchanged. The desktop does not add video attachment transport. See ADR
`stepfun-first-party-model-metadata` and the StepFun setup guide.

## Image model binding

The default conversation model has a separate **Image generation model** row below
it. Model Advanced can select that unique binding; provider form Save commits it,
Cancel discards it, and replacing it leaves the conversation default unchanged.
See [image generation and editing](21-image-generation.md) for the tool and batch contract.

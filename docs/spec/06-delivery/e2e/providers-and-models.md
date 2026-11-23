# E2E Scenarios: Providers and Models

## E2E-provider-refresh-remote-identity

Render the normal Composer toolbar for an active remote session that denies Stop/local tools, then refresh providers while session inventory omits the Host. Verify the remote identity and capability restrictions remain, and the Stop control remains disabled. Return an authoritative summary and verify its updated capabilities replace the retained value. Coverage: `provider-refresh-remote-identity.test.mjs`, remote project regressions and `scripts/e2e-provider-refresh-remote-identity.mjs` with production ComposerToolbar/useAppStore in Electron.

> Part of the [E2E test plan](../04-e2e-test-plan.md). Provider setup, credentials, OAuth, model catalogs, wire protocols, usage, and hosted search.
> Scenario template, gates, and traceability live in the plan.

## E2E-USAGE-explicit-zero-cache

- Complete a controlled Pi request with nonzero input/output and explicit zero
  cache reads/writes. Observe the request, consume the stream result, and replay
  its usage: both cache fields remain zero, not absent.
- Include zero reads with nonzero writes and nonzero reads with zero writes.
  Replaying the same operation does not double-count any token bucket. Cache
  counters that are absent, non-finite or negative remain unavailable.
- Focused runtime coverage: `src/request-usage.test.ts`. Native/live-provider
  execution is separate from these controlled request-accounting regressions.

## E2E-MODEL-idle-write-order

Hold the first idle configuration response, select a second model, then release
both responses. Assert a single in-flight write and the final newest model.
Coverage: `session-model-write-order.test.mjs`, using real slice/coordination
with only Host API controlled. Running-turn configuration remains queued.

## E2E-PROVIDER-DASHSCOPE-terminal-parameter-error

- **Preconditions:** Isolated Agent runtime and a synthetic OpenAI-compatible
  provider; no real credentials or user history.
- **Steps:** Submit a prompt. Return HTTP 200 with a streamed provider error
  whose message starts `InvalidParameter: <400>` and reports repetitive tool
  calls. Also exercise 400/422, authentication, 429 and 5xx envelopes through
  the shared classifier.
- **Expected:** The 400 error ends the turn as non-retriable `PROVIDER_ERROR`
  with provider status 400, without another provider request or retry backoff.
  The HTTP 200 transport does not override the embedded error status.
  Authentication stays terminal; throughput limits and 5xx remain retriable.
  Structured status takes precedence and prose numbers are ignored.
- **Automated coverage:** `agent-errors.test.ts` and `provider-retry.test.ts`.
- **Specs:** `03-runtime/08-error-codes.md` §3.2.

## E2E-PROVIDER-openai-error-code-status

- **Preconditions:** Isolated Agent runtime classifier; no credentials, network,
  or user history.
- **Steps:** Classify messages that begin `Error code: 402`, `Error code: 401`,
  `Error code: 429`, and `Error code: 404`, including a body that also contains
  a parenthesized status. Also classify SiliconFlow-style `Error code: 30001`,
  prose that only mentions `error code: 500`, a bare `code: 401`, and a Zhipu
  `"code":1308` body.
- **Expected:** `providerStatus` is the prefix and the status table applies:
  402 is terminal `PROVIDER_ERROR`, 401 is `PROVIDER_UNAUTHORIZED`, 429 is
  `PROVIDER_RATE_LIMITED`, and 404 is `MODEL_NOT_CONFIGURED`. The prefix wins
  over a later parenthesized number. Business codes and prose do not become an
  HTTP status; Zhipu `1308` stays terminal `PROVIDER_ERROR` without
  `providerStatus`. A structured `status` field still wins over the prefix.
- **Automated coverage:** `packages/agent-runtime/src/agent-errors.test.ts`.
- **Specs:** `03-runtime/08-error-codes.md` §3.2.

## E2E-PROVIDER-anthropic-oauth-claude-code-identity

- **Preconditions:** Built desktop, isolated Host data directory and Electron
  profile, and a seeded Claude (Anthropic OAuth) account row with a synthetic,
  unexpired credential. Every `api.anthropic.com` / `platform.claude.com`
  request from Electron main and the agent sidecar is redirected to a local
  fixture; no real Anthropic request is made.
- **Steps:** Launch the app, type a prompt in the Composer, and press Enter.
  The fixture rejects Claude Code identities older than 2.1.290 with HTTP 400
  `claude_code_version_too_old`, as Claude Pro/Max models do (issue #2239),
  and otherwise streams a reply.
- **Expected:** The model request carries the OAuth bearer token, `x-app: cli`
  and a `claude-cli/<version>` User-Agent of at least 2.1.290. The chat shows
  the streamed reply and no version rejection.
- **Automated coverage:** `pnpm test:e2e:anthropic-oauth-identity`
  (`scripts/e2e-anthropic-oauth-identity.mjs`) and
  `packages/agent-runtime/src/anthropic-oauth-identity.test.ts`.
- **Specs:** `03-runtime/12-provider-config-schema.md`.

## E2E-PROVIDER-retry-backoff-is-not-idle

- **Entry:** Build shared and the production sidecar bundle, then run
  `node scripts/e2e-provider-retry-idle.mjs` (about one minute).
- **Sequence:** Use the supported 30-second idle setting. Return one HTTP 429
  with a 30-second retry delay, then succeed. Separately hold an HTTP request
  silent until its idle deadline, then let the retry succeed. Stop another
  turn during its rate-limit backoff.
- **Expected:** The planned wait consumes exactly one retry; the successful
  follow-up is sent. A real stalled request closes before its replacement
  begins, and Stop prevents a later retry request.
- **Coverage:** Real production sidecar, provider adapter and localhost HTTP
  server with fixture Host responses. Real-clock process checks are supplemented
  by real Agent-loop tests under a controlled clock, including all ten allowed
  rate-limit retries and exhaustion after eleven genuinely stalled attempts.
- **Specs:** `03-runtime/02-agent-runtime.md` provider retry behavior.

## E2E model discovery membership

- **Entry:** `node scripts/e2e-model-discovery-state.mjs` after building Host,
  shared, agent-runtime and host-runtime in the task worktree.
- **Environment:** Real isolated Host process and SQLite; production provider
  IPC and Composer selection; simulated HTTP only, no credentials/live app.
- **Sequence:** Discover two configured models and retain a never-discovered
  manual id; remove one; refresh offline; restart Host; read cache; republish;
  change id casing; send partial, malformed, and empty lists; change endpoint.
- **Expected:** Missing previously published models leave normal/recent choices
  without deleting bindings or changing defaults. Offline/restart cannot
  resurrect them. Reappearance restores them. Manual ids and partial refreshes
  remain safe; old endpoint state does not contaminate the new endpoint.
- **Component coverage:** `provider-model-list-refresh.test.mjs` also renders
  the actual settings panes and verifies saved bindings remain editable.

## E2E-PI-130-kernel-upgrade

- **Preconditions:** Exact Pi 1.3.0 pins and migrated patches in a dedicated
  worktree, isolated fixture state, and no real provider credentials.
- **Steps:** Submit a Desktop turn that receives malformed final tool JSON,
  then a corrected Write call and a final answer. Repeat with a literal invalid
  Unicode escape in the tool input. Resume DeepSeek history using the same and
  a different provider/model identity. Run two turns with extensions that guard
  `before_agent_start` by `messageType === "user"`. Exercise hosted search,
  native Pi continuation, and MCP with existing offline suites.
  Expand a slash template with an empty quoted argument followed by two values;
  exercise strict-tool downgrade, thinking-off, error images, mixed reasoning/text
  stream chunks, and native tool restoration under `noTools: "all"`.
- **Expected:** Malformed calls never reach Host execution; raw input reaches
  the next model request as a tool error, and only the corrected call executes.
  Unicode escapes retain all fields. Same-model thinking replays as reasoning;
  foreign thinking is omitted without altering visible history. Prompt additions
  remain ordered and do not accumulate. Host permissions, persistence, native
  tool restrictions, search replay, and cancellation remain unchanged.
  Empty quoted template arguments retain their positions and activate defaults;
  strict `require` remains strict, hosted search survives downgrade, and native
  historical tool activation cannot bypass Desktop's explicit no-tools setting.
- **Coverage:** `pi-upstream-1.3-contract.test.ts`, `flash-transcript.test.ts`,
  `hosted-search-consumers.test.ts`, `provider-stream-frame-fields.test.ts`,
  `extensions/prompt-chain.test.ts`, `native-pi-session.test.ts`,
  `pi-anthropic-strict-fallback.test.ts`, `pi-1.3-adapter-features.test.ts`,
  `prompt-templates.test.ts`, and the
  existing `test:e2e`, `test:e2e:hosted-search`, `test:e2e:provider-api-style`,
  and `test:e2e:trusted-extensions` commands.
- **Specs:** [Pi dependency boundary](../../02-architecture/06-pi-runtime-dependency-boundary.md),
  [trusted extensions](../../07-plugins/16-trusted-extensions.md).
- **Acceptance:** Offline runtime/contract and isolated process validation.
- **Milestone:** Maintenance.
- **Status:** Candidate validation recorded in `docs/project/pi-130-adoption.md`.

## E2E-PI-140-kernel-upgrade

- **Preconditions:** Exact Pi 1.4.0 release-group pins and migrated package
  patches in a dedicated worktree, isolated fixture state, and no real provider
  credentials.
- **Steps:** Submit a Desktop prompt through the runtime with a local model
  fixture and capture the provider request identity. Repeat through a delegated
  subagent. Exercise OpenRouter, NVIDIA, and OpenCode identity-header mapping
  with pure request fixtures. Run the existing hosted-search, native Pi session,
  and trusted-extension offline suites against the installed 1.4.0 packages.
- **Expected:** Parent and delegated requests retain pi-ai's detailed,
  versioned `User-Agent` while suppressing pi-agent-core's default Pi
  attribution headers. Existing hosted-search replay and validation, provider
  request errors, native-session context estimates, tool validation, extension
  compatibility, retry and cancellation behavior remain intact. No provider
  credentials or live services are used.
- **Coverage:** `pi-upstream-1.4-identity.test.ts`,
  `pi-upstream-1.4-contract.test.ts`, `pi-1.4-adapter-features.test.ts`,
  `runtime.test.ts`, `subagent.test.ts`, plus the existing
  `test:e2e:hosted-search` and `test:e2e:trusted-extensions` commands.
- **Specs:** [Pi dependency boundary](../../02-architecture/06-pi-runtime-dependency-boundary.md),
  [trusted extensions](../../07-plugins/16-trusted-extensions.md).
- **Acceptance:** Offline runtime/contract and isolated process validation.
- **Milestone:** Maintenance.
- **Status:** Candidate validation recorded in `docs/project/pi-140-adoption.md`.

## E2E-PI-150-kernel-upgrade

- **Preconditions:** Exact Pi 1.5.0 release-group pins (including the new
  `pi-schema` package) and rebased package patches in a dedicated worktree,
  isolated fixture state, and no real provider credentials.
- **Steps:** Run the existing runtime, native Pi session, and identity suites
  against the installed 1.5.0 packages. Stream Anthropic hosted-search blocks
  through the incrementally parsed 1.5.0 adapter. Build the split sidecar
  bundle. Run the existing hosted-search and trusted-extension offline suites.
- **Expected:** Desktop tool schemas built with TypeBox validate unchanged on
  pi-schema. Hosted-search capture, live query updates, citations, replay, and
  local request errors remain intact. The release group resolves a single
  `undici` 8.x, so the sidecar entry stays below its size threshold. Identity
  headers report 1.5.0. No provider credentials or live services are used.
- **Coverage:** `pi-upstream-1.5-identity.test.ts`,
  `pi-upstream-1.5-contract.test.ts`, `pi-1.5-adapter-features.test.ts`,
  `official-native-search.test.ts`, `native-pi-session.test.ts`,
  `agent-runtime-bundle-package.test.mjs`, `anthropic-oauth-retry.test.mjs`,
  plus the existing `test:e2e:hosted-search` and
  `test:e2e:trusted-extensions` commands.
- **Specs:** [Pi dependency boundary](../../02-architecture/06-pi-runtime-dependency-boundary.md),
  [trusted extensions](../../07-plugins/16-trusted-extensions.md).
- **Acceptance:** Offline runtime/contract and isolated process validation.
- **Milestone:** Maintenance.
- **Status:** Candidate validation recorded in `docs/project/pi-150-adoption.md`.

## E2E-PROVIDER-adaptive-thinking-protocol

- **Preconditions:** Isolated provider settings fixture with a non-OAuth
  Anthropic Messages provider, `claude-opus-5-5`, a legacy Claude model, and a
  Claude-named relay id whose generic model config has no protocol or
  reasoning-options metadata;
  no live credentials.
- **Steps:** Open a configured model's Advanced settings, inspect the
  thinking-protocol row, save an adaptive model with `medium`, then submit a
  request through the local Anthropic transport fixture. Repeat with the
  legacy model. Submit a request with the protocol unset for the generic relay
  model, then repeat after selecting its legacy protocol.
- **Expected:** The adaptive model sends `thinking.type=adaptive` and
  `output_config.effort=medium`; the legacy model sends the existing
  budget-based thinking shape. Omitting the new field on an old binding keeps
  the existing inference after reload: effort-only models use adaptive, while
  models publishing `budget_tokens` (including effort + budget combinations)
  retain budget thinking. The metadata-free generic Claude relay defaults to
  adaptive, while its explicit legacy selection sends budget thinking. An
  explicit per-model `compat.forceAdaptiveThinking` value overrides automatic
  inference when no protocol is selected.
- **Specs:** 03-runtime/11-provider-model-system; 03-runtime/12-provider-config-schema.
- **Acceptance:** Provider/model protocol selection and wire compatibility.
- **Milestone:** Maintenance.
- **Status:** Protocol coverage is automated in the agent-runtime provider
  binding tests; desktop settings coverage remains part of the provider model
  configuration E2E fixture.

## Provider & Key

## E2E-169: Default model picker selects a configured model

- **Preconditions**: Two runnable providers exist; one provider has at least two configured model bindings.
- **Steps**: Open Settings → Model configuration → Change default model, then select the second model under the provider.
- **Expected**: The Defaults card presents a compact settings row with the
  provider name and exact model ID beneath the Default model label; its quiet
  Change action does not repeat the current value. The picker groups
  model-level entries by provider, marks the exact current model, and a newly
  created session inherits that exact model and its owning provider. Changing
  the default later does not rewrite an already created session's stored
  provider/model; only a new session or the unpersisted home draft follows the
  live default. Searching by provider or model filters locally, the result list
  scrolls without moving the settings card, and an unmatched query shows an empty
  state.
- **Specs linked**: `03-runtime/13-model-catalog-and-selection.md`
- **Acceptance**: B (model selection)
- **Milestone**: M6
- **Status**: Documented; automation pending

## E2E-005: Add a provider and save API key

- **Preconditions**: App running; no provider configured; the models.dev snapshot ships with the build.
- **Steps**: 1) Open Settings → Model configuration and choose Add provider. 2) Confirm the searchable service chooser opens. Filter and select a built-in API-key service or **Custom endpoint**; the selection must open its matching form, never the plugin-only “selected service unavailable” state. Confirm the form has no stepper or Next/Back buttons. For **Custom endpoint**, Name and Base URL appear on one row with no helper paragraph under the URL (placeholder only), API Key and API format appear side by side on the next row (not behind Advanced), and a focused field plus its 2px accent ring stays fully inside the dialog, including on a window narrower than 1040px. The custom form has no authentication-mode switch; the API key is optional and its input stays enabled. 3) Enter a name and a base URL for a service that publishes a `/models` route, then paste an API key. Confirm the models section fills with the models THAT SERVICE returned without requiring a key for discovery; confirm a model the deployment does not host is absent. Also exercise the no-auth path with a custom endpoint: leave the key empty, select a discovered model, and save. 4) Type in the filter box and confirm the list narrows client-side with no network request per keystroke. 5) Confirm each row shows the models.dev-derived context/output for models the catalog knows, that its compact text tracks the published value instead of a coarser rounded one (a 1,050,000 window reads `1.05M`, never `1.1M`), and that a model with no catalog match still lists with generic defaults. 6) Select two models with the checkboxes. 7) Expand Advanced on one chosen row, override its limits and toggle thinking chips; confirm each numeric field has a five-chip preset ladder for common values, clicking a chip writes the value, hand editing remains possible, and a non-preset value leaves the ladder unselected. Set max output to 8,192 while its context window still follows the catalog. On a model whose published image input is enabled, toggle image input off and then back on before saving, so the explicit choice equals the current catalog value. Confirm the label and optional hint sit above one compact grouped control and do not force the options onto a second row at normal dialog width; confirm all seven canonical levels are available, that published levels start selected for a known reasoning model, and that a non-reasoning or unknown row shows the same chips unselected with the manual-override hint; enable one level on that row and confirm the other row is unaffected. 8) Open the form-level Advanced and confirm the API format is present but pre-derived. 9) Add a free-form model ID the service did not return; confirm it is added with 128,000 / 8,192 / no-thinking defaults, then enable a thinking level if the endpoint supports it; confirm re-adding the same ID in different letter case is rejected as already added. 10) Save.
- **Expected**: The service is asked first and models.dev only enriches the answer and seeds known-model defaults. The no-auth custom path saves `authKind: "none"`, omits `secretValue`, and makes the configured provider available anywhere an enabled no-auth provider is selectable; named cloud preset behavior stays unchanged. Newly fetched or checked model rows stay collapsed until the user opens Advanced, so every selected model ID remains visible in the right pane after a multi-select. The settings picker always offers the seven canonical thinking levels, and the Composer later renders the explicit levels saved in the same model binding; an empty or `off`-only binding resolves to `off`. Discovery is debounced ~600 ms, does not mark loading until that window elapses, and a slow reply from an earlier keystroke never replaces a newer list; named add-path discovery waits for an API key, while an unsaved custom provider is probed with the typed base URL (and key, if any) before it exists. Preset ladders cover common context/output limits while preserving hand-edited values. The explicitly selected 8,192 output remains pinned independently of the catalog-sourced context window, and the image-input choice remains explicitly enabled after it is toggled back to the published value; neither is reinterpreted as "follow catalog" on save/reopen. Later catalog corrections change only values whose own source is `catalog`. Limit text renders through one shared compact formatter, so neighbouring published windows stay distinguishable (`1M` / `1.05M` / `1.1M`) and a compact limit never reads above its published value. Custom endpoint keeps API format beside the key and omits Base URL helper copy; named endpoints do not show format. Point the same custom form at an unreachable or unauthorized URL and confirm one classified sentence reaches the app toast while the left pane keeps its single “no list” label (not a raw JSON/HTML dump and not a second “no models” empty state); with cached rows from a later edit the same reason is toasted while the rows stay. Point a second provider at a base URL with no `/models` route and confirm the list falls back to the catalog, is labelled as coming from models.dev rather than the service, and still saves. The provider appears as a row with its host, model count and secret badge; the key is stored securely (not in plaintext config); `models` contains both bindings and `models[0]` remains the provider default.
- **Specs linked**: `03-runtime/11-provider-model-system.md`, `03-runtime/12-provider-config-schema.md`, `03-runtime/13-model-catalog-and-selection.md`, `03-runtime/14-secrets-storage.md`, `04-ux/06-settings-ia.md`
- **Acceptance**: B (multi-model provider configuration, save key)
- **Milestone**: M2
- **Status**: Manual model-picker acceptance; chooser-to-key-form selection is covered by `apps/desktop/test/plugin-provider-catalog-user-path.test.mjs`; automated protocol smoke covers provider creation and secret handling without plaintext echo.

## E2E-PROVIDER-custom-endpoint-no-api-key: Configure a custom service without credentials

- **Preconditions**: Isolated settings profile and a local OpenAI-compatible fixture that lists a model without credentials; no live or paid provider.
- **Steps**: 1) Open Settings → Model configuration → Add provider → Custom endpoint. 2) Enter a name and the fixture URL; leave the optional API key empty, without selecting an authentication mode. 3) Confirm model discovery succeeds without a key, select the returned model, and save. 4) Reopen and save without changes, then type a key and save; confirm API-key authentication is restored. 5) Edit an API-key provider and save with a blank input; confirm its key is retained. Reopen and confirm **Clear saved API key** is an icon-only button to the right of the input on the same row, with a localized accessible name and tooltip. Activate it, confirm focus returns to the input, and confirm subsequent discovery does not reuse the stored key. Close without saving and confirm no credential changed. Repeat Clear followed by Save, and Clear followed by a replacement key and Save. 6) Confirm the no-auth provider and model are offered by chat/default-model and subagent selectors. 7) Send a request through the no-auth provider fixture.
- **Expected**: The custom form has no no-key switch and keeps the key input enabled. An empty or whitespace-only key with no saved credential automatically saves `authKind: "none"` without `secretValue`; a supplied key uses API-key authentication. A blank edit retains an existing key. Clear is staged until Save and a replacement key takes precedence over removal. The enabled no-auth provider with `hasSecret: false` remains selectable for chat, defaults, subagents, and image generation where its model supports that operation. Named cloud presets remain unchanged. Runtime requests contain no API-key or Authorization credentials.
- **Automation**: `node --test apps/desktop/test/custom-provider-no-api-key-user-path.test.mjs` covers empty/whitespace keys, keyed creation, save/reopen, preservation, staged removal/cancellation, discovery without the old secret, and replacement. `pnpm test:e2e:provider-api-style` renders the production setup form in English and Simplified Chinese with a stubbed model-discovery/API boundary and verifies create/update payloads and chat/default/subagent selector eligibility. `pnpm --filter @pi-desktop/agent-runtime exec vitest run src/provider-binding.test.ts` verifies request headers; `apps/desktop/test/image-generation-default.test.mjs` covers no-auth image-model availability; `cargo test -p host-core --locked switching_provider_to_no_auth_clears_its_api_key` verifies Host persistence and secret removal.
- **Specs linked**: `03-runtime/11-provider-model-system.md`, `03-runtime/12-provider-config-schema.md`, `03-runtime/13-model-catalog-and-selection.md`, `04-ux/06-settings-ia.md`.
- **Acceptance**: B (model configuration), F (provider persistence), Security.
- **Milestone**: M2.
- **Status**: Automated coverage uses a deterministic stub for model discovery and fetch. The full local-endpoint send flow remains available for manual acceptance; no paid provider or user profile is used.

## E2E-PROVIDER-defaults-survive-an-added-provider: An added provider leaves the app defaults alone

- **Preconditions**: App running; provider A saved and set as the app default model; a second provider B serving different models; one image-capable model configured on A and another on a different service.
- **Steps**: 1) Open Settings → Model configuration and add provider B; save without touching the Default model row. 2) Confirm the Default model row still names provider A and its exact model, and that a new session starts on it. 3) Set an image model as the default image model, then add a provider that also serves image models; save. 4) Confirm the Default image model row still names the earlier binding while the picker lists the new provider's image models as candidates. 5) Delete the provider that owned a default, then add a service that serves a model and an image model; save. 6) Confirm both defaults now resolve to that newly added provider.
- **Expected**: Saving a new provider never repoints an app default that still resolves: the model default keeps the pairing the Default model row already renders, and the image default keeps its stored binding while its candidate list grows. A removed image model is cleared and requires an explicit new selection; a removed chat default still uses the existing chat repair rule. Deleting the provider row that owned an image default needs no manual repair either: the next settings read or write drops the binding and candidate whose provider row is gone, so the Default image model row reports no default instead of a binding the runtime rejects. The explicit make-default actions and the edit path remain unchanged.
- **Specs linked**: `03-runtime/13-model-catalog-and-selection.md`, `03-runtime/21-image-generation.md`
- **Acceptance**: B (model selection)
- **Milestone**: M6
- **Status**: Documented; covered by `apps/desktop/test/default-model-display.test.mjs`, `apps/desktop/test/image-generation-default.test.mjs`, `apps/desktop/test/provider-model-config.test.mjs`

## E2E-PROVIDER-custom-model-limits: A hand-typed custom model id takes its limits from the model library

- **Preconditions**: App running; the models.dev snapshot ships with the build; a provider editor is open.
- **Steps**: 1) Type a model id the snapshot publishes into the add-model field and add it; confirm the new row's context window, max output tokens and thinking levels match the published record instead of 128,000 / 8,192 with none. 2) Type an id the snapshot does not publish and add it; confirm the row keeps the generic 128,000 / 8,192 seed and no thinking levels. 3) Add an id while the service list is unreachable; confirm the row still appears exactly once and stays editable. 4) Add an id and edit its limits immediately, before the lookup answers; confirm the typed values survive.
- **Expected**: `providers.lookupModel` answers a hand-typed id from the local snapshot only — no provider network request and no host call — and a hit seeds the binding the way a picked model is seeded (published context window, max output tokens, thinking levels, `contextWindowSource: "catalog"`) while the stored id stays exactly what the user typed. A miss, a failed call, or an id the current discovery already described leaves the previous behavior intact: one usable row, the generic seed, and no stalled or duplicated list.
  A record published under another spelling of that id — a route prefix, a dated
  stamp, a marker the deployment appends — is a hit too: the row is upgraded in
  place as soon as the answer arrives, without waiting for a save. In a live
  discovered row, a positive safe integer context/input or output limit reported by
  the endpoint takes precedence over the catalog for that field; omitted fields
  independently use catalog metadata. For an unanchored relay, a published
  owner record outranks reseller matches; dotted/dashed version aliases and one
  whitelisted deployment label keep the served ID intact, the owner's sibling
  keys add evidence when the public key states nothing, and a corroborated
  canonical declaration translates a name the owner publishes under another ID
  without rewriting the served ID. Conflicting owner records do not supply
  guessed limits.
- **Specs linked**: `03-runtime/12-provider-config-schema.md`, `03-runtime/13-model-catalog-and-selection.md`
- **Acceptance**: B (multi-model provider configuration)
- **Milestone**: M2
- **Status**: Documented; covered by `apps/desktop/test/model-custom-lookup.test.mjs`, `apps/desktop/test/provider-lookup-model-handler.test.mjs`, and `apps/desktop/test/provider-endpoint-metadata.test.mjs`

## E2E-PROVIDER-configured-models-search: The chosen pane's search narrows the configured list

- **Preconditions**: App running; one provider saved with at least three model bindings, one of them carrying an alias and another whose catalog display name differs from its id.
- **Steps**: 1) Open Settings → Model configuration and edit that provider. 2) Type part of one model id into the search field beside the right pane's title and confirm the configured list narrows as you type while the count beside the title keeps reporting every configured model. 3) Search another row by its alias, then by its catalog display name, and confirm both find the binding they stand for. 4) Type a query that matches nothing and confirm the right pane shows its own empty state rather than the "nothing chosen yet" one. 5) With that query still in the field, tick a model in the left discovered list and confirm it is added in view — the field is dropped only when the filter would have hidden it — then tick a model whose id matches the query and confirm the filter stays. 6) Clear the filter, remove every configured model, and confirm the field ends up empty instead of holding a query in a box that is now disabled. 7) Save.
- **Expected**: The right pane's search filters the configured list client-side with no host round trip, matching the model id, its alias and the catalog display name case-insensitively. The count badge keeps reporting every configured model, so a filtered view is never mistaken for a provider that offers fewer models. A model added while a filter is active is never added out of view: the field is dropped when the new row would be hidden and kept when it still shows what was added, and an emptied list discards the query so no filter is stranded in a disabled field.
- **Specs linked**: `04-ux/08-component-spec.md`, `03-runtime/13-model-catalog-and-selection.md`
- **Acceptance**: B (multi-model provider configuration)
- **Milestone**: M2
- **Status**: Documented; UI automation pending

## E2E-005A: Edit provider model bindings and migrate a legacy model

- **Preconditions**: One provider saved with two model bindings; one fixture provider row exists with only the legacy `default_model_id` and no `config_json.models`; one fixture row carries an unknown or legacy `apiStyle` string.
- **Steps**: 1) Reopen the saved provider; confirm the single form opens with its cached model list painted immediately, and that the API key field explains an unchanged key is kept. 2) Confirm the live probe then refreshes that list without a retyped key, because the stored secret is reused. 3) Confirm both existing bindings are still chosen and check-marked, with their limits, thinking chips and defaults intact. 4) Enable a level the fixture catalog does not publish, edit one row's limits and save. 5) Reopen the fixture provider and confirm its legacy model appears as one chosen row with 128,000 context, 8,192 max output and all seven thinking choices available but unselected. 6) Reopen the unknown-style fixture and confirm the editor renders with Chat Completions selected instead of an error boundary; save it and confirm the repaired style is persisted. 7) Save the fixture provider without changing the model. 8) Select the second binding as the app default, reopen the provider and save unchanged; confirm the app default stays on that binding. Save another provider and confirm the app default is unchanged. Reopen the default provider, remove the selected binding, and save; confirm the app default falls back to the first remaining binding. 9) Take the service offline or revoke the key, reopen the provider, and confirm the cached rows stay visible with a compact classified discovery error rather than an empty list or a raw host dump.
- **Expected**: Editing never drops an unmodified binding. An explicitly enabled level remains saved even when the catalog does not publish it, so the Composer reads the same binding rather than silently narrowing it; a binding whose model discovery is unavailable keeps its stored levels untouched. Legacy read materializes one binding without losing the old model ID; the subsequent write stores `config_json.models` and keeps `defaultModelId` equal to the first binding for older readers. An unknown or legacy `apiStyle` is treated as a compatibility input: the editor falls back to Chat Completions, remains usable, and repairs the stored value on save. Saving the default provider preserves `settings.defaultModelId` while the selected model remains configured; only removal of that model falls back to the first remaining binding. Editing another provider never changes the app default. A failed live probe degrades to the cached list, one classified toast sentence and a one-line pane label, never to a blank picker or a raw HTTP/JSON dump, and a catalog fallback is never written into the model cache. Deleting a configured model and saving forgets that model's cached parameters, so the pane no longer paints the deleted id from cache and a later re-add starts from what the service or the catalog says. A probe that no longer publishes a model drops its cached row the same way, unless the row is the user's own (a hand-typed id, a configured binding), and a save that moves the base URL or the API format drops the answer the previous endpoint produced.
- **Specs linked**: `03-runtime/11-provider-model-system.md`, `03-runtime/12-provider-config-schema.md`, `03-runtime/13-model-catalog-and-selection.md`, ADR 0114
- **Acceptance**: F (provider persistence and migration)
- **Milestone**: M2
- **Status**: Unit-covered host migration; manual UI journey

## E2E-MODELS-list-layout: Model lists remain browsable in constrained windows

- **Preconditions:** 60 discovered and configured models; isolated Electron
  fixture with real provider/account dialogs, hooks and production styles.
- **Steps:** Open both dialog types at 850×600, 850×850, 1000×560, 1200×700
  and 1600×1000 content sizes. Scroll each list to its last and first model.
- **Expected:** Every list displays at least one complete row. Both endpoints
  are fully visible inside the list, dialog body and viewport. Narrow panes
  stack; short wide windows keep the side-by-side layout.
- **Command:** `pnpm test:e2e:provider-model-layout`
- **Boundary:** Model-discovery IPC is a fixture; no real credentials or host
  persistence are involved. React, browser layout and scrolling are real.

## E2E-005K: Preserve explicit extended thinking levels on the wire

- **Preconditions**: A provider has a selected model binding with reasoning
  enabled and `xhigh`/`max` explicitly selected; the catalog omits or marks
  those adapter mappings as unsupported; a deterministic OpenAI-compatible
  capture fixture records request JSON.
- **Steps**: 1) Select `high`, `xhigh`, and `max` in separate turns. 2) Capture
  each request body at the fixture boundary.
- **Expected**: The three requests contain `reasoning_effort: "high"`,
  `reasoning_effort: "xhigh"`, and `reasoning_effort: "max"` respectively.
  The catalog's non-null wire mapping remains in force when one is published;
  an absent or null mapping for an explicitly enabled extended level does not
  silently downgrade it to `high`.
- **Specs linked**: `03-runtime/11-provider-model-system.md`,
  `03-runtime/12-provider-config-schema.md`,
  `03-runtime/13-model-catalog-and-selection.md`
- **Acceptance**: B (model configuration), F (runtime provider requests)
- **Milestone**: M2
- **Status**: Unit-covered; deterministic provider fixture pending

## E2E-005B: Configure the fixed OpenCode Go API-style preset

- **Preconditions**: App running; no OpenCode Go provider configured; the
  OpenCode Go endpoint is reachable with a test API key.
- **Steps**: 1) Open Settings → Model configuration and open the add-provider
  dialog. 2) Select **OpenCode Go** in Service. 3) Confirm Name and Base URL
  are not on the common path, enter an API key, and wait for model discovery.
  4) Select a discovered model and save the provider. 5) Reopen the provider
  and switch Service to Custom endpoint.
- **Expected**: Selecting the preset shows Service + API key, a host summary
  for `opencode.ai/zen/go/v1`, and focuses the API key field. Discovery
  requests `https://opencode.ai/zen/go/v1/models` with
  `Authorization: Bearer <key>`; the saved row persists
  `apiStyle: "opencode_go"` and the key is stored via the secret store.
  Reopening preserves the fixed identity. Switching to Custom endpoint reveals
  editable Name and Base URL.
- **Specs linked**: `03-runtime/11-provider-model-system.md`,
  `03-runtime/12-provider-config-schema.md`, `04-ux/06-settings-ia.md`,
  ADR 0116
- **Acceptance**: B (model configuration and key storage), Security
- **Milestone**: M2
- **Status**: Unit-covered (form and discovery contracts); rendered UI scenario Draft

## E2E-205: OpenCode Go requests carry a stable session header

- **Preconditions**: An OpenCode Go provider is configured; a deterministic
  fixture or capture proxy records outbound HTTP headers. A second generic
  OpenAI-compatible provider is also configured.
- **Steps**: 1) Start an Agent turn in a session against OpenCode Go. 2)
  Capture the provider request headers. 3) Send a follow-up in the same
  session. 4) Run a plugin `agent.complete` one-shot against the same provider.
  5) Run `/compact` in the same session and capture
  the summary request. 6) Repeat a turn against the generic
  OpenAI-compatible provider.
- **Expected**: Every OpenCode Go LLM request includes `x-opencode-session`
  equal to the conversation id (or a stable per-call id when no session
  exists), `x-opencode-client: pi-desktop`, and a `User-Agent` identifying
  PI-Desktop. Follow-up turns reuse the same session header, and so does the
  compaction summary request, which the harness would otherwise send with no
  headers at all. The generic OpenAI-compatible provider does not receive
  these headers. The gateway does
  not return `MissingSessionID`, and `/compact` does not fail with a 400.
- **Specs linked**: `03-runtime/02-agent-runtime.md`,
  `03-runtime/11-provider-model-system.md`,
  `03-runtime/12-provider-config-schema.md`, ADR 0116
- **Acceptance**: B (model configuration), F (runtime provider requests)
- **Milestone**: M2
- **Status**: Unit-covered (header merge, one-shot stream options, and the
  compaction summary request)

## E2E-005E: Provider and model wire API precedence stays explicit

- **Preconditions**: An OpenCode Go provider is configured; a deterministic
  fixture serves `muse-spark-1.3-contributor` on `/responses` and 500s it on
  `/chat/completions`. A generic provider and a custom endpoint each serve the
  same model id; the custom model metadata pins `openai-completions`, while its
  saved provider style is Responses.
- **Steps**: 1) Select the muse model on the OpenCode Go provider and send a
  turn. 2) Capture the outbound request path. 3) Repeat against the generic
  provider with the same model id. 4) Select the model on the custom endpoint
  and send a turn, then capture its outbound request path.
- **Expected**: The OpenCode Go turn posts to `/responses` (the model-level
  `api: "openai-responses"` pin wins); the generic turn still posts to
  `/chat/completions`; the custom endpoint posts to `/responses` because its
  saved provider style wins over the model metadata. Replayed history carries
  the resolved API.
- **Specs linked**: `03-runtime/11-provider-model-system.md`,
  `03-runtime/12-provider-config-schema.md`, ADR 0116
- **Acceptance**: F (runtime provider requests)
- **Milestone**: M2
- **Status**: Unit-covered (binding resolution and endpoint assertion)

## E2E-005K: OpenCode Go Claude models use the published Anthropic route

- **Preconditions**: An OpenCode Go provider uses the built-in preset. The
  deterministic catalog fixture contains `claude-haiku-5-5` with
  `api: "anthropic_messages"` and an OpenCode Anthropic root `baseUrl`, plus a
  DeepSeek Chat Completions control model.
- **Steps**: 1) Select Claude Haiku and send a text turn through a capture
  fixture. 2) Capture the request URL and adapter payload. 3) Repeat with the
  DeepSeek control model. 4) Repeat with the same catalog metadata on a custom
  OpenAI-compatible provider.
- **Expected**: OpenCode Claude uses the Anthropic adapter and posts to
  `/zen/go/v1/messages`; it does not post Chat Completions and does not return
  `ModelProtocolUnsupported`. DeepSeek keeps `/chat/completions`. The custom
  provider keeps its saved wire style and base URL despite the foreign catalog
  API. Unit coverage lives in `packages/agent-runtime/src/provider-binding.test.ts`.
- **Specs linked**: `03-runtime/11-provider-model-system.md`,
  `03-runtime/13-model-catalog-and-selection.md`, issue #1728
- **Acceptance**: F (runtime provider requests)
- **Milestone**: M2
- **Status**: Unit-covered; live endpoint scenario Draft

## E2E-005C: OpenAI-compatible system role fallback

- **Preconditions**: A deterministic OpenAI-compatible Chat Completions
  fixture exposes one reasoning-capable model and rejects `role: "developer"`
  in favor of `role: "system"`.
- **Steps**: 1) Configure the fixture provider and select its reasoning model.
  2) Start an Agent turn with a non-empty system prompt. 3) Capture the JSON
  request body at the fixture boundary. 4) Repeat with a model record that
  explicitly sets `compat.supportsDeveloperRole: true`.
- **Expected**: The first request contains the system prompt with
  `role: "system"` and the turn succeeds. The explicit model override changes
  only the second request to `role: "developer"`; the default remains
  model-scoped and does not affect other provider adapters.
- **Specs linked**: `03-runtime/11-provider-model-system.md`,
  `03-runtime/12-provider-config-schema.md`
- **Acceptance**: B (OpenAI-compatible provider interoperability)
- **Milestone**: M2
- **Status**: Unit-covered (including the #30 GLM gateway regression); deterministic provider fixture pending

## E2E-206: Anthropic Messages endpoint with a `/v1` base URL

- **Preconditions**: A deterministic Anthropic Messages fixture exposes
  `GET /v1/models` and `POST /v1/messages`; the configured custom endpoint ends
  in `/v1` and returns one model such as `glm-5.3`.
- **Steps**: 1) Open Settings → Model configuration and add a Custom endpoint.
  2) Enter the fixture URL ending in `/v1`, choose Anthropic Messages, and
  wait for model discovery. 3) Select the discovered model and save. 4) Start
  an Agent turn and capture the fixture request path.
- **Expected**: Discovery succeeds against `/v1/models`, and the Agent turn
  succeeds against `/v1/messages`. The runtime does not send the request to a
  doubled `/v1/v1/messages` path; a configured Anthropic root without `/v1`
  remains equivalent.
- **Specs linked**: `03-runtime/11-provider-model-system.md`,
  `03-runtime/12-provider-config-schema.md`
- **Acceptance**: B (custom provider interoperability), C (chat and stream)
- **Milestone**: M2
- **Status**: Unit-covered; deterministic provider fixture pending

## E2E-005F: Custom endpoint input guardrails

- **Preconditions**: App running; the add-provider dialog is open with Custom
  endpoint selected.
- **Steps**: 1) Enter `api.gateway.example.com` with no scheme and leave the
  Base URL field. 2) Confirm the field settles on
  `https://api.gateway.example.com` and discovery runs. 3) Paste
  `https://api.gateway.example.com/v1/messages` and leave the field. 4) Confirm
  the field settles on `https://api.gateway.example.com/v1`, the API format
  reads Anthropic Messages, and the form says that format was auto detected. 5)
  Change the API format by hand to OpenAI Chat Completions, then paste the
  `/v1/responses` URL: confirm the hand-picked format survives and the operation
  is left in place until the suggestion is applied. 6) Replace the value with
  `ftp://gateway.example.com`, then leave the field. 7) Enter a valid URL again
  and confirm model discovery can run; paste a full `/models` path and leave the
  field. 8) Point the row at a gateway whose `/models` route answers only under
  `/v1` and confirm the field and the saved row show that address.
- **Expected**: A bare host is completed with `https://` inside the origin the
  user typed; credentials, queries and fragments are still refused. A pasted
  operation path names the matching format, selects it and is stripped from the
  base endpoint, and `/models` is removed as well — unless the operation
  contradicts a format the user picked by hand, which is then preserved and
  offered as a suggestion instead. When the endpoint itself decided the format,
  the form says so next to the selector. When only the `/v1` candidate answers,
  the field and the saved row show that address rather than a hidden rewrite,
  and every probed candidate stays on the typed origin. A non-http(s) URL shows
  an inline, accessible error, does not start discovery, and keeps Save
  disabled. A valid URL restores discovery. The long URL field uses a full row
  on wide dialogs and stacks cleanly with the other credentials at the
  responsive breakpoint.
- **Specs linked**: `04-ux/06-settings-ia.md`,
  `03-runtime/12-provider-config-schema.md`
- **Acceptance**: B (custom provider configuration)
- **Milestone**: M2
- **Status**: Unit-covered; rendered UI scenario pending

## E2E-005G: Per-provider custom HTTP headers

- **Preconditions**: One API-key AI service (including an OpenCode Go row) and
  one signed-in vendor (OAuth) account; a capture proxy records outbound HTTP
  headers, including Codex and Anthropic adapters.
- **Steps**: 1) Open the AI service and click the upper-right Advanced settings
  action. Confirm a separate modal opens without changing the main form layout,
  and that its header close action is the only close control (no footer action
  row). Use the common-header preset to add User-Agent, then import a JSON object
  containing `X-Gateway: alpha` and enough headers to exceed five visible rows.
  Copy headers as JSON and confirm the clipboard is the pretty-printed persisted
  record (blank names omitted, last write wins) with localized success feedback.
  Confirm the header list scrolls inside the modal while the underlying model
  panes keep their working area, close the modal, then save. 2) Start an Agent
  turn, a follow-up, a plugin `agent.complete` one-shot, and the standalone
  plugin's Composer transform when installed. 3) Refresh
  `/models` from the form before saving a second change and confirm the
  unsaved headers are sent. 4) Clear the rows and save; confirm adapter
  defaults return. 5) Edit the OAuth account Advanced headers, save, then
  run a turn that refreshes the access token. 6) Repeat against OpenCode Go
  and confirm `x-opencode-session` is still present. 7) Repeat against
  Codex/Anthropic OAuth inference. 8) Enter a value holding fullwidth
  characters (`０`, `１２３`) and confirm the editor says it will be saved as
  half-width, then save and reopen: the stored value is ASCII. 9) Enter a value
  holding Han text or a NUL and confirm the editor warns before saving, then
  save: it is rejected as `HEADERS_INVALID` with the character and its index
  named. 10) Point the app at a store whose row was written before this rule and
  run a turn. 11) Attempt `Authorization` and CR/LF values; save is rejected.
- **Expected**: Non-empty custom headers are the last writer on that row's
  outbound HTTP (turns, subagents, one-shots, discovery, connection test,
  OAuth refresh). Empty restores pi-ai / `claude-cli` / OpenCode defaults.
  Advanced keeps up to five header rows visible and scrolls additional rows in its
  own bounded area, so they do not compress or hide the model panes. Escape and outside-click close
  only the Advanced modal while it is open. The preset adds the expected
  User-Agent value, Copy JSON serializes the same `pairsToRecord` map saved on
  the row, JSON import accepts both supported object shapes, and
  case-insensitive duplicate keys are merged rather than duplicated.
  Toolbar actions wrap at the narrow dialog breakpoint instead of overflowing.
  OpenCode still sends
  `x-opencode-session` and `x-opencode-client`. Codex
  and Anthropic still send the custom User-Agent despite adapter last-writes.
  First OAuth login does not collect headers. A fullwidth value saves as
  half-width and is folded again on read, so a row stored before this rule runs
  a turn instead of throwing. A value holding Han text or a control character is
  refused at save with the character and index named, and dropped by the runtime
  rather than thrown by `Headers.set`. Reserved keys and CR/LF are
  rejected. Advanced is a compact key/value editor, not a lone User-Agent
  field.
- **Specs linked**: `03-runtime/12-provider-config-schema.md`,
  `03-runtime/11-provider-model-system.md`, `03-runtime/02-agent-runtime.md`,
  `04-ux/06-settings-ia.md`, ADR 0178
- **Acceptance**: B (model configuration), F (runtime provider requests)
- **Milestone**: M2
- **Status**: Unit-covered (host persistence, fetch wrapper, discovery,
  form Advanced); rendered UI scenario pending

## E2E-005J: GitHub Copilot OAuth requests carry native IDE headers

- **Preconditions**: A signed-in GitHub Copilot OAuth account with a selected
  model; a deterministic capture proxy records the model request headers.
- **Steps**: 1) Start an Agent turn against the account and capture the request
  headers. 2) Send a follow-up after the assistant response and capture the
  next request. 3) Repeat with an image attachment when the selected model
  supports vision. 4) Set a saved custom header with the same name as one of
  the Copilot defaults and send another turn. 5) Select a Claude model on the
  same account (Anthropic Messages) and send a turn, capturing its auth and
  identity headers.
- **Expected**: Every Copilot model request includes the pinned pi-ai
  transport identity headers `Editor-Version`, `Editor-Plugin-Version`, and
  `Copilot-Integration-Id`. `X-Initiator` is `user` for a user-led request and
  `agent` for a continuation; `Openai-Intent` is `conversation-edits`, and
  image requests include `Copilot-Vision-Request: true`. The OAuth row keeps
  its local provider id for account binding, and a saved custom header remains
  the final override. Claude requests carry `Authorization: Bearer <Copilot token>`
  and no `X-Api-Key`, while retaining the same IDE identity and context headers.
- **Specs linked**: `03-runtime/11-provider-model-system.md`,
  `03-runtime/12-provider-config-schema.md`, ADR 0095
- **Acceptance**: B (model configuration), F (runtime provider requests)
- **Milestone**: M2
- **Status**: Unit-covered (row-scoped model headers and request-context
  headers, Anthropic Messages Bearer auth and rotating tokens); live Copilot
  account journey pending

## E2E-005H: Select every visible model from a long service list

- **Preconditions**: App running; the add-provider or edit-provider dialog is
  open against a service (or vendor account) that returns a long model list,
  including at least one model whose id would not match a later search.
- **Steps**: 1) Wait until the left pane lists the service's models. Confirm
  the list header shows a checkbox beside the pane title, unchecked while no
  rows are chosen. 2) Tick that header checkbox. Confirm every listed row is
  checked and the right pane lists a chosen binding for each, keeping any
  already-configured advanced overrides. 3) Untick one row, then confirm the
  header checkbox is indeterminate. Tick it again and confirm the remaining
  visible rows are chosen without duplicating already-chosen ones. 4) Type a
  filter that matches a subset. Untick the header checkbox and confirm only
  the matching chosen rows disappear; a model hidden by the filter stays on
  the right. 5) Tick the header checkbox again and confirm only the matching
  rows are added back. Clear the filter and confirm the previously hidden
  chosen model is still present. 6) Save.
- **Expected**: One header checkbox selects or clears the currently visible
  list. A search filter narrows which rows "all" means. Models already chosen
  outside the filter stay chosen. Newly added rows adopt published limits and
  thinking levels; existing bindings are not rebuilt. The same control is
  present in the vendor-account editor because both dialogs render the shared
  picker.
- **Specs linked**: `03-runtime/13-model-catalog-and-selection.md`,
  `04-ux/06-settings-ia.md`, `04-ux/08-component-spec.md`
- **Acceptance**: B (multi-model provider configuration)
- **Milestone**: M2
- **Status**: Unit-covered (shared picker source contract); rendered UI
  scenario pending

## E2E-005I: Fetch the service model list from the picker header

- **Preconditions**: The add-provider or edit-provider dialog is open against a
  reachable service (or vendor account) that publishes a `/models` list.
- **Steps**: 1) Confirm the left-pane header shows a Fetch list action beside
  the title, disabled before a valid endpoint is ready. 2) Enter a valid
  endpoint. Confirm Fetch list enables during the 600 ms debounce wait. Click
  it immediately; confirm it does not wait for that window, shows the loading
  label while the probe is in flight, and then shows rows. 3) Click Fetch list
  again. Confirm it keeps the current rows on screen and replaces them with the
  live answer. 4) Take the service offline and click Fetch list; confirm the
  classified error reaches the toast and the previous rows remain. 5) Restore the
  service, click Fetch list, and confirm the live list returns. 6) Repeat in
  the vendor-account editor.
- **Expected**: The header action probes the service immediately, including
  during the edit debounce after a URL becomes valid. Automatic discovery on
  credential edits is unchanged. The same control is present for both
  credential kinds because both dialogs render the shared picker.
- **Revocation regression**: Configure two served models, revoke one upstream,
  add another, then Fetch list. The left service pane shows the current served
  pair, including when the revoked ID has a published catalog record. The right
  chosen pane retains both saved bindings and their overrides; refresh does not
  delete configuration. A manual/offline fallback still exposes configured IDs.
- **Specs linked**: `03-runtime/13-model-catalog-and-selection.md`,
  `04-ux/06-settings-ia.md`, `04-ux/08-component-spec.md`
- **Acceptance**: B (multi-model provider configuration)
- **Milestone**: M2
- **Status**: Unit-covered (discovery hook + picker source contract); rendered
  UI scenario pending

## E2E-005D: Configure a Zhipu / Z.AI named endpoint preset

- **Preconditions**: App running; no Zhipu provider configured; the models.dev
  snapshot ships with `zhipuai`, `zhipuai-coding-plan`, `zai`, and
  `zai-coding-plan`.
- **Steps**: 1) Open Settings → Model configuration and open the add-provider
  dialog. 2) Open Service, type to filter, and select **Zhipu AI Coding Plan**.
  Confirm model discovery does not start until an API key is entered. 3) Confirm
  the common path is Service + API key with a host summary, enter an API key,
  and wait for model discovery. 4) Select a discovered model and save. 5) Reopen the
  provider, switch Service to **Z.AI**, then to **Custom endpoint**.
- **Expected**: Coding Plan shows Service + API key, a host summary for
  `open.bigmodel.cn/api/coding/paas/v4`, and focuses the API key field. Name
  and API format are not on the common path. The saved row persists
  `vendorKey: "zhipuai-coding-plan"`, `apiStyle: "chat_completions"`, and the
  exact Coding Plan URL. Switching to Z.AI replaces the host summary with
  `api.z.ai/api/paas/v4` and `vendorKey: "zai"`. Switching to Custom endpoint
  reveals editable Name and Base URL without a stepper or vendor-card grid.
  A later Agent turn against a Zhipu URL sends Completions with Zhipu thinking
  (`thinkingFormat: "zai"`) rather than the OpenAI `developer` role.
- **Specs linked**: `03-runtime/11-provider-model-system.md`,
  `03-runtime/12-provider-config-schema.md`, `04-ux/06-settings-ia.md`,
  ADR 0155
- **Acceptance**: B (model configuration and key storage)
- **Milestone**: M2
- **Status**: Unit-covered (preset matching, catalog aliases, Completions
  compat); rendered UI scenario Draft

## E2E-248: Responses turn completes without waiting for the server to close the connection

- **Preconditions**: A provider whose model pins `api: "openai-responses"` (or
  a provider with `apiStyle: "responses"`) is configured; the endpoint is
  fronted by a proxy that holds the HTTP connection open after the final
  SSE event (a local reverse proxy or a stub server that never sends FIN).
- **Steps**: 1) Start a session with that model and send a short prompt. 2)
  Capture the SSE frames and confirm the server emitted
  `response.completed` with `status: "completed"` and usage. 3) Keep the
  stub/proxy connection open without sending a TCP FIN. 4) Observe the
  assistant turn state and send a follow-up prompt.
- **Expected**: The turn completes as soon as `response.completed` is
  finalized: usage is recorded, `stopReason` is `stop`, and the client stops
  consuming the stream (the underlying request is aborted) instead of
  blocking on the idle connection. The composer becomes idle immediately and
  the follow-up turn starts normally. The stream must not hang when the
  server never closes the connection.
- **Specs linked**: `03-runtime/11-provider-model-system.md` (§16.1)
- **Acceptance**: B (provider Responses compatibility)
- **Milestone**: M2
- **Status**: Unit-covered (stream processor terminates on the terminal
  event via the pi-ai patch); live-proxy scenario Draft

## E2E-PROVIDER-responses-explicit-nonstrict

- Complete a turn, then switch the same conversation to a custom Responses
  model using default compatibility. Ask to update an existing weekly task
  for two distinct weekdays. Activate `ScheduledTaskUpdate` via `ToolSearch`.
- Verify the new request replays the prior turn. The activated function
  declaration carries explicit `strict: false` and retains the weekday
  uniqueness constraint. The runtime sends one update to the Host, replays
  the result to the provider, and returns the assistant confirmation.
- Run `node scripts/e2e-responses-tool-strictness.mjs <built sidecar.js>`
  against the production sidecar bundle with a loopback provider and a fixture
  Host. The runtime regression also covers current and replayed declarations,
  strict-capable adapters, and local rejection of duplicate weekdays.
- Spec: [Responses function tool strictness](../../03-runtime/11-provider-model-system.md#162-responses-function-tool-strictness).

## E2E-005E: DeepSeek thinking replay includes reasoning_content on aggregator endpoints

- **Preconditions**: An OpenAI-compatible provider whose base URL is not
  `deepseek.com` is configured with a DeepSeek-family model id (for example
  SiliconFlow `deepseek-ai/DeepSeek-V3.2`) and thinking enabled.
- **Steps**: 1) Start a session in thinking mode. 2) Complete several turns
  including at least one assistant reply that produces no thinking text.
  3) Send another prompt so the history is replayed to the provider.
- **Expected**: The later Completions request includes a reasoning field on
  every assistant message. Official `api.deepseek.com` rows may use `""` for
  turns that had no thinking. Non-official DeepSeek-family relays use real
  retained thinking when available, otherwise the documented non-empty
  placeholder from ADR 0256 — never a silent empty string after compaction.
  Each assistant message carries exactly one reasoning field, named after the
  newest assistant row's field; real reasoning stored under another field name
  is moved there rather than replaced by the placeholder, which only fills rows
  with no reasoning at all (D677). The thinking panel and replayed history
  never show a leading echo of the placeholder as reasoning.
  Relay requests omit the generic OpenAI `reasoning_effort` field because
  relays were reported rejecting it (#1664). Official `api.deepseek.com`
  requests send `thinking: {type: "enabled"}` together with the selected
  `reasoning_effort` (#1821).
  The request does not switch `thinkingFormat` to `"deepseek"` solely because
  the model id contains `"deepseek"`. Official `api.deepseek.com` rows keep
  URL-based DeepSeek `thinkingFormat` from pi-ai.
- **Specs linked**: `03-runtime/11-provider-model-system.md`,
  `03-runtime/12-provider-config-schema.md`
- **Acceptance**: B (provider Completions compatibility)
- **Milestone**: M2
- **Status**: Unit-covered (compat inject + convertMessages empty/non-empty fill +
  mixed-field normalization + echoed-placeholder strip + compaction
  retained-reasoning wire proof); live OpenCode / aggregator
  verification deferred; rendered UI scenario pending

## E2E-006: Key survives restart

- **Preconditions**: Provider + key configured.
- **Steps**: 1) Quit app. 2) Relaunch. 3) Open Settings → Agent → Providers.
- **Expected**: Provider still listed; key usable (no re-entry needed).
- **Specs linked**: `03-runtime/14-secrets-storage.md`
- **Acceptance**: B (key survives restart)
- **Milestone**: M2
- **Status**: Draft

## E2E-007: No-provider blocking prompt

- **Preconditions**: App running; no provider configured.
- **Steps**: 1) Attempt to start a chat.
- **Expected**: Clear blocking prompt explaining that a provider must be configured.
- **Specs linked**: `04-ux/06-settings-ia.md`
- **Acceptance**: B (blocking prompt)
- **Milestone**: M2
- **Status**: Draft

## E2E-050: Composer model × reasoning menu follows exact capability

- **Preconditions**: One catalogued reasoning model, one non-reasoning model,
  and one unknown free-form model id.
- **Steps**: 1) Open the Composer model × reasoning chip. 2) Confirm the root
  contains the model list plus a segmented reasoning control in the footer
  with one labeled column per supported level; confirm every level keeps a
  visible label, each centered in its column. 3) Drag and click the control
  across multiple supported levels and click a label, confirming the chip
  updates while the menu stays open and the raised pill sits under the
  selected label. 4) Open Model, search for a model, and select a
  model from a provider group; confirm the menu remains open at the root.
  5) Open Reasoning level and choose a level from the radio list. 6) Repeat
  with a non-reasoning provider and an unknown free-form model id; exercise
  Escape, outside click, Up/Down, Enter, Left, and the slider's arrow keys.
  In both roomy and crowded toolbars, switch `omit`, `low`, `high`, `max`,
  and `off` without closing the menu: its horizontal position stays stable,
  and the trigger stays inside its slot, including with a long model name.
  Moving the anchor and dispatching a viewport resize must reposition the
  menu without an event-target type error. Automated geometry coverage:
  `node scripts/e2e-composer-thinking-layout.mjs` (isolated Electron fixture,
  production React picker and compiled styles; no live providers).
  Repeat native mouse press/release to open, select the first and subsequent
  reasoning levels, close, and reopen three times with motion enabled. The
  menu must retain its opening position on every selection; synthetic DOM
  `click()` alone does not exercise the trigger's `:active` transition.
  Hover each dot and its label: the corresponding label highlights. Unfilled
  dots brighten and enlarge slightly; filled dots and the selected thumb stay unchanged
  without shifting the menu. Move outside: the preview clears and the selected
  value remains unchanged. Reduced motion disables hover transitions.
  Click a non-adjacent level and verify the thumb travels through intermediate
  positions while the selected value already equals the target. Interrupt
  travel with another click; the thumb retargets without jumping to the old
  start, and only the clicked levels are submitted. Check save failure,
  stale completion, remount, and 3/5/7/8-stop alignment. At each stop, verify
  the fill covers the first dot's left edge and still ends at the thumb center.
  Native range dragging
  follows immediately; arrow keys retain focus and update the selection.
  With reduced motion enabled, the target is shown without a transition.
- **Expected**: The chip is in the right toolbar with a Bot icon; any
  explicitly installed plugin text actions appear after it and before
  Send/Abort. The host has no built-in prompt-enhancement action. Off omits the
  level text. The single anchored menu replaces its root
  with an in-place back row and submenu, never opens tabs or a second popover,
  and always reopens at the root. Model search filters sticky provider groups;
  reasoning levels come from `omit` then the selected model binding's enabled
  levels in canonical order. The root carries a drag slider with one labeled
  stop per level directly beneath the Reasoning level entry when more than
  one level is listed (a single-level binding hides the slider). Dragging
  across several stops persists only the last pending level; tick labels are
  not tab stops. Slider and tick commits update the chip immediately while
  the menu stays at the root. The Reasoning level entry opens the radio list,
  which uses radio semantics, a trailing check, and the current model support
  note. Selecting either value immediately updates the chip and root value,
  clears model filtering, and keeps the menu open. A
  non-reasoning or unknown model starts at `off`, but an explicit Settings
  binding can make its configured levels available; discovery never promotes it
  automatically. Refreshing discovered model data cannot overwrite the binding.
  Before the first message creates a session, the Composer uses the
  exact model selected in its model menu rather than the provider's default
  model; after materialization, the same exact-model capability remains in
  effect.
- **Specs linked**: `03-runtime/11-provider-model-system.md`,
  `03-runtime/12-provider-config-schema.md`,
  `03-runtime/13-model-catalog-and-selection.md`, ADR 0018, ADR 0027
- **Acceptance**: B (model config), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`thinking-ui.test.mjs`, `composer-model-thinking-menu.test.mjs`, `thinking-commit-queue.test.mjs`, agent-runtime capability tests); full UI scenario Draft

## E2E-051: Thinking level persists with the session

- **Preconditions**: A reasoning-capable session is idle.
- **Steps**: 1) Select `high`. 2) Change Plan/Goal/Agent mode without changing the
  thinking level. 3) Restart the app and reopen the session. 4) Switch to
  another session and back.
- **Expected**: Every configuration update sends the complete session config;
  `high` survives the permission-mode change, session switches, host reload, and
  app restart.
  A v2 database migrates the same field to `off` without transcript loss.
- **Specs linked**: `03-runtime/04-data-storage.md`,
  `03-runtime/06-host-rpc-protocol.md`, `04-ux/08-component-spec.md`, ADR 0018
- **Acceptance**: F (persistence)
- **Milestone**: M5
- **Status**: Unit-covered (host schema/session tests, `thinking-ui.test.mjs`); full restart scenario Draft

## E2E-052: Thinking level reaches the pi request

- **Preconditions**: Instrumented reasoning-capable provider with a sparse
  level set and request capture; one session configured above and below gaps.
- **Steps**: 1) Select each enabled level and run a prompt. 2) Seed an
  explicit binding level the catalog does not publish and run again. 3) Repeat
  with a pi-catalogued non-reasoning model, first with no enabled level and then
  after an explicit Settings opt-in.
- **Expected**: Main resolves capability using the session's actual model id;
  Composer, main, sidecar, and pi use the same upward-first/downward-second
  clamp over the binding's enabled set, without intersecting it with the
  catalog. Pi receives the effective level, an empty or `off`-only binding
  receives `off`, and an explicitly opted-in endpoint receives the configured
  level. Model-specific request semantics, including adaptive thinking and
  whether `off` is expressible, match the pinned pi record without a desktop
  rewrite.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `03-runtime/02-agent-runtime.md`, `03-runtime/13-model-catalog-and-selection.md`, ADR 0018, ADR 0027
- **Acceptance**: B (model config), C (chat and stream)
- **Milestone**: M5
- **Status**: Unit-covered (agent-runtime prompt/clamp tests); integration scenario Draft

## E2E-053: Thinking streams separately from the answer

- **Preconditions**: Provider emits thinking deltas before and between answer
  deltas.
- **Steps**: 1) Start a turn in both light and dark themes. 2) Observe a
  thinking-only phase. 3) Let the answer complete. 4) Toggle the disclosure,
  test keyboard focus, enable reduced motion, and use Copy answer.
- **Expected**: The transcript opens during thinking-only streaming; the latest
  Thinking disclosure opens and updates without an empty answer bubble or
  duplicate Working indicator. If the user collapses or expands it, that choice
  remains authoritative through later thinking deltas and completion. The
  disclosure uses the transcript surface, theme tokens, a Sparkles/chevron
  trigger, and a left rule instead of an inset card; collapsed content leaves
  focus traversal and reduced motion disables the running marker pulse and
  transitions. Final answer markdown renders separately; Copy answer contains
  no thinking text.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `04-ux/07-ui-design-system.md`, `04-ux/08-component-spec.md`, ADR 0018
- **Acceptance**: C (chat and stream), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`thinking-ui.test.mjs`, agent-runtime event tests); full streaming scenario Draft

## E2E-054: Stored thinking reloads losslessly

- **Preconditions**: A completed assistant message contains both reasoning and
  final answer blocks; another contains reasoning only.
- **Steps**: 1) Complete both turns. 2) Restart the host/app. 3) Reopen the
  session. 4) inspect search results and answer copy.
- **Expected**: Host returns the same separate `thinking` and `content`
  values after reload/import/replace round-trips; both messages remain
  visible; search and answer copy exclude reasoning.
- **Specs linked**: `03-runtime/04-data-storage.md`,
  `03-runtime/06-host-rpc-protocol.md`, `04-ux/08-component-spec.md`, ADR 0018
- **Acceptance**: C (chat and stream), F (persistence)
- **Milestone**: M5
- **Status**: Unit-covered (host message/import tests, `thinking-ui.test.mjs`); full reload scenario Draft

## E2E-055: Unsupported provider transition clamps safely

- **Preconditions**: Session on a reasoning provider at `max`; target
  providers include non-reasoning and sparse-level variants.
- **Steps**: 1) Switch to the non-reasoning provider. 2) Run a turn. 3) Switch
  to sparse variants around the previous level. 4) send malformed/legacy
  payloads lacking capability or thinking fields.
- **Expected**: Non-reasoning persists and sends `off`; sparse variants choose
  the same nearest level everywhere; missing fields fall back safely;
  malformed thinking is not rendered and never contaminates answer content.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `03-runtime/13-model-catalog-and-selection.md`, `04-ux/08-component-spec.md`, ADR 0018
- **Acceptance**: B (model config), C (chat and stream), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`thinking-ui.test.mjs`, host validation tests); full UI scenario Draft

## E2E-066: Provider model catalog survives restart and offline refresh

- **Preconditions**: A saved provider matches a models.dev provider/API URL and
  has at least two catalog models; a deterministic fixture can make
  `https://models.dev/api.json` unavailable and can also make a provider
  discovery endpoint unavailable.
- **Steps**: 1) Open the provider model picker and confirm models.dev model
  names, limits, capability badges, and source label appear. 2) Inspect the
  network fixture and confirm the provider API key is never sent to models.dev.
  3) Quit and restart the app. 4) Disconnect models.dev and the provider
  endpoint. 5) Open the Composer model menu and wait for refresh fallback.
  6) Reconnect only the provider endpoint with one custom model, then reopen
  the picker. 7) Warm lookups for a known and an unknown model, then refresh
  the catalog fixture with changed metadata and the previously unknown model.
  8) Repeat after making that catalog refresh fail.
- **Expected**: The first picker open renders the configured/provider cache
  without starting from an empty list. On restart, the bundled models.dev
  release snapshot is used without network access. A failed Settings refresh
  preserves that in-memory snapshot; a custom provider then falls back to its
  endpoint only for IDs absent from models.dev and finally the configured
  bindings. Offline refresh preserves every cached/configured entry. A
  successful provider discovery may persist normalized IDs to Rust-owned SQLite,
  but it cannot replace models.dev metadata or user-defined bindings.
  A successful catalog refresh replaces both cached matches and cached misses;
  a failed refresh keeps the previous results. Editing a model binding or
  changing the default provider/model takes effect without restarting the app.
- **Specs linked**: `03-runtime/04-data-storage.md`,
  `03-runtime/12-provider-config-schema.md`,
  `03-runtime/13-model-catalog-and-selection.md`, `04-ux/08-component-spec.md`
- **Acceptance**: B (model config), F (persistence), Quality, Security
- **Milestone**: M5
- **Status**: Unit-covered (`providers::tests`, `model-cache.test.mjs`,
  `models-dev-catalog.test.mjs`); full restart/offline UI scenario Draft

## E2E-080: Models.dev metadata and generic unknown models

- **Preconditions**: A provider/model exists in the models.dev fixture with
  limits, modalities, and reasoning options. A second fixture contains a
  provider-discovered model ID absent from models.dev.
- **Steps**: 1) Open the provider model picker and select the fixture model.
  2) Confirm its models.dev name, context/output limits, capability badges,
  modalities, cost fields, and thinking levels. 3) Start a short turn and
  inspect the sidecar model snapshot/request metadata. 4) Use Settings → Model
  configuration to force a models.dev refresh and confirm the new record is
  visible without changing the bundled file or writing a user cache. 5) Repeat
  with an ID absent from models.dev and confirm its limits display as unknown
  in Settings. 6) Open the picker at a wide but short
  viewport (1254 × 772 CSS px): confirm the model panes remain side by side,
  both lists scroll inside their panes, and a selected model's Advanced fields
  are reachable. Narrow the viewport to 520 × 480 CSS px and confirm the panes
  stack while both lists and Advanced remain reachable.
- **Expected**: The matching models.dev record is authoritative, including its
  `limit`, `modalities`, `reasoning_options`, `tool_call`,
  `structured_output`, dates, and cost fields; no provider secret is sent to
  the catalog. Vendor-prefixed records match providers whose configured model
  ID omits the prefix when the vendor/API identity is unambiguous. A PDF-capable
  model shows PDF in its modality metadata; PDF attachments remain bounded file
  references until the selected transport exposes a native PDF block. A
  provider-discovered or explicitly configured ID absent from models.dev remains
  runnable with the generic text-only, non-reasoning shape; Settings shows an
  em dash instead of presenting its 128k / 8.2k runtime fallback as a published
  model limit. Explicit user limits remain visible. pi-ai supplies only
  the selected wire adapter, OAuth flow, and fallback account IDs. The custom
  endpoint keeps its selected API style even if the published model adapter
  differs; named providers may retain a model-level route when required. A
  ChatGPT Plus/Pro or GitHub Copilot account lists IDs returned by its live
  account endpoint; matching models.dev records supply their published metadata, while
  live-only IDs absent from models.dev keep generic chat limits and capabilities.
- **Specs linked**: `02-architecture/02-tech-stack.md`,
  `03-runtime/11-provider-model-system.md`,
  `03-runtime/13-model-catalog-and-selection.md`, ADR `models-dev-catalog-authority`
- **Acceptance**: B (model config), C (conversation & stream), Security
- **Milestone**: M5
- **Status**: Unit-covered (`model-capabilities.test.ts`,
  `models-dev-catalog.test.mjs`); full UI scenario Draft

## E2E-082: New reasoning session defaults to the binding thinking level

- **Preconditions**: The app default provider/model resolves as reasoning-capable
  and publishes a sparse thinking-level set with a stored binding default that
  is not the strongest enabled level; a second default model is non-reasoning.
- **Steps**:
  1. Set the reasoning-capable model as the app default and create a new session.
  2. Inspect the Composer model × reasoning chip and the session configuration
     sent to the host.
  3. Select a lower level or Off, leave the session, and reopen it.
  4. Set the non-reasoning model as default and create another new session.
- **Expected**:
  - The first new session persists and displays the binding's stored default
    thinking level, clamped onto the enabled set, even when the provider returns
    its sparse levels out of order. It does not jump to the strongest enabled
    level merely because the model supports reasoning.
  - Reopening the first session preserves the user's later explicit selection.
  - The non-reasoning session starts at `off`; its combined chip keeps the Bot
    icon, omits level text, and its reasoning submenu exposes only Off. Missing
    capability metadata also falls back to `off`.
- **Specs linked**: `03-runtime/13-model-catalog-and-selection.md`,
  `04-ux/08-component-spec.md`, ADR 0018, D303
- **Acceptance**: B (model config), F (persistence), Quality
- **Milestone**: M5
- **Status**: Partially automated (`thinking-levels.test.ts`,
  `thinking-ui.test.mjs`); full UI scenario Draft

## E2E-084: Long tool loop compacts before the provider context limit

- **Preconditions**: Provider configured with known pi-ai context/output
  limits; a fixture can produce repeated tool turns and large capped tool
  results without finishing the agent run. Automatic protection is always on
  and has no settings.
- **Steps**:
  1. Start one agent task whose tool loop grows past the hard budget.
  2. Let at least three `turn_end` events occur before `agent_end`; observe the
     composer/session controls, processing rows, transcript, and toasts.
  3. Continue until a checkpoint is installed, then allow the task to finish.
  4. Send further prompts until a second checkpoint is installed.
  5. Repeat the hard-boundary turn with multiple parallel capped tool results in
     the compacted range.
  6. Restart the app, reopen the session, and send a follow-up that depends on
     summarized old work while verifying that completed prompts are not replayed
     as naked historical user messages.
  7. Repeat with a provider fixture that returns Bedrock's
     `prompt is too long: N tokens > M maximum` once.
  8. Run a turn where the model calls `new_context` well below the hard budget.
  9. Invoke `/compact` manually while idle.
  10. Use a saved non-OAuth Responses endpoint whose catalog-owned window is
      1,050,000, whose discovery record reports 500,000, and whose output cap
      is 128,000. Report 400,000 occupied tokens and submit a follow-up.
- **Expected**:
  - The summary request of every checkpoint carries the session's own
    conversation identity: on the Responses-shaped providers
    (`openai-responses`, `openai-codex-responses`) the outgoing payload keeps
    the session id as `prompt_cache_key`, exactly as the session's turns do, so
    a gateway fronting a Codex backend accepts it instead of answering 400
    `invalid_responses_request`. A provider on another wire API, or on a
    published vendor host, is unchanged; an unrecognized endpoint on Chat
    Completions gains the key for the reason
    `E2E-PROVIDER-custom-endpoint-session-identity` records.
  - Each `turn_end` is evaluated before another provider request and never
    marks the overall task idle; composer/config controls remain blocked until
    `agent_end`, `error`, or manual-only `compaction_end`. In-run follow-up
    assistant turns compact through `prepareNextTurn` (pi 0.84.4+ skips that
    hook on a terminating turn); a new user prompt still compacts before its
    first provider request.
  - In step 10, the main session launches with a 500,000-token window and
    installs a checkpoint before the follow-up request. A smaller manual
    window still applies, and missing or unlisted discovery falls back to
    the existing catalog or binding.
  - Every successful compaction adds exactly one divider row to the transcript,
    positioned immediately after the last message that checkpoint covers, and
    raises exactly one warning toast. Two checkpoints produce two rows, in
    order, and neither row replaces or hides a message.
  - Once a checkpoint is installed, including the manual `/compact` in step 9,
    the composer context ring drops to the checkpoint's estimated next-request
    size without waiting for another turn; the provider usage rows in its
    panel still describe the last real request. The next request's reported
    usage replaces the estimate, and reopening the session after a restart
    shows the same estimate. Repeat after a failed or stopped reply that
    reported usage. Its tokens remain in the provider breakdown while the ring
    shows the new checkpoint estimate (#2015, #2410; unit coverage in
    `apps/desktop/test/compaction-context-usage.test.mjs`).
  - The `new_context` call appears as a normal tool activity row, returns
    immediately, and the checkpoint is created at the following turn boundary
    rather than mid-turn.
  - Opening the context usage inspector after a checkpoint shows one line with
    the compaction count and the newest summary's token estimate; before any
    checkpoint that line is absent.
  - The context usage indicator exposes the same localized remaining-context
    summary on hover and keyboard focus, and its tooltip remains visible above
    the home/docked composer without clipping.
  - At the hard boundary a durable checkpoint is created before the next model
    request. The complete visible transcript is unchanged, and the continued
    task stays below the model-aware safe budget.
  - After a checkpoint the next provider request contains no assistant or tool
    message from before the boundary — only the summary and, while an active
    turn continues, its latest user message, which may carry the
    checkpoint-truncation marker. A completed-turn checkpoint has an empty
    retained tail. The request contains no tool call without its result, and
    expanding the original transcript rows still shows their complete
    persisted results.
  - A successful active-turn checkpoint with one retained request and no
    reasoning to replay sends that request before the nonempty summary. Any
    newer user message follows the summary (issue #2512).
  - Restart restores the summary and the recorded active/completed retention
    mode, and every earlier compaction row is still drawn. A regenerate/fork
    before a checkpoint boundary drops that record specifically; records
    anchored on surviving messages are preserved/remapped.
  - The exact provider overflow removes only the failed assistant from model
    context, keeps the visible assistant bubble in a running state while
    compaction/retry is pending, retries once after compaction, and does not
    loop on a second overflow. A recoverable first overflow emits no terminal
    error message or `error` event; only a failed retry (or failed compaction)
    closes the bubble with `CONTEXT_TOO_LARGE` / the actual terminal error.
  - If a retryable provider stream failure arrives after compaction has already
    replaced the failed assistant with a summary or retained user message, the
    retry keeps that current compacted transcript and calls `continue()`; it
    does not surface the missing-assistant guard error (issue #1768).
  - If automatic summary generation fails, a durable retained-tail fallback
    checkpoint is appended, the run stays active, and one warning explains
    that older model context was reduced; the transcript row for that
    checkpoint reads "summary generation failed · recent context retained",
    never `summary ≈N tokens` (ADR 0282). Before that fallback, the summary
    request retries transient provider failures up to three times with
    2s/4s/8s backoff, Stop cancels the backoff, deterministic failures do not
    retry, and an input whose serialized prompt exceeds the window is sent
    once more with tool results cut to a short prefix rather than skipping the
    model. If fallback persistence or the safe budget guard fails,
    `CONTEXT_COMPACTION_FAILED` is emitted once.
    The fallback's recovery notice precedes the retained window even when it
    contains only the active request.
  - If the newest checkpoint is already the transcript leaf when a follow-up
    prompt crosses the hard budget, the runtime rebuilds a smaller tail from
    the full transcript and carries the existing summary forward instead of
    reporting that there is no new context to compact.
  - The budget reminders appear at most once each per checkpoint window, never
    in the transcript, and never in a persisted system prompt. On a model
    without mid-conversation system messages (for example a local OpenAI
    compatible endpoint) the leading system message of the request that carries
    a reminder is byte-identical to the previous request's, so the provider's
    prefix cache stays warm.
  - Idle `/compact` succeeds and shows its own informational toast on top of the
    compaction warning, because the user asked for it. Compaction failures
    surface once through `CONTEXT_COMPACTION_FAILED` without duplicate error
    toasts.
  - Settings contains no context-management card and Settings search returns no
    compaction rows.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `03-runtime/02-agent-runtime.md`, `03-runtime/03-tools-and-permissions.md`,
  `03-runtime/04-data-storage.md`, `03-runtime/06-host-rpc-protocol.md`,
  `04-ux/06-settings-ia.md`, `04-ux/08-component-spec.md`,
  `04-ux/09-interaction-patterns.md`, ADR 0030, ADR 0049, ADR 0061, ADR 0064,
  ADR 0136, D158, D203, D275
- **Acceptance**: C (chat/stream), F (persistence), Quality
- **Milestone**: M5
- **Status**: Partially automated (`runtime.test.ts`,
  `context-compaction.test.mjs`, `assistant-turns.test.mjs`, host-core
  transcript/session unit tests); full provider/UI journey Draft

## E2E-PROVIDER-custom-endpoint-session-identity: A self-hosted endpoint receives the session id

- **Preconditions**: Two independent sessions, each with several turns, bound to
  a provider row whose API style is `chat_completions` and whose base URL points
  at a local capture endpoint (not a published vendor host). A third row on a
  published vendor host, a fourth on `anthropic_messages`, and a fifth on
  `openai-responses`, use the same capture endpoint's stand-ins where
  applicable.
- **Steps**: 1) Send a turn in each session and capture the full request headers
  and body of both. 2) Compare the two requests field by field. 3) Trigger a
  context-compaction summary in the first session and capture it. 4) Run a
  subagent turn and a plugin one-shot that carry a session id, and capture both.
  5) Repeat step 1 on the row whose base URL host is a published vendor host.
  6) Repeat step 1 on a row whose API style is `opencode_go`.
  7) For Chat Completions, reject `session_id` with a plain-text 400 at the
  capture endpoint and send two turns in one session and one in the other.
- **Expected**:
  - Both captured requests carry a stable per-session identifier that differs
    between the two sessions: `x-session-affinity` and `x-client-request-id`
    without `session_id`, plus `prompt_cache_key` in the body, all holding the
    session's own conversation id and unchanged across that session's turns.
  - All three Chat Completions turns finish with a complete assistant reply
    through the strict endpoint. Explicit model `compat` can still opt into
    the legacy `openai` headers or disable affinity headers.
  - The custom Responses request also carries `x-session-affinity` alongside
    the adapter's existing `session_id`, `x-client-request-id`, and
    `prompt_cache_key`, so a reverse proxy that drops underscore headers can
    still route the session.
  - The compaction summary, the subagent turn, and the one-shot carry the same
    id for their session, so a gateway pins the whole session to one backend.
  - The published-vendor-host row and the OpenCode row are byte-identical to
    their pre-change requests (the OpenCode row keeps `x-opencode-session`).
  - A one-shot call with no session id gains no `prompt_cache_key` or
    `x-session-affinity` header.
- **Specs linked**: `03-runtime/02-agent-runtime.md` (§6.2, §6.3),
  `03-runtime/11-provider-model-system.md`, issues #1634 and #2278
- **Acceptance**: C (chat/stream) + Quality
- **Milestone**: M5
- **Status**: Adapter-covered (`session-affinity.test.ts`); the real Runtime /
  HTTP gateway regression (`session-affinity-flow.test.ts`, issue #2278) covers
  repeated Chat Completions turns in two sessions against an edge that returns
  400 for `session_id`, verifying completed replies, stable hyphenated headers,
  distinct session ids, and the body cache key. Full cross-path gateway capture
  journey Draft.

## E2E-096: Recover transient provider stream failures in place

- **Preconditions**: A project-bound Agent session uses a deterministic
  provider fixture that emits a partial assistant stream, terminates once, then
  succeeds on the next request; a second fixture run can terminate eleven times; a
  third fixture returns `OpenAI API error (502)` before headers on one attempt
  and mid-stream on the next; a fourth fixture returns eleven consecutive 502s; a
  fifth fixture returns a 503 with `Retry-After`; a sixth fixture returns a
  pre-stream opaque 400/422 once and succeeds when the output-limit fields are
  omitted; the fixture supports both Chat Completions and Responses payloads and
  aborting after the opaque failure.
- **Steps**:
  1. Start an Agent turn with the one-termination fixture and observe the
     partial assistant response.
  2. Wait for the bounded retry and inspect the transcript, session state, and
     terminal diagnostics after recovery.
  3. Repeat with the eleven-termination fixture and inspect the terminal error
     message/event and its diagnostic details.
  4. Run the mixed-phase 502 fixture and inspect the request count and terminal
     diagnostics for both the pre-header and the mid-stream 502.
  5. Run the persistent eleven-502 fixture and inspect the terminal error.
  6. Run the 503 `Retry-After` fixture and inspect the observed wait.
  7. Run the opaque 400/422 fixture with both API styles and inspect the two
     request payloads, request count, and terminal diagnostics.
  8. Abort immediately after the first opaque 400/422 failure and inspect that
     no repair request starts.
  9. Reload the session and verify that only the completed response or the
     single terminal failed assistant remains durable.
  10. Open Settings → Behavior → Execution, enable infinite provider retry, and repeat
      a network fixture that fails beyond ten attempts before recovering. Stop the
      turn during backoff and verify no later request starts; disable the setting
      and verify a fresh persistent outage stops after ten retries.
  11. Alternate one socket failure and one successful tool-call response for
      eleven actual Read calls, then fail once and return a final answer.
      Verify all twelve independent failures recover in the same user turn,
      each beginning at retry 1, with no repeated tool execution.
  12. After a recovered tool response, keep the next response failing. Verify
      it receives ten fresh retries and terminates once with `retryAttempt: 10`.
      Restore the fixture, click Continue, and verify completion in the UI.
- **Expected**:
  - `terminated` is classified as `STREAM_FAILED`, and an upstream gateway
    `502`/`503`/`504` as retryable `PROVIDER_ERROR`.
  - Non-429 transient failures share one bounded budget of ten retries after
    the initial attempt, for eleven provider attempts total, shared by request
    setup and stream delivery. Each retry waits for an abortable bounded
    backoff, removes the entire failed assistant suffix from model context,
    and produces no duplicate assistant bubble or terminal error notification. A retry never
    calls native continuation while an assistant remains the last model message.
  - A mid-stream 502 is retried rather than surfacing immediately. The
    mixed-phase fixture spends one counter across both phases and makes eleven
    attempts in total, not one retry per phase. A complete successful response
    replenishes both retry budgets for the next tool round. Headers and partial
    output do not. Observed waits without a
    `Retry-After` header are 1, 2, 4, then 8 seconds for every later retry,
    identical in both phases.
  - Only the failed request is replayed: the session, its transcript, and any
    completed tool call are untouched across every retry.
  - The recovered turn emits one terminal lifecycle and keeps the same visible
    assistant message id. Its terminal diagnostics retain the bounded retry
    outcome and attempt number.
  - The eleventh termination emits one terminal `STREAM_FAILED` assistant error
    and lifecycle event; the persistent 502 fixture emits one terminal
    `PROVIDER_ERROR`. Both carry `retryAttempt: 10`. Available details include
    phase, stream timing, and provider status, without credentials or an
    unrestricted provider body.
  - The 503 fixture waits for the server's `Retry-After` instead of the client
    backoff. Non-429 server and fallback waits are capped at 8 seconds.
  - A pre-stream 400/422 with the `(no body)` marker gets one silent repair
    request with `max_tokens`, `max_completion_tokens`, and `max_output_tokens`
    removed. The caller's payload rewrite remains active, the repair consumes no
    transient retry budget or backoff, and both Chat Completions and Responses
    fixtures complete on their second request. A second opaque failure remains
    terminal. A 400/422 that names an output ceiling (`at most N completion
    tokens`, `max_tokens: N > M, which is the maximum allowed number of output
    tokens`, `expected a value <= N`, `valid range of max_tokens is [1, N]`,
    `Range of max_tokens should be [1, N]`, or `max_tokens must be less than
    or equal to N`) gets one silent repair that clamps
    those fields to that ceiling instead of removing them. Credit exhaustion
    and context overflow do not take this repair.
  - If the turn is aborted after the first opaque failure, the repair request is
    not started and the result is `aborted`.
  - A mid-stream HTTP 429 is covered by E2E-149's separate ten-retry path; the
    two budgets do not draw from each other.
  - Authentication, model-selection, context, and descriptive
    malformed-request failures do not enter either provider replay path. The
    opaque empty-body 400/422 case and the explicit output-ceiling case are
    the bounded repair exceptions described above. Infinite mode changes no
    classification and only removes the retry
    ceiling for admitted network/transient failures; it remains abortable and
    is visibly marked with an unbounded retry indicator.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `03-runtime/02-agent-runtime.md`, `03-runtime/08-error-codes.md`,
  `08-meta/decisions-log.md` (D186, D259, D378), ADR 0050, ADR 0128, ADR 0206
- **Acceptance**: C (chat & stream), F (persistence), H (diagnostics), Quality
- **Milestone**: M5
- **Status**: Retry and successful-response budget boundaries covered by
  `provider-recovery-flow.test.ts` through real agent loops. Desktop socket
  failure, partial-stream recovery, Responses recovery, exhaustion, Continue,
  and eleven-tool-round recovery run in `scripts/e2e-provider-recovery.mjs`.
  Existing classification coverage: `agent-errors.test.ts`,
  `provider-retry.test.ts`, `runtime.test.ts`, `subagent.test.ts`.
  Other scenario variants remain Draft.

## E2E-149: Recover provider rate limits (429) silently in place

- **Preconditions**: A project-bound Agent session uses deterministic provider
  fixtures for a setup HTTP 429 and a mid-stream HTTP 429. Each fixture can
  succeed after a retry and can return eleven consecutive 429 responses. Fixtures
  cover `retry-after-ms`, `retry-after` seconds, and HTTP-date headers, and
  support aborting during the wait. A builtin subagent uses a
  fixture with the same responses. Billing/account-exhaustion fixtures also
  return HTTP 429 with `insufficient_quota`, `credit_balance_exhausted`,
  organization usage-limit, spend-limit, and OpenCode Zen
  `FreeUsageLimitError` codes.
- **Steps**:
  1. Start an Agent turn with a setup-429 fixture whose next request succeeds.
  2. Repeat with a mid-stream-429 fixture whose next request succeeds.
  3. Inspect the transcript, lifecycle events, request count, and terminal
     diagnostics for both recoveries.
  4. Repeat with eleven consecutive 429 responses, then inspect the terminal
     assistant error and diagnostic details.
  5. Start the subagent fixture, then repeat the persistent eleven-429 case.
  6. Start another 429 turn and abort while it is waiting; inspect that no
     later provider request or terminal retry is started.
  7. Repeat with authentication, model-selection, malformed-request, and
     context-error fixtures.
  8. Repeat with the billing/account-exhaustion 429 fixtures and inspect the
     terminal assistant error and provider request count.
- **Expected**:
  - Throughput rate-limit 429s are classified as retryable
    `PROVIDER_RATE_LIMITED` in both setup and post-start recovery, including a
    response body that omits rate-limit wording when the captured HTTP status
    is 429. Diagnostics retain `providerStatus: 429`.
  - Explicit billing/account exhaustion is terminal `PROVIDER_ERROR` even
    when returned with HTTP 429, including `insufficient_quota`,
    `credit_balance_exhausted`, organization usage-limit, and organization/
    project spend-limit codes, and OpenCode Zen's `FreeUsageLimitError`.
    It retains the provider's message and status, starts no retry, and
    consumes neither retry budget.
  - Setup and mid-stream failures share one budget of ten retries after the
    initial attempt. A persistent fixture therefore makes eleven provider
    attempts, never multiplies attempts through nested pi-ai retries, and
    emits no intermediate assistant error, lifecycle `error`, `turn_end`, or
    `agent_end`.
    A complete successful response, including a tool-call response, resets both
    budgets before the next model request. Independent recovered rate limits
    across more than ten tool rounds must not terminate the user turn or a
    builtin subagent; partial output alone must not replenish either budget.
  - A recovered attempt removes the failed assistant from model context and
    reuses its visible assistant message id. The transcript has one assistant
    bubble and one terminal lifecycle; bounded retry diagnostics retain the
    phase, delay, and attempt number.
  - Delay precedence is `retry-after-ms`, `retry-after` seconds, HTTP-date,
    then exponential backoff with positive jitter. Server and fallback waits
    are capped at 30 seconds and the wait is abortable.
  - Exhaustion emits one terminal `PROVIDER_RATE_LIMITED` assistant error and
    lifecycle event with `retryAttempt: 10` and `providerStatus: 429`; no
    eleventh retry occurs after the eleven provider attempts. The structured
    assistant error card remains the only failure
    surface, exposing one localized **Continue** action and no **Regenerate**
    action; the generic TurnOutcomeCard is omitted. Activating **Continue**
    appends the localized continuation prompt (`Continue the user's unfinished
    task.` / `继续用户未完成的任务`) to the same session and starts the next turn
    without discarding the failed turn.
  - The subagent uses the same ten-retry budget and one visible child bubble;
    its final report is failed only after the budget is exhausted, while
    intermediate 429s never become a parent-visible error report.
  - Aborting during a backoff cancels the pending timer and starts no later
    provider request. Authentication, model-selection, malformed-request, and
    context fixtures make no automatic retry.
  - The 429 budget is separate from the non-429 transient budget in E2E-096.
    A 429 does not consume transient retries and a 502 does not consume 429
    retries.
- **Specs linked**: `03-runtime/02-agent-runtime.md` (D245, D378),
  `03-runtime/08-error-codes.md`, `08-meta/decisions-log.md` (D245, D378),
  ADR 0091, ADR 0206
- **Acceptance**: C (chat & stream), H (diagnostics), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`provider-retry.test.ts`, `runtime.test.ts`,
  `subagent.test.ts`); full provider/UI journey Draft

## E2E-102c: Vision-capable models receive pasted images as image input

- **Preconditions**: A deterministic vision-capable models.dev model whose
  resolved record contains `modalities.input: ["text", "image"]`; an Agent
  session; one pasted PNG and one text prompt. Capture the renderer request,
  main-to-sidecar payload, provider request, durable transcript, and
  `<data_dir>/attachments/`.
- **Steps**:
  1. Select the vision-capable model and paste the PNG into Composer.
  2. Confirm the PNG appears as a removable image chip above the textarea and
     no separate explanatory vision-status row is rendered.
  3. Send a prompt asking the model to identify one visible detail.
  4. Inspect the provider request and durable session message after completion.
  5. Reload the session and ask a follow-up about the same image.
- **Expected**:
  - The model picker/session capability state comes from the exact models.dev
    record, and Composer shows the image as a removable chip without a
    separate explanatory status row. If a remote refresh fails, the bundled
    release snapshot remains authoritative for the process.
  - Main writes one content-addressed image blob and sends the sidecar a
    transient image attachment; the provider adapter emits an image content
    block/data URL, not only `@<scratch-path>` text.
  - The durable message contains `kind`, display `name`, MIME/size, and the
    `attachments/<sha256>` ref, but no base64 or image bytes.
  - After reload, history hydration restores the image block from the bounded
    attachment root and the follow-up still has image context.
- **Specs linked**: `03-runtime/01-ipc-protocol.md` §5.1/§13c,
  `03-runtime/02-agent-runtime.md` §5c,
  `03-runtime/04-data-storage.md`, `03-runtime/13-model-catalog-and-selection.md`
  §11.2, `04-ux/08-component-spec.md` §11.7–11.8,
  `08-meta/decisions-log.md` (D243), ADR 0101
- **Acceptance**: B (model config), C (conversation & stream), F (persistence),
  Quality, Security
- **Milestone**: M5
- **Status**: Unit-covered (`model-capabilities.test.ts`, host-core attachment
  roundtrip); provider/UI journey Draft (run only in a capable environment when this surface changes)

## E2E-ATTACHMENTS-svg-file-fallback: SVG inputs are sent as files, not model images

- **Preconditions**: A vision-capable model; an Agent session; one SVG file
  (clipboard paste or native file picker) and one PNG.
- **Steps**:
  1. Paste or attach an SVG file into Composer alongside a PNG.
  2. Send a prompt asking the model about both attachments.
  3. Inspect the provider request body.
  4. Reload the session and inspect restored attachments.
- **Expected**:
  - The SVG appears as a file chip, not an image chip. It is classified as
    `kind: "file"` with `.svg` extension (even if the original had none).
  - The PNG still appears as an image chip and is sent as a model image block.
  - The provider request contains no `inlineData` for the SVG; it uses a safe
    `@path` file reference.
  - Legacy content-addressed SVG attachments from older sessions are restored
    as files, not images; stale temporary image data is cleared.
  - Non-SVG image attachments and vision capability detection are unaffected.
- **Specs linked**: `03-runtime/svg-attachment-input.md`,
  `03-runtime/01-ipc-protocol.md` §5.1, `04-ux/08-component-spec.md` §11.7
- **Acceptance**: C (conversation & stream), F (persistence), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`svg-attachments.test.mjs`); Desktop E2E Draft

## E2E-102e: Unknown model ids fail closed for vision transport

- **Preconditions**: A custom provider/model id absent from the models.dev catalog,
  discovery data that incorrectly labels it `vision`, no explicit
  `supportsImages` binding override, and a pasted PNG.
- **Steps**:
  1. Refresh the provider model list and select the discovered custom id.
  2. Paste the PNG and inspect the model picker and Composer image chip.
  3. Send the prompt and inspect the sidecar/provider payload.
- **Expected**:
  - The unknown model is runnable as a generic text model but is not promoted
    to `vision` by discovery/cache metadata.
  - Composer keeps the image chip without rendering a model-dependent status
    message, and the provider receives no image block or base64 value; the safe
    file path remains available.
  - The durable attachment ref is still recorded so a later known vision model
    can replay the image correctly.
- **Specs linked**: `03-runtime/11-provider-model-system.md` §6.2/§11,
  `03-runtime/13-model-catalog-and-selection.md` §11.2,
  `04-ux/08-component-spec.md` §11.8, ADR 0101, ADR 0218
- **Acceptance**: B (model config), C (conversation & stream), E (tools &
  permissions), Security
- **Milestone**: M5
- **Status**: Unit-covered (`model-capabilities.test.ts`); provider/UI journey
  Draft (run only in a capable environment when this surface changes)

## E2E-OAUTH-anthropic-rate-limit-retry: Bounded token retries preserve the account

- **Preconditions**: A local HTTP fixture intercepts only Anthropic's token URL;
  the production pi-ai flow and Desktop `VendorOAuth` run with an in-memory Host
  RPC fixture. No real account, browser authorization or remote endpoint is used.
- **Steps**: Run `pnpm test:e2e:oauth-retry`. Exercise exchange and refresh
  429 → success, repeated 429, seconds/date/malformed/over-budget `Retry-After`,
  invalid grants (including after 429), 5xx, socket disconnect, invalid success
  JSON, cancellation during request/body/wait, and an earlier caller deadline.
  Resolve the same account concurrently and retry after a failed refresh.
- **Expected**: At most three requests share one deadline and original signal;
  no retry precedes a server hint. Only explicit 429 is retried; grant rejection
  and ambiguous failures stop. Request grant fields and custom headers remain
  unchanged. Failed refresh retains the old credential and releases its lock;
  concurrent resolves rotate/write once. Failed/cancelled login removes only
  its newly created row. HTTP/token-JSON errors contain no token-body canary, URL
  or embedded stack and provide recovery guidance without claiming every 429
  consumes code. Existing network-error diagnostics are unchanged.
- **Specs linked**: `03-runtime/11-provider-model-system.md` §8a; ADR 0095.
- **Acceptance**: B (vendor accounts), Security, Quality.
- **Status**: All 20 local HTTP scenarios passed against the installed patch;
  the existing 20 login/session regressions also passed. This is a pre-merge
  transport and orchestration integration test, not live OAuth, visual UI or
  Host persistence validation. Post-integration main E2E is NOT RUN.

## E2E-OAUTH-anthropic-copy-code: Anthropic copy-code login uses the existing prompt bridge

- **Preconditions**: A local token-endpoint fixture intercepts only Anthropic's
  OAuth token URL. The production pi-ai Anthropic flow and Desktop `VendorOAuth`
  use an in-memory Host RPC fixture. No real account or remote endpoint is used.
- **Steps**: Start an Anthropic vendor login; choose `copy_code` from the
  `select` prompt; inspect the generated authorization URL; provide a synthetic
  `code#state` to the manual-code prompt; finish token exchange against the
  fixture; resolve request auth and inspect the stored Host credential.
- **Expected**: The select options retain `browser` and `copy_code`; the
  authorization URL uses `https://platform.claude.com/oauth/code/callback`;
  the token exchange succeeds; refresh credentials stay under the
  provider-scoped Host OAuth reference and only the short-lived access token is
  returned to runtime auth. No API-key secret is created.
- **Specs linked**: `03-runtime/14-secrets-storage.md` §10; `07-plugins/16-trusted-extensions.md` §4.
- **Acceptance**: B (vendor accounts), Security, Quality.
- **Status**: Local provider-flow integration fixture; no live account or visual
  renderer validation.

## E2E-151: Multiple vendor accounts stay isolated through login, use, and removal

- **Preconditions**: A build with `registerBunOAuthFlows()` running at startup
  and a real subscription for at least one PKCE vendor (Anthropic) and one
  device-code vendor (xAI, GitHub Copilot, or Meta/Muse). No provider row exists yet for
  either vendor.
- **Steps**: 1) Open Settings -> Model configuration, confirm the Vendor
  accounts card starts empty, and open Add account — the picker lists every
  `models.getProviders().filter(p => p.auth.oauth)` vendor, including vendors
  with existing accounts; when accounts exist, confirm their rows use the same
  single-level list surface as AI services and that Add account matches the
  primary button treatment of Add provider. 2) Pick Anthropic and complete
  the browser login;
  confirm one connected account row and one OAuth provider row appear. 3) Use
  Add account again, pick Anthropic again, and complete a second login with a
  different account; confirm two account rows and two provider ids. 4) Edit
  the first account, change its display name, select multiple catalog/custom
  models, configure context window, max output tokens, and thinking levels for
  one model, then save; confirm the row shows the account label once while the
  Defaults selector reflects the edited model and each option shows only one provider name,
  without an appended account label or model ID. Before saving, focus the
  default-model field and confirm the authenticated suggestions open as an
  app-styled list with aligned model IDs/display names, that typing filters it,
  ArrowDown/ArrowUp plus Enter selects an option, Escape closes it, and the
  fixed list is portaled above the dialog without changing dialog height or
  being clipped by the dialog's overflow. Confirm a custom model ID can still
  be entered. Press Test connection and confirm the result resolves the edited
  account. Open the Composer model menu and confirm the edited account label is
  used as the OAuth provider group heading, while the configured model alias is
  shown on its model row. With both Anthropic accounts configured, open the
  Defaults picker and confirm the one provider name each group shows is that
  account's own label, so the two accounts are not two identical `Anthropic`
  groups, that the summary line above the Change action names the account
  holding the current default, and that typing an account label filters to that
  account's models while typing the vendor name still reaches both. Repeat the
  5) Resolve and use each account separately, including model discovery and one streamed
  turn per account. 6) Start the device-code login on a second vendor, including
  Meta/Muse when available, then press Cancel while the dialog is polling;
  confirm no row or credential is left. 7) Remove the first Anthropic account,
  then confirm its provider row and OAuth secret are gone while the second
  Anthropic account remains usable. 8) If the removed account was default,
  confirm Defaults points to another ready provider or shows no default. 9) Grep
  sidecar and renderer logs for token material.
- **Expected**: Each successful login creates a distinct row with
  `authKind: "oauth"`, `hasSecret` and `hasOauth` both true, a non-secret
  account label, and `baseUrl`/`apiStyle`/`defaultModelId` filled from that
  account's own catalog. Each row has its own
  `secret:provider:<providerId>:oauth` ref and row-scoped pi-ai collection;
  resolving one account never returns the other account's token. The model list
  is the authenticated catalog (a Copilot account lists only what its
  subscription includes; a Meta account lists Muse Spark models), not a
  `/models` probe. Matching models.dev metadata supplies each newly logged-in
  binding's limits, modalities, and thinking levels; an ID missing from
  models.dev uses the conservative generic text-only/non-reasoning shape.
  label/model fields and the full per-model bindings, and Test connection
  resolves that exact account. Both turns run without a
  pasted key and reuse the same warm runtime — the launch payload carries
  `apiKey: ""` and each request resolves auth through `provider.resolveAuth`,
  which Electron main answers locally and refuses with `PROVIDER_NOT_BOUND` for
  an unbound provider id. Cancel aborts the local callback server /
  device-code polling and leaves no row and no credential. The connection test
  proves the account by resolving auth rather than probing with a key. Remove
  account delegates to `providers.delete`, clearing both secret refs and
  metadata for exactly that row. No log, event, or IPC payload contains an
  access token, refresh token, or authorization code.
- **Specs linked**: `03-runtime/11-provider-model-system.md` §8a,
  `03-runtime/12-provider-config-schema.md` §3,
  `03-runtime/14-secrets-storage.md` §10,
  `03-runtime/01-ipc-protocol.md` §8, `04-ux/06-settings-ia.md`,
  `08-meta/decisions-log.md` (D237/D240), ADR 0095, ADR 0098
- **Acceptance**: B (model config), C (conversation & stream), F (persistence),
  Security, Quality
- **Milestone**: M6+
- **Status**: Unit coverage in `packages/agent-runtime` (auth resolution and
  runtime reuse) and host-core secret-ref tests; full desktop journey Draft and
  needs live vendor accounts (run only in a capable environment when this surface changes)

## E2E-197: GitHub Copilot accepts the default Enterprise domain

- **Preconditions**: A build with the GitHub Copilot OAuth flow registered;
  the device-code login can reach the GitHub endpoint.
- **Steps**: 1) Open Settings -> Model configuration -> Add account and choose
  GitHub Copilot. 2) Leave the Enterprise URL/domain field empty. 3) Confirm
  Continue is enabled and submit the empty value. 4) Complete the device-code
  login and inspect the resulting account row.
- **Expected**: The empty text prompt is submitted as an empty string, the
  provider uses github.com, and the device-code flow completes normally. Secret
  and manual-code prompts remain disabled while empty. No OAuth token or device
  credential is rendered or logged.
- **Specs linked**: `04-ux/06-settings-ia.md`,
  `04-ux/08-component-spec.md` §19, `03-runtime/12-provider-config-schema.md`
  §3, `08-meta/decisions-log.md` (D237/D240)
- **Acceptance**: B (model config), Security, Quality
- **Milestone**: M6+
- **Status**: Unit-covered (`apps/desktop/test/oauth-login-prompt.test.mjs`);
  live device-code journey Draft (run only in a capable environment when this surface changes)

## E2E-154: Model additions use models.dev metadata and generic unknown IDs

- **Preconditions**: A custom provider dialog matches a models.dev provider/API
  URL and exposes at least two model records with limits, modalities, and
  reasoning options. A deterministic fixture also exposes a provider-discovered
  ID absent from models.dev.
- **Steps**:
  1. Select two models from the models.dev list and inspect their names,
     context/output limits, capability badges, source labels, and thinking
     chips. 2. Save the provider and start a session; confirm the request keeps
     the provider's configured base URL/API style. 3. Force a Settings catalog
     refresh and confirm it refetches models.dev without changing the bundled
     release file or writing a user cache. 4. Add an ID absent from models.dev
     and inspect its generic fallback card. 5. In the OAuth protocol fixture,
     sign in to an account that offers a new Claude ID absent from models.dev
     while a same-tier Pi sibling exists. Resolve its runtime binding, apply
     runtime model configuration without a saved model binding, and send a
     request through the real Anthropic adapter to an intercepted HTTP boundary.
     Confirm the sibling does not supply chat limits, reasoning levels or effort
     mappings.
- **Expected**: models.dev fields prefill known model bindings and remain the
  published metadata source. Provider keys are never included in the fixed
  models.dev request. Custom IDs without metadata retain generic defaults.
  An OAuth live-only ID does not inherit metadata from a Pi sibling; only an
  exact models.dev match supplies its chat limits and reasoning shape. The
  selected adapter keeps its wire behavior, and Copilot Bearer authentication
  remains unchanged.
- **Specs linked**: `03-runtime/11-provider-model-system.md` §6.2 and §8a,
  `03-runtime/13-model-catalog-and-selection.md` §11.1–§12, ADR 0134
- **Acceptance**: B (model config), C (conversation & stream), Security
- **Milestone**: M6+
- **Status**: OAuth-to-runtime-binding-to-adapter HTTP contract automated in
  `apps/desktop/test/vendor-oauth-login.test.mjs`. Full provider-dialog journey
  Draft. No live account or paid provider request is required for this fixture.

## E2E-PROVIDER-custom-form-excludes-account-formats: Keep account APIs out of new custom services

- **Preconditions**: Isolated profile, English and Simplified Chinese. Seed
  non-OAuth legacy rows using Codex and Pi account formats, including an OpenAI
  preset URL; use synthetic models and no real credentials. Include a synthetic
  OpenAI Codex OAuth account with one configured model binding.
- **Steps**: 1) Add a Custom service and inspect its format choices. 2) Edit each
  legacy row and save unchanged, then explicitly select Responses and save.
  3) Copy each original legacy row, inspect the current format and explanatory
  hint, wait past discovery debounce, and cancel. 4) Copy again, choose Anthropic
  Messages and save. 5) Check saved payloads and the unchanged source row.
  6) Edit the synthetic Codex OAuth account; confirm Native web search is
  enabled but unchecked, check it, save, and inspect the model binding payload.
- **Expected**: New custom choices are the four general protocols; Codex and Pi
  are available through vendor accounts, not as new API-key choices. Legacy
  editing preserves format, name, URL and authentication unless explicitly
  changed. A copied account format is visible but cannot be newly selected;
  saving and discovery are blocked until an explicit supported choice. The
  explanation is localized. Cancel performs no create; a valid copy never uses
  the source id or credentials. For Codex OAuth, Native web search is enabled
  for the supported Responses wire, defaults off, and saves as
  `nativeWebSearch: true` on that model only. Named OpenCode Go and OAuth account
  flows remain unchanged.
- **Automation**: `pnpm test:e2e:provider-api-style` renders the production React
  form and `VendorAccountDialog` in Electron/Chromium with a stubbed API boundary;
  it checks create/update/discovery payloads and the Codex model binding save.
  This does not verify Host storage, live OAuth or live model/search calls.
- **Specs linked**: `03-runtime/11-provider-model-system.md`,
  `03-runtime/12-provider-config-schema.md`, ADR 0095, ADR 0297.
- **Acceptance**: B (model configuration), Security.
- **Status**: The Electron/React scenario passed in English and Simplified
  Chinese: eight scenario groups, four creates and eight provider updates through
  the stubbed API; both locales also verify the Codex OAuth search opt-in save.
  Host persistence, live OAuth/model calls and visual layout were not exercised.
  Post-integration main E2E is NOT RUN.

## E2E-PROVIDER-stepfun-plan-setup: Save the StepFun subscription preset

- **Preconditions**: Isolated Electron profile, English and Simplified Chinese,
  synthetic API key and a discovered `step-5-preview` model; no live provider.
- **Steps**: Select StepFun Plan in Add AI service, enter the test key, wait for
  model discovery, explicitly select Step 5 Preview, then save.
- **Expected**: The chooser and connection summary both visibly include
  `api.stepfun.com/step_plan/v1`. Discovery receives `https://api.stepfun.com/step_plan/v1`,
  `anthropic_messages`, and the entered key sent as `Authorization: Bearer` rather
  than the Anthropic `x-api-key`. Save retains that URL and format,
  the catalog vendor `stepfun-step-plan`, and the selected model. The ordinary
  StepFun `/v1` endpoint is not substituted for the subscription endpoint.
- **Automation**: `pnpm test:e2e:provider-api-style` uses real settings components
  with only the API boundary stubbed. `provider-presets.test.ts` checks the
  preset contract and ordinary-endpoint separation; `service-catalog.test.mjs`
  checks discoverability by localized label, name, vendor key, and URL;
  `provider-stepfun-plan-discovery.test.mjs` drives the real provider handlers
  and pins the Bearer model list for both discovery and the connection test.
- **Scope**: Save/discovery payloads are covered; host persistence, live model
  calls, and visual layout are not asserted by this fixture.
- **Specs linked**: `03-runtime/12-provider-config-schema.md`, `guide/stepfun.md`.

## E2E-PROVIDER-copy-config-without-credentials: Copy configuration into an independent provider

- **Preconditions**: Settings contains an ordinary provider with a saved API
  key, custom headers, and two model bindings with distinct aliases, limits,
  thinking levels, and modality overrides; an OAuth account also exists.
  Record the source configuration and global default provider/model. Use a
  deterministic endpoint to capture discovery requests without real secrets.
- **Steps**: 1) Copy the ordinary provider. 2) Confirm the custom-service
  draft retains the name, URL, API format, and model bindings while the key
  and custom headers are blank and an omission notice is visible. 3) Change
  the API format, a model alias/limit, and its thinking levels; cancel.
  4) Confirm provider count, source data, and global defaults are unchanged.
  5) Copy again and trigger discovery before entering a new key, then with a
  distinct fixture key. 6) Save under a distinct name with the changed API
  format. 7) Reopen both providers and edit the copy. 8) Inspect the OAuth
  account row for absence of Copy. 9) In the draft-construction fixture, add
  unknown source/model fields and verify they are not copied. 10) Copy an
  OpenCode Go provider, confirm its named service and fixed format are kept,
  then select Custom service and choose another ordinary API format.
- **Expected**: Cancel creates no provider or secret. Draft model objects and
  thinking arrays do not share references with the source. Discovery and
  connection testing do not use the source provider id or stored credential;
  authenticated discovery uses only the new draft key. Copy never reads the
  secret store. Save creates a distinct provider through the existing create
  path with independent model bindings and credentials, while the source and
  global defaults remain unchanged. Custom headers and unknown fields are
  omitted even if they contain credential-like values. OAuth accounts cannot
  be copied through this action.
- **Specs linked**: `03-runtime/12-provider-config-schema.md`,
  `03-runtime/14-secrets-storage.md`
- **Acceptance**: B (model configuration), F (independent persistence), Security
- **Milestone**: M2
- **Status**: Real Host/helper fixture verified independent creation, edits,
  deletion, retained source credentials/defaults, and restart persistence.
  Actual UI validation on an isolated no-secret profile confirmed cancel
  leaves one provider; saving a copy with Responses changed to Anthropic
  Messages and a changed name/alias creates a second provider without changing
  the global default. Reopening both rows confirmed the source retained
  Responses and its original alias, while the copy retained Anthropic Messages
  and its edited alias. Credential-bearing network discovery, external-model
  calls, and the OpenCode Go UI variant were not exercised.

## E2E-162: A vendor account and an AI service offer the same model picker

- **Preconditions**: One signed-in vendor (OAuth) account and one API-key AI
  service, both with discoverable models, and at least one of them exposing a
  reasoning-capable model.
- **Steps**: 1) Open Settings → Model configuration. 2) Edit the AI service,
  expand a chosen model's Advanced disclosure, and note its context window, max
  output and thinking chips; cancel. 3) Edit the vendor account and do the same
  on one of its chosen models. 4) Toggle a thinking level on a reasoning-capable
  account model and save. 5) Reopen the account editor and read that model's
  chips. 6) For an OpenAI Codex account, inspect `gpt-6-astra` (or another
  account model also published under models.dev's `openai` provider) and confirm
  its published context/output limits and reasoning levels are present. For
  `gpt-6.1-sol`, verify a 1,050,000-token context and 128,000-token output cap.
  7) In
  the account editor, hand-type a custom model ID the catalog does not publish,
  enable a thinking level on it, and save.
- **Expected**: Both dialogs render the same picker — the same discovered list,
  the same search, the same free-form custom-model entry, the same chosen pane,
  the same Advanced disclosure and the same chips — so the account editor is no
  longer missing the advanced controls. A level enabled on an account model
  persists and reappears when the editor is reopened, including a level the
  catalog does not publish. OpenAI Codex's `openai-codex` adapter key resolves
  the matching `openai` models.dev record, so `gpt-6-astra` is not shown with
  generic 128,000 / 8,192 / no-reasoning defaults. The authenticated ChatGPT
  list comes from `GET {base}/codex/models` on the account token, so an id the
  pin does not know yet is selectable when that response includes it; pi-ai is
  only the OAuth/transport adapter; it supplies no sibling chat-model limits.
  models.dev enriches an ID only when its record matches. A model with no
  published record keeps its explicit levels, starts
  at `off` when no binding default is stored, and keeps all choices available
  for manual opt-in. The account's default model stays the head binding.
- **Specs linked**: `04-ux/06-settings-ia.md`,
  `04-ux/08-component-spec.md` §19, `03-runtime/11-provider-model-system.md`
  §10, `08-meta/decisions-log.md` (D270 refines D237/D240)
- **Acceptance**: B (model config), Quality

## E2E-163: Advanced model settings own the default thinking level and attachment capabilities

- **Preconditions**: One AI service with discoverable models, including a
  reasoning-capable model that publishes at least three thinking levels, a
  vision-capable model, and a model models.dev describes as text-only. The
  service must persist model-local `supportsImages` overrides.
- **Steps**: 1) Open Settings → Model configuration, edit the service and expand
  a reasoning-capable model's Advanced disclosure. 2) Enable at least three
  thinking levels and pick a default that is not the lowest enabled level, then
  save. 3) Reopen the editor and read the default selector. 4) Disable the level
  currently chosen as default and read the selector again. 5) Start a new session
  on that model and open the composer reasoning menu. 6) Back in Advanced, on
  the text-only model, turn Image input on, save, reopen and confirm the switch
  reports itself as overridden. 7) Open the Composer model menu and confirm
  that this model shows the vision badge. 8) On the published vision model,
  turn Image input off and confirm its Composer row no longer shows the vision
  badge. 9) Attach an image in a session on the text-only model. 10) Tick the
  same box back to the value models.dev publishes, save, and reopen.
  11) Turn PDF input on for a model whose catalog entry omits it, save, and
  attach a PDF. 12) Configure a model, then point the service at an endpoint that
  no longer lists it, reopen the editor and read that model's capability boxes.
- **Expected**: The default thinking level is selectable among the levels the
  binding enables and nothing else; it persists across reopen and is the level
  the home draft chip and a newly persisted session start at, not the strongest
  enabled level. Disabling the chosen default moves it to a still-enabled
  level rather than leaving a level the runtime would clamp away, and the
  selector is absent when a binding enables one level or none. An answered
  Image input switch overrides the published capability in both directions and
  survives reopen. The Composer model menu shows the vision badge for the
  effective `true` override on the published text-only model, hides it for an
  explicit `false` override on the published vision model, and follows the
  published value when the override is reset to `null`. The text-only model
  transports the attached image as an image content block. Ticking a box back
  to the published value
  stores "follow the catalog" rather than an equal-valued override, so a later
  catalog correction still reaches the binding without any separate reset
  control. All seven canonical thinking chips remain available even when the
  catalog publishes no reasoning support, so an endpoint can be opted in
  explicitly. PDF input records the capability without changing transport: the PDF
  stays a bounded file reference the model reads with its file tools. Each
  capability is one checkbox with a short label and no per-row explanatory copy.
  The Advanced body is a compact sheet: the alias hint is a title tooltip, limit
  fields hide native spinners, thinking chips span the pane with the default
  selector on the label row, and attachment plus delegation checkboxes share one
  wrapping row. The first chosen row starts expanded. A configured model absent
  from live discovery still shows its published capabilities rather than reading
  as undescribed.
- **Specs linked**: `03-runtime/11-provider-model-system.md` §6.2,
  `03-runtime/12-provider-config-schema.md`,
  `03-runtime/13-model-catalog-and-selection.md` §11.2,
  `04-ux/08-component-spec.md` §11.7–11.8,
  `04-ux/06-settings-ia.md`, ADR 0218
- **Acceptance**: B (model config), Quality

## E2E-172: Mid-turn thinking pick does not collapse an unpinned session menu

- **Preconditions**: The app default is a reasoning-capable custom
  provider/model whose binding publishes a sparse set such as `low`/`high`/`max`.
  A session exists on the default create path (`provider_id`/`model_id` NULL).
- **Steps**: 1) Send a prompt so the session is running. 2) Open the Composer
  model × reasoning menu and select a different enabled thinking level. 3) Reopen
  the thinking submenu without waiting for the turn to finish. 4) Switch to
  another session and back. 5) Let the turn finish.
- **Expected**: The chip shows the selected level (not Off). The submenu still
  lists every enabled binding level. Switching sessions does not collapse the
  menu. After `agent_end`, the queued configuration is durable. Re-saving a
  provider is not required to recover the menu.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `03-runtime/13-model-catalog-and-selection.md`,
  `04-ux/08-component-spec.md` §11
- **Acceptance**: B (model config), C (chat and stream), Quality
- **Milestone**: M6
- **Status**: Unit-covered (`session-thinking.test.mjs`, `thinking-ui.test.mjs`,
  `composer-send-state.test.mjs`); full UI scenario Draft
  (run only in a capable environment when this surface changes)

## E2E-174: Binding default thinking level seeds drafts and new sessions

- **Preconditions**: One AI service with a reasoning model whose published
  levels omit `off` (for example `low` / `high` / `max`) and whose Advanced
  default thinking level is a non-max enabled level such as `low`.
- **Steps**: 1) Open the home composer with no active session and read the
  model × reasoning chip. 2) Create a new task without opening the reasoning
  menu, then read the chip and the session's stored `thinkingLevel`. 3) On the
  home draft, switch to that model from the model menu and read the chip before
  sending. 4) Change the binding default to another enabled level, save, and
  repeat steps 1–2 on a fresh draft.
- **Expected**: The home draft chip, a draft model switch, and the newly
  persisted session all start at the binding's stored default, not the
  strongest published or enabled level. Changing the default in Settings
  changes the next draft and new session and does not rewrite existing
  sessions.
- **Specs linked**: `03-runtime/11-provider-model-system.md` §6.2,
  `03-runtime/13-model-catalog-and-selection.md` §4,
  `04-ux/08-component-spec.md` §11.4 / §11.5, `08-meta/decisions-log.md` (D303)
- **Acceptance**: B (model config), C (chat/stream), Quality
- **Milestone**: M6+
- **Status**: Unit/source-contract covered (`thinking-levels.test.ts`,
  `thinking-ui.test.mjs`); rendered desktop journey remains pending

## E2E-209: Import copies model configuration from local agent stores

- **Preconditions**: At least one supported local config exists among
  `~/.claude/settings.json`, `~/.codex/config.toml` `[model_providers.*]`,
  `~/.config/opencode/opencode.json`, `~/.pi/agent/models.json`,
  `~/.pi/agent/auth.json` plus `~/.pi/agent/models-store.json`, or
  `~/.cc-switch/cc-switch.db`, including two API-key profiles with the same
  endpoint and different keys, one auth-only Pi API-key provider, and
  optionally one OAuth-only vendor. PI-Desktop may already have an equivalent
  provider.
- **Steps**:
  1. Open Settings → Models and expand **Import from other tools**. Confirm
     its scan explanation appears as inline text without a help icon, and the
     workbench remains idle until Scan is activated.
  2. Scan model configuration. Confirm source groups start expanded, rows
     show name, model count, host, and an API key / No API key badge, and no
     secret value appears in the UI or scan IPC payload. Confirm the
     auth-only Pi provider appears in the Pi group with its cached model
     count and an API key badge.
  3. Import the selected providers. Confirm both same-endpoint profiles appear
     as separate rows under Settings → Models and remain selectable in the
     Composer model menu. Re-import the same selection and confirm those
     unchanged credentials are skipped.
  4. If the app had no default model, confirm the first imported provider
     becomes the default. If a default already existed, confirm it is
     unchanged.
  5. Confirm an OAuth-only source account is absent from the candidate
     list.
- **Expected**: Explicit scan only (D007). Stored API keys land in the host
  secret store. Pi providers connected through `auth.json` are paired with
  the cached `models-store.json` catalog; OAuth grants and `!command` keys
  are not imported. Only equivalent providers (normalized URL + API style +
  same credential) skip; different credentials at one endpoint remain
  separate. The expanded importer shows its scan explanation directly
  without a question-mark control. No protocol or schema version bump.
- **Specs linked**: `04-ux/06-settings-ia.md`,
  `04-ux/08-component-spec.md` §18.5, `03-runtime/01-ipc-protocol.md`,
  `03-runtime/11-provider-model-system.md`, ADR 0179, D342
- **Acceptance**: B (model configuration)
- **Milestone**: M4
- **Status**: Unit-covered (`packages/shared/src/model-config-import.test.ts`,
  `apps/desktop/test/model-config-import.test.mjs`); full UI journey Draft
  (run only in a capable environment when this surface changes)

## E2E-201: Alias a configured model and copy a model id

- **Preconditions**: One provider saved with at least two model bindings, at
  least one of which the catalog publishes with a display name.
- **Steps**: 1) Open Settings → Model configuration and reopen the provider.
  2) Drag-select a model id in the live model list and copy it; confirm the
  clipboard holds the id and the row's checkbox did not toggle. 3) Click the
  same row's checkbox without selecting text; confirm it still toggles.
  4) Expand Advanced on a chosen row and type a short alias. 5) Save and open
  the Composer model picker; confirm the alias names that model while the other
  row keeps its published name. 6) Search the picker by the alias and by the
  real id; both reach the row. 7) Clear the alias, save, and confirm the
  published display name returns. 8) Re-enter the alias, save, reopen the
  provider, restart the app, and confirm the alias is still there. 9) Type more
  than 60 characters into the alias input; confirm the field keeps only the
  first 60, then send a direct `providers.update` RPC with a 61-character alias
  and confirm it fails with `MODEL_ALIAS_TOO_LONG`.
- **Expected**: The alias is a display label only — the provider request still
  carries `models[].id`, and the configuration row keeps showing the real id
  beside the alias chip. Model ids and names are selectable inside the
  non-selectable shell, and a click that carries a selection never toggles the
  row checkbox. A blank or cleared alias falls back to the catalog display
  name.
- **Specs linked**: `03-runtime/12-provider-config-schema.md`,
  `04-ux/08-component-spec.md`, ADR 0192
- **Acceptance**: B (model configuration), Quality
- **Milestone**: M2
- **Status**: Unit-covered (`composer-models.test.mjs`,
  `provider-model-config.test.mjs`); rendered UI journey Draft (run only in a capable environment when this surface changes)

## E2E-MODEL-selected-order-persists: Selected model order survives saving

- **Preconditions**: An AI service and an OAuth vendor account each have at
  least three selected models. Include a model with an alias and non-default
  Advanced settings. Record their binding values, the app-level default
  provider/model, and an explicitly bound session's model choice. A controllable
  save response is available to hold either editor busy.
- **Steps**:
  1. Open Settings → Model configuration and edit the AI service. Drag the
     last selected model by its handle before the first row, then drag it
     after the last row. Confirm the insertion location and resulting order.
  2. Configure the selected IDs in this order: `shown-a`, `hidden-a`,
     `shown-b`, `hidden-b`, `shown-c`. Filter by `shown-`, then drag `shown-c`
     before `shown-a`. Clear the filter and inspect all five bindings.
  3. Apply the filter again. Focus `shown-c`'s reorder handle and press Down,
     then Up. Confirm it moves past the neighboring visible row each time
     and focus remains on the moved model's handle. Try Up on the first
     visible model and Down on the last; neither changes the order.
  4. Start a drag and cancel it, then start another and drop outside the
     selected rows. Neither action changes the draft order.
  5. Drag-select and copy a model ID in the discovery list and in the selected
     pane. Confirm no reorder or checkbox toggle occurs. Click a discovery
     checkbox, toggle Advanced, edit an alias, and remove a selected model;
     each action retains its existing behavior without starting a drag.
  6. Save the reordered bindings, reopen the editor, then restart the app and
     reopen it again. Check order, aliases, model IDs, and Advanced settings.
     Check the provider default and existing session. Repeat with the service
     set as the app's default provider and with a different default provider.
  7. Change the order again, cancel the editor, and reopen it. The last saved
     order remains.
  8. Repeat the drag, keyboard, save/reopen, and cancel checks in the vendor
     account editor, including a filtered list with hidden selected bindings.
  9. Hold a save in flight and try drag and keyboard reordering. Release the
     save, then filter down to one visible selected row and try again.
- **Expected**: Both editors persist the complete ordered binding array. In
  step 2 the full order becomes `shown-c`, `shown-a`, `hidden-a`, `shown-b`,
  `hidden-b`; the hidden bindings remain present and retain their relative
  order. Moving a binding never resets its ID, alias, or Advanced overrides.
  Saving keeps the provider's compatibility default at the head binding. When
  that service or account is the app's default provider, saving also updates
  the app's default model to the head, preserving E2E-005A's existing behavior.
  Editing another provider leaves the app default unchanged. An explicitly
  bound session keeps its stored model choice.
  Canceled/outside drags leave the draft unchanged, editor cancellation
  discards unsaved moves, and busy or single-visible-row forms disable the
  reorder handles. Text copying and existing row actions remain independent.
- **Specs linked**: `03-runtime/13-model-catalog-and-selection.md` §2,
  `03-runtime/12-provider-config-schema.md`; ADR 0114, ADR 0192
- **Acceptance**: B (model configuration), F (persistence), Quality
- **Milestone**: M6+
- **Status**: Documented; full desktop journey has not been run.

## E2E-203a: Session thinking omit sends no provider override

- **Preconditions**: A configured reasoning model is selected in Composer.
- **Steps**: 1) Open the model × reasoning menu and confirm `omit` is the first
  reasoning option, followed by the binding's enabled canonical levels.
  2) Choose `omit` and confirm the chip shows `omit` and the session stores
  `thinkingLevel: omit`. 3) Send a turn and inspect the outbound request.
  4) Choose explicit `off` and send again. 5) In Settings → Model configuration,
  expand the same model's Advanced row and confirm the default picker lists
  `omit` first; save `omit` as the default and start a new session.
- **Expected**: `omit` persists and the request has no thinking/reasoning field.
  Explicit `off` still serializes a disable. A non-reasoning model keeps an
  `off`-only menu. A new session whose binding default is `omit` starts at
  `omit`.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `03-runtime/02-agent-runtime.md`, `03-runtime/13-model-catalog-and-selection.md`,
  ADR 0295 / D456
- **Acceptance**: C (chat/stream) + Quality
- **Milestone**: M6+
- **Status**: Unit/source-contract-covered; full UI journey Draft

## E2E-213: The first Composer model menu paint keeps configured aliases

- **Preconditions**: A runnable provider has at least one configured model with
  a non-empty alias and a cached or discoverable model record for that ID. The
  app has restarted, or the provider model cache has been invalidated.
- **Steps**: 1) Open the Composer model × reasoning chip. 2) Enter the Model
  submenu immediately and observe the first visible frame. 3) Keep the menu open
  until the cached/live model refresh completes. 4) Close and reopen the menu.
- **Expected**: The first visible row already uses the configured alias (or the
  configured ID when no alias exists), and the list never flashes empty or
  replaces the alias with a catalog name/wire ID during hydration. The same
  single display name remains after refresh and on the next open; selecting the
  row still sends the configured model ID.
- **Specs linked**: `03-runtime/13-model-catalog-and-selection.md`,
  `04-ux/08-component-spec.md`
- **Acceptance**: Quality (stable first paint), B (model selection)
- **Milestone**: M6+
- **Status**: Unit/source-contract covered (`composer-models.test.mjs`);
  full UI journey remains runner validation (run only in a capable environment when this surface changes)

## E2E-MODEL-catalog-window-correction-reaches-saved-bindings

- **Goal**: a models.dev limit correction — the context window or the output cap —
  reaches an already saved binding without deleting and re-adding the model, while
  a number the user entered in Settings is never overwritten.
- **Steps**:
  1. Configure a provider, select a model models.dev publishes a context window
     for, and save. Open the row's Advanced body and read the context-window field
     and its hint.
  2. Serve a corrected models.dev record for that model (a different published
     window), reopen Settings, and read the row, the context inspector, and the
     window a new session launches with.
  3. Type a window in the Advanced field — the preset ladder once and a
     hand-typed `128000` once — save, then serve another catalog correction and
     reopen Settings and the inspector.
  4. Save and reopen a provider row whose binding carries no
     `contextWindowSource`: once with the generic `128000` seed, once with any
     other stored value.
  5. Repeat step 4 with a row whose stored output cap is the generic `8192`, and
     one whose cap the user typed, and read the cap in the settings row and in the
     request a new session launches with.
- **Expected**: Step 1 shows the published number with the "follows the catalog"
  hint. Step 2 shows the corrected number everywhere the effective window is used
  (settings row, context inspector, session launch) with no delete and re-add.
  Step 3 keeps the entered number in the settings row, in the inspector, and in
  the launched request, including a hand-typed `128000` for a model whose
  published window is larger, and the hint is gone. Step 4 resolves
  deterministically: the `128000` seed follows the catalog, every other value
  stays as stored. Step 5 applies the same provenance rule to the output cap: an
  `8192` seed follows the published `limit.output`, and a cap the user entered is
  kept. Every step keeps the marker across the save/read round trip of the
  provider row, and a config written before the marker stays readable.
- **Specs linked**: `03-runtime/13-model-catalog-and-selection.md` §9.1,
  `03-runtime/12-provider-config-schema.md` §2,
  `03-runtime/11-provider-model-system.md` §2, `04-ux/06-settings-ia.md` §2
- **Acceptance**: B (model config), F (persistence), Quality
- **Milestone**: M6+
- **Status**: Partially automated:
  `apps/desktop/test/model-binding-catalog-source.test.mjs` drives the main-process
  resolver (catalog-sourced correction reaches the exposed row, a user value
  survives it, the generic seed still follows the catalog, an inherited value stays
  marked); `packages/shared/src/model-catalog.test.ts` covers the four source rules;
  `crates/host-core/src/providers/catalog.rs` covers the config round trip, the
  unmarked record, and the dropped unknown marker. The end-to-end settings journey
## E2E-PROVIDER-ORDER: Reorder configured AI services

- Open Model configuration with three providers and drag the last before the
  first, then after the last; verify pointer-following cards, live slot preview,
  and saved order. Check movement threshold, action-button exclusion, edge
  scrolling, Escape cancellation, and automatic-scroll cleanup.
- Cancel a drag and use Up/Down on a focused provider card. Verify no configuration or
  default-model changes. Failed saves report an error and retain accepted order;
  overlapping moves are blocked and late catalog reads cannot undo a move.
- Reopen the Composer model menu: groups follow the provider order. Restart the
  host and renderer and verify persistence. Check English and Chinese labels.
- Automated: `pnpm test:e2e:provider-order` runs the real settings component,
  sandboxed preload, provider IPC registrar, and an isolated Rust host. It uses
  synthetic Chromium pointer/key events and test providers without credentials;
  model-catalog/OAuth discovery is stubbed and no provider requests are sent.
- Host unit tests cover no metadata, disabled/plugin rows, new/deleted IDs,
  stale moves, no-op moves, preserved configuration, and reopening the database.

The provider-order suite also runs a 200-card fixture under a controlled animation
clock. A burst of 200 pointer events may arm React state once, but stationary
frames must produce no further renders or pending callbacks. Card geometry is
read at press time, and move/release/cancel/unmount paths must clear transient
transforms and queued frames. Release before the scheduled frame must still save
the latest destination. These assertions measure work counts, not device FPS.

## E2E-PROVIDER-certificate-trust-and-terminal-errors

- **Preconditions:** Built request candidate incorporating current `origin/main`,
  Electron installed, isolated test process/profile and loopback HTTPS fixture.
  No real provider, credentials, user profile, or OS certificate-store writes.
- **Steps:** Run `node scripts/e2e-provider-certificates.mjs`. Launch the actual
  desktop sidecar and submit a chat prompt against an untrusted localhost
  certificate. Relaunch with its CA in `NODE_EXTRA_CA_CERTS`, then request the
  same certificate through a hostname absent from its SAN.
- **Expected:** The child's default CA set includes every non-expired system
  root and extra CAs, while expired system-store entries are omitted. Bundled
  roots and inherited extra CAs remain available.
  The first request fails once with a non-retriable certificate error and no
  retry status; the trusted request returns text; the hostname mismatch still
  fails once. TLS and hostname verification remain enabled.
- **UI:** Run `node scripts/e2e-provider-certificate-ui.mjs` for the real error
  component in isolated Chromium. Certificate errors get localized guidance;
  DNS and protocol errors retain the generic summary. Errno/raw details remain
  visible, and details can be closed and reopened. Optional
  `PI_CERTIFICATE_EVIDENCE_DIR` records a screenshot; `--baseline` uses the
  upstream error component with the same fixture and stylesheet.
- **Lower-level coverage:** `provider-certificate-flow.test.ts` enters main
  session `prompt()` and delegate `run()` through real Agent/pi-ai wiring,
  with only the external fetch mocked. Both stop after one request and retain
  the certificate cause. Error classification and recovery suites cover direct,
  nested, flattened, non-certificate and wrapped certificate failures.
- **Limits:** OS-root inclusion is checked without installing a root. The TLS
  success fixture uses a child-only extra CA; it does not reproduce a specific
  antivirus installation or claim native macOS/Linux verification.

## E2E-PROVIDER-stored-binding-array-reads-entry-by-entry

- **Preconditions:** A throwaway data directory and the host-core binary; a
  provider created through `providers.create` with at least three complete
  bindings; no real provider or credentials.
- **Steps:** Call `providers.list` and confirm every binding returns. Edit the
  stored `config_json` to delete one binding's `maxTokens` and list again.
  Restore the field and list again. Then set one binding's `contextWindow` to a
  string and list once more. Attempt `providers.update` with the readable
  subset and an unrelated provider change.
- **Expected:** All three bindings return in every case except the malformed
  entry, where the readable bindings return in their stored order. The binding
  that lost `maxTokens` reads with the generic default output cap, and restoring
  the field restores the value. The host log names the provider id, the entry's
  index and the reason for the entry that could not be decoded. The explicit
  model-array update is rejected with `MODEL_BINDINGS_DEGRADED`, while the
  stored `config_json` remains unchanged.
- **Specs linked:** `03-runtime/12-provider-config-schema.md` §2,
  `08-meta/decisions-log.md` D610
- **Acceptance:** F (persistence), Quality
- **Status:** Unit-covered (`providers::catalog::tests`,
  `providers::tests::a_stored_array_survives_an_entry_that_lost_a_field`); the
  host RPC path is exercised by `scripts/e2e-smoke.mjs` for provider create and
  list, but no suite drives a hand-edited `config_json`.
## Hosted-search continuation contract (offline sidecar)

**Scope:** ADR 0297; provider-hosted search content, estimation, local tools,
Task delegation, and saved-history recovery. No real model or search service.

**Entry:** `pnpm test:e2e:hosted-search`, which rebuilds the shared
package and `@pi-desktop/agent-runtime` sidecar bundle. The test starts that
bundle over its ordinary stdio RPC interface, with an isolated data root,
a synthetic Host and a loopback-only Responses endpoint. Source-only mocks
or an already installed desktop application do not satisfy this test.

| Case | Required observation |
| --- | --- |
| Search then new user prompt | Valid search item is replayed and the second turn completes. |
| Search then ordinary local tool | A real tool round completes and the next provider request is prepared without type/estimation failure. |
| Search then Task | Actual delegation orchestration runs against a synthetic provider; parent continuation finishes without repeated local errors. |
| Saved search history restored | A fresh runtime preserves search replay without adding fake tool fields or rewriting the original record. |
| Usage invalidated by a real prefix change | The isolated sidecar changes instructions during a real Read round; the prior nonzero usage no longer covers that prefix, and continuation succeeds. |
| Invalid saved replay container | Restore returns safe INTERNAL/context-validation, sends no provider request or persistence Host RPC, and keeps the process healthy. In-memory immutability is checked by the replay unit tests. |
| Unknown saved search phase | The same explicit rejection is observed without silently discarding the search record. |

**Companion gates:** Responses/Azure/Anthropic/Codex adapter contracts; typed
search phases; zero/valid/stale usage; changed/unchanged system prefix and tool
ledger; search content growth and CJK output budgets; structured local
preparation failures without retry/fetch, ordinary transport retry and
cancellation. The Codex contract uses a synthetic JWT payload, captures the
request before fetch, proves opt-out omits the tool, and never contacts a
provider. Dependency upgrades must run these gates against the locked version
and record the tested bundle.

**Evidence:** record build and test exit codes, baseline SHA, dependency versions,
artifact identity and independent review in
`docs/project/hosted-search-contract-verification.md`. Never record private
conversation content or credentials. A skipped test remains NOT RUN, not PASS.

## E2E-PROVIDER-endpoint-guidance-and-search

- **Preconditions:** Isolated Electron/Chromium, production provider form,
  synthetic provider responses; no live keys or services.
- **Steps:** Open an existing DeepSeek, xAI and legacy OpenAI Completions entry.
  Check search directly, cancel, reopen, check and save, reopen, uncheck and save.
  Apply format advice on relay `/responses` and `/messages` operation URLs.
- **Expected:** One service entry and one checkbox; no separate search preset or
  interface-switch action. Save changes only the model opt-in, retaining URL,
  format, name, key and other model settings; Cancel writes nothing. A selected
  explicit format wins over hostname defaults. Relay advice preserves origin.
- **Specs:** 03-runtime/12 endpoint guidance; 03-runtime/11 search setup guidance;
  ADR 0297 official-route amendment.
- **Acceptance:** English/Chinese interaction flows and the previous custom and
  Codex account paths pass. Real adapter contracts verify opt-in request routes,
  credentials and search tools. A DeepSeek conversation continues off/on/off,
  retains prior text, and does not replay encrypted search blocks to Completions.
- **Milestone:** Provider configuration maintenance.
- **Status:** `pnpm test:e2e:provider-api-style` and
  `official-native-search.test.ts`; shared route tests reject lookalike hosts,
  unsafe URLs and unknown gateways. The UI fixture does not prove Host/SQLite
  persistence or live provider availability.

## E2E-OAUTH-pi-installation-identity-and-standalone-load

- **Preconditions**: Pi 1.1.0; temporary Host secrets and account fixtures;
  network/browser/callback I/O mocked; no user account or paid service.
- **Steps**: Run `installation-identity.test.mjs`, `vendor-oauth-login.test.mjs`
  and `oauth-standalone-bundle.test.mjs` under `apps/desktop/test`.
- **Expected**: One lazy, persisted UUID per installation; failed persistence
  never reaches login and is retryable. Multiple same-vendor accounts retain
  separate credentials. The standalone bundle executes the actual ChatGPT and
  Meta OAuth flows from outside the repository with empty `NODE_PATH`, including
  PKCE, callback validation and token conversion. Legacy Codex credentials remain
  unchanged; account deletion leaves the installation identity and other accounts.
- **Acceptance**: Offline identity/account/module-loading contracts pass.
- **Status**: Offline integration covered. Installed Electron artifact loading,
  Anthropic/Codex/Copilot flow execution and final migration packaging NOT RUN.

## E2E-PI-0991-account-operations-and-usage

- Scope: pi-ai and pi-agent-core; coding-agent design review is reference-only.
- Offline provider/catalog flows preserve same-vendor account isolation, live
  entitlement, unavailable-account errors, relay matching and explicit overrides.
- Native Pi image operation contract tests cover generations/edits, cancellation,
  downloads, multiple artifacts, text/response IDs and physical usage provenance.
- Shared/Main/Host tests replay parent, delegate and image records, including late
  old-turn usage, and assert one ledger entry per physical operation.
- Production sidecar hosted-search E2E covers seven scenarios with offline
  providers, delegation and persisted restore. Standalone OAuth tests execute
  actual login modules outside the repository with mocked external I/O.
- Installed Electron, real account/paid API and cross-version rollback are
  separate release qualification. No MCP, Codemode or virtual-router migration
  is included. See `docs/project/pi-0991-adoption.md` for candidate evidence.

## Composer recent chat models

- Send accepted messages using four distinct configured chat models across providers. Open the combined
  model menu: the Recent source is selected and lists the latest available pairs
  (up to six) in recency order, with provider labels. Select an older recent row: order stays unchanged until
  a message is accepted, at which point that model moves first.
- Search immediately; results span every provider and the rail selection is
  released; choose using keyboard navigation. Choose a provider in the source
  rail and verify each of its models appears once. Move from a recent row to the
  rail, and tab out of search after arrow navigation: no stale keyboard
  highlight remains on a model row. Without history and with one provider, the
  rail is hidden and all configured models are directly visible. With a
  search typed, Escape clears it and keeps the menu open; a second Escape
  closes the menu. Verify thinking
  defaults still follow the selected binding and manual same-model levels survive.
- Create a new chat: it inherits the last actually used model. Reload local preferences
  and create another chat: the same binding is restored. An existing chat keeps
  its own binding, including when opened after a different model was used.
  Opening an old chat or changing a model or reasoning alone does not alter history.
  Send in an older chat: accepted submission updates new-chat inheritance;
  rejected submission does not. Deferred configuration alone does not count
  as usage.

- **Preconditions:** Isolated Electron profile, fake Host IPC/secret storage,
  and a `globalThis.fetch` fixture for `https://api.typesafe.ai/v1/systemone`.
  Build workspace JS packages with `pnpm build:js`, then run
  `pnpm test:e2e:jev`. Do not use a real TypeSafe key or endpoint.
- **Steps:** 1) On the service chooser's add path, confirm Jev is offered in
  its own Classifiers group and absent when an existing row changes service,
  and that no Jev card is on the model configuration page yet. 2) Open the Jev
  form, paste a sentinel key and Check and save: the fixture answers the check,
  the key reaches Host secure storage, Jev is on, and the card appears. Confirm
  AI services (with catalog status and refresh) precede Jev and image generation,
  and that the card's privacy explanation is available from its heading help
  control instead of as a persistent paragraph.
  3) Resolve a session launch with Jev enabled, then disabled and in Plan mode.
  4) Through the runtime's deferred catalog, request Jev in Agent mode and
  inspect Plan/Goal catalogs. 5) Call `JevClassify` with one choice, one score
  and one boolean question over a small JSON state. 6) Answer a check with 401
  for a second key: nothing is written and Jev stays off. 7) Start a check and
  close the dialog while it is still in flight: the key is not stored and Jev
  stays off. 8) In the Jev card, switch Jev off and remove the key; the card
  leaves with it.
- **Expected:** The check runs before any write, in the order check, store, then
  enable, so a refused key leaves no secret and no enabled setting behind, and
  the refusal is reported with TypeSafe's status. The card is on the page only
  once Jev has been added, and it leaves when the key does. The UI never returns
  the key to settings state, and removal disables Jev before deleting it. Only
  the Jev title, key status and controls occupy the card; explanatory privacy
  copy appears on demand from the heading help control. AI services stay above
  Jev, followed by image generation. An enabled Agent launch reads the key and
  passes it ephemerally to the sidecar.
  `JevClassify` appears in the Agent's deferred catalog only with a key and
  never in Plan or Goal. Closing the dialog cancels an in-flight check the same
  way a refused key does: nothing stored, nothing enabled. The fixture receives
  the TypeSafe System One payload and bearer header; the tool returns bounded
  structured answers and usage.
- **Specs:** [Tools and permissions](../../03-runtime/03-tools-and-permissions.md),
  [provider/model system](../../03-runtime/11-provider-model-system.md),
  [secrets storage](../../03-runtime/14-secrets-storage.md),
  [settings IA](../../04-ux/06-settings-ia.md).
- **Acceptance:** No paid or real-provider call. The suite verifies the UI user
  path, the ordered check-then-store gate, the refused-key path, the fixed
  secret reference, opt-in Agent launch boundary, deferred mode catalog,
  request body, bearer auth, usage, error redaction, cancellation, timeout,
  malformed and oversized input rejection, and key removal.
- Disable/remove a provider or model and mark a model for image generation:
  unavailable history entries are skipped for inheritance and recent menu rows.
- Settings contains no fixed chat-default picker or Make default service action;
  image model selection and provider configuration remain available.
- Coverage: recent-models.test.mjs, recent-model-flow.test.mjs,
  default-model-picker.test.mjs, and scripts/e2e-composer-model-selection.mjs.

## E2E-FAST-MODE: `/fast` asks for the priority tier only on an allowed model

- **Preconditions**: A ChatGPT subscription (Codex) account and a Responses
  API-key provider, each with two configured models. No real provider is
  required for the automated path; the manual path uses a capturing local
  endpoint or the user's authorized account.
- **Steps**:
  1. In Settings → Models, check **Fast mode** on one model of each provider.
     Confirm the checkbox is disabled on a Chat Completions provider.
  2. Start a new task on the allowed Codex model, type `/fast`, send a prompt.
  3. Send `/fast` again, then send another prompt.
  4. Switch the session to the model without the opt-in and send `/fast`.
  5. Fork the session while Fast is on; restart the app and reopen both.
- **Expected**: Step 1 persists `fastModeAllowed` on the binding only. Step 2
  shows the Fast mark on the model chip and the request body carries
  `service_tier: "priority"`; a Responses API-key model shows the per-token
  price toast instead. Step 3 clears the mark and the field. Step 4 refuses
  with the model-settings hint and stores nothing. Step 5 keeps the switch on
  the fork and across restart. Subagent and compaction requests never carry
  the field. Remote sessions refuse `/fast`. A trusted extension that switches
  the session to its own Responses model sends its next request without the
  field.
- **Specs linked**: `03-runtime/11-provider-model-system.md`,
  `03-runtime/04-data-storage.md` (v27), `04-ux/04-builtin-commands.md`,
  ADR 0334, issue #1657.
- **Status**: Automated coverage: `apps/desktop/test/fast-mode-command.test.mjs`
  (draft → created session, toggle, refusals, remote, chip),
  `apps/desktop/test/fast-mode-session-launch.test.mjs` (launch resolution),
  `packages/agent-runtime/src/fast-mode.test.ts` (request body through the real
  pi-ai Responses and Completions adapters),
  `packages/agent-runtime/src/fast-mode-reuse.test.ts` (mid-session switch on a
  reused runtime; an extension model switch drops the tier), host-core
  migration, RPC and fork
  tests. The full settings → `/fast` → captured request path is a manual
  validation scenario.

## E2E-PROVIDER-optional-client-certificate

- **Preconditions:** The locked Electron 43 runtime, built workspace packages,
  and an isolated profile. Only a local HTTPS fixture and local proxy are used;
  trust is confined to the test process/session and fixture certificate.
- **Steps:** Run `node scripts/e2e-provider-client-certificate.mjs`. Confirm one
  real `net.fetch` fails or stalls before HTTP. Replay that isolated fixture
  failure for subsequent probes to avoid a second Chromium TLS handshake, then
  exercise model discovery and connection through the real metadata fallback;
  repeat with an invalid fixture key and an authenticated custom HTTP proxy.
  Return a cross-origin redirect, then cancel a pending response.
- **Expected:** Valid credentials return the fixture model; invalid credentials
  reach HTTP 401. The retry follows the proxy route, sends no client identity,
  refuses cross-origin redirects and aborts with the original signal.
- **Security coverage:** `provider-https-metadata.test.mjs` additionally checks
  mandatory client authentication, untrusted server certificates, hostname
  mismatch, compressed responses, and late-tunnel cleanup. The metadata policy
  tests reject fallback on other TLS/network errors or HTTP failures.
- **Specs linked:** `03-runtime/07-process-model.md`,
  ADR `provider-metadata-client-certificate-retry`, issue #1676.
- **Acceptance:** Recovery without an Electron major upgrade, TLS verification
  bypass, direct proxy bypass, or change to persisted provider bindings.
- **Milestone:** Maintenance.
- **Status:** Automated fixture; record the tested head/base and execution
  result in the delivery report.

## E2E-PROVIDER-reasoning-effort-override: Preserve an explicit gateway reasoning parameter

- **Setup:** A custom Chat Completions provider with a DeepSeek-family model;
  start with a legacy binding that omits `supportsReasoningEffort`.
- **Steps:** In English, Chinese and German at 850/1000/1400px widths, open model settings, confirm Auto, select
  Send, save and reopen; repeat for Do not send and Auto. Switch to Responses
  and Anthropic and confirm the Completions-only control is hidden.
- **Expected:** Each saved binding retains true, false, or null respectively.
  With High selected, the real Completions adapter sends `reasoning_effort: high`
  only when enabled; Auto keeps the existing DeepSeek compatibility default.
  Responses continues using its own reasoning contract. Provider creation,
  update/read, copying, and sync preserve the explicit override.
- **Automation:** `node scripts/e2e-provider-api-style.mjs --reasoning-effort` exercises real
  React/Chromium controls and captures the Host API payload (the IPC boundary is
  stubbed). Rust provider tests independently verify real SQLite persistence;
  `provider-reasoning-effort.test.ts` captures requests from the real pi-ai
  adapter with fixture SSE responses. No live gateway credentials are required.

## E2E-ISSUE-1789

Image-model marking explains chat/default-menu exclusion and distinguishes generation from image input. Collapsed model rows retain an image-model badge. Verify marking, help, collapsing, unmarking and restored chat eligibility through `image-model-disclosure-user-path.test.mjs`.

## E2E-PI-152-kernel-upgrade

- **Preconditions:** Exact Pi 1.5.2 release-group pins and rebased package
  patches in a dedicated worktree, isolated fixture state, and no real provider
  credentials.
- **Steps:** Run the runtime, native Pi session, identity, and patch-gate
  suites against the installed 1.5.2 packages. Drive an Anthropic-compatible
  loopback gateway with message threads enabled through a main turn, a
  delegate request and a compaction summary that share the session id, then a
  second main turn. Dispose the runtime and start a new one for the same
  session id.
- **Expected:** The main conversation creates one thread and continues it with
  only the new turn; delegate and summary requests send no `thread` field and
  leave the conversation's continuation intact. After disposal the next
  runtime creates a new thread. Hosted-search capture and local request-error
  mapping from the Desktop patches remain intact. Identity headers report
  1.5.2. No provider credentials or live services are used.
- **Coverage:** `pi-anthropic-message-threads.test.ts`,
  `pi-upstream-1.5-identity.test.ts`, `pi-upstream-1.5-contract.test.ts`,
  `pi-1.5-adapter-features.test.ts`, `pi-anthropic-strict-fallback.test.ts`,
  `pi-ai-provider-sync.test.ts`, `provider-presets.test.ts`,
  `scripts/pi-patch-hash.test.mjs`, `pnpm check:pi-patches`,
  `pnpm check:pi-dependencies`.
- **Specs:** [Pi dependency boundary](../../02-architecture/06-pi-runtime-dependency-boundary.md).
- **Acceptance:** Offline runtime/contract validation.
- **Milestone:** Maintenance.
- **Status:** Candidate validation recorded in `docs/project/pi-152-adoption.md`.

# 04. E2E Test Plan

> Scope: MVP acceptance scenarios plus current shipped product increments for PI-Desktop
> Status: Accepted (protocol/Electron automation is active; full desktop Playwright remains planned)
> Cross-references: [acceptance-criteria](02-acceptance-criteria.md) · [milestones](01-mvp-milestones.md) · [ai-development-workflow](03-ai-development-workflow.md) · [change-checklist](05-change-checklist.md)

---

## 1. Goals

- Document every user-visible and protocol-visible behavior that MVP must verify.
- Provide a scenario catalog that maps to acceptance criteria (A–H) and milestones (M1–M6).
- Serve as the traceability backbone: scenario ID ↔ acceptance criterion ↔ spec.
- Prepare for future automation without requiring implementation now.

## 2. Non-goals

- Full UI-driven automated coverage; protocol and source-contract automation is
  active while the broader desktop suite remains planned.
- Performance / stress testing (post-MVP).
- Native Windows/Linux release qualification (published artifacts exist; native
  qualification gaps remain documented).
- Hostile-plugin sandbox scenarios. Publisher provenance and the marketplace
  download boundary are now in scope (E2E-024R through E2E-024V); basic
  browse/install/update flows were already part of the catalog.
- Remote gateway / control-plane scenarios (post-MVP — ADR 0004 / baseline #20).

---

## 3. Test Pyramid

```
        ╱  E2E  ╲           — few, high-value, cross-system
       ╱ Integration ╲      — IPC/RPC contracts, host↔renderer
      ╱    Unit       ╲     — per-module, fast, isolated
```

| Level | Scope | Count target | Tooling |
|---|---|---|---|
| **Unit** | Single module, no IPC | Many | Vitest / Rust #[test] |
| **Integration** | IPC contract, host↔renderer, host↔sidecar | Moderate | Vitest + IPC mocks or live Electron |
| **E2E** | Full user journey through the desktop app | 100+ functional + US-UI visual catalog | protocol smoke + Electron probes now; Playwright later |

**Strategy**: document all E2E scenarios now; add or update unit/integration
tests alongside code when change risk makes them necessary; automate E2E after
M5.

---

## 4. Tooling Intent

| Tool | Purpose | Status |
|---|---|---|
| **Vitest** | Unit + integration (TS side) | Active (`pnpm test`, shared package) |
| **Rust #[test]** | Host-core unit tests | Active (`cargo test -p host-core`) |
| **Protocol smoke** | Host RPC + tools + plugins headless | Active (`test:e2e`, 20 checks) |
| **Electron probes** | Boot bridge + crash supervision | Active (`test:e2e:boot`, `test:e2e:supervision`) |
| **Playwright** | Full UI-driven journeys | Planned (post-M5) |

> Decision: document scenarios now; pick concrete E2E runner when code is ready for M5 hardening.

---

## 5. Environment Requirements

| Requirement | Detail |
|---|---|
| Platform | macOS arm64 and Intel x64, Windows x64, and Linux x64 release targets (D126/D285) |
| Profile | Clean `~/.pi-desktop` profile (no prior config) |
| Fixtures | Sample project directory (`examples/fixtures/sample-project/`) |
| Sample plugin | `examples/plugins/hello` loaded from local path |
| Provider | At least one provider with a valid key (test account) |
| Display | Headless-capable Electron or real display |

---

## 6. Scenario Template

Each scenario is documented in this format:

```markdown
### E2E-<ID>: <title>

- **Preconditions**: what must be true before steps start
- **Steps**: ordered list of user / system actions
- **Expected**: observable outcome that proves correctness
- **Specs linked**: relevant spec file(s)
- **Acceptance criterion**: which A–H letter(s) this verifies
- **Milestone**: M1–M6 target
- **Status**: Draft | Documented | Partially automated | Automated | Passed
```

---

## 7. MVP Scenario Catalog

### Runtime Resource Governance

#### E2E-097: Tool burst is bounded and recovers after host restart

- **Preconditions**: Host-core is healthy; one session has a workspace; the
  supervision probe can terminate the host process.
- **Steps**: 1) Dispatch a burst larger than the host tool budget containing
  read tools and shell commands. 2) Observe `app.health` while the burst runs.
  3) Terminate host-core during active calls. 4) Wait for one supervised
  restart. 5) Allow the persistence outbox to flush.
- **Expected**: Active shell processes never exceed the configured global and
  per-session limits. Excess work returns `HOST_OVERLOADED` or waits in the
  bounded queue. Only one restart loop runs; stale-generation calls fail fast
  as `HOST_UNAVAILABLE`; no repeated `ERR_STREAM_DESTROYED` persistence storm
  is emitted. Temporary OS thread pressure during the same burst does not
  terminate host-core through its stdio control path; the host remains on one
  generation and capacity errors stay structured. Completed assistant/tool
  messages are persisted once after recovery.
- **Specs linked**: `03-runtime/06-host-rpc-protocol.md`,
  `03-runtime/07-process-model.md`, `03-runtime/08-error-codes.md`,
  `03-runtime/09-logging-and-observability.md`, ADR 0051
- **Acceptance**: A (runtime health), C (tool execution and recovery)
- **Milestone**: M5
- **Status**: Documented; automation pending

### Boot & Healthcheck

#### E2E-001: App launches and shows main window

- **Preconditions**: macOS arm64 or Intel x64; no prior `~/.pi-desktop` profile. For the
  development lane, workspace package build outputs are absent or older than
  their TypeScript sources.
- **Steps**: 1) Launch PI-Desktop. In the development lane, use `pnpm dev`.
  2) Observe main window appears.
- **Expected**: Development launch rebuilds all workspace dependencies before
  host-core and Electron startup. Window first shows the branded startup splash
  while bootstrap runs, then reveals the main shell in English with the current
  locale catalog; no compile error, missing-menu runtime error, or crash;
  version info visible.
- **Specs linked**: `03-runtime/07-process-model.md`, `04-ux/01-ui-ia.md`
- **Acceptance**: A (app startup)
- **Milestone**: M1
- **Status**: Partially automated (`runtime-build-contract.test.mjs` covers the
  dependency build contract; Electron window launch remains Draft)

#### E2E-002: IPC bridge is functional

- **Preconditions**: App is running.
- **Steps**: 1) Trigger an action that calls preload IPC (e.g. version query). 2) Observe result in renderer.
- **Expected**: Main↔renderer IPC returns expected data; no error.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`
- **Acceptance**: A (bridge normal)
- **Milestone**: M1
- **Status**: Automated (`scripts/e2e-electron-boot.mjs` — sandboxed preload bridge + IPC round-trip)

#### E2E-003: Rust host healthcheck responds

- **Preconditions**: App is running; Rust host-core sidecar started.
- **Steps**: 1) Electron handshakes with protocol version 10. 2) Call the host
  healthcheck RPC. 3) Repeat boot with mismatched older and newer protocol
  fixtures.
- **Expected**: The protocol v10 host returns `ok` and the handshake is logged.
  Every version other than v10, whether older or newer, is rejected before the
  conversation surface becomes interactive, so Plan approval/state events and
  context checkpoints cannot be silently lost.
- **Specs linked**: `03-runtime/05-host-core-rust.md`, `03-runtime/06-host-rpc-protocol.md`
- **Acceptance**: A (bridge normal)
- **Milestone**: M1
- **Status**: Automated (protocol smoke)

#### E2E-004: First-run inline checklist appears

- **Preconditions**: Fresh profile (no `~/.pi-desktop`).
- **Steps**: 1) Launch app on fresh profile. 2) Observe onboarding checklist.
- **Expected**: Inline checklist is displayed; provider/key items open Settings
  → Agent, and the optional plugin item opens the app-shell Plugins
  destination.
- **Specs linked**: `04-ux/05-onboarding.md`
- **Acceptance**: A (first-run checklist)
- **Milestone**: M2
- **Status**: Automated (protocol smoke: host onboarding state; UI checklist manual)

### Provider & Key

#### E2E-169: Default model picker selects a configured model

- **Preconditions**: Two runnable providers exist; one provider has at least two configured model bindings.
- **Steps**: Open Settings → Model configuration → Change default model, then select the second model under the provider.
- **Expected**: The Defaults card presents a compact settings row with the
  provider name and exact model ID beneath the Default model label; its quiet
  Change action does not repeat the current value. The picker groups
  model-level entries by provider, marks the exact current model, and a newly
  created session inherits that exact model and its owning provider.
  Searching by provider or model filters locally, the result list scrolls without moving the settings card, and an unmatched query shows an empty state.
- **Specs linked**: `03-runtime/13-model-catalog-and-selection.md`
- **Acceptance**: B (model selection)
- **Milestone**: M6
- **Status**: Documented; automation pending


#### E2E-005: Add a provider and save API key

- **Preconditions**: App running; no provider configured; the models.dev snapshot ships with the build.
- **Steps**: 1) Open Settings → Model configuration and choose Add provider. 2) Confirm the dialog is ONE form and no stepper, no preset grid and no Next/Back buttons. The first control is Service — a searchable menu (Choose a service, Custom endpoint, then a flat vendor list from models.dev including Xiaomi), not a native select, region grouping, or vendor-card grid. Open it, type to filter client-side, then choose **Custom endpoint**. Confirm Name and Base URL appear on one row, API Key and API format appear side by side on the next row (not behind Advanced), and that a focused field plus its 2px accent ring stays fully inside the dialog, including on a window narrower than 1040px. 3) Enter a name and a base URL for a service that publishes a `/models` route, then paste an API key. 4) Confirm the models section fills with the models THAT SERVICE returned, not with every model its vendor publishes; confirm a model the deployment does not host is absent. 5) Type in the filter box and confirm the list narrows client-side with no network request per keystroke. 6) Confirm each row shows the models.dev-derived context/output for models the catalog knows, and that a model with no catalog match still lists with generic defaults. 7) Select two models with the checkboxes. 8) Expand Advanced on one chosen row, override its limits and toggle thinking chips; confirm the label and optional hint sit above one compact grouped control and do not force the options onto a second row at normal dialog width; confirm all seven canonical levels are available, that published levels start selected for a known reasoning model, and that a non-reasoning or unknown row shows the same chips unselected with the manual-override hint; enable one level on that row and confirm the other row is unaffected. 9) Open the form-level Advanced and confirm the API format is present but pre-derived. 10) Add a free-form model ID the service did not return; confirm it is added with 128,000 / 8,192 / no-thinking defaults, then enable a thinking level if the endpoint supports it; confirm re-adding the same ID in different letter case is rejected as already added. 11) Save.
- **Expected**: The service is asked first and models.dev only enriches the answer and seeds known-model defaults. The settings picker always offers the seven canonical thinking levels, and the Composer later renders the explicit levels saved in the same model binding; an empty or `off`-only binding resolves to `off`. Discovery is debounced ~600 ms, does not mark loading until that window elapses, and a slow reply from an earlier keystroke never replaces a newer list; named add-path discovery waits for an API key, while an unsaved custom provider is probed with the typed base URL (and key, if any) before it exists. The user never types a token limit on the common path. Custom endpoint keeps API format beside the key; named endpoints do not show format. Point a second provider at a base URL with no `/models` route and confirm the list falls back to the catalog, is labelled as coming from models.dev rather than the service, and still saves. The provider appears as a row with its host, model count and secret badge; the key is stored securely (not in plaintext config); `models` contains both bindings and `models[0]` remains the provider default.
- **Specs linked**: `03-runtime/11-provider-model-system.md`, `03-runtime/12-provider-config-schema.md`, `03-runtime/13-model-catalog-and-selection.md`, `03-runtime/14-secrets-storage.md`, `04-ux/06-settings-ia.md`
- **Acceptance**: B (multi-model provider configuration, save key)
- **Milestone**: M2
- **Status**: Manual UI + automated protocol smoke (provider create + secret, no plaintext echo)

#### E2E-005A: Edit provider model bindings and migrate a legacy model

- **Preconditions**: One provider saved with two model bindings; one fixture provider row exists with only the legacy `default_model_id` and no `config_json.models`.
- **Steps**: 1) Reopen the saved provider; confirm the single form opens with its cached model list painted immediately, and that the API key field explains an unchanged key is kept. 2) Confirm the live probe then refreshes that list without a retyped key, because the stored secret is reused. 3) Confirm both existing bindings are still chosen and check-marked, with their limits, thinking chips and defaults intact. 4) Enable a level the fixture catalog does not publish, edit one row's limits and save. 5) Reopen the fixture provider and confirm its legacy model appears as one chosen row with 128,000 context, 8,192 max output and all seven thinking choices available but unselected. 6) Save the fixture provider without changing the model. 7) Make the edited provider the global default, reopen it, remove its first model so a different binding becomes the head, and save. 8) Take the service offline or revoke the key, reopen the provider, and confirm the cached rows stay visible with the discovery error shown rather than an empty list.
- **Expected**: Editing never drops an unmodified binding. An explicitly enabled level remains saved even when the catalog does not publish it, so the Composer reads the same binding rather than silently narrowing it; a binding whose model discovery is unavailable keeps its stored levels untouched. Legacy read materializes one binding without losing the old model ID; the subsequent write stores `config_json.models` and keeps `defaultModelId` equal to the first binding for older readers. When the edited provider is the global default and its first model changed, `settings.defaultModelId` is re-synced to the new head binding. A failed live probe degrades to the cached list plus an error, never to a blank picker, and a catalog fallback is never written into the model cache.
- **Specs linked**: `03-runtime/11-provider-model-system.md`, `03-runtime/12-provider-config-schema.md`, `03-runtime/13-model-catalog-and-selection.md`, ADR 0114
- **Acceptance**: F (provider persistence and migration)
- **Milestone**: M2
- **Status**: Unit-covered host migration; manual UI journey

#### E2E-005B: Configure the fixed OpenCode Go API-style preset

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

#### E2E-005C: OpenAI-compatible system role fallback

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

#### E2E-005D: Configure a Zhipu / Z.AI named endpoint preset

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

#### E2E-006: Key survives restart

- **Preconditions**: Provider + key configured.
- **Steps**: 1) Quit app. 2) Relaunch. 3) Open Settings → Agent → Providers.
- **Expected**: Provider still listed; key usable (no re-entry needed).
- **Specs linked**: `03-runtime/14-secrets-storage.md`
- **Acceptance**: B (key survives restart)
- **Milestone**: M2
- **Status**: Draft

#### E2E-007: No-provider blocking prompt

- **Preconditions**: App running; no provider configured.
- **Steps**: 1) Attempt to start a chat.
- **Expected**: Clear blocking prompt explaining that a provider must be configured.
- **Specs linked**: `04-ux/06-settings-ia.md`
- **Acceptance**: B (blocking prompt)
- **Milestone**: M2
- **Status**: Draft

### Conversation Stream & Abort

#### E2E-008: New session and send message

- **Preconditions**: Provider configured.
- **Steps**: 1) Create new session. 2) Type a message. 3) Send.
- **Expected**: The transcript immediately shows a compact localized `Working…`
  status after send, before the first assistant or tool event. It yields to
  concrete thinking/tool/answer feedback, and disappears when the turn ends.
  The conversation topbar keeps only the task title and window actions; it does
  not add a separate running-state indicator.
- **Specs linked**: `03-runtime/02-agent-runtime.md`, `03-runtime/10-session-state-machine.md`
- **Acceptance**: C (new session, send message)
- **Milestone**: M2
- **Status**: Automated (protocol smoke, live-model lane; requires PI_DESKTOP_TEST_API_KEY)

#### E2E-008a: First-turn tools load on demand

- **Preconditions**: Agent mode; provider configured; `BrowserPreview` or an
  enabled plugin tool is available; request capture can inspect the first and
  subsequent provider payloads.
- **Steps**: 1) Create a fresh session and send a simple prompt. 2) Inspect
  the first provider request's tool list. 3) Ask the agent to create or edit an
  HTML page and observe the tool activity. 4) Start a second user prompt after
  the preview task completes.
- **Expected**: The first request contains only the mode core tools (Agent:
  `Read`/`Bash`/`Edit`/`Write`; Chat: `Read`/`Glob`/`Grep`)
  and local `ToolSearch`; deferred schemas are
  represented only by a bounded `# On-demand tools` catalog. The agent calls
  `ToolSearch` before `BrowserPreview` (or the selected plugin/`Skill` tool)
  when the capability is needed, and the matching schema is available on the
  next model turn. For a user-visible HTML deliverable, `BrowserPreview` is
  called once after creation or the first meaningful visual edit, then reused
  through live reload while the page is refined. Generated, test-only, and
  non-visual HTML files do not trigger a preview call. The loaded set does not
  leak into the next prompt's first request. Tool activation markers survive
  transcript reload without granting a host permission or workspace escape.
- **Specs linked**: `03-runtime/02-agent-runtime.md` §7.1,
  `03-runtime/03-tools-and-permissions.md` §2.1, ADR 0048,
  `08-meta/decisions-log.md` (D185)
- **Acceptance**: C (first turn and stream) + E (tool execution)
- **Milestone**: M5
- **Status**: Unit-covered (`agent-runtime` deferred-tool tests); live-model
  request capture and full Electron journey pending

#### E2E-009: Streamed tokens visible in UI

- **Preconditions**: Session active; message sent.
- **Steps**: 1) Request a long answer containing Markdown and inline/display
  math. 2) Observe the assistant response as it streams. 3) Let the answer
  complete and inspect the renderer console.
- **Expected**: Runtime chunks appear progressively through the incremental
  Markdown renderer and the final response is complete. The renderer does not
  start a second animation-frame typewriter loop, raise React error 185, or
  reject Vite-inlined KaTeX fonts under CSP.
- **Specs linked**: `03-runtime/02-agent-runtime.md`,
  `04-ux/08-component-spec.md`, `04-ux/09-interaction-patterns.md`,
  `05-security/01-security.md`
- **Acceptance**: C (streamed output), Quality
- **Milestone**: M2
- **Status**: Partially automated (protocol live-model stream plus renderer
  source regression in `renderer-stream-safety.test.mjs`; full UI observation
  remains Draft)

#### E2E-010: Abort generation

- **Preconditions**: A session can produce both a deliberately delayed first
  token and a streaming response.
- **Steps**: 1) Send ordinary text and stop before assistant text, thinking, or
  a tool row begins. 2) Confirm the user row is undone and the text returns to
  the composer. 3) Send again, wait for partial output, then stop during the
  stream. 4) Observe the transcript and composer.
- **Expected**: The unanswered send is undone and its draft restored. The
  streaming send stops with its partial response preserved and no draft
  restoration or duplicate user turn. The session remains usable.
- **Specs linked**: `03-runtime/02-agent-runtime.md`
- **Acceptance**: C (abort)
- **Milestone**: M2
- **Status**: Draft

#### E2E-171: Streaming reply survives quit, crash, and stop

- **Preconditions**: A session whose transcript is longer than one renderer
  page (more than 100 messages) and a model that streams a reply for at least
  ten seconds before its first tool call.
- **Steps**: 1) Send a prompt and let the reply stream for ~5 s. 2) Quit the
  app (Cmd+Q / tray Quit) mid-stream, relaunch, and open the session. 3) Repeat
  the send, then kill the agent sidecar process mid-stream and observe the
  transcript. 4) Repeat the send, press Stop mid-stream, then reopen the
  session from the sidebar and inspect `sessions/<id>.jsonl` and
  `sessions/<id>.inflight.json`. 5) Repeat the send and let it finish normally.
- **Expected**: 2) The session shows the user prompt followed by the streamed
  text up to at most 1.5 s before the quit, as an `aborted` assistant row under
  an `aborted` turn; nothing earlier in the session is missing or truncated. 3)
  The streaming row settles to `aborted` in place with its text, the same row
  is present after a reload, and no `.inflight.json` remains. 4) The partial
  reply is visible immediately after Stop and after reopening; the transcript
  file was not rewritten (its earlier lines are byte-identical) and the
  checkpoint file is gone once the aborted final row landed. 5) The completed
  reply has exactly one row per assistant fragment, no `aborted` duplicate, and
  no checkpoint file.
- **Specs linked**: `03-runtime/04-data-storage.md`,
  `03-runtime/06-host-rpc-protocol.md`, `03-runtime/07-process-model.md`,
  `03-runtime/01-ipc-protocol.md`
- **Acceptance**: C (abort), F (persistence)
- **Milestone**: M2
- **Status**: Draft

#### E2E-011: Switch between project and temporary sessions

- **Preconditions**: One retained project session and one path-less Temporary
  session exist. Both transcripts exceed one viewport and have distinct final
  records.
- **Steps**: 1) Open the project session from its exact-path sidebar group. 2)
  Scroll to an earlier record and confirm the jump-to-latest control appears.
  3) Open the Temporary session and observe its first painted frame. 4) Switch
  rapidly project → Temporary → project while the first two transcript reads
  are delayed, and observe which row responds and which destination commits. 5)
  Hover/focus Temporary, switch to it again to exercise the warm cache, then
  repeat with reduced motion enabled. 6) Observe chat content and workspace
  chrome.
- **Expected**: The sidebar contains no Recents aggregate; retained projects
  have scoped groups and path-less sessions remain under Temporary; each
  transcript loads correctly; selecting Temporary clears project context and
  inherits no workspace access; both sessions remain persisted. Every session
  first activation paints its distinct final record at the transcript bottom
  without first exposing the transcript top, another session's scroll position,
  or a stale jump-to-latest control. The latest clicked row responds immediately
  and its transcript request does not wait for superseded reads; only the final
  project/session/work-panel tuple commits. On a cold switch the currently
  visible pane keeps showing its own session under a thin progress track until
  the destination commits, with the composer keeping its settled home/docked
  shape but inert so no prompt can reach the session being left; no transcript is
  dimmed at any point. A warm revisit reveals the retained pane immediately at
  its own content and scroll position, then revalidates in place without a
  visible change. Reduced motion keeps the progress track static and preserves
  the same destination without a skeleton remount or animated traversal through
  history.
- **Specs linked**: `03-runtime/10-session-state-machine.md`,
  `04-ux/01-ui-ia.md`, `04-ux/08-component-spec.md`,
  `04-ux/09-interaction-patterns.md`
- **Acceptance**: C (switch sessions)
- **Milestone**: M2
- **Status**: Source-level regression covered; full visual scenario Draft

#### E2E-011g: Open large and long sessions through bounded transcript windows

- **Preconditions**: A session contains a message with at least 50 MB of text
  or tool output and enough additional messages to span several transcript
  pages; a second session contains a long ordinary conversation.
- **Steps**: 1) Open each session from the sidebar while recording the first
  visible transcript frame and renderer responsiveness. 2) Scroll to the top
  of the transcript. 3) Repeat the open/close cycle after the session has been
  cached. 4) Inspect the host request/response or test fixture for the session
  read window.
- **Expected**: Opening paints the newest bounded page without transferring
  the complete 50 MB value to the renderer. The large value is visibly marked
  as truncated for display while the transcript and model-facing read remain
  lossless. Reaching the top loads older pages incrementally and preserves the
  viewport position; the final page reports no older history. Reopening a long
  session reuses the bounded cache and does not synchronously construct every
  historical row before the latest messages become usable. Edit, delete,
  revision, and Stop operations rehydrate the full transcript before any
  rewrite, so older messages are never lost because only a window was visible.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `03-runtime/04-data-storage.md`, `03-runtime/06-host-rpc-protocol.md`,
  ADR 0120
- **Acceptance**: C (session open and scroll), F (persistence), Quality
- **Milestone**: M5
- **Status**: Source-level regression covered; full large-fixture Electron
  journey Draft

#### E2E-011a: New session while another session is still streaming

- **Preconditions**: Provider configured; session A is streaming a long
  response (composer shows the stop/abort control).
- **Steps**: 1) While A is still streaming, click New task / New chat. 2)
  Observe the fresh session's composer. 3) Type a prompt and send it while A
  continues streaming in the background. 4) Let A finish and observe the
  fresh session's composer again.
- **Expected**: The previous streaming transcript leaves the screen on the
  first frame. The new session immediately shows the empty home and the idle
  Send control (never a stuck stop/abort control) and its textarea is enabled;
  the prompt sends and streams normally while A keeps running in the
  background. When A ends, its cross-session `agent_end` does not change the
  new session's composer state, which remains idle with the Send control.
- **Specs linked**: `04-ux/08-component-spec.md` (§11.4),
  `04-ux/09-interaction-patterns.md` (§1.6, §11)
- **Acceptance**: C (session isolation, chat & stream)
- **Milestone**: M2
- **Status**: Unit-covered (`composer-send-state.test.mjs`); full UI scenario Draft

#### E2E-011b: Create a new session from a retained project group

- **Preconditions**: Provider configured; at least one retained project is
  visible in the sidebar; the current conversation may be idle or streaming.
- **Steps**: 1) Click the project group's New session control. 2) Wait for the
  project conversation to load. 3) Type a prompt and inspect the Send control.
  4) Send without clicking New session again.
- **Expected**: Project activation commits as one renderer navigation flow.
  Reuse is decided from the in-memory list plus renderer empty signals
  (`messageCount`, live rows, running flag, submitted drafts), not a blocking
  `session.list`. If the latest session is empty, the existing row is selected
  on the first frame; if it is non-empty, the empty home replaces the previous
  transcript immediately and one durable empty session is created from
  `session.create`. The composer becomes editable with the Send control
  enabled as soon as the destination is selected; an earlier project's
  background turn cannot leave it disabled. Repeating the click while the slot
  is empty selects the same row and creates no duplicate.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `04-ux/09-interaction-patterns.md` (§1.6), `04-ux/08-component-spec.md` (§11.4)
- **Acceptance**: C (project session creation and send readiness)
- **Milestone**: M2
- **Status**: Source-level regression covered (`app-store-sidebar.test.mjs`);
  full UI scenario Draft

#### E2E-011c: Session-scoped composer drafts

- **Preconditions**: Provider configured; sessions A and B exist; A has a
  transcript so it uses the docked composer; B is an empty session so it uses
  the home composer; the composer is visible and both sessions are idle.
- **Steps**: 1) Select A and type a prompt without sending it. 2) Switch to B
  and inspect the composer. 3) Type a different prompt in B, then switch back
  to A. 4) Create a new session and inspect its composer. 5) Return to B and
  then delete B; revisit the remaining sessions and the home composer if it is
  available. 6) Type in A, open Settings (or Plugins), then return to chat.
  7) Hide the app window and show it again with an unsent draft in A.
- **Expected**: B initially shows an empty composer, A restores its original
  unsent prompt, and the new session starts empty rather than inheriting A or
  B. Each session keeps only its own draft (including file-reference chips)
  across empty-home ↔ docked remounts. Deleting B removes its cached draft. If
  a prompt is sent while its request is in flight and the user switches
  sessions, successful completion clears only the submitting session's draft
  and never clears the destination composer. The draft in A is still present
  after the Settings/Plugins round-trip and after the window is hidden and
  shown (D301).
- **Specs linked**: `04-ux/09-interaction-patterns.md`
- **Acceptance**: C (session isolation and composer input)
- **Milestone**: M2
- **Status**: Source-level regression covered
  (`composer-draft-cache.test.mjs`); full UI scenario Draft

#### E2E-011d: New task creates an immediate durable empty slot

- **Preconditions**: Provider configured; at least one real session exists so
  the sidebar history is non-empty.
- **Steps**: 1) Invoke New Task from the sidebar, the top bar, or Cmd/Ctrl+N
  inside a retained project and in the temporary scope. 2) Inspect the sidebar
  history and the composer. 3) Click the same group's New Task control several
  times quickly. 4) Type a message and send it. 5) Inspect the sidebar history
  again and repeat in a different project group.
- **Expected**: When the group's latest session is non-empty, the empty home
  replaces the previous transcript on the first frame, then one new row is
  persisted from `session.create` (without a blocking `session.list` /
  `session.get` round-trip) and selected before the first send. Once that row
  is the group's latest empty session, repeated clicks select it (or do
  nothing when already selected) and create no duplicate. Sending updates the
  same row's title and message count; the project and temporary groups keep
  independent slots.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `04-ux/08-component-spec.md` (§11), `04-ux/01-ui-ia.md` (§5)
- **Acceptance**: C (history integrity and group-scoped creation)
- **Milestone**: M2
- **Status**: Source-level regression covered
  (`app-store-sidebar.test.mjs`, `composer-send-state.test.mjs`,
  `session-create.test.mjs`); full UI scenario Draft

#### E2E-011e: Empty-session reuse is scoped to the latest session

- **Preconditions**: One project group contains an older empty session and a
  newer session with messages; a separate project and the Temporary group are
  available.
- **Steps**: 1) Click New Task in the first project group. 2) Confirm the new
  row is created even though the older empty session remains. 3) Click New Task
  again before sending. 4) Repeat in the second project and Temporary group.
- **Expected**: The first click creates a new durable row because only the
  latest session is considered and it is non-empty. The second click reuses
  that newly created empty row. The older empty row remains untouched, while
  each other group gets its own independent empty-slot decision.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`, `04-ux/01-ui-ia.md`,
  `04-ux/08-component-spec.md`
- **Acceptance**: C (session creation and grouping), F (persistence)
- **Milestone**: M2
- **Status**: Source-level regression covered; full UI scenario Draft

#### E2E-011f: Send while running queues per-session prompts and supports Send now

- **Preconditions**: Provider configured; session A can produce a delayed
  response with at least one completed tool batch; session B exists and is
  idle.
- **Steps**: 1) Send a long-running prompt in A. 2) While A is running, verify
  the composer has exactly one submit button: with an empty draft it is Stop
  (`aria-label="Stop generating"`) and no Send button is present; type a draft
  and verify the same slot becomes Send (`aria-label="Send"`) with no Stop
  button present. Send two more prompts and inspect the queue above the
  composer. 3) Remove the second queued row and switch to B. 4) Send a prompt
  in B, then return to A before either run completes. 5) Choose Send now on A's
  remaining queued row. 6) Observe A through the current tool/reply boundary
  and then the next turn. 7) Start another run in A, clear the draft to expose
  the single Stop button, press Stop, and inspect the queue.
- **Expected**: The single submit slot contains exactly one button in every
  state: disabled Send while idle and empty, enabled Send while running with
  content (which queues the prompt), and Stop while running with an empty
  draft. A's two prompts appear in FIFO order, the removed row never sends,
  and B's queue remains independent. Send now requests a graceful stop: the
  current batch completes with a normal `agent_end`/completed turn, then the
  selected row starts before any remaining FIFO rows without `AGENT_BUSY`.
  Immediate Stop aborts the current reply and preserves A's queued row;
  switching sessions preserves both queues.
- **Specs linked**: `03-runtime/01-ipc-protocol.md` (§5.2),
  `04-ux/08-component-spec.md` (§11),
  `04-ux/09-interaction-patterns.md` (§3.4), ADR 0118
- **Acceptance**: C (chat, stream, and session isolation), Quality
- **Milestone**: M6+
- **Status**: Source-level regression covered; full UI scenario Draft

#### E2E-011g: New Task does not leave the previous transcript on screen

- **Preconditions**: Provider configured; session A has a visible transcript
  (idle or streaming); the group's latest session is non-empty.
- **Steps**: 1) Click New Task (sidebar, top bar, or Cmd/Ctrl+N). 2) Observe
  the chat surface on the next frame, before the new sidebar row is required
  to exist. 3) Type in the composer during that interval. 4) Wait for the new
  row and send.
- **Expected**: A's transcript is gone on the first frame (empty home, idle
  Send). The composer does not stay on A's draft. After `session.create` the
  same empty session is selected, any text typed during the wait belongs to
  that session, and sending does not create a second row. Repeating New Task
  before sending reuses the row. The host is not asked to `session.list` or
  `session.get` before the empty destination is visible.
- **Specs linked**: `04-ux/09-interaction-patterns.md` (§1.6),
  `04-ux/08-component-spec.md` (§11), ADR 0154
- **Acceptance**: C (session creation), Quality
- **Milestone**: M2
- **Status**: Source-level regression covered (`session-create.test.mjs`,
  `session-switch-performance.test.mjs`); full UI scenario Draft

### Conversation Top Bar

#### E2E-087: Conversation top bar renders on the chat route

- **Preconditions**: Provider configured; at least one session exists.
- **Steps**: 1) Open the chat route. 2) Inspect the 46px bar at the top of the
  conversation area. 3) Confirm it shows the concise session/task title and the
  New task / Search action buttons; confirm the
  sidebar toggle appears **only when the sidebar is collapsed** (when expanded,
  the sidebar owns that control). 4) Switch to the Pull requests, Scheduled,
  Plugins, or Settings routes and inspect the same top region.
- **Expected**: Every route-owned top region uses the same `--ds-toolbar-height`
  (46px), bg-primary surface, and bottom border; Windows/Linux reserve the
  same 120px native-control band at the right. On the chat route the
  conversation top bar renders with its title and actions only; it has no model
  or Agent|Plan|Goal mode control. The
  left-of-input Composer chip owns the active session's Agent/Plan/Goal switch,
  and the Composer-right combined chip owns model and reasoning selection. The
  task title is the only visible title text and is capped at 10 characters
  with an ellipsis; project scope is available through its tooltip. The sidebar
  toggle is present only in the collapsed state (no
  duplicate of the sidebar's control). On every other route the frameless drag
  band renders instead (no chat top-bar controls) while retaining the same
  surface and alignment. The bar is draggable to move the window; interactive
  controls do not start a window drag.
  macOS leaves the left ~76px clear for traffic lights only while the sidebar is
  collapsed (8px in fullscreen); Windows/Linux leave the right 120px clear for
  native window controls.
- **Specs linked**: `04-ux/08-component-spec.md` (§2 Topbar)
- **Acceptance**: C (send/UI), Quality
- **Milestone**: M2
- **Status**: Draft

#### E2E-087a: Destination page headers clear the titlebar band on macOS

- **Preconditions**: macOS build; at least one plugin installed.
- **Steps**: 1) Open the Plugins route with the window at its default size.
  2) Inspect the top of the page: the "Plugins" title row, its primary action,
  and the overflow menu button. 3) Scroll the page to the top and confirm no
  page content is hidden behind the 46px band. 4) Repeat on the Scheduled and
  Pull requests routes. 5) Open a plugin's detail sheet and inspect its head.
- **Expected**: The page header renders fully below the frameless drag band on
  macOS as it already does on Windows/Linux: the title row is not clipped, and
  the Installed / Marketplace segmented control and search field sit at their
  intended offset instead of at the window's top edge. `.page-frame` reserves
  `--ds-toolbar-height` plus an 8px buffer on darwin, win32, and linux alike.
  The plugin detail sheet stacks above the band (`z-index: 60`) and keeps its
  own head at the top edge, with its close button opting out of the drag
  rectangle.
- **Specs linked**: `04-ux/08-component-spec.md` (§2.3 Layout)
- **Acceptance**: C (UI), Quality
- **Milestone**: M2
- **Status**: Source-level regression covered
  (`apps/desktop/test/plugins-page-style.test.mjs`); full UI scenario Draft

#### E2E-088: Composer Agent/Plan/Goal chip updates the session

- **Preconditions**: Chat route active; a session selected.
- **Steps**: 1) Click the left-of-input Composer mode chip to enter Plan. 2)
  Send a prompt that would normally require Write/Edit and observe behavior. 3)
  Click the same Composer chip to return to Agent. 4) Begin a turn and try to
  toggle mode mid-run or while a pending Plan approval is visible.
- **Expected**: The Composer chip updates the active session `mode` (Plan and
  Goal hard-deny Write/Edit and plugin tools while Bash follows the selected
  permission mode; Agent allows its normal tools per permission settings). The
  chip is disabled while a turn or active pending approval exists and re-enables
  after the session returns idle/planning. No top-bar mode control is rendered.
- **Specs linked**: `04-ux/08-component-spec.md` (§2, §11),
  `03-runtime/03-tools-and-permissions.md` (§10),
  `03-runtime/04-data-storage.md` (§8)
- **Acceptance**: C, E
- **Milestone**: M2
- **Status**: Draft

#### E2E-088a: Composer configuration controls survive project/session initialization

- **Preconditions**: Provider configured; a new project or new session flow is
  visible while the destination `activeSessionId` is still resolving.
- **Steps**: 1) Inspect the Composer mode, model × reasoning, and permission
  controls during the empty/home transition. 2) Click the mode control and
  confirm it advances to the next mode. 3) Open the combined chip, enter the
  Reasoning level submenu, and select a supported level. 4) Open permission
  mode and select Auto. 5) Inspect the destination session
  after navigation completes.
- **Expected**: None of the idle configuration triggers is disabled merely
  because the destination session has not been projected yet. New Task has
  already selected or created the durable empty row, and the first
  configuration action applies to that session without waiting for a message;
  no second click is required. Running turns and pending approvals still
  disable the controls. Behind that transition the chat area follows the
  cold-switch rule: the currently visible pane keeps showing its own session
  until the destination commits, the only wait affordance is the thin progress
  track, nothing is dimmed, and prompt submission stays inert until the visible
  pane is the active session, so a prompt cannot reach the session being left.
- **Specs linked**: `04-ux/08-component-spec.md` (§11),
  `04-ux/09-interaction-patterns.md` (§5A), ADR 0137
- **Acceptance**: C (new project/session composer)
- **Milestone**: M2
- **Status**: Draft

#### E2E-088b: Composer placeholder guidance follows page and session context

- **Preconditions**: English and zh-CN locales are available; a provider is
  configured; both an empty home and two conversations can be opened.
- **Steps**: 1) On empty home, record the welcome placeholder and wait longer
  than 4 seconds to confirm it is unchanged. 2) Open conversation A, record
  its guidance, type and clear text, focus and blur the textarea, and wait;
  confirm the copy is unchanged. 3) Switch to conversation B and then back to
  A, recording each guidance change. 4) Switch between home and a conversation
  and inspect the command/file and keyboard hints. 5) Type `/` and inspect the
  slash menu. 6) Switch to zh-CN and repeat the context-switch checks.
- **Expected**: The initially rendered context starts with its welcome copy and stays stable until
  the page/session context changes. Each context switch advances to the next
  localized command/file or keyboard hint with an opacity fade; no timer-driven
  changes occur. The keyboard hint includes Shift+Enter and a submit hint, while the
  command/file hint includes `/` and `@`. The slash menu still contains `/new`,
  `/compact`, `/agent-mode`, `/plan-mode`, and `/goal-mode`. zh-CN shows the
  matching localized copy, including `Shift+Enter for newline · Use Send to submit`.
- **Specs linked**: `04-ux/08-component-spec.md` (§11),
  `04-ux/04-builtin-commands.md` (§7)
- **Acceptance**: C (send/UI), Localization, Quality
- **Milestone**: M2
- **Status**: Source-covered (`composer-placeholder-context.test.mjs`);
  full UI scenario Draft

#### E2E-089: Composer model menu opens upward and switches model

- **Preconditions**: Chat route active; provider configured.
- **Steps**: 1) Click the Composer-right model × reasoning chip. 2) Confirm the
  menu opens upward from the bottom composer. 3) Enter Model, select a different
  provider/model, and return to the root. 4) Enter Reasoning level and select a
  supported level. 5) Open Settings from the command palette or application menu.
- **Expected**: The trigger uses a Bot icon while retaining the current model
  and reasoning labels. The root shows only Model and Reasoning level entries.
  The Model submenu lists enabled runnable providers and only the model bindings
  saved for each provider, with each model row visibly indented beneath its provider
  heading. Cached or freshly discovered models may supply display names and
  metadata for those bindings, but unconfigured discovery results are absent;
  configured IDs remain available when discovery is unavailable. The Reasoning
  level submenu lists only the selected model's published levels. Selecting
  updates the active session model/reasoning configuration without dismissing
  the menu; Settings opens from the command palette/menu. The Composer model
  trigger ellipsizes long IDs. Each option shows one display name only, and
  hovering a long option exposes its complete display name in the tooltip
  without changing the menu layout or adding a visible model ID.
- **Specs linked**: `04-ux/08-component-spec.md` (§11, model menu),
  `03-runtime/13-model-catalog-and-selection.md`
- **Acceptance**: C
- **Milestone**: M2
- **Status**: Draft

#### E2E-090: Transcript bottom reserve tracks the docked composer height

- **Preconditions**: Chat route active; a session with a transcript that
  exceeds one viewport so the last message sits near the docked composer.
- **Steps**: 1) Scroll the transcript to the latest message. 2) Measure the
  vertical gap between the last message and the top of the docked composer.
  3) Type several lines into the composer so the draft grows multi-line. 4)
  Re-measure the gap and confirm the last message is still fully visible above
  the composer (not overlapped). 5) Collapse the draft back to a single line and
  confirm the gap shrinks back toward the tight ~16px reserve.
- **Expected**: The last message sits close above the composer (a small,
  consistent gap) rather than far below it; the reserve follows the composer's
  real height via `--composer-dock-height` so a taller multi-line draft pushes
  the transcript up instead of covering it. The jump-to-latest button and the
  minimap stay anchored just above the composer at every draft height.
- **Specs linked**: `04-ux/08-component-spec.md` (§4.3 MainChat layout)
- **Acceptance**: C (send/UI), Quality
- **Milestone**: M2
- **Status**: Draft

#### E2E-144: Sending a prompt keeps the transcript at the latest turn

- **Preconditions**: Chat route active; the selected session contains enough
  history to overflow the transcript viewport; the transcript is at the latest
  message or has been scrolled upward.
- **Steps**: 1) Send a prompt from the bottom of the viewport. 2) Observe the
  transcript from the first send state through the persisted user-message
  event and the first streamed row. 3) Repeat with a multi-line draft so the
  composer collapses when the draft clears, and again after manually scrolling
  upward before sending.
- **Expected**: Send immediately hides the jump control and re-pins the
  transcript in the layout phase. The historical rows move upward only as the
  new turn is added; the viewport never flashes to the top of the conversation,
  and the new user turn plus streamed response remain visible at the bottom.
  The composer collapse and indicator layout clamps after send never release
  follow mode (no "↓ Scroll to bottom" button appears while the turn streams
  unless the user actually scrolled with an input device).
- **Specs linked**: `04-ux/08-component-spec.md` (§4.3, §4.4),
  `04-ux/09-interaction-patterns.md` (§9.1, §10.4)
- **Acceptance**: C (send/UI), Quality
- **Milestone**: M2
- **Status**: Draft

### Workspace Open

#### E2E-012: Open a project directory

- **Preconditions**: App running; no project open.
- **Steps**: 1) Open project directory via UI. 2) Select a local folder.
- **Expected**: Project path displayed; tool paths resolve relative to project root.
- **Specs linked**: `03-runtime/15-workspace-ignore-rules.md`
- **Acceptance**: D (open project, show path)
- **Milestone**: M3
- **Status**: Draft

#### E2E-013: Read-only tools work in project

- **Preconditions**: Project directory open.
- **Steps**: 1) Ask agent to read a file in the project. 2) Observe result.
- **Expected**: `Read` returns immediately within project scope. In Agent mode,
  the agent activates `Glob` or `Grep` through `ToolSearch` before using it;
  Plan keeps its read/search core available from the first request. All results
  remain within project scope.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md`
- **Acceptance**: E (Read/Glob/Grep work), D (tools based on project)
- **Milestone**: M3
- **Status**: Automated (protocol smoke: Read + Glob in sample project)

### Permission Allow / Deny / Timeout

#### E2E-014: Write/Edit/Bash triggers permission card

- **Preconditions**: Agent mode; project open.
- **Steps**: 1) Ask agent to write a file. 2) Observe permission card.
- **Expected**: Permission card appears inline in the originating transcript
  with tool name, workspace, arguments preview, countdown, and allow/deny
  options. It creates no backdrop or modal and does not cover another session.
- **Specs linked**: `04-ux/03-permission-ux.md`, `03-runtime/03-tools-and-permissions.md`
- **Acceptance**: E (Write/Edit/Bash trigger confirmation)
- **Milestone**: M3
- **Status**: Draft

#### E2E-015: Denied permission blocks execution

- **Preconditions**: Permission card displayed.
- **Steps**: 1) Click deny on permission card. 2) Observe agent response.
- **Expected**: Tool not executed; agent receives denied result; no file changed.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md`
- **Acceptance**: E (denied → not executed)
- **Milestone**: M3
- **Status**: Draft

#### E2E-016: Allowed permission executes tool

- **Preconditions**: Permission card displayed.
- **Steps**: 1) Click allow on permission card. 2) Observe agent response and UI.
- **Expected**: Tool executed; result returned to model and displayed in UI; file modified.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md`
- **Acceptance**: E (allowed → result returned)
- **Milestone**: M3
- **Status**: Draft

#### E2E-017: Permission timeout defaults to deny

- **Preconditions**: Permission card displayed; no user action.
- **Steps**: 1) Wait 120 seconds without responding to permission card. 2) Observe outcome.
- **Expected**: Permission auto-denied after timeout; tool not executed.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md`
- **Acceptance**: E (timeout → deny)
- **Milestone**: M3
- **Status**: Draft

#### E2E-018: Plan denies workspace mutation and plugin tools

- **Preconditions**: Plan mode active with Auto selected and a plugin agent tool registered.
- **Steps**: 1) Ask the Agent to call Write, Edit, and the plugin tool. 2) Ask it
  to run a Bash command that creates a marker file. 3) Repeat the Bash call
  with Ask selected and inspect the permission card.
- **Expected**: Write, Edit, and the plugin tool are not visible and direct
  attempts return `WRITE_DISABLED_IN_PLAN`, `EDIT_DISABLED_IN_PLAN`, or
  `PLUGIN_DISABLED_IN_PLAN`; no file is changed by those tools. Bash runs
  without a confirmation under Auto and may mutate; under Ask it waits for the
  ordinary permission card. No Chat-mode error or command exists.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md`
- **Acceptance**: E (Plan policy)
- **Milestone**: M3
- **Status**: Documented (M6; no E2E execution requested)

#### E2E-019: Workspace-outside paths follow permission mode

- **Preconditions**: Agent or Plan mode; project open; a readable file exists
  outside both the session project and scratch roots.
- **Steps**: 1) With Ask selected, ask the agent to `Read` the external file and
  observe the inline permission card. 2) Deny once and verify no content is
  returned. 3) Repeat and allow once; verify the tool result carries
  `root: "external"` and the canonical absolute path. 4) Switch to Auto and
  repeat with `Grep` or `Glob`; verify no card appears and the bounded result
  returns. 5) Repeat with Accept edits; verify the external read/search still
  asks for permission.
- **Expected**: An explicit outside path never hard-fails before the user can
  decide. Ask and Accept edits request permission; Auto executes. Denial,
  timeout, or cancellation returns `TOOL_DENIED` and performs no operation.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md`,
  `03-runtime/15-workspace-ignore-rules.md`, `04-ux/03-permission-ux.md`
- **Acceptance**: E (workspace-outside permission policy)
- **Milestone**: M3
- **Status**: Automated (host-core protocol/unit coverage; desktop journey pending)

#### E2E-019e: Bounded search parameters stay portable across platforms

- **Preconditions**: Agent or Plan mode; project open; the host tool catalog is
  available on macOS, Linux, or Windows.
- **Steps**: 1) Activate `Glob`/`Grep` when deferred and inspect their schemas.
  2) Search with workspace-relative `path`, `include`, `headLimit`, and
  `outputMode: "filesWithMatches"` or `"count"`, first with a directory and
  then one explicit file. 3) Call `Read` with a directory and follow its
  structured Glob suggestion. 4) Repeat with the platform's native shell
  selected, without changing the tool arguments.
- **Expected**: The schemas expose the same bounded search controls on every
  platform; `Read` declares file-only input, `Glob` declares directory input,
  and `Grep` accepts a file or directory. `filesWithMatches` is accepted as the
  canonical output mode. A directory Read returns `INVALID_ARGUMENT` with
  `suggestedTool=Glob` and bounded args; the corrected call succeeds. Search
  results use workspace-relative paths inside the project and absolute paths
  only for approved external locations. No shell-specific path syntax is
  required and oversized results remain bounded.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md`,
  `03-runtime/16-tool-result-limits.md`, ADR 0057, ADR 0069
- **Acceptance**: E (bounded cross-platform search)
- **Milestone**: M5
- **Status**: Unit-covered (host-core and agent-runtime); live multi-platform
  protocol capture pending

#### E2E-019a: Scratch-directory writes stay out of the workspace (D114)

- **Preconditions**: Agent mode; project open; session started.
- **Steps**: 1) Ask the agent to produce a temporary/intermediate file (e.g. a one-off script). 2) Observe where it writes and whether a permission card appears. 3) Check `git status` and the work-panel state. 4) Delete the session and check `<data_dir>/scratch/`.
- **Expected**: The file lands under `<data_dir>/scratch/<sessionId>/` without a permission card; project `git status` stays clean; no file or Review artifact tab opens for the scratch write; deleting the session removes the scratch directory.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md §4b`, `03-runtime/04-data-storage.md`
- **Acceptance**: E (temp files isolated from workspace)
- **Milestone**: M5
- **Status**: Partially automated (host-core unit tests: dual-root resolve, scratch write/read, PI_SCRATCH_DIR, sweep)

#### E2E-019b: Scratch containment matches workspace defenses (D114)

- **Preconditions**: Agent mode; project open.
- **Steps**: 1) Attempt Write with `..` traversal from the scratch root. 2) Attempt Write through a symlink planted inside scratch pointing outside. 3) Attempt the same Write calls in Plan.
- **Expected**: Both escapes return `PATH_OUTSIDE_WORKSPACE`; Plan returns
  `WRITE_DISABLED_IN_PLAN` before any scratch path can make Write available.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md §4b`
- **Acceptance**: E (scratch root cannot be escaped)
- **Milestone**: M5
- **Status**: Automated (host-core unit tests)

#### E2E-019c: Permission modes govern high-risk approval (D115/D132)

- **Preconditions**: Agent mode; project open; global default `ask`.
- **Steps**: 1) With a newly inherited session and global default Ask every time, open the composer menu — expect Ask every time to be selected with no global-default/inherit label — then ask the Agent to write a workspace file and expect a permission card. 2) Switch the session chip to Accept edits; repeat — expect no card for Write/Edit but still a card for Bash. 3) Switch to Auto — expect no card for Bash either. 4) Create another inherited session after setting the global default to Accept edits in Settings — expect the composer chip and menu selection to display Accept edits directly and Write/Edit to be auto-allowed. 5) Switch the session to Plan, then Goal, with Auto set — expect Write/Edit/plugin denied but Bash allowed without confirmation.
- **Expected**: Effective mode = session override → global default → ask; Plan and Goal Write/Edit/plugin hard denies outrank every mode while their Bash follows the selected mode; the composer chip and menu always display the effective mode without default/inherit provenance.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md §6`, `03-runtime/04-data-storage.md`, `08-meta/decisions-log.md` (D115/D132)
- **Acceptance**: E (permission modes resolve and enforce host-side)
- **Milestone**: M5
- **Status**: Partially automated (host-core unit tests: evaluate matrix, Plan policy precedence, session grants under ask; renderer source test: effective-only composer options and selection)

#### E2E-019d: Bash tool sees the user's login-shell toolchain (D181)

- **Preconditions**: Agent mode; project open; the OS user has a login shell
  (default on macOS) whose profile exports at least one tool not on the app's
  minimal GUI PATH (e.g. nvm/Homebrew).
- **Steps**: 1) Ask the agent to print `$PATH` and run a toolchain check such
  as `command -v node && node -v`. 2) Compare with the PATH a fresh terminal
  shows for the same user. 3) Optionally remove `~/.bash_profile` temporarily
  and repeat on a machine where only `.zshrc` initializes the toolchain.
- **Expected**: The Bash tool resolves tools the user's own login shell
  exports (nvm, pnpm, Homebrew) even though commands run through bash; the
  probed login PATH is a subset of the effective child PATH (bash profile may
  prepend/dedupe). A missing or wedged user shell degrades to the host PATH
  without failing the tool.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md §5`, `08-meta/decisions-log.md` (D181), ADR 0045
- **Acceptance**: E (user toolchain visible in Bash tool)
- **Milestone**: M5
- **Status**: Automated (host-core unit tests: login-PATH probe + child-PATH injection)

### Session Persistence

#### E2E-020: Session survives restart

- **Preconditions**: Session with message history exists.
- **Steps**: 1) Quit app. 2) Relaunch. 3) Open session list.
- **Expected**: Previous session appears; messages recoverable.
- **Specs linked**: `03-runtime/04-data-storage.md`, `03-runtime/10-session-state-machine.md`
- **Acceptance**: F (session survives restart)
- **Milestone**: M2
- **Status**: Automated (protocol smoke: host-level persistence; full restart lane manual)

#### E2E-021: Delete session works

- **Preconditions**: Session exists.
- **Steps**: 1) Delete a session. 2) Observe session list.
- **Expected**: Session removed from list; data gone.
- **Specs linked**: `03-runtime/04-data-storage.md`
- **Acceptance**: F (delete session)
- **Milestone**: M2
- **Status**: Draft

#### E2E-021a: Rename session title persists without changing activity

- **Preconditions**: A project-scoped session and a path-less session exist;
  at least one session has transcript history and one still has the default
  title.
- **Steps**: 1) Open a Sidebar session overflow menu or right-click a session
  row and choose Rename. 2) Enter a title with surrounding whitespace and
  save. 3) Verify the title in the Sidebar, topbar, Project archive, and
  Search. 4) Restart the app and verify the title again. 5) Try an empty and
  an over-80-Unicode-code-point title. 6) Send the first prompt in the
  default-title session.
- **Expected**: The saved title is trimmed, displayed across every current
  session-summary surface, and persists after restart. The session stays in
  the same project or Temporary group, its transcript/message count and
  recent-activity ordering do not change, and historical notification title
  snapshots are unchanged. Empty and overlong values are rejected. A custom
  title is not replaced by first-prompt auto-title; a still-default session
  continues to receive its automatic title.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `03-runtime/04-data-storage.md`, `03-runtime/06-host-rpc-protocol.md`,
  `04-ux/01-ui-ia.md`, `04-ux/08-component-spec.md`, ADR 0143
- **Acceptance**: F (session metadata persistence), Quality (localized task
  management)
- **Milestone**: M2
- **Status**: Draft (do not run E2E locally unless explicitly requested)

#### E2E-036: Localized import grouping starts collapsed

- **Preconditions**: Supported local agent stores contain importable sessions across at least two project paths and two sources, including one session without a project path; the app can be launched once with an English system locale and once with a Simplified Chinese system locale.
- **Steps**: 1) Launch in English and open Settings → Import. 2) Scan for sessions. 3) Inspect the initial source groups. 4) Expand one group and select a session. 5) Change Group by to Project path. 6) Switch back to Source. 7) Repeat the flow after launching with a Simplified Chinese system locale.
- **Expected**: Source/来源 is the initial grouping; all groups are collapsed after the scan and after either grouping change; project-path mode shows exact project paths and a final No project/未关联项目 group; expanding one group leaves the others collapsed; the selected session remains selected across grouping changes; counts, dates, selection labels, accessible names, and the import result use the active locale without raw keys or unresolved double-brace placeholders.
- **Specs linked**: `04-ux/01-ui-ia.md`, `04-ux/02-i18n-english-first.md`, `04-ux/08-component-spec.md`
- **Acceptance**: F (session import review)
- **Milestone**: M2
- **Status**: Draft

#### E2E-037: Import creates durable project entries

- **Preconditions**: Import candidates include two sessions at path A, one at path B, and one without a project path; neither project is the active workspace.
- **Steps**: 1) Import all candidates. 2) Open Settings → Project archive. 3) Inspect and expand paths A and B. 4) Return home and inspect Temporary sessions. 5) Repeat the import.
- **Expected**: Project archive contains exactly one durable row for A and one for B; the matching imported sessions appear under their exact project rows; the path-less session appears only under Temporary sessions; the active workspace does not change; repeating import duplicates neither sessions nor project rows; no missing filesystem path is created on disk.
- **Specs linked**: `03-runtime/04-data-storage.md`, `04-ux/01-ui-ia.md`, `04-ux/08-component-spec.md`
- **Acceptance**: F (session/project persistence)
- **Milestone**: M2
- **Status**: Draft

#### E2E-038: Settings owns the project archive destination

- **Preconditions**: App running with at least one configured provider, one supported local session store, one retained project, and one archived project.
- **Steps**: 1) Open Settings. 2) Inspect the complete settings rail. 3) Open Basics and change the theme in its Appearance card using the searchable theme picker. 4) Open 全局 AI and inspect the Permissions and Defaults cards, including the Command shell row; confirm Context management has no settings card. 5) Open Shortcuts and inspect the Keyboard shortcuts card. 6) Open Instructions and save global instructions. 7) Open Model configuration and inspect the provider studio. 8) Open Import, Project archive, and Info in order. 9) Search Settings for "project" or "archive". 10) In Project archive, compare each group strip's count with its rendered rows. 11) Switch the sort control from Recent to Name. 12) Search for a known session title, inspect its expanded project row, then reveal more than eight sessions; clear the search with the clear affordance. 13) Open a row menu, dismiss it with Escape and with an outside press. 14) Restore the archived project, then activate it. 15) Return to the app shell and open Plugins.
- **Expected**: The rail contains exactly Basics, 全局 AI/AI, Shortcuts, Instructions, Model configuration, Import, Project archive, and Info in that order, each with its semantic Lucide icon (Sliders / Sparkles / Keyboard / FileText / Bot / Download / Archive / Info). The flat directory is visually grouped under four muted, non-interactive headings — Personal / 个人 for Basics, AI, and Shortcuts; Agent / 智能体 for Instructions and Model configuration; Workspace / 工作区 for Import and Project archive; About / 关于 for Info — with whitespace and no divider lines between groups; searching keeps the destination results flat and hides empty groups together with their headings. Appearance remains in Basics, while Permissions, Defaults, and the Command shell row live under 全局 AI; an available selected shell is represented by the selector without a duplicate Configured status, while default, fallback, and no-effective-shell states remain explicit; Context management has no settings card; Keyboard shortcuts and global instructions have their own destinations; Developer lives under Info; Project archive shows active, closed, and archived durable rows without a visibility toggle, grouping them under the always-visible Pinned / All projects / Archived strips (D168/D267) with per-section counts inside one panel. The destination renders no hero block and no page-level counter run: the intro is one quiet description line, and each group strip's count agrees with its rendered rows; sorting by Name reorders rows inside every section without hiding any; search matches project fields and session titles and reports a match count, a session-title result expands its owning project, lists sessions by latest activity with relative update times, and reveals history in batches of eight; clearing the search restores the complete index. The row menu closes on Escape and on an outside press. Bootstrap completion and background refreshes do not return Settings or Extensions to the chat home; the destination changes only after an explicit navigation action. Restore keeps the archive open and activation returns to chat with the restored project retained in the sidebar; the home sidebar and global page results have no standalone Projects destination; Settings search finds Project archive; Plugins remains an independent app-shell destination.
- **Specs linked**: `04-ux/06-settings-ia.md`, `04-ux/01-ui-ia.md`, `03-runtime/11-provider-model-system.md`
- **Acceptance**: B (model configuration), F (session import)
- **Milestone**: M4
- **Status**: Unit-covered (`settings-project-archive.test.mjs`, `sidebar-navigation.test.mjs`); rendered scenario Draft

#### E2E-091: Appearance card selects searchable theme and language pickers

- **Preconditions**: App running on macOS with a Simplified Chinese system locale.
- **Steps**:
  1) Open Settings → General.
  2) In the Appearance card, open the Theme picker. Confirm System, Light, and
     Dark are pinned at the top; select Dark and confirm the trigger shows Dark
     and the UI switches to dark.
  3) Select Light and confirm the UI switches to light.
  4) In the Language row, open the searchable picker. Confirm Auto is pinned
     at the top with the detected native name (简体中文) and that English,
     简体中文, and Türkçe are listed by native name; with the OS locale set to
     Chinese, selecting Auto applies Simplified Chinese.
  5) Select English and confirm the UI switches to English; select 简体中文 and
     confirm it switches back; select Türkçe and confirm shell chrome is
     Turkish without a reload.
  6) Type a native name or English name into the language search and confirm
     unmatched locales disappear. Type a theme name into the theme search and
     confirm unmatched options disappear.
- **Expected**: Theme and Language are searchable picker rows (not a card grid
  and not a native select); each closed trigger fills the settings control
  column without overflowing the row. Theme lists System, Light, and Dark,
  then any plugin themes after a divider. Auto resolves the OS locale through
  the main process (`app.getLocale()`), passes it safely through the sandboxed
  preload bridge, and reflects the detected native name inline in the menu;
  switching options updates the live UI without a reload.
- **Specs linked**: `04-ux/06-settings-ia.md`, `04-ux/02-i18n-english-first.md`
- **Acceptance**: A (core shell), H (localization)
- **Milestone**: M4
- **Status**: Documented

#### E2E-039: Settings titlebar drag moves the window

- **Preconditions**: App running windowed on macOS with Settings open.
- **Steps**: 1) Record the window position. 2) Drag the empty 46px band above the settings rail. 3) Drag the same band above the content pane. 4) Use Back, search, Project archive, and navigation controls. 5) In light and dark themes, sample the top row's color above the rail and above the content pane.
- **Expected**: Either top-band drag moves the native window; Back, search, and navigation remain interactive and never initiate a window drag. The top row above the rail matches the rail surface (`#f4f4f4` light / `#000` dark) and the top row above the content pane matches the primary surface, so the band never renders a mismatched color over the rail.
- **Specs linked**: `04-ux/06-settings-ia.md`, `04-ux/01-ui-ia.md`
- **Acceptance**: Quality (key operations feel polished)
- **Milestone**: M5
- **Status**: Draft

#### E2E-043: Settings content follows window width

- **Preconditions**: App running windowed on macOS with Settings open.
- **Steps**: 1) Open Basics at the default window width and record the content-card width. 2) Expand the window to 1600px wide. 3) Open Model configuration, Import, and Project archive. 4) Shrink the window to the supported 1040px minimum.
- **Expected**: The right-side content cards expand and contract with the available pane at every tested width; the 275px rail and pane gutters remain stable; controls remain visible without clipping or horizontal page scrolling.
- **Specs linked**: `04-ux/06-settings-ia.md`, `04-ux/07-ui-design-system.md`
- **Acceptance**: Quality (key operations feel polished)
- **Milestone**: M5
- **Status**: Unit-covered (`settings-responsive-layout.test.mjs`); scenario Documented

#### E2E-040: Codex-style tool activity survives transcript reload
- **Preconditions**: Provider configured; project open; a session can run a
  successful tool and a failing or aborted tool.
- **Steps**: 1) Run representative read, search, and command tools. 2) Inspect
  the collapsed processing header while it is active. 3) Wait for completion
  and expand the processing group. 4) Expand a completed row and copy its
  output. 5) Click the vertical rule beside the expanded row, then keyboard-focus
  and activate the processing group's vertical rule. 6) Reload the session and
  expand the restored group.
- **Expected**: Consecutive calls are collapsed by default under one localized
  processing header that updates and then freezes its elapsed time and shows a
  step count. Expanded calls use transparent semantic activity rows with an
  action icon, natural-language verb, monospace primary argument, and quiet
  disclosure. The processing group uses the full assistant-column width, so a
  short label or payload does not shrink expanded details into a content-sized
  chip. Each expanded-content vertical rule is a pointer and keyboard-focusable
  collapse control for its owning disclosure. Nested expansion shows output
  before raw input in clamped scroll regions. Live partial output updates in
  place. Reloaded rows preserve the tool name, arguments, result, and status.
- **Specs linked**: `04-ux/01-ui-ia.md`,
  `04-ux/07-ui-design-system.md`, `04-ux/08-component-spec.md`,
  `04-ux/09-interaction-patterns.md`
- **Acceptance**: C (chat stream), E (tools), F (persistence)
- **Milestone**: M3
- **Status**: Draft

#### E2E-041: Conversation minimap navigates long transcripts

- **Preconditions**: A session contains enough user and assistant turns to
  scroll beyond one viewport and densely fill the minimap, including one AI
  response emitted as multiple assistant fragments around tool activity; a
  second session has at least two eligible turn markers that still fit in one
  viewport.
- **Steps**: 1) Open the long session. 2) Scroll through the transcript and
  observe the active minimap marker. 3) Hover a marker and inspect its preview.
  4) Use keyboard focus to reach another marker. 5) Activate a marker. 6) Open a
  session with fewer than two eligible turn markers. 7) Open the
  multi-message session that still fits one viewport. 8) Resize the long session
  window taller until content no longer overflows, then shorter again. 9) At a
  short window height, inspect and activate the first and last markers near the
  minimap's vertical bounds, including from the titlebar-facing side.
- **Expected**: The rail contains one marker per visible user turn and one per
  AI response. Multiple assistant fragments between two user messages share a
  single marker and combined bounded preview, while tool-only rows create no
  marker and do not split the response. The marker near the upper-third reading
  anchor exposes `aria-current`; hover and focus show the same localized sender
  and preview; nearby markers magnify horizontally without shifting the stack;
  activation smoothly scrolls to the first contentful message in that response;
  the rail is absent when fewer than two eligible markers exist **or** when
  content does not overflow one viewport; the rail reappears once overflow
  returns after a resize. Dense markers remain centered in the unobstructed
  span between the 46px titlebar and docked composer, compress uniformly, and
  remain interactive without entering the native window drag region. The
  empty-home and docked composer use the same horizontal width envelope, and
  the composer does not shrink when the minimap appears.
- **Specs linked**: `04-ux/08-component-spec.md`
- **Acceptance**: C (chat stream), Quality (keyboard and long-thread navigation)
- **Milestone**: M3
- **Status**: Draft

#### E2E-042: Pre-v7 storage archives via breaking reset; transcripts live in session files

- **Preconditions**: A fixture data directory contains a `pi.sqlite` whose
  `PRAGMA user_version` is between 1 and 6 (pre-D119 content-in-DB schema)
  with representative rows.
- **Steps**: 1) Start host-core against the fixture. 2) Create a session and
  append messages through host RPC. 3) Stop and restart host-core. 4) Reload
  the session through RPC and inspect the data directory.
- **Expected**: Host-core renames the legacy file to exactly one
  `pi.sqlite.v6.bak`, bootstraps a fresh schema-v7 database (index-only
  `messages`), writes `sessions/<id>.jsonl` with a session-header line plus
  one line per message, reloads the transcript from the file after restart
  with identical logical results, and deleting the session removes both the
  index rows and the session files. No Electron-owned persistence file is
  authoritative.
- **Specs linked**: `03-runtime/04-data-storage.md`,
  `03-runtime/06-host-rpc-protocol.md`, ADR 0014
- **Acceptance**: F (persistence), H (reset failures are diagnosable)
- **Milestone**: M2
- **Status**: Unit-covered (`db::tests::archives_pre_v7_database_and_starts_fresh`,
  `sessions::tests::transcript_survives_reopen_from_file`,
  `sessions::tests::delete_session_removes_transcript_files`); full fixture
  scenario Draft

### Plugin Load / Command / Disable

#### E2E-022: Load local plugin

- **Preconditions**: App running; sample plugin available at local path.
- **Steps**: 1) Open Extensions from the sidebar footer Plugins icon. 2) Choose Load local plugin from the header overflow menu. 3) Enable it with the row switch.
- **Expected**: Plugin loads; manifest validated; contributions registered; the row appears under Active with a Local tag.
- **Specs linked**: `07-plugins/01-plugin-system.md`, `07-plugins/05-plugin-lifecycle.md`
- **Acceptance**: G (load local plugin)
- **Milestone**: M4
- **Status**: Automated (protocol smoke: plugins.loadDev)

#### E2E-022A: Create a plugin from a template

- **Preconditions**: App running; an empty folder available.
- **Steps**: 1) Open Extensions. 2) Choose New plugin from template in the header overflow menu (or use the empty-state button). 3) Pick each of the four templates in turn and read its description. 4) Choose the folder. 5) Cancel the folder picker on a second attempt.
- **Expected**: The picker lists exactly `panel-basic`, `agent-tool-basic`, `skill-pack`, `full-demo`, each named and described in the active locale; choosing a folder writes the template files, loads the plugin as a development plugin, refreshes the list, then opens that folder as the active project — the app lands on chat with the new folder as the workspace, it appears in the sidebar project list, and the toast reads "<name> created, loaded, and opened for development"; the plugin's contributions are immediately usable and the built-in plugin-development skill is active in the new workspace. That skill teaches the current global `pi` API (`onLoad()` plus `pi.commands.register`) and the fixed `window.pluginBridge` boundary, and does not teach the retired `onLoad(pi)` / `pi.registerCommand` shape. A canceled folder picker changes nothing and reports no error.
- **Specs linked**: `07-plugins/10-plugin-devex.md`, `../../plugin-development.md`, ADR 0039
- **Acceptance**: G (create plugin from template)
- **Milestone**: Post-MVP
- **Status**: Automated in part (`apps/desktop/test/plugin-template-action.test.mjs`: channel, template-id parity with the devkit, locale coverage, canceled-pick ordering, project activation); UI walk-through Documented

#### E2E-022B: Development plugin hot reload

- **Preconditions**: A plugin loaded from a local folder and enabled.
- **Steps**: 1) Edit `main.js` to change a command title and save. 2) Save several files at once. 3) Introduce a syntax error and save. 4) Fix the error and save. 5) Add a new permission to `manifest.json` and save. 6) Open the development-plugin card's More actions menu and choose Reload. 7) Edit again and restart the app.
- **Expected**: The single edit reloads the plugin without re-picking the folder and the command palette shows the new title; a save burst produces one reload, and writes under `dist/` or `node_modules/` produce none; the syntax error reports a reload failure without crashing the app, and the fixing save recovers the plugin; the added permission refuses automatic reload with `PERMISSION_DENIED`, while the explicit Reload action loads the registered folder, refreshes the permission ceiling, and reports success; a later edit uses the refreshed ceiling, and after a restart the folder is still watched.
- **Specs linked**: `07-plugins/10-plugin-devex.md` §7, `07-plugins/13-plugin-permissions-matrix.md`, ADR 0039, ADR 0075
- **Acceptance**: G (hot reload), D (permissions cannot widen without review)
- **Milestone**: Post-MVP
- **Status**: Automated in part (`apps/desktop/test/plugin-hot-reload.test.mjs`: debounce, ignore list, permission ceiling, recovery, teardown); manual edit loop Documented

#### E2E-022C: Check, pack, install round-trip

- **Preconditions**: A scaffolded plugin directory.
- **Steps**: 1) `pnpm pi-plugin check <dir>`. 2) Delete the file named by `main` and run `check` again. 3) Restore it, declare `contributes.skills` without `agent.prompt.inject`, and run `check` again. 4) `pnpm pi-plugin pack <dir>`. 5) Install the resulting `.piplug` from the plugins page. 6) Ask the agent to run `PluginCheck` and `PluginPack` on the same directory.
- **Expected**: A scaffolded plugin checks clean and reports its file count and size; the missing `main` is an error that blocks `pack`; the inert-skills case is a warning that does not block; `pack` writes `dist/<id>-<version>.piplug` with store-only entries and prints its sha256; the package installs through the normal permission review and appears under Active; the agent tools produce the same verdicts and refuse any directory outside the session workspace.
- **Specs linked**: `07-plugins/10-plugin-devex.md` §5–§6, `07-plugins/06-plugin-packaging.md`, ADR 0039
- **Acceptance**: G (local packaging round-trip)
- **Milestone**: Post-MVP
- **Status**: Automated in part (`packages/plugin-devkit` vitest: scaffold→check→pack per template, store-method headers, every check rule); install step Documented

#### E2E-023: Plugin command in global search and executes

- **Preconditions**: Plugin loaded and enabled.
- **Steps**: 1) Open global search (Cmd/Ctrl+K or Cmd/Ctrl+Shift+P). 2) Find the plugin command under the Commands section. 3) Execute.
- **Expected**: Command appears in global search results; execution produces expected result.
- **Specs linked**: `07-plugins/09-plugin-command-palette.md`
- **Acceptance**: G (plugin command appears and executes)
- **Milestone**: M4
- **Status**: Draft

#### E2E-024: Plugin registers and calls agent tool

- **Preconditions**: Plugin loaded; plugin declares an agent tool.
- **Steps**: 1) Ask agent to use the plugin's tool. 2) Observe permission card if required. 3) Allow.
- **Expected**: Tool registered with forced prefix (`plugin_<id>_<name>`); call succeeds.
- **Specs linked**: `07-plugins/03-plugin-api.md`, `07-plugins/13-plugin-permissions-matrix.md`
- **Acceptance**: G (plugin agent tool)
- **Milestone**: M4
- **Status**: Automated (protocol smoke: dispatch roundtrip host->runner->host; in-app JS execution via PluginRuntime)

#### E2E-024G: Marketplace detail sheet shows README, permissions, versions

- **Preconditions**: Official marketplace catalog available.
- **Steps**: 1) Open Extensions → Marketplace. 2) Open details for `demo.workspace-summary`. 3) Inspect README / risk-grouped permissions / version rows. 4) Pick a version and install after permission review. 5) Dismiss the sheet with Escape and by clicking the scrim.
- **Expected**: Detail sheet loads via `market.getDetail`; README, safety notes, and per-risk permission explanations render; the picked version drives the sticky install action; Escape and scrim both close the sheet without closing the permission dialog underneath.
- **Specs linked**: `07-plugins/07-plugin-marketplace.md`
- **Acceptance**: G (marketplace detail UX)
- **Status**: Documented

#### E2E-024F: Refresh official remote marketplace repository

- **Preconditions**: Network available to GitHub raw content.
- **Steps**: 1) Open Extensions → Marketplace. 2) Use the header Refresh marketplace action. 3) Confirm the source line points at `vastsa/pi-desktop-plugins`.
- **Expected**: Catalog refreshes from the remote official repo; card grid updates; offline fallback still works if fetch fails.
- **Specs linked**: `07-plugins/07-plugin-marketplace.md`
- **Acceptance**: G (remote marketplace source)
- **Status**: Documented / host-core unit covered

#### E2E-024P: Switch the marketplace catalog source

- **Preconditions**: Network available to `cnb.cool`.
- **Steps**: 1) Open Extensions → Marketplace. 2) Switch Marketplace source from GitHub (official) to Mirror (cnb.cool). 3) Confirm the catalog refreshes in the same surface. 4) Install a plugin.
- **Expected**: Switching triggers a refresh and reports the new plugin count; the active-source status shows the cnb.cool catalog URL; the install downloads its package from the mirror and passes shasum verification. Switching back to official restores the GitHub source. Choosing Custom URL with an empty value falls back to the official default rather than an empty endpoint.
- **Specs linked**: `07-plugins/07-plugin-marketplace.md`
- **Acceptance**: G (remote marketplace source)
- **Status**: Documented / host-core unit covered

#### E2E-024B: Marketplace install with permission review

- **Preconditions**: App running; official market catalog available.
- **Steps**: 1) Open Extensions → Marketplace. 2) Install `demo.workspace-notes`. 3) Read the risk-tiered permission dialog. 4) Accept high-risk permissions.
- **Expected**: Permissions are grouped High / Medium / Low with plain-language explanations before any download; the host refreshes marketplace metadata immediately before download so a stale UI cache cannot pair an old checksum with a current package; plugin installed from the marketplace package, checksum verified, permissions granted, panel/tools available; the installed tab and risk-grouped rows reflect the new plugin without a separate overview card row.
- **Specs linked**: `07-plugins/07-plugin-marketplace.md`, `07-plugins/13-plugin-permissions-matrix.md`
- **Acceptance**: G (marketplace install + permission review)
- **Status**: Documented / host-core covered by unit tests + protocol methods

#### E2E-024R: Install a center-published plugin from the unchanged distribution source

- **Preconditions**: A `schemaVersion: 2` catalog served from the distribution repository, with one plugin carrying provenance and an approved review verdict, its package under `packages/`. A second fixture declares `artifactBaseUrl` for the mirror/enterprise case.
- **Steps**: 1) Keep the marketplace source at its default. 2) Open a plugin's detail sheet. 3) Read the Source section. 4) Install the selected version. 5) Switch to the CNB mirror and repeat the install. 6) Repeat against the fixture that declares a base.
- **Expected**: No settings change or client update is needed to see center-published plugins, because the catalog URL is unchanged; the relative package URL resolves against the catalog directory, so GitHub serves it from `raw.githubusercontent.com` and the mirror from `cnb.cool` with an identical checksum; a declared `artifactBaseUrl` takes precedence when present; the detail sheet shows the source repository, commit, and builder before install; the installed record keeps publisher, trust tier, and source pin.
- **Specs linked**: `07-plugins/07-plugin-marketplace.md`, `07-plugins/15-plugin-center.md`
- **Acceptance**: G (publisher-owned source distribution)
- **Status**: Documented / host-core covered by unit tests

#### E2E-024S: Package host allowlist refuses an untrusted download

- **Preconditions**: A catalog fixture whose version URL points at a host outside the allowlist, plus one with embedded credentials and one on plain HTTP.
- **Steps**: 1) Refresh the marketplace. 2) Inspect the plugin card and detail sheet. 3) Attempt an install. 4) Repeat with a private catalog whose packages sit on its own host.
- **Expected**: The row does not offer an install action for an off-allowlist URL; an attempted install fails with `PLUGIN_MARKET_UNTRUSTED_HOST` naming the rejected host before any request leaves the machine; a credentialed URL and non-loopback plain HTTP are refused the same way; a private catalog can still serve packages from the host that served it, without widening the allowlist for third-party hosts.
- **Specs linked**: `07-plugins/07-plugin-marketplace.md`, `07-plugins/04-plugin-security.md`
- **Acceptance**: G (marketplace download boundary)
- **Status**: Documented / host-core covered by unit tests

#### E2E-024T: A withdrawn version is not offered, installed, or hidden

- **Preconditions**: A catalog where the newest version is `yanked` with a reason, an older version is live, and the yanked version is installed locally.
- **Steps**: 1) Open the plugin's detail sheet. 2) Inspect version history. 3) Select the withdrawn version. 4) Run Check for updates. 5) Run Apply automatic updates. 6) Inspect the installed row.
- **Expected**: The offered latest version is the newest non-yanked one; the withdrawn version stays in history with its reason and a struck-through number; selecting it disables the install action with withdrawn copy rather than not-yet-published copy; an explicit install of it fails with `PLUGIN_MARKET_YANKED` and the reason; no update is offered when the newest live version is not newer than the installed one, so a downgrade is never presented as an update; the installed row is flagged as needing attention and the plugin keeps running.
- **Specs linked**: `07-plugins/08-plugin-signing-updates.md`
- **Acceptance**: G (incident response propagation)
- **Status**: Documented / host-core covered by unit tests

#### E2E-024U: Trust tier and host version bound are enforced by the client

- **Preconditions**: A custom-source catalog claiming `trust: "verified"`, a catalog with an unrecognised tier, and a version whose `minPiDesktop` exceeds the running host.
- **Steps**: 1) Point the marketplace at the custom source. 2) Inspect the card and detail sheet badges. 3) Attempt to install the version pinned to a newer host. 4) Repeat with a `minPiDesktop` that is a range expression rather than a version.
- **Expected**: A `verified` claim from a non-official source renders as community with no shield; an unrecognised tier renders as unknown; the version requiring a newer host is not offered and an explicit install fails with `PLUGIN_HOST_TOO_OLD` naming both versions; an unparseable bound is ignored rather than making the plugin uninstallable.
- **Specs linked**: `07-plugins/07-plugin-marketplace.md`, `07-plugins/15-plugin-center.md`
- **Acceptance**: G (trust presentation)
- **Status**: Documented / host-core covered by unit tests

#### E2E-024V: Publisher pins a version with pi-plugin publish

- **Preconditions**: A plugin directory inside a git repository with an https or ssh origin remote.
- **Steps**: 1) Run `pi-plugin publish` with uncommitted changes. 2) Commit and tag, then rerun. 3) Rerun on a commit with no tag. 4) Rerun with a remote containing credentials. 5) Feed the resulting registry entry through the center's catalog build and the client preflight.
- **Expected**: A dirty worktree is refused so the submitted commit describes the packaged bytes; a clean run writes the package, its sha256, the canonical repository URL, the tag ref, the resolved commit, and the plugin subdirectory into a submission payload; an untagged commit is accepted with a warning; a credentialed remote is refused; the generated catalog passes the same preflight the client ships.
- **Specs linked**: `07-plugins/10-plugin-devex.md`, `07-plugins/15-plugin-center.md`
- **Acceptance**: G (publisher tooling)
- **Status**: Documented / devkit covered by unit tests

#### E2E-024C: Plugin package install and auto-update path

- **Preconditions**: Marketplace catalog has a newer version or local `.piplug`.
- **Steps**: 1) Install package from the header overflow menu. 2) Enable auto-update from the row overflow menu. 3) Reopen Extensions while the marketplace is slow or unavailable and confirm the Installed surface and Marketplace tab remain usable. 4) Confirm the installed list refreshes update metadata from the local catalog. 5) Run Check for updates, then Apply automatic updates.
- **Expected**: The Extensions surface does not wait for a remote request during its silent cache-only check; the row moves to Updates available and the update banner reports the count; the highest semantic version is selected even when the catalog version array is not newest-first; the explicit check fetches the current catalog and uses the cached catalog offline; permissions the new version adds are tagged New in the review dialog; auto-update applies only when the permission diff is empty or pre-granted.
- **Specs linked**: `07-plugins/06-plugin-packaging.md`, `07-plugins/08-plugin-signing-updates.md`
- **Acceptance**: G (package install + update policy)
- **Status**: Documented

#### E2E-024Q: Marketplace update diagnosis and release-data gate

- **Preconditions**: A catalog fixture contains an installed `0.5.0` plugin, a
  `0.5.1` version, and either unsorted version entries or intentionally missing
  package metadata.
- **Steps**: 1) Record the plugin ID, installed version, displayed latest
  version, catalog URL, and local cache path. 2) Fetch the live/fixture catalog
  and inspect the exact entry. 3) Inspect the installed registry separately.
  4) Run `pnpm check:marketplace -- --url <catalog> --plugin <id>`. 5) Run the
  update check against the fixture.
- **Expected**: The failure is classified as catalog data, fetch/cache,
  host comparison, IPC propagation, or renderer presentation before code is
  changed; the preflight reports every missing checksum, URL, package size, or
  permissions field; an incomplete release may be shown for discovery but is
  not installable; a valid `0.5.1` is detected regardless of catalog ordering;
  the final fix includes a regression test for the diagnosed boundary.
- **Specs linked**: `07-plugins/07-plugin-marketplace.md`,
  `07-plugins/08-plugin-signing-updates.md`,
  `06-delivery/03-ai-development-workflow.md`
- **Acceptance**: G (marketplace update diagnosis)
- **Status**: Documented / preflight script

#### E2E-024H: Installed plugins surface state, risk, and failures

- **Preconditions**: At least one enabled plugin, one disabled plugin, and one plugin whose load failed.
- **Steps**: 1) Open Extensions → Installed while plugin changed events are arriving in a burst. 2) Read the tab and group counts. 3) Confirm the failed plugin sits under Needs attention with its error message. 4) Search by author and by permission. 5) Clear the search.
- **Expected**: The page remains usable during transient host backpressure: identical plugin and extension registry refreshes coalesce, and renderer-facing RPC calls retry explicit `HOST_OVERLOADED` responses with bounded backoff before surfacing an error. Rows group as Needs attention / Updates available / Active / Turned off with counts; `status: "error" | "load_error"` renders the error message inline instead of being silent; each row defaults to a two-line name/id/version summary, while a Details disclosure reveals risk-tinted permission chips, capabilities, and resident service status; the single scope trigger opens explained Off / This project / Everywhere choices and the project picker; row icon actions expose hover/focus labels; the result count reflects the filtered subset and clearing restores every group.
- **Specs linked**: `04-ux/01-ui-ia.md`, `07-plugins/13-plugin-permissions-matrix.md`
- **Acceptance**: G (installed plugin management)
- **Status**: Documented

#### E2E-024D: Isolated plugin panel host bridge

- **Preconditions**: Plugin with `ui.panel` enabled.
- **Steps**: 1) Set the app language to English and open a panel whose manifest declares localized `ui.title.en` and `ui.title.zh-CN`; confirm the native window/launcher identity remains available without a host-rendered title. 2) Set the app language to Simplified Chinese and reopen the panel; confirm the panel content remains plugin-owned. 3) Open the panel on macOS, Windows, and Linux; confirm the same frameless 46px drag band, fixed top-right capsule fully contained inside that band, and exactly three accessible controls. 4) Exercise minimize, maximize, restore, close, keyboard focus, light/dark themes, page-defined light/dark backgrounds, and reduced motion on every platform. 5) Render a plugin-owned titlebar/toolbar; verify fixed/sticky UI uses `--pi-plugin-titlebar-height`, its interactive controls use `no-drag`, and clicks outside the capsule in the top 46px are treated as window dragging. 6) On Windows with classic scrollbars, scroll a panel with content overflow and inspect the right edge. 7) Open a development plugin and confirm the localized reminder explains that the top 46px is not clickable outside the capsule. 8) Reopen a minimized panel. 9) Invoke panel bridge APIs (`ui.showToast`, optional fs/net with grants).
- **Expected**: Panel runs in its sandboxed window/partition; all three platforms use one host-owned frameless chrome contract with no native traffic lights, host-rendered title, or application menu; the top drag band is exactly 46px, and the minimal capsule stays fixed at the top-right without exceeding it. The capsule contains minimize/maximize-or-restore/close, follows the plugin page's surface/text colors, and never forces a black surface onto a light page. A v2 page marked `pi-plugin-chrome` uses `--pi-plugin-titlebar-height` and starts its own content directly below the 46px band without an additive duplicate spacer; a legacy page keeps the compatibility offset. A panel's stable scrollbar gutter is scoped to its actual content scroller; Windows does not show a second root-level empty side rail outside the page surface. The plugin owns its title and toolbar; the host drag strip remains usable, blocks clicks outside the capsule, and development panels alone show the reminder. Reopening restores the existing panel; bridge calls remain permission-checked and the host remains stable on panel close.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`, `04-ux/07-ui-design-system.md`, `07-plugins/01-plugin-system.md`, `07-plugins/03-plugin-api.md`, `07-plugins/04-plugin-security.md`, ADR 0081, ADR 0082, ADR 0092, ADR 0093
- **Acceptance**: G (isolated panel)
- **Status**: Documented

#### E2E-024E: High-risk plugin APIs require grants

- **Preconditions**: Notes plugin installed with explicit grants.
- **Steps**: 1) Call `fs.writeText` / `net.fetch` / `shell.openExternal` through plugin runtime or panel bridge. 2) Revoke one permission and retry.
- **Expected**: Granted calls succeed with audit; revoked/undeclared calls fail with `PERMISSION_DENIED` and do not crash the app.
- **Specs linked**: `07-plugins/13-plugin-permissions-matrix.md`, `07-plugins/04-plugin-security.md`
- **Acceptance**: Security + G
- **Status**: Documented

#### E2E-024W: Plugin clipboard history captures bounded text and images

- **Preconditions**: The app is running; a test plugin declares and is granted
  `clipboard.read`; the system clipboard can provide one text value and one
  image value.
- **Steps**: 1) Copy text, then copy an image, then invoke
  `pi.clipboard.getHistory()`. 2) Invoke it again and mutate the returned image
  bytes. 3) Copy the same text consecutively and invoke the API. 4) Revoke
  `clipboard.read` and invoke it again. 5) Add fixtures over the text/image
  caps and older than the retention window.
- **Expected**: The result is newest-first with text and image entries
  interleaved, ISO timestamps, PNG bytes, and image dimensions; mutating the
  result does not mutate host state. Consecutive duplicates collapse with a
  refreshed timestamp. Entries over the per-entry caps and expired entries are
  absent, and the host total/entry caps are enforced. The API reuses the
  `clipboard.read` grant, denied calls fail with `PERMISSION_DENIED`, and a
  successful call emits an audit entry containing the returned entry count.
- **Specs linked**: `07-plugins/03-plugin-api.md`,
  `07-plugins/04-plugin-security.md`,
  `07-plugins/13-plugin-permissions-matrix.md`, ADR 0115
- **Acceptance**: G (plugin clipboard history) + Security
- **Status**: Unit-covered (`clipboard-history.test.mjs`); Electron clipboard
  capture remains manual

#### E2E-024I: Plugin skills reach the agent and load on demand

- **Preconditions**: `examples/plugins/hello` enabled with `agent.prompt.inject` granted; a second copy of the manifest without that permission available; one workspace that is a plugin directory and one that is not.
- **Steps**: 1) Start a session and ask the agent what skills it has. 2) Ask it to follow the Hello demo skill so it calls the `Skill` tool. 3) Edit the skill document and repeat step 2. 4) Disable the plugin and start a new turn. 5) Load the variant without `agent.prompt.inject` and repeat step 1. 6) Declare a document larger than the per-skill cap. 7) Open each of the two workspaces in turn.
- **Expected**: The catalog lists the skill id, name, and trimmed description but no body, after the built-in skills and before the project instruction chain; the `Skill` schema is loaded through `ToolSearch` only when requested and reads the edited file without a restart; disabling the plugin rebuilds the runtime so the skill disappears from the next turn; the variant without the permission loads normally and contributes no skills; the oversized document is skipped with an audit line rather than clamped into the prompt; the built-in `plugin-development` skill is catalogued in the plugin workspace and absent in the other, while `PluginCheck` is listed in the bounded on-demand tool catalog in both.
- **Specs linked**: `07-plugins/02-plugin-manifest-schema.md`, `07-plugins/04-plugin-security.md` §7.1, `07-plugins/10-plugin-devex.md`, ADR 0039, ADR 0037, D174
- **Acceptance**: G (skill activation) + E (tools & permissions) + D (high-risk permission gating)
- **Status**: Unit-covered (`plugin-skills.test.mjs`, agent-runtime prompt/digest tests); agent-facing scenario Draft

#### E2E-024J: Plugin theme applies and falls back when withdrawn

- **Preconditions**: `examples/plugins/hello` enabled with `ui.theme` granted; a plugin whose CSS uses `@import` or a remote `url()` available for the rejection case.
- **Steps**: 1) Open Settings → General → Theme and pick `Hello Midnight`. 2) Restart the app. 3) Disable the providing plugin. 4) Re-enable it, then uninstall it. 5) Load the plugin with unsafe CSS.
- **Expected**: The plugin theme appears in the picker alongside the built-ins and applies immediately; the choice survives restart as `plugin:demo.hello:midnight`; disabling or uninstalling the provider falls back to `system` instead of an unstyled shell; unsafe CSS is refused at load with the reason logged and no `<style>` element injected.
- **Specs linked**: `07-plugins/04-plugin-security.md` §3.1, `04-ux/07-ui-design-system.md`, D175
- **Acceptance**: G (theme contribution) + Security
- **Status**: Unit-covered (`plugin-themes.test.mjs`, `theme-css` SDK tests); visual scenario Draft

#### E2E-024K: Plugin MCP server tools reach the agent

- **Preconditions**: A plugin declaring one `stdio` and one non-loopback HTTP MCP server against trusted local-network stubs; `mcp.server.local` and `mcp.server.remote` granted; the HTTP host is listed in `net.domains`; a settings key holding the stub credential.
- **Steps**: 1) Enable the plugin and confirm no server process starts yet. 2) Ask the agent to call a discovered tool. 3) Inspect the stub's received environment/headers. 4) Make the stub fail a call and time one out. 5) Disable the plugin.
- **Expected**: Servers connect lazily on first use; tools appear as `plugin_demo_*_<serverId>_<tool>` at `risk: "medium"` with per-call audit; the stdio child receives only the declared `env` values plus PATH/temp/locale, never host provider keys; the non-loopback HTTP endpoint is accepted only because its host is declared, and its unencrypted transport is visible in review; a redirect to an undeclared host is blocked before the second request; failures and timeouts return tool errors without crashing the plugin or the host; disable disconnects both servers.
- **Specs linked**: `07-plugins/02-plugin-manifest-schema.md`, `07-plugins/04-plugin-security.md` §8.1, ADR 0038, ADR 0142, D176, D281
- **Acceptance**: G (MCP bridge) + E (tools & permissions) + Security
- **Status**: Unit-covered (`plugin-mcp.test.mjs` stdio + HTTP stubs); agent-facing scenario Draft

#### E2E-024L: Resident plugin service is supervised and visible

- **Preconditions**: `examples/plugins/hello` enabled with `background.service` granted.
- **Steps**: 1) Open Extensions → Installed and expand Details on the plugin row to read the `Greeter heartbeat` chip. 2) Kill the plugin's utility process and watch the chip. 3) Kill it repeatedly past the restart ceiling. 4) Disable and re-enable the plugin. 5) Revoke `background.service` and reload.
- **Expected**: The Details disclosure exposes a chip that reports `running` after load; a kill shows `failed` then `running` again with an incremented restart count and backoff between attempts; past five attempts the plugin stays `failed` and stops retrying; manual disable/enable cancels the pending timer and resets the counter; without the permission the service never starts and the skip is audited.
- **Specs linked**: `07-plugins/05-plugin-lifecycle.md` §3.1, ADR 0040, D177
- **Acceptance**: G (resident services)
- **Status**: Unit-covered (`plugin-services.test.mjs` supervision + backoff); manual kill scenario Draft

#### E2E-024M: Bus messages cross plugins only as declared

- **Preconditions**: Two plugins enabled — one publishing `demo.*` topics, one subscribing `demo.**` — with `bus.publish` / `bus.subscribe` granted.
- **Steps**: 1) Run the publisher's command and watch the subscriber. 2) Publish a topic absent from `contributes.bus.publish`. 3) Subscribe to a pattern absent from `contributes.bus.subscribe`. 4) Publish a payload over 64KB and exceed 100 publishes in 10s. 5) Unload the subscriber and publish again.
- **Expected**: The subscriber receives `{ topic, from, payload, at }` and the publisher never receives its own message; undeclared publish and subscribe both fail `PERMISSION_DENIED` with an audit line naming the topic; the oversized payload and the rate burst fail `LIMIT_EXCEEDED` / `RATE_LIMITED`; publishing to a departed subscriber succeeds with a smaller fan-out and no host error.
- **Specs linked**: `07-plugins/02-plugin-manifest-schema.md` §5.1, `07-plugins/04-plugin-security.md` §5.1, ADR 0040, D178
- **Acceptance**: G (message bus) + Security
- **Status**: Unit-covered (`plugin-bus.test.mjs` delivery, filtering, caps); two-plugin manual scenario Draft

#### E2E-024N: Extensions page density and theme-readable actions

- **Preconditions**: App running with at least one installed extension and one
  available marketplace action; dark and light themes available.
- **Steps**: 1) Open Extensions in dark theme. 2) On Windows/Linux, confirm
  the compact two-tier header presents the extension mark/title and contextual
  action rail below the native window-control band, then confirm the Installed and Marketplace tabs are the only tabs and both reach the content
  without a four-card numeric overview band or explanatory header/section
  paragraphs. 3) Confirm installed rows begin
  as a quiet two-line summary, then expand Details on one row and inspect its
  capabilities, service status, and permissions. 4) Use the compact scope
  control and its explained scope menu, contextual primary action, and a
  secondary update/action button. 5)
  Switch to light theme and repeat. 6) Keyboard-focus the Details disclosure,
  scope states, and each action.
- **Expected**: The four numeric overview cards are absent; the header uses a
  quiet 24px extension mark, 18px title, restrained 30px action controls, and
  a visible keyboard focus ring; tab counts,
  installed group counts, and any update alert remain available in their
  relevant surfaces. The page header, section headers, empty states, and update
  alert use compact labels and actions; decision-specific explanations remain
  in disclosures, details, and dialogs. Installed rows keep their default height low while the
  disclosure exposes the complete secondary readout. The scope trigger stays
  aligned with the row action rail, its menu explains each state, and icon
  actions remain visible at rest while showing labels on hover and focus.
  Primary and secondary buttons keep
  visible semantic surfaces, text, borders, hover states, and focus rings in
  both themes, and keyboard focus does not depend on pointer hover.
- **Specs linked**: `04-ux/01-ui-ia.md`, `04-ux/07-ui-design-system.md`,
  `07-plugins/07-plugin-marketplace.md`, ADR 0058, D196
- **Acceptance**: G (Extensions page) + Quality
- **Status**: Unit-covered (`extensions-page.test.mjs`,
  `plugins-page-style.test.mjs`); visual scenario Draft

#### E2E-024O: Marketplace hides development-only sample plugins

- **Preconditions**: App running; the official catalog contains the
  development fixtures `demo.hello` or `demo.workspace-summary` and at least
  one product plugin.
- **Steps**: 1) Open Extensions → Marketplace with an empty search. 2) Search
  for `Hello`, `Workspace Notes`, and `Workspace Summary` in turn. 3) Inspect
  the category filters and result cards. 4) Open Installed and verify an
  already-installed sample remains manageable.
- **Expected**: Entries whose IDs begin with `demo.` never appear in the
  marketplace cards, categories, or search results; product plugins remain
  discoverable. An already-installed sample is still listed under Installed so
  it can be disabled or uninstalled rather than becoming an unmanaged runtime.
- **Specs linked**: `07-plugins/07-plugin-marketplace.md`,
  `04-ux/01-ui-ia.md`
- **Acceptance**: G (Extensions page) + Quality
- **Status**: Unit-covered (`extensions-page.test.mjs`); visual scenario Draft

#### E2E-025: Disable plugin removes contributions

- **Preconditions**: Plugin enabled and contributions visible.
- **Steps**: 1) Disable the plugin on the Extensions page. 2) Check global search and agent tools.
- **Expected**: Commands and tools disappear; no leftover contributions.
- **Specs linked**: `07-plugins/05-plugin-lifecycle.md`
- **Acceptance**: G (disable removes contributions)
- **Milestone**: M4
- **Status**: Automated (protocol smoke: disable clears enabled flag; global search removal manual)

#### E2E-026: Plugin error does not crash app

- **Preconditions**: Plugin loaded.
- **Steps**: 1) Trigger a scenario where plugin throws an error. 2) Observe app behavior.
- **Expected**: App remains running; error is captured and reported; no crash.
- **Specs linked**: `07-plugins/04-plugin-security.md`
- **Acceptance**: G (plugin error → no crash)
- **Milestone**: M4
- **Status**: Draft

#### E2E-024X: Page copy stays concise in both locales

- **Preconditions**: App running with English and Simplified Chinese available; project archive, Scheduled, Pull requests, Extensions, and Agent capability destinations are reachable.
- **Steps**: 1) Open each destination in English and inspect its header, toolbar, empty state, and primary action. 2) Switch to 简体中文 and repeat. 3) Trigger a permission, validation, destructive-action, or provider-error state.
- **Expected**: Page headers do not repeat their title as explanatory subtitles; empty states use a concise title and action, with body text only when context or a required next step is necessary. Settings and capability pages omit prose that only explains obvious controls. Permission, security, validation, destructive-action, keyboard, scope, and error details remain visible in both locales.
- **Specs linked**: `04-ux/01-ui-ia.md`, `04-ux/07-ui-design-system.md`
- **Acceptance**: Quality (concise page copy)
- **Status**: Unit-covered (`packages/i18n/test/user-facing-copy.test.mjs`); visual scenario Draft

### Security — No Secret Leakage

#### E2E-027: Secrets not in logs for normal flows

- **Preconditions**: Provider configured with API key.
- **Steps**: 1) Perform a chat session. 2) Inspect log files.
- **Expected**: API keys / tokens not present in any log output for normal flows.
- **Specs linked**: `05-security/01-security.md`, `03-runtime/09-logging-and-observability.md`
- **Acceptance**: H (secrets not in logs)
- **Milestone**: M2
- **Status**: Automated (protocol smoke: provider list carries no secret material)

#### E2E-028: Renderer has no Node integration

- **Preconditions**: App running.
- **Steps**: 1) Inspect renderer process flags.
- **Expected**: `nodeIntegration: false`; `contextIsolation: true`; preload is the only bridge.
- **Specs linked**: `05-security/01-security.md`
- **Acceptance**: Security (no Node in renderer)
- **Milestone**: M1
- **Status**: Draft

#### E2E-029: Unwhitelisted IPC cannot be called

- **Preconditions**: App running.
- **Steps**: 1) Attempt to invoke an IPC method not on the whitelist from renderer.
- **Expected**: Call blocked; no data returned; error or no response.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`, `05-security/01-security.md`
- **Acceptance**: Security (IPC whitelist enforced)
- **Milestone**: M1
- **Status**: Draft

#### E2E-030: Plugin cannot read API key

- **Preconditions**: Plugin loaded; provider configured.
- **Steps**: 1) Plugin attempts to access provider secret via any API. 2) Observe result.
- **Expected**: Access denied; no secret data returned to plugin.
- **Specs linked**: `07-plugins/04-plugin-security.md`, `03-runtime/14-secrets-storage.md`
- **Acceptance**: Security (plugin cannot read API key)
- **Milestone**: M4
- **Status**: Draft

#### E2E-031: Error codes are stable and readable

- **Preconditions**: App launched through the normal desktop development
  command; provider configured.
- **Steps**: 1) Select or enter a model ID that the provider rejects. 2) Send a
  prompt. 3) Inspect the assistant error message and its detail disclosure. 4)
  Switch sessions and reload the failed session. 5) Repeat with an invalid
  provider key.
- **Expected**: The run stops and the transcript contains one durable
  `role=assistant`, `status=error` message instead of a toast, floating banner,
  or blank row. It shows a localized summary and stable
  `MODEL_NOT_CONFIGURED` or `PROVIDER_UNAUTHORIZED` code. Details expose the
  redacted provider response plus provider/model IDs and can be copied; no API
  key or Authorization value appears. The configuration failure links to
  settings, retriable failures offer Retry, the composer becomes usable again,
  and reload preserves the error message. The development launch executes a
  sidecar rebuilt from current runtime source.
- **Specs linked**: `03-runtime/02-agent-runtime.md`,
  `03-runtime/07-process-model.md`, `03-runtime/08-error-codes.md`
- **Acceptance**: C (failed chat settles), H (errors expose stable codes)
- **Milestone**: M2
- **Status**: Unit-covered (agent-runtime error message/redaction, host
  persistence, desktop transcript contract, and predev build contract); full
  Electron UI scenario Draft

### Hardening (M5)

#### E2E-032: Backend crash triggers supervised restart

- **Preconditions**: App running; host-core and sidecar healthy.
- **Steps**: 1) Kill the host-core (or sidecar) process externally. 2) Observe app behavior.
- **Expected**: In-flight RPCs fail fast (no long hang); `hostStatus` shows degraded then restored; child restarts with backoff; after 3 failed restarts in 2 minutes the app stays degraded with a visible fatal status. Repeat the kill with the main window closed: the crash is still logged (with the child's last stderr lines), the child still restarts, and no unhandled renderer-send error appears — supervision is independent of a live window.
- **Specs linked**: `03-runtime/07-process-model.md`
- **Acceptance**: Quality (main path no crash)
- **Milestone**: M5
- **Status**: Automated (`scripts/e2e-supervision.mjs` — SIGKILL host-core, assert restart + healthy RPC)

#### E2E-033: Window bounds persist across restart

- **Preconditions**: App running with default window size.
- **Steps**: 1) Resize/move the window to distinct normal bounds A (≥1040×700), maximize before the 600ms save debounce ends, quit, and relaunch. 2) Restore, resize/move to distinct bounds B, quit before the debounce ends, and relaunch again.
- **Expected**: Each relaunch restores the latest normal bounds (A, then B), including when quit occurs while maximized or with a pending save. Maximized/fullscreen geometry is never stored as normal bounds; invalid/tiny saved bounds fall back to the 1200×800 default.
- **Specs linked**: `04-ux/09-interaction-patterns.md`
- **Acceptance**: Quality (key operations feel polished)
- **Milestone**: M5
- **Status**: Documented

#### E2E-034: NDJSON log files are written and redacted

- **Preconditions**: Fresh profile; provider configured; one chat turn completed.
- **Steps**: 1) Run a prompt with a tool call. 2) Open `~/.pi-desktop/logs/`. 3) Inspect the categorized files under `app/`, `host/`, and `agent/`.
- **Expected**: NDJSON records exist with `ts/level/channel/category/message`; tool start/end carry `sessionId`/`toolCallId`; no API key material appears; each category file rotates at 5 MB. Additionally (D183) `host/timing.log` has one `tool timing` record per tool call carrying `prompted`/`permission_wait_ms`/`execute_ms`/`overhead_ms`/`total_ms`, and `agent/timing.log` has matching `[timing] kind=tool` and `[timing] kind=model` lines, so an approval wait, a slow tool body, and a slow provider are distinguishable for the same `toolCallId`.
- **Specs linked**: `03-runtime/09-logging-and-observability.md`
- **Acceptance**: H (diagnostics)
- **Milestone**: M5
- **Status**: Documented

#### E2E-035: Bash tool uses the effective catalog shell

- **Preconditions**: Workspace open; agent mode.
- **Steps**: 1) Select an available catalog shell and run `Bash` (e.g. `echo ok`). 2) Make the persisted selection unavailable and inspect the effective catalog before running the next turn. 3) Run with the previous turn snapshot.
- **Expected**: The unchanged `Bash` protocol call uses the selected catalog entry. A later unavailable persisted choice falls back to the first available platform shell and marks the catalog fallback; the previous turn snapshot is rejected as stale by `COMMAND_SHELL_CHANGED` rather than silently changing shell. No partial execution occurs; E2E-113 covers the stale identity path.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md`, `03-runtime/06-host-rpc-protocol.md`, `03-runtime/08-error-codes.md`, ADR 0054
- **Acceptance**: H (errors expose stable codes)
- **Milestone**: M5
- **Status**: Unit-covered (`tools::shell::tests`); scenario Documented

#### E2E-044: Development launch uses PI-Desktop Dock branding

- **Preconditions**: macOS development checkout with canonical `build/icon_1024.png`.
- **Steps**: 1) Run `pnpm dev`. 2) Inspect the running application's Dock icon.
- **Expected**: The Dock shows the PI-Desktop brand icon, not Electron's default icon; packaged builds continue to use `build/icon.icns`.
- **Specs linked**: `06-delivery/06-release-runbook.md`
- **Acceptance**: Quality (development shell matches release branding)
- **Milestone**: M5
- **Status**: Unit-covered (`development-branding.test.mjs`); visual scenario Documented

#### E2E-045: Global text selection preserves editing and copying

- **Preconditions**: App running with a chat transcript containing a user
  message, an assistant Markdown response with a code block, and an expanded
  tool result.
- **Steps**: 1) Drag across sidebar/titlebar chrome and a button label. 2)
  Drag across user/assistant prose, code, and tool output. 3) Focus the
  composer and a settings/search input, then use `Cmd/Ctrl+A` and replace the
  selected text. 4) Copy selected transcript and code text.
- **Expected**: Chrome does not leave an accidental text selection; message
  prose, code, tool input/output, and editable controls remain selectable and
  copyable; native editing shortcuts, focus-visible rings, and window drag
  behavior remain intact.
- **Specs linked**: `04-ux/07-ui-design-system.md`,
  `04-ux/09-interaction-patterns.md`
- **Acceptance**: Quality (key operations feel polished)
- **Milestone**: M5
- **Status**: Unit-covered (`user-select.test.mjs`); scenario Documented

#### E2E-046: PI-Desktop renderer branding and composer icon boundary

- **Preconditions**: App running in both English and zh-CN locales, with an
  empty home and a docked transcript available.
- **Steps**: 1) Inspect the expanded and collapsed sidebar. 2) Inspect the
  empty-home hero and docked composer. 3) Observe the eight-frame mascot GIF
  looping in place, move the pointer over it, and confirm its cadence and
  geometry do not change. Enable reduced motion and confirm the still first
  frame is shown. 4) Focus the footer Settings and Plugins icons, then each
  project/Temporary session create control. 5) Open Settings and the composer
  input.
- **Expected**: Visible shell identity reads `PI-Desktop`; the empty-home hero
  renders the theme-matching 100px `HomeMascotLogo` GIF with a short idle hold
  and a looping wave. Pointer hover does not alter the cadence or geometry,
  and reduced motion shows the matching still first frame.
  The expanded/collapsed
  sidebar renders the derived `src/assets/brand/logo-*.png` asset through `BrandLogo`
  and the docked composer prompt row has no leading
  brand icon or reserved icon slot and its text aligns directly with the input
  gutter. The right Composer toolbar shows a Bot model × reasoning chip, then
  a standalone prompt-enhancement Sparkles button, then the single submit
  slot. The footer Settings and Plugins actions are compact icon buttons;
  Plugins sits immediately to the right of Settings and exposes a localized
  accessible name. Every scoped session-creation control uses the dedicated
  message-plus icon with localized labels and accessible names. `Codex` remains visible only as
  the external import-source label or in non-runtime design-reference text.
- **Specs linked**: `04-ux/01-ui-ia.md`, `04-ux/07-ui-design-system.md`,
  `04-ux/08-component-spec.md`, `04-ux/09-interaction-patterns.md`,
  `08-meta/decisions-log.md` (D094/D160/D293),
  `../../adr/0031-icon-free-composer-prompt-row.md`,
  `../../adr/0152-eight-frame-empty-home-mascot-gif.md`
- **Acceptance**: Quality (brand consistency and key operations feel polished)
- **Milestone**: M5
- **Status**: Unit-covered (`renderer-branding.test.mjs`); scenario Documented

#### E2E-047: Retain, collapse, switch, and close multiple project tabs

- **Preconditions**: Projects A and B each have at least one durable session;
  neither path is archived; a Temporary session also exists.
- **Steps**: 1) Open project A from Settings → Project archive. 2) Open project B without closing
  A. 3) Click A's directory row on its chevron, folder, label, and trailing
  disclosure hit area in turn to collapse/expand it; use B's directory row to
  activate and collapse B; verify `+` and overflow do not toggle B. 4) Hover and
  keyboard-focus A's project title and confirm the full path is exposed; open
  A's project overflow or right-click menu and choose Open folder; confirm
  conversation overflow no longer offers Open folder. 5) Select A's conversation.
  6) Close B. 7) Restart the app. 8) Reopen B from Settings → Project archive.
- **Expected**: A and B render as separate exact-path sidebar groups in a
  compact continuous list with one keyboard stop per directory disclosure;
  every non-action point in A's row toggles only A, project actions appear on
  hover/focus without shifting labels, the project title hover/focus path shows
  A's full absolute path, Open folder is a project-menu action only and opens A
  in the system file manager, and collapse survives restart;
  activating a group or its conversation
  clears the previous visible transcript, updates the selected workspace and
  session binding, and then loads only the selected project's conversation;
  Temporary remains separate; closing B removes only its retained tab and
  deletes neither its project row nor sessions; reopening B restores the same
  sessions without duplication.
- **Specs linked**: `04-ux/01-ui-ia.md`, `04-ux/08-component-spec.md`,
  `04-ux/09-interaction-patterns.md`, ADR 0016
- **Acceptance**: C (switch sessions), D (workspace), F (local presentation
  persistence)
- **Milestone**: M5
- **Status**: Unit-covered (`sidebar-preferences.test.mjs` for retained paths
  and collapse persistence); full UI scenario Draft

#### E2E-047b: Sidebar session hover card surfaces rich metadata

- **Preconditions**: A retained project with at least two sessions, one of
  which has a recorded git branch; a Temporary/scratch session also exists.
- **Steps**: 1) Hover a session row under the retained project and wait for
  the card to appear; repeat with keyboard focus on the same row. 2) Move the
  pointer to a different session row without leaving the sidebar; wait. 3)
  Hover a Temporary/scratch session row. 4) Resize the sidebar narrower than
  320px; hover again. 5) Right-click a session row while the card is visible
  and open its context menu. 6) Scroll the sidebar body while the card is up.
- **Expected**: The card appears after a 500ms dwell, never appears during
  quick pointer passes, and re-targets to the latest hovered row when the
  pointer changes. Each card shows: the localized session title, two tag
  chips (Local task + mode/permission badge), the project name under
  Workspace (or "Temporary" / "临时对话" for scratch rows), the project's
  git branch when one is known, and the row's `Updated` timestamp formatted
  by the active locale. The session row has no native `title` tooltip; the
  hover card is the only full-title surface. The card never widens past
  320px, never causes the underlying row to horizontally scroll, and
  disappears immediately on resize, scroll, or context-menu open.
- **Specs linked**: `04-ux/09-interaction-patterns.md §9.1b`
- **Acceptance**: F (local presentation)
- **Milestone**: M5
- **Status**: Unit-covered (`sidebar-navigation.test.mjs` for the session
  hover card and the absence of a native row `title`); full UI scenario Draft

#### E2E-048: Pin, archive, restore, and sort project/conversation rows

- **Preconditions**: Two retained projects contain conversations with distinct
  titles and created/updated timestamps; archived view is initially disabled.
- **Steps**: 1) Inspect the Sessions and Projects heading actions at rest. 2)
  Hover each heading and keyboard-focus each action to confirm the controls
  reveal without moving the labels. 3) Inspect the `Sessions` toolbar and verify
  that Sort appears before New Chat. 4) Open Sort and inspect its placement,
  then select Recently updated, Created date, Oldest first, and Name in turn.
  5) Pin one project and one conversation. 6) Archive another conversation
  and project. 7) Enable Show archived and restore both. 8) Restart the app.
  9) Delete a disposable conversation through the distinct Delete action.
- **Expected**: Section create and sort controls are visually quiet at rest and
  reveal on toolbar hover or keyboard focus; project `+` and overflow actions
  follow the same rule without shifting labels. Sort precedes New Chat in the
  Sessions toolbar; the sort menu remains content-sized, opens to the trigger's
  right without flipping left, and
  session/project/section body-level menus use the same right-side rule with a
  narrow-viewport width cap. Pinned rows remain ahead
  of unpinned rows under every selected secondary order; in the sidebar, pinned
  project rows replace the Folder with a filled accent Star while unpinned rows
  retain Folder. Each sort
  produces the documented stable order; archived rows disappear from the default view but
  retain transcripts/project records and reappear in Show archived; restore
  returns them to the selected order; archiving the active row selects a visible
  non-archived fallback or creates the documented empty fallback instead of
  leaving hidden active context; pin/archive/sort choices survive restart; only
  Delete removes the disposable durable session. A legacy `manual` preference
  loads safely without exposing or implying a drag-reorder workflow.
- **Specs linked**: `03-runtime/04-data-storage.md`, `04-ux/01-ui-ia.md`,
  `04-ux/08-component-spec.md`, `04-ux/09-interaction-patterns.md`
- **Acceptance**: C (session organization), F (persistence)
- **Milestone**: M5
- **Status**: Unit-covered (`sidebar-preferences.test.mjs` for metadata,
  filtering, and sort behavior); full UI scenario Draft

#### E2E-048A: Project session lists fold after the ten most recent rows

- **Preconditions**: One retained project contains more than ten durable
  sessions with distinct updated timestamps; the sidebar uses the default
  Recently updated sort; another retained project has ten or fewer sessions.
- **Steps**: 1) Inspect the large project's session rows and count them. 2)
  Select the **Load N more…** control. 3) Switch the sort to Name and inspect
  the same group before expanding. 4) Restart the app and inspect the group
  again.
- **Expected**: The group shows exactly ten session rows by default plus a
  **Load N more…** control (N = remaining session count) styled like the
  time-grouped overflow; the ten rows are the first rows in the active sort
  order, so pinned rows are never pushed behind unpinned rows and a Name sort
  folds everything after the first ten alphabetically; selecting Load more
  expands the full time-grouped list (Yesterday/Previous 7 days/Previous 14
  days/Older headers appear as applicable) and the control disappears;
  expansion is per group and resets on restart (not persisted); the project
  with ten or fewer sessions shows no fold control.
- **Specs linked**: `04-ux/01-ui-ia.md`, `04-ux/09-interaction-patterns.md`
- **Acceptance**: C (session organization)
- **Milestone**: M5
- **Status**: Scenario Documented

#### E2E-049: Background sessions keep their originating workspace

- **Preconditions**: Projects A and B are retained; each contains a session in
  Agent mode; both workspaces contain different marker files with the same
  relative name.
- **Steps**: 1) In session A, start a turn that reads the marker and performs a
  permission-gated long-running tool. 2) While A is running, activate project
  B and open session B. 3) Read B's marker and allow a tool only in B. 4) Wait
  for both turns to complete. 5) Open a Temporary session and attempt a
  workspace-required tool.
- **Expected**: Switching tabs aborts neither turn; A's tool cwd/path sandbox
  remains project A and B's remains project B; A's events and grants never
  appear in B's transcript/session; each sidebar row reports its own
  running/completed state; the Temporary session inherits no project and
  receives `WORKSPACE_REQUIRED`; returning to A restores A's completed
  transcript.
- **Specs linked**: `02-architecture/01-architecture.md`,
  `03-runtime/02-agent-runtime.md`, `03-runtime/03-tools-and-permissions.md`,
  `03-runtime/06-host-rpc-protocol.md`,
  `03-runtime/10-session-state-machine.md`, ADR 0016
- **Acceptance**: C (parallel sessions), D (workspace), E (tool/permission
  isolation), Security (workspace boundary)
- **Milestone**: M5
- **Status**: Unit-covered (`rpc::tests` for project-bound, Temporary, and
  missing-session workspace resolution); full multi-turn UI scenario Draft

#### E2E-050: Composer model × reasoning menu follows exact capability

- **Preconditions**: One catalogued reasoning model, one non-reasoning model,
  and one unknown free-form model id.
- **Steps**: 1) Open the Composer model × reasoning chip. 2) Confirm the root
  contains only Model and Reasoning level entries with current values. 3) Open
  Model, search for a model, and select a model from a provider group. 4) Confirm
  the menu remains open at the root, then open Reasoning level and choose multiple
  supported levels. 5) Repeat with a non-reasoning provider and an unknown
  free-form model id; exercise Escape, outside click, Up/Down, Enter, and Left.
- **Expected**: The chip is in the right toolbar with a Bot icon, before the
  standalone prompt-enhancement Sparkles action and Send/Abort; Off omits the
  level text. The single anchored menu replaces its root
  with an in-place back row and submenu, never opens tabs or a second popover,
  and always reopens at the root. Model search filters sticky provider groups;
  reasoning rows come from the selected model's explicit binding levels in
  canonical order, use radio semantics and a trailing check, and show the
  current model support note. Selecting either value immediately updates the
  chip and root value, clears model filtering, and keeps the menu open. A
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
- **Status**: Unit-covered (`thinking-ui.test.mjs`, `composer-model-thinking-menu.test.mjs`, agent-runtime capability tests); full UI scenario Draft

#### E2E-051: Thinking level persists with the session

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

#### E2E-052: Thinking level reaches the pi request

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

#### E2E-053: Thinking streams separately from the answer

- **Preconditions**: Provider emits thinking deltas before and between answer
  deltas.
- **Steps**: 1) Start a turn in both light and dark themes. 2) Observe a
  thinking-only phase. 3) Let the answer complete. 4) Toggle the disclosure,
  test keyboard focus, enable reduced motion, and use Copy answer.
- **Expected**: The transcript opens during thinking-only streaming; one open
  Thinking disclosure updates without an empty answer bubble or duplicate
  Working indicator. The disclosure uses the transcript surface, theme tokens,
  a Sparkles/chevron trigger, and a left rule instead of an inset card;
  collapsed content leaves focus traversal and reduced motion disables the
  running marker pulse and transitions. Final answer markdown renders separately; Copy answer
  contains no thinking text.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `04-ux/07-ui-design-system.md`, `04-ux/08-component-spec.md`, ADR 0018
- **Acceptance**: C (chat and stream), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`thinking-ui.test.mjs`, agent-runtime event tests); full streaming scenario Draft

#### E2E-054: Stored thinking reloads losslessly

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

#### E2E-055: Unsupported provider transition clamps safely

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

#### E2E-056: Work panel shell docking and persistence

- **Preconditions**: App running with any workspace state.
- **Steps**: 1) Relaunch and inspect the titlebar and application menu; confirm
  the panel starts closed. Press Cmd/Ctrl+J and inspect the empty panel title
  and context menu, then press it again to confirm the shortcut collapses the
  panel and no tab is created or deleted; a third press must restore the same
  context. 2) Open two distinct file artifacts, the same first file again,
  a URL preview, and a completed Bash row. 3) Open the header's unified
  context menu: verify Browser and in-scope plugin views appear once, with active,
  open-inactive, and closed states, and that transcript-opened resources appear
  only in the second section. Open/select each available view with pointer
  and keyboard,
  reopen a Browser that already has a URL and confirm the URL survives, walk the
  rows with ArrowDown/ArrowUp/Home/End (focus must skip the close buttons), close
  an inactive row with Delete and confirm the menu stays open with focus on the
  neighbor, press Escape and confirm focus returns to the trigger, then close the
  active item from the header. Confirm the right action cluster stays at the
  header's right edge for both the shortest and longest labels. 4) Close active middle and edge items
  and verify neighbor selection. 5) Use the sole session-pane collapse control and
  trigger another artifact. 6) In session A, leave the panel open with multiple
  tabs and a Browser resource; switch to session B, create a different tab set,
  then switch repeatedly between A and B and select a project without an active
  conversation. Generate a background artifact in the non-visible session.
  7) Drag the inner left-edge handle left and right across its bounds; verify
  pointer-down does not jump the divider or resize the native window, cancel one
  gesture with Escape, then focus the handle and exercise Arrow/Shift+Arrow/Home/End.
  Commit a different panel width with Browser active. 8) Record MainChat width
  and native bounds while opening, repeating the same open action, resizing the
  panel, collapsing, reopening, and closing the final resource. Repeat collapse
  on Windows while watching the entire frameless window. 9) With the panel open,
  resize the application from each native edge and confirm only the application
  bounds change; the panel remains at its renderer-committed width. Resize from
  the left edge and repeat after toggling the sidebar. 10) Open, resize, and
  collapse on a small work area, then repeat while maximized and fullscreen. 11)
  Move the normal window between displays and change the active display's
  work-area geometry. 12) Send valid and malformed reservation payloads,
  including positive values, and confirm the compatibility seam never changes
  native bounds. 13) Relaunch.
- **Expected**: Startup shows no panel, welcome chooser, fixed tool buttons, or
  titlebar/menu launcher. Cmd/Ctrl+J opens the active session's panel at its
  committed width without creating a resource tab and collapses it again on the
  next press while retaining that context,
  and the shortcut does nothing without an active session or while Settings is
  open. Each artifact atomically opens the docked third column and creates or
  activates one resource; file resources are path-keyed and repeated resources
  deduplicate. Opening, collapse, and
  closing animate the panel's width/flex allocation with its bounded
  opacity/slide, so MainChat reflows continuously without a pre-animation jump.
  Opening the panel, collapsing it, or committing a divider resize updates the
  presentation jump. Once the panel is open, a single unified context trigger
  opens one dropdown that lists Browser and in-scope plugin views, with a fill
  plus 2px edge marker for the active row and a dot for open inactive ones, each
  open row carrying its own close control in an always-reserved trailing slot;
  a second section appears after a divider only for transcript-opened resources
  (full-path tooltips, per-item close), so no entry is listed twice. The menu
  fades in over ≤4px and is static under reduced motion. Arrow/Home/End move
  focus across rows only and skip the close buttons, ArrowDown/ArrowUp on the
  trigger open on the active/last row, Delete/Backspace closes the focused row
  while the menu stays open with focus on its neighbor, and Escape/Tab/selection
  restore focus to the trigger. Reopening an already-open tool activates it and
  preserves its Browser URL. The right action cluster stays pinned to the
  header's right edge regardless of label length. Opening the menu temporarily
  hides the native Browser preview so it is never occluded. The sole collapse
  control sits in the session pane top-right rather than the content header.
  Active close selects the right neighbor then left; closing the last tab hides
  the panel. Collapse retains runtime tabs but hides the panel until another
  artifact reopens it. Width clamps to the fixed `244px–720px` range and
  previews its current/minimum/maximum values through the panel separator. The
  inner divider exposes the panel width to assistive technology and supports
  the documented keyboard steps. Pointer-down preserves the starting width,
  movement follows the pointer continuously, and release commits once only when
  the target changed. Escape or cancellation restores the press-time width.
  Browser preview does not intercept an active divider drag.
  A and B independently restore their runtime open state, ordered tabs, active
  tab, and Browser resource; selecting a project without an active conversation
  hides the panel, and no relative resource crosses session/workspace context.
  Background artifacts update only their retained context and never change the
  visible panel or native window geometry. Before exit motion, the native
  Browser preview detaches from the window; collapse produces no stale preview
  frame. Only `{width}` is restored after relaunch; every session's open state,
  tabs, active tab, and Browser resource reset. The panel remains exactly at its
  committed width while open, and sidebar or native window changes do not alter
  that preferred panel width. The compatibility reservation seam returns
  `{requested: 0, reserved: 0}` for every valid request, including positive
  legacy values, and never changes native bounds. Malformed payloads fail with
  `INVALID_ARGUMENT` and never coerce. The former context-panel overlay no
  longer exists.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`, `04-ux/01-ui-ia.md`,
  `04-ux/07-ui-design-system.md`, `04-ux/08-component-spec.md`,
  `04-ux/09-interaction-patterns.md`, ADR 0068, ADR 0151, D207, D292
- **Acceptance**: F (persistence), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`work-panel-resize.test.mjs`,
  `work-panel-window.test.mjs`, `work-panel-presentation.test.mjs`,
  `work-panel.test.mjs`); full UI scenario Draft

#### E2E-057: Message-owned review history survives commits and rolls back safely

- **Preconditions**: A project-bound Agent session with a writable workspace;
  no Git repository is required.
- **Steps**: 1) Ask the active agent to edit an existing file and create a new
  file in session A. 2) Expand the activity group and inspect each review card
  directly after its corresponding tool row; verify every card starts
  collapsed with its added/modified status and +/− counts visible in the
  header, then expand it to verify the exact hunks. 3) Commit the files
  outside the app, close and reopen the Review panel, then reload session A.
  4) Verify the same cards
  and counts remain because they come from the transcript messages. 5) Use a
  card's rollback action and verify the created file is removed or the previous
  file bytes are restored. 6) Edit that file again outside the app and retry
  rollback; inspect the conflict result and verify the later bytes remain. 7)
  Switch to session B and a background project session, then return to A. 8)
  Repeat with failed, denied, and scratch writes.
- **Expected**: Each successful workspace Write/Edit creates one message-owned
  review record and one adjacent keyboard-accessible card; the card is never a
  bottom/global entry. Every review card, inline and in the Review tab, is
  collapsed by default and expands on demand. The Review tab lists A's
  chronological recorded changes, independent of Git status, repository
  presence, commit state, focus refresh,
  or workspace switching. Added, modified, and deleted statuses plus line
  additions/deletions and hunks are shown when bounded evidence is available.
  Successful rollback updates the card to Rolled back and survives restart.
  A post-tool file change returns Conflict and does not overwrite it. Failed,
  denied, and scratch writes do not create cards; session B cannot inherit A's
  records. Binary or oversized snapshots show bounded metadata and disable
  rollback when the previous bytes were not retained.
- **Specs linked**: `03-runtime/01-ipc-protocol.md` §13a,
  `03-runtime/03-tools-and-permissions.md` §4c,
  `04-ux/08-component-spec.md` §5, ADR 0043
- **Acceptance**: D (workspace), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`chat-review-entry.test.mjs`); full UI scenario Draft

#### E2E-058: Built-in interactive terminal is absent

- **Preconditions**: A workspace is open and the Agent has completed a Bash
  tool call.
- **Steps**: 1) Open the work panel with Cmd/Ctrl+J and inspect the empty
  state and context menu. 2) Confirm there is no Terminal tab, launcher row,
  terminal-specific panel copy, or terminal IPC surface. 3) Confirm the
  completed Bash row still shows its command, output, status, and copy action,
  and that its `IconTerminal` presentation remains available. 4) Verify an
  interactive shell is opened in the user's external terminal instead of the
  work panel. 5) Build/package the desktop app and inspect the dependency and
  unpacked-resource lists.
- **Expected**: The work panel offers Browser and in-scope plugin views plus
  transcript-opened Review/file resources; no PTY is created and no terminal
  tab can be opened. Agent Bash remains non-interactive and fully visible in
  the transcript. Interactive shell work is performed by the external
  terminal. Desktop packaging has no PTY/xterm dependency, terminal-specific
  IPC, or native terminal payload, while generic lifecycle `terminal` values
  continue to work.
- **Specs linked**: `02-architecture/02-tech-stack.md`,
  `03-runtime/01-ipc-protocol.md` §13a, `04-ux/08-component-spec.md` §5,
  ADR 0108
- **Acceptance**: D (workspace), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`work-panel.test.mjs`, `packaging-footprint.test.mjs`);
  full UI scenario Draft

#### E2E-059: Embedded browser preview isolation and overlays

- **Preconditions**: A local dev server is running; a URL or BrowserPreview artifact exists.
- **Steps**: 1) Activate the artifact, enter `localhost:<port>` without a scheme, and submit.
  2) Navigate site links; use back/forward/reload/stop. 3) Trigger a
  `window.open` popup and a permission-requesting page (e.g. notification
  prompt). 4) Open global search, then Settings. Return to chat
  and trigger an inline tool permission card. 5) Switch to another panel tab
  and back; close the panel. 6) Use open-external.
- **Expected**: Scheme-less input normalizes to http; nav state (URL bar,
  back/forward enablement, load spinner) mirrors the page. Popups open in
  the default browser (never in-app); permission requests are denied;
  non-http(s) navigation is blocked. The preview hides under every blocking
  overlay and while unmounted, reappearing with correct bounds afterwards. An
  inline permission card does not hide or remount the preview; resize/drag
  keeps the view aligned with the placeholder rect.
  Open-external launches the current URL in the default browser. The view
  uses an isolated persist partition (no session bleed from the app shell).
- **Specs linked**: `03-runtime/01-ipc-protocol.md` §13a, ADR 0019
- **Acceptance**: Quality, Security
- **Milestone**: M5
- **Status**: Draft (manual)

#### E2E-060: Files tab browsing stays inside the workspace

- **Preconditions**: Workspace with file artifacts for nested source, large
  (>512KB), image, and binary files.
- **Steps**: 1) Activate each file artifact and verify a distinct path-keyed
  resource in the header switcher; browse the tree, expanding nested folders.
  2) Open a source
  file, the image, the binary, and the large file. 3) Use reveal-in-Finder.
  4) Attempt a traversal read (`../outside`) via devtools IPC. 5) Switch
  workspaces.
- **Expected**: Directories list lazily, folders first, with `.git` /
  `node_modules` / build outputs hidden; text renders with syntax highlight
  (capped at 5000 lines), images preview inline, binary and oversized files
  show fallbacks with reveal still available. Traversal attempts are
  rejected with `INVALID_ARGUMENT`; no workspace → empty state; switching
  workspaces resets the tree and viewer.
- **Specs linked**: `03-runtime/01-ipc-protocol.md` §13a, ADR 0019,
  `03-runtime/15-workspace-ignore-rules.md`
- **Acceptance**: D (workspace), Security
- **Milestone**: M5
- **Status**: Unit-covered (`fs-panel-guard.test.mjs`); full UI scenario Draft

---

#### E2E-059a: Transcript message plates follow WorkBuddy density

- **Preconditions**: A session contains at least one short user prompt, one
  longer user prompt, and a completed assistant answer; light and dark themes
  available.
- **Steps**: 1) Open the session in dark theme. 2) Inspect user and assistant
  rows at rest and on hover. 3) Start a streaming assistant answer. 4) Switch
  to light theme and repeat. 5) Focus the copy control with the keyboard.
- **Expected**: User turns are right-aligned, theme-neutral soft plates capped
  near 560px, derived from each theme's primary text ink rather than an accent
  tint, with a subtle border; assistant answers remain transparent full-width
  prose in the 720px content band, including while they stream — no left rail
  and no whole-turn `--ds-tile` (D323). The tile belongs only to a
  subagent/delegation card (D319). Row spacing is denser (~10px). Copy chips are
  hidden at rest, appear on hover/focus-within, and stay right-aligned under
  user turns. Both themes keep readable contrast on the user plate.
- **Specs linked**: `04-ux/07-ui-design-system.md`,
  `04-ux/08-component-spec.md` §8.3 / §8.4, `04-ux/10-workbuddy-benchmark-ux.md`,
  decisions-log D101, D323
- **Acceptance**: C (chat stream), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`transcript-style.test.mjs`); full visual scenario Draft

#### E2E-060b: Neutral gray accent across chrome

- **Preconditions**: App running in dark and light themes; plugins page and a
  chat with markdown links/blockquotes available.
- **Steps**: 1) Inspect focus rings, primary buttons, toggles, selected
  session ring, plugin market primary CTAs. 2) Open an assistant answer with
  links and a blockquote. 3) Switch theme and re-check.
- **Expected**: No blue brand accent remains. Interactive accent, markdown
  links/rules, and plugin primary actions resolve through the neutral gray
  accent tokens (`white/gray` dark, dark-ink light). The plugins
  installed/market UI (tabs, search, cards, permission modal, and primary /
  secondary buttons) uses only `--ds-*` tokens with no blue-slate fallbacks in
  either theme; button surfaces and ink remain visible in dark mode. Semantic
  success/warning/error colors are unchanged.
- **Specs linked**: `04-ux/07-ui-design-system.md`,
  `04-ux/08-component-spec.md`
- **Acceptance**: Quality
- **Milestone**: M5
- **Status**: Unit-covered (`neutral-accent.test.mjs`,
  `plugins-page-style.test.mjs`); visual scenario Draft

#### E2E-060c: Assistant markdown prose hierarchy and code chrome

- **Preconditions**: A completed assistant answer containing headings, a
  blockquote, a GFM table, a fenced code block with a language tag, inline
  code, a task list, and a remote image link; light and dark themes available.
- **Steps**: 1) Open the session in dark theme and scroll the answer. 2)
  Hover the code-block copy control and the table rows. 3) Expand a thinking
  disclosure that contains markdown. 4) Switch to light theme and re-check
  contrast on inline code, blockquote rule, and code card.
- **Expected**: Answer prose uses the `.prose-chat` hierarchy (h1–h6 ramp,
  accent-tinted blockquote, hairline-bordered inline code, zebra/hover table
  shell, inset code card with monospace language tag). Thinking prose stays
  secondary/smaller and does not merge into the answer. Both themes keep
  readable contrast; copy still copies raw fence text.
- **Specs linked**: `04-ux/07-ui-design-system.md`,
  `04-ux/08-component-spec.md` §8.7
- **Acceptance**: C (chat stream), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`user-select.test.mjs`, `thinking-ui.test.mjs`);
  full visual scenario Draft

#### E2E-061: User message plaintext layout survives wrapping and reload

- **Preconditions**: Provider configured; composer can accept multi-line input
  via Shift+Enter (or Enter-to-send disabled).
- **Steps**: 1) Compose a three-line prompt with two hard newlines and a URL
  whose encoded path is wider than the user plate. 2) Send. 3) Inspect the user
  bubble in the transcript. 4) Copy the user message and paste into an external
  editor. 5) Reload the session.
- **Expected**: The user plate shows three distinct lines (not collapsed to a
  single paragraph). The linked URL wraps inside the plate without horizontal
  overflow, and every continuation line stays logical-start aligned with the
  first line instead of being centered. Copied text retains the original
  newlines. After reload the same line breaks remain.
- **Specs linked**: `04-ux/08-component-spec.md`
- **Acceptance**: C (chat stream), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`transcript-style.test.mjs`); full visual scenario Draft

#### E2E-060d: Assistant meta chips, compact context summary, and retry action

- **Preconditions**: A completed assistant message includes modelId and token
  usage; another completed assistant message has content but no usage. The
  selected model has a published 1m-class context window, while its provider
  binding still contains the legacy 128k generic seed.
- **Steps**: 1) Open the session. 2) Hover the completed assistant turn that has
  usage, confirm the panel stays closed, then click its Context inspector
  trigger. 3) Inspect the compact remaining-token header, used/window counts,
  unboxed turn/speed values, one inline provider-usage summary, and one
  aggregate tool-usage summary. 4) Scroll the transcript until the trigger is
  close to the top, bottom, and right viewport edges, and resize the window
  while the panel is open. 5) Move the pointer away from the panel, then
  dismiss it by clicking the trigger again, clicking outside it, and pressing
  Escape from the keyboard. 6) Click Retry on that turn while idle. 7) Confirm
  a turn without usage still offers Retry and omits the inspector.
- **Expected**: Model badge and compact Context inspector appear under completed
  assistant answers when data exists; the trigger shows remaining capacity and
  low-space warning/error states, and click or keyboard activation toggles the
  same compact summary while pointer hover alone never opens or closes it. An
  open panel survives the pointer leaving it and closes on a second trigger
  activation, an outside click, or Escape, which returns focus to the trigger.
  Provider values remain exact, tool values remain visibly approximate through
  the `~` aggregate total, and no per-tool list, source badge, progress bar, or
  explanatory estimate paragraph is rendered. The cache hit rate is omitted
  when cache-read metadata is absent rather than inferred. A published 1m-class
  limit (for example `gpt-5.6-luna` at 1,050,000 tokens) is shown instead of
  128k, the same effective window is used by the agent runtime, and a non-default
  Advanced override remains honored. Generation rate remains a completed-turn
  value and does not update during streaming; Retry
  re-sends the nearest preceding user prompt and is disabled while a turn is
  running; the portaled panel remains fully visible within the viewport, never
  clipped by transcript scrolling, and follows the trigger after scrolling or
  resize; Copy still excludes thinking text.
- **Specs linked**: `04-ux/08-component-spec.md`,
  `04-ux/10-workbuddy-benchmark-ux.md`, `03-runtime/01-ipc-protocol.md`
- **Acceptance**: C (chat stream), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`transcript-style.test.mjs`,
  `context-usage.test.mjs`, runtime usage mapping); full scenario Draft

#### E2E-061a: Regenerate replaces the current turn in place

- **Preconditions**: A session has user A → assistant A → user B → assistant B.
- **Steps**: 1) Hover assistant A and click Regenerate. 2) Wait for the new
  turn to complete. 3) Reload the session.
- **Expected**: Transcript truncates away assistant A / user B / assistant B
  before the redo starts; only user A plus the new assistant/tool tail remain.
  The regenerated answer does not leave the old branch above it. Reload keeps
  the truncated branch only.
- **Specs linked**: `04-ux/08-component-spec.md`,
  `03-runtime/01-ipc-protocol.md`, `03-runtime/04-data-storage.md`
- **Acceptance**: C (chat stream), F (persistence)
- **Milestone**: M5
- **Status**: Unit-covered (store/main truncate wiring tests); full scenario Draft

#### E2E-062: Regenerate history pager restores prior variants

- **Preconditions**: A session where an assistant answer was regenerated at least once.
- **Steps**: 1) Click Retry/Regenerate on a completed assistant turn. 2)
  Observe the visible root user bubble while the replacement turn starts and
  after it completes. 3) Switch to a previous variant. 4) Switch forward
  again. 5) Reload the session.
- **Expected**: The root user bubble remains visible and shows the
  `current / total` pager inside its action toolbar once the row is hovered or
  focused; the toolbar, including the pager, is hidden by default. Retry does
  not move or detach the selector from that bubble. Switching restores the
  archived assistant/tool branch in place. Reload preserves the active variant
  and the full revision set.
- **Specs linked**: `04-ux/08-component-spec.md`, `03-runtime/04-data-storage.md`
- **Acceptance**: C (chat stream), F (persistence)
- **Milestone**: M5
- **Status**: Unit-covered (`sessions::tests::save_and_activate_message_revision`, schema v4 migration); full scenario Draft

#### E2E-063: Empty home keeps the primary task surface focused

- **Preconditions**: App running on empty chat home (no transcript) in light
  and dark themes; window can be resized to ~1200×690 and ~900×640.
- **Steps**: 1) Open empty home. 2) Confirm the hero contains the quiet logo,
  localized title, and short supporting line. 3) Confirm no developer starter
  cards or contextual quick-action row is rendered. 4) Dismiss onboarding and
  inspect again. 5) Repeat in the other theme. 6) Resize to a short height and
  scroll the content region if needed.
- **Expected**: The default empty state keeps the hero and bottom composer as
  the visual anchors, with optional onboarding as the only additional content.
  Dismissing the checklist leaves no empty spacer. The composer remains at the
  bottom without covering the hero or checklist, and short windows keep every
  content block reachable via scroll.
- **Specs linked**: `04-ux/01-ui-ia.md`, `04-ux/07-ui-design-system.md`,
  `04-ux/08-component-spec.md`, `08-meta/decisions-log.md` (D111/D131/D204/D206)
- **Acceptance**: Quality (layout integrity)
- **Milestone**: M5
- **Status**: Unit-covered (`home-empty-layout.test.mjs`); full UI scenario Draft

#### E2E-094: Active turns keep the lower transcript surface clear

- **Preconditions**: A deterministic agent can emit thinking, tool start/end,
  streamed answer, permission, and terminal events for a durable session; a
  second session can run in the background.
- **Steps**: 1) Start a turn in the visible session. 2) Observe the transcript
  while the agent is thinking, using tools, and streaming an answer. 3) Trigger
  a permission request and inspect the approval card. 4) Switch to a second
  session while the first continues. 5) Return to the first session after
  completion.
- **Expected**: No generic Understanding, Working, Checking, or completion
  card appears below the transcript while the turn is active. Assistant and
  tool rows remain inline; only an actual permission request renders an
  actionable card. Background activity never changes the visible session,
  transcript, composer focus, or project.
- **Specs linked**: `04-ux/08-component-spec.md`,
  `04-ux/09-interaction-patterns.md`, `03-runtime/10-session-state-machine.md`
- **Acceptance**: C (chat stream), Quality (interaction and accessibility)
- **Milestone**: M5
- **Status**: Unit-covered (`active-turn-surface.test.mjs`); full UI scenario Draft

#### E2E-095: Terminal failures expose recovery without a success card

- **Preconditions**: A deterministic provider can recover from a failed
  directory `Read` with `Glob`, complete a turn with a workspace edit, and fail
  another turn with a retriable error; the session has a visible composer.
- **Steps**: 1) Run the failed-Read then successful-Glob recovery turn and
  inspect its activity group. 2) Complete the workspace-edit turn. 3) Confirm
  that no success outcome card appears and inspect the inline review card
  immediately after the change tool row. 4) Expand the inline card and verify
  its hunks. 5) Commit
  the edited file and confirm the recorded card remains, then use rollback
  once. 6) Trigger the retriable failure. 7) Inspect the failure card, then
  choose Retry. 8) Start another new prompt and inspect the old card.
- **Expected**: The recovered turn keeps the failed Read visible on its own row,
  labels the containing group as processed, completes its session outcome, and
  shows no failure card. Completion uses the transcript and inline review card
  as its evidence without adding a "Task complete" card. File status, counts,
  and hunks remain on the adjacent card after commit, and guarded rollback
  restores the pre-tool state. Failure shows that existing work remains,
  exposes Retry and Continue, and retry preserves the latest prompt. A new turn
  clears the previous failure card; an abort creates no failure outcome copy.
- **Specs linked**: `04-ux/08-component-spec.md`,
  `04-ux/09-interaction-patterns.md`, `03-runtime/10-session-state-machine.md`,
  ADR 0069
- **Acceptance**: C (chat stream), Quality (completion and recovery)
- **Milestone**: M5
- **Status**: Unit-covered (`assistant-turns.test.mjs`,
  `interaction-performance.test.mjs`, `turn-outcome-card.test.mjs`); full UI
  scenario Draft

#### E2E-064: Durable notification inbox records terminal task outcomes

- **Preconditions**: Two durable sessions exist; a deterministic provider can
  complete one turn, fail one turn with a stable error code, and abort one
  turn; notification inbox starts empty.
- **Steps**: 1) Focus and view session A, then complete a turn in A. 2) While
  still focused on A, fail a turn in background session B. 3) Unfocus the
  window and complete another turn in A. 4) Abort a fourth turn. 5) Repeat each
  terminal RPC. 6) Confirm the main titlebar has no bell, then open the bell in
  the expanded sidebar footer and switch between All and Unread. 7) Mark one
  row read and confirm its session has no terminal sidebar mark, then
  close/reopen the popover and restart the app. 8) Select the other session
  from its terminal-marked sidebar row. 9) Generate a host fixture with 205
  eligible terminal turns. 10) Use Mark all read, then Clear.
- **Expected**: A's visible-current completion creates no row or terminal sidebar mark. Exactly two rows
  exist, newest first: the unfocused A completion and background B failure,
  with localized labels, snapshotted session titles, and B's stable code.
  Abort/repeated terminal calls create no row. The former footer Help shortcut
  is absent; the 32px footer bell and its upward-opening popover replace it.
  Badge and Unread show the exact unread count without opening implicitly
  reading rows. Read state and both
  records survive restart. Row selection marks it read and activates its bound
  project/session. The fixture retains exactly the newest 200 rows. Mark all
  preserves rows with zero unread. Selecting the other session clears its
  terminal sidebar mark and marks its task notification read; neither mark
  returns after refresh or restart. Clear empties only the inbox and leaves
  sessions, turns, and transcripts intact.
- **Specs linked**: `03-runtime/04-data-storage.md`,
  `03-runtime/06-host-rpc-protocol.md`, `03-runtime/01-ipc-protocol.md`,
  `04-ux/07-ui-design-system.md`, `04-ux/08-component-spec.md`,
  `08-meta/decisions-log.md` (D117/D130)
- **Acceptance**: C (turn completion), F (persistence), Quality
- **Milestone**: M5
- **Status**: Draft

#### E2E-065: Native task notifications are unfocused-only and activate sessions

- **Preconditions**: Native notifications are supported; sessions A and B
  exist; the main window can be focused, unfocused, hidden, and minimized. A
  Windows run uses the NSIS-installed app or the standard development command.
- **Steps**: 1) Keep the app focused on A and complete a turn in A. 2) While
  still focused on A, complete a turn in B. 3) Unfocus the app while A remains
  current and complete another turn in A. 4) Click A's native notification. 5)
  Minimize the app, fail another turn, and click its native notification. 6)
  Unfocus the app and abort a turn. 7) Repeat with native delivery suppressed
  by the OS. 8) On Windows, inspect the native notification attribution,
  notification-settings entry, taskbar group, installed executable, and Start
  menu shortcut.
- **Expected**: Focused-current A creates neither inbox row, terminal sidebar mark, nor native banner.
  Focused-background B creates an inbox row without a native banner. Unfocused
  current A and the minimized failure each create one durable row and one
  localized native notification. Clicking restores, shows, and focuses the
  main window before activating the matching session; no event opens the wrong
  currently selected session. Abort shows neither surface. OS suppression does
  not lose the durable row or surface a misleading app error. Every inspected
  Windows system surface identifies `PI-Desktop`; no stock Electron application
  name or identity is exposed.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `04-ux/07-ui-design-system.md`, `04-ux/09-interaction-patterns.md`,
  `08-meta/decisions-log.md` (D117/D141)
- **Acceptance**: C (turn completion), Quality
- **Milestone**: M5
- **Status**: Draft

#### E2E-066: Provider model catalog survives restart and offline refresh

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
  the picker.
- **Expected**: The first picker open renders the configured/provider cache
  without starting from an empty list. On restart, the bundled models.dev
  release snapshot is used without network access. A failed Settings refresh
  preserves that in-memory snapshot; a custom provider then falls back to its
  endpoint only for IDs absent from models.dev and finally the configured
  bindings. Offline refresh preserves every cached/configured entry. A
  successful provider discovery may persist normalized IDs to Rust-owned SQLite,
  but it cannot replace models.dev metadata or user-defined bindings.
- **Specs linked**: `03-runtime/04-data-storage.md`,
  `03-runtime/12-provider-config-schema.md`,
  `03-runtime/13-model-catalog-and-selection.md`, `04-ux/08-component-spec.md`
- **Acceptance**: B (model config), F (persistence), Quality, Security
- **Milestone**: M5
- **Status**: Unit-covered (`providers::tests`, `model-cache.test.mjs`,
  `models-dev-catalog.test.mjs`); full restart/offline UI scenario Draft

#### E2E-080: Models.dev metadata and generic unknown models

- **Preconditions**: A provider/model exists in the models.dev fixture with
  limits, modalities, and reasoning options. A second fixture contains a
  provider-discovered model ID absent from models.dev.
- **Steps**: 1) Open the provider model picker and select the fixture model.
  2) Confirm its models.dev name, context/output limits, capability badges,
  modalities, cost fields, and thinking levels. 3) Start a short turn and
  inspect the sidecar model snapshot/request metadata. 4) Use Settings → Model
  configuration to force a models.dev refresh and confirm the new record is
  visible without changing the bundled file or writing a user cache. 5) Repeat
  with an ID absent from models.dev.
- **Expected**: The matching models.dev record is authoritative, including its
  `limit`, `modalities`, `reasoning_options`, `tool_call`,
  `structured_output`, dates, and cost fields; no provider secret is sent to
  the catalog. Vendor-prefixed records match providers whose configured model
  ID omits the prefix when the vendor/API identity is unambiguous. A PDF-capable
  model shows PDF in its modality metadata; PDF attachments remain bounded file
  references until the selected transport exposes a native PDF block. A
  provider-discovered or explicitly configured ID absent from models.dev remains
  runnable with the generic text-only, non-reasoning shape; pi-ai supplies only
  the selected wire adapter, OAuth flow, and account model availability.
- **Specs linked**: `02-architecture/02-tech-stack.md`,
  `03-runtime/11-provider-model-system.md`,
  `03-runtime/13-model-catalog-and-selection.md`, ADR 0134
- **Acceptance**: B (model config), C (conversation & stream), Security
- **Milestone**: M5
- **Status**: Unit-covered (`model-capabilities.test.ts`,
  `models-dev-catalog.test.mjs`); full UI scenario Draft


#### E2E-067: Platform application menus and window chrome

- **Preconditions**: Native macOS, Windows, and Linux runners; built desktop
  app; English and zh-CN locales available. The Windows/Linux harness can set
  `PI_DESKTOP_START_MAXIMIZED=1` before launch so Main maximizes the hidden
  native window before renderer mount.
- **Steps**: 1) On macOS, launch both `pnpm dev` and a packaged build. Confirm
  the application-menu title is PI-Desktop, open About PI-Desktop, and inspect
  its name, version, and icon. Then open every system menu and invoke New Task, Open
  Project, Settings, global search, sidebar toggle, editing,
  zoom/fullscreen, Window, Help, Logs, and Check for Updates actions. Verify
  the update status reports that the current fixture version is up to date.
  2) On Windows/Linux, confirm no File/Edit/View/Window/Help menubar appears
  inside the window and the left-side navigation occupies the reclaimed
  titlebar space. Verify F10 and Shift+F10 are not consumed by shell chrome;
  exercise New Task, Open Project, Settings, close-window, zoom, fullscreen,
  global search (Cmd/Ctrl+K and Cmd/Ctrl+Shift+P), sidebar, and standard editing shortcuts. Invoke
  Check for Updates from Settings -> Info with the same status result.
  3) Close the macOS window, immediately invoke two native menu
  commands, and acknowledge renderer readiness after the replacement loads.
  Verify one window and one delivery per command. 4) On Windows/Linux, repeat
  from the main chat, Settings, and an open work panel. With the work panel
  open, confirm the panel collapse button is flush with the main-pane right
  divider and does not retain the 120px outer-window control clearance. In the
  main chat, send a first user message and confirm its full bubble starts below
  the 46px titlebar control band. Open the Extensions page and confirm its header
  actions, then the detail sheet's close button, also start below that band and
  take their own clicks instead of moving the window. Click the center plus the
  top, bottom, and
  titlebar-facing edges of each right-side control to minimize, maximize,
  restore, and close the window. 5) Start
  the renderer while its native window is already maximized and inspect the
  initial queried glyph/state. 6) Attempt unknown menu/window IPC actions
  while a window exists and after it closes. 7) Build each target on its
  native runner from a clean release-host directory.
- **Expected**: macOS development and packaged launches show PI-Desktop as the
  native application identity, and the About panel uses the canonical
  PI-Desktop icon; neither surface exposes the stock Electron name or icon.
  macOS follows native menu conventions and accelerators.
  Windows/Linux show no application menu inside the window; navigation and
  right-side controls do not collide with drag regions, keyboard shortcuts
  remain operational, and no work-panel launcher is present. The open-panel
  collapse button touches the main-pane right divider without an inset or a
  duplicate native-control gap. Check for Updates
  invokes the allowlisted update command from the macOS system menu and the
  Settings surface and shows the resulting up-to-date state. Replacement-window
  commands wait for renderer readiness without
  creating duplicate windows or losing events. No Main, Settings, or work-panel
  drag rectangle overlaps the reserved control zone. The 120px control band is
  an opaque `bg-primary` surface in both light and dark themes, with an 8px
  visual buffer separating it from adjacent work-panel actions, so destination
  content never bleeds through it. Window controls remain clickable across
  their full 46px-high hit targets, match native state, and
  have accessible names; the first user or assistant transcript row never
  paints beneath them, and neither do the Extensions page header actions or the
  plugin detail sheet close button. The titlebar and right-side control band
  share one continuous 1px `border-subtle` separator; the control band's
  leading divider uses the same token and its bottom edge does not disappear
  under the window buttons. Unknown actions fail closed. Each package contains
  the target-native host binary (`.exe` only on Windows). Passing this scenario
  on Windows/Linux proves shell readiness, not first-release qualification.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `04-ux/01-ui-ia.md`, `04-ux/02-i18n-english-first.md`,
  `04-ux/07-ui-design-system.md`, `04-ux/08-component-spec.md`,
  `04-ux/09-interaction-patterns.md`, `06-delivery/06-release-runbook.md`,
  `08-meta/decisions-log.md` (D118, D121, D129)
- **Acceptance**: A (app startup), Quality
- **Milestone**: M5 on macOS; post-MVP release qualification on Windows/Linux
- **Status**: Unit-covered (`window-menu.test.mjs`,
  `development-branding.test.mjs`); Electron boot probe covers
  platform bridge, native menu installation, and the pre-render maximize
  fixture on Windows/Linux; native visual scenario Draft

#### E2E-143: Close behavior is asked once and stays configurable (D230)

- **Preconditions**: Windows/Linux run with a clean data dir (no
  `close-behavior.json`); the main window is visible; Settings → General is
  reachable. macOS is excluded: it keeps the native Dock lifecycle.
- **Steps**: 1) With the preference unset, click the close button (or press
  the close-window shortcut) and answer the prompt: Cancel keeps the window
  open and the preference unset; Close to tray hides the window, shows the
  tray icon, and the app keeps running (a turn in flight stays live); Quit
  exits the app. 2) Re-run each choice and verify it is remembered across a
  full restart and that no second prompt ever appears once a choice exists.
  3) With `tray` set, click the tray icon: the window
  restores, shows, and focuses; the tray context menu offers Open and Quit,
  and Quit exits the app. 4) In Settings → General, switch between Close to
  tray / Quit app and verify the next close follows the new
  choice, that the D216 tray icon stays resident either way, that an unset
  preference shows no selection, and that search matches
  the row. 5) With `quit` stored, restart and close the window: the app
  exits even though the tray icon is present. 6) From any setting, use the
  renderer minimize control on Windows/Linux and verify the native taskbar
  entry remains available and restores the same window; on macOS verify its
  native minimize still hides to the tray. The Windows taskbar toggle is
  covered separately by E2E-124. 7) Invoke unknown values and `"ask"` on
  `pi-desktop/window/closeBehavior/set` and verify they fail closed, and
  verify the channel is rejected outright on macOS.
- **Expected**: The first close prompts exactly once per unset state and
  Cancel never persists a choice. Tray mode keeps the app alive with a
  localized tooltip/menu and no data loss; switching to Quit app leaves the
  tray icon in place, because close-to-tray and macOS minimize still need a
  restore surface. The preference survives restarts and is honored by both
  the window-control close button and the close shortcut, and a stored `quit`
  exits through the ordered `before-quit` shutdown rather than depending on
  `window-all-closed`. Windows/Linux renderer minimize remains taskbar-native;
  macOS native minimize remains tray-resident; the bounds watchdog never
  force-restores a minimized or tray-hidden window. The automated boot probe
  (`app.quit`) exits without prompting.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `04-ux/01-ui-ia.md`, `04-ux/09-interaction-patterns.md`,
  `08-meta/decisions-log.md` (D216, D230, D256), ADR 0078, ADR 0090,
  ADR 0123
- **Acceptance**: A (app startup), Quality
- **Milestone**: M5 on Windows/Linux (release qualification)
- **Status**: Draft

#### E2E-067A: Prerelease install discovers newer stable release (D120)

- **Preconditions**: Packaged build whose embedded version is a prerelease such
  as `0.2.0-rc.6`; GitHub Releases latest stable tag is newer (for example
  `0.2.2`) with published `latest*.yml` feeds.
- **Steps**: 1) Launch the packaged prerelease install. 2) Wait for the
  automatic check or invoke Check for Updates from the application menu /
  Settings → Info.
- **Expected**: Update state reports `available` (manual platforms) or
  advances through in-app download for Windows NSIS / Linux AppImage with
  `availableVersion` equal to the newer stable tag. The client must not report
  up-to-date merely because no newer release shares the same `rc` prerelease
  channel.
- **Specs linked**: `04-ux/09-interaction-patterns.md`,
  `05-security/01-security.md`, `08-meta/decisions-log.md` (D120),
  ADR 0022
- **Acceptance**: A (app startup), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`auto-update.test.mjs` asserts
  `allowPrerelease = false`); packaged discovery scenario Draft

#### E2E-067B: Dual-locale update notes and full changelog dialog (D164)

- **Preconditions**: The shipped `packages/shared` CHANGELOG contains aligned
  `en` and `zh-CN` stable history; product language can be switched. For the
  compact update path, use a packaged or fixture updater state with a
  catalogued `availableVersion`.
- **Steps**: 1) With no available update, open Settings → Info and open Release
  notes. 2) Inspect the complete history, current-version marker, scrolling,
  and close behavior by close control, Escape, and backdrop. 3) Force or wait
  for update discovery so status is manual `available`, in-app `downloading`,
  or `downloaded`; inspect the ambient banner and Settings Updates row, then
  reopen Release notes. 4) Switch UI language to zh-CN and re-inspect without
  invoking a new check. 5) Repeat the compact update path with a version absent
  from the catalog.
- **Expected**: `UpdateState.releaseNotes` is plain multi-line product
  highlights selected by Main from the dual-locale catalog — never a
  renderer-supplied URL. Both surfaces show a localized "What's new" block
  when notes exist and hide it when they do not. Locale change refreshes notes
  for the same version. The Release notes action remains available in every
  updater state and opens a localized, newest-first modal containing every
  shipped stable entry, with current and available versions identified when
  present. The modal traps focus, restores it after close, and does not expose
  a new IPC domain or feed configuration.
- **Specs linked**: `04-ux/06-settings-ia.md`, `04-ux/09-interaction-patterns.md`,
  `05-security/01-security.md`, `06-delivery/06-release-runbook.md`,
  `08-meta/decisions-log.md` (D164), ADR 0022
- **Acceptance**: A (app startup), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`auto-update.test.mjs`, `changelog.test.ts`);
  packaged UI scenario Draft

#### E2E-067C: Release version-surface preflight blocks a misaligned tag (D260)

- **Preconditions**: A clean worktree at the current stable version. No release
  tag has been created for the candidate version.
- **Steps**: 1) Run `node scripts/check-release-docs.mjs` on the aligned tree.
  2) Regress one surface at a time — remove the newest changelog entry from
  `en`, then from `zh-CN`, then change a highlight count so the locales differ,
  then set `docs/package.json` to an older version, then leave the READMEs
  stating the previous `<major>.<minor>.x` release line — and rerun the
  preflight after each. 3) Run `node scripts/release.mjs <next-version> --tag`
  with one surface still regressed. 4) Restore every surface, rerun the
  preflight, and repeat the release command.
- **Expected**: The aligned tree reports alignment and exits 0. Each regression
  is reported by name with the offending file and expected version, and exits
  non-zero. With a regressed surface, `release.mjs` bumps files but creates
  neither the release commit nor the tag, and says the documentation check
  failed. After restoration the preflight passes and the release command
  proceeds to commit and tag. `--skip-docs-check` bypasses only the check and
  is documented as non-release use.
- **Specs linked**: `06-delivery/06-release-runbook.md` §4.1,
  `06-delivery/05-change-checklist.md`, `06-delivery/03-ai-development-workflow.md`,
  `08-meta/decisions-log.md` (D164, D260)
- **Acceptance**: Quality (release process)
- **Milestone**: M5
- **Status**: Script-covered (`scripts/check-release-docs.mjs`); manual release
  rehearsal Draft

#### E2E-068: Fork a conversation into an independent session

- **Preconditions**: An idle project conversation has user, assistant,
  thinking, and tool history plus at least one regenerate variant. A second
  source conversation is running. A Temporary conversation and two retained
  project workspaces contain distinct same-named marker files. The idle source
  has a session-scoped tool grant.
- **Steps**: 1) Open the idle conversation overflow menu with keyboard. 2)
  Choose Create branch. 3) Append a prompt and change model/mode on the child.
  4) Switch the visible workspace, return to the child, and read the marker.
  5) Trigger the previously granted tool and verify confirmation is requested.
  6) Reopen the source. 7) Restart the app and inspect both sessions. 8) Open
  the running conversation overflow menu. 9) Fork the Temporary conversation
  and invoke a workspace-required tool.
- **Expected**: A localized branch title appears in the same project group and
  is activated with composer focus. Its visible active transcript and durable
  project/provider/model/mode/thinking/permission configuration match the
  source snapshot, but regenerate pager history is absent. Child messages and
  later configuration changes do not affect the source; both survive restart.
  The running source action is disabled. No turns, notifications, artifacts,
  permission grants, revisions, or scratch files are copied.
  The marker resolves under the child's inherited project; the Temporary child
  remains path-less and returns `WORKSPACE_REQUIRED`.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `03-runtime/04-data-storage.md`, `03-runtime/06-host-rpc-protocol.md`,
  `04-ux/01-ui-ia.md`, `04-ux/08-component-spec.md`,
  `04-ux/09-interaction-patterns.md`
- **Acceptance**: C (sessions), D (workspace), F (persistence), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`sessions::tests::fork_session_clones_active_transcript_and_configuration`,
  `session-fork.test.mjs`); full restart UI scenario Draft

#### E2E-071: Fork an assistant response without changing its source

- **Preconditions**: An idle conversation contains two completed user/assistant
  exchanges and the second assistant response has cache-token usage metadata.
- **Steps**: 1) Hover the first assistant response and inspect its toolbar. 2)
  Click Fork. 3) Confirm the activated child ends at that response and append a
  prompt. 4) Reopen the source and inspect it. 5) Append a prompt to the child,
  restart, and inspect source and child. 6) Repeat while the source is running.
- **Expected**: The completed-assistant toolbar contains Copy, Fork, and
  Regenerate only — no Delete and no Edit (D137 moved Edit to user turns). Fork
  is disabled during a source turn. It activates a separately titled session
  whose history stops at the selected response; later source turns are absent.
  Source text, version history, token metadata, later turns, runtime, and cache
  state remain unchanged. Continuing the child affects only that child and
  reseeds from its own remapped transcript.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `03-runtime/04-data-storage.md`, `03-runtime/06-host-rpc-protocol.md`,
  `04-ux/08-component-spec.md`, `08-meta/decisions-log.md` (D134, D137)
- **Acceptance**: C (chat stream/sessions), F (persistence), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`sessions::tests::message_scoped_fork_stops_at_selected_assistant_response`,
  `session-fork.test.mjs`, `transcript-style.test.mjs`); full restart UI scenario Draft

#### E2E-071b: Forked session retains messages after the first AI turn completes

- **Preconditions**: A completed conversation with at least two user/assistant
  exchanges. The session history window feature is active (bounded loading).
- **Steps**: 1) Fork the conversation from the sidebar overflow menu. 2) In the
  forked session, send a new prompt and wait for the AI to finish responding.
  3) Observe the transcript after agent_end fires. 4) Click the forked session
  entry in the sidebar (re-select). 5) Restart the app and reopen the fork.
- **Expected**: All forked messages plus the new user prompt and AI response
  remain visible after agent_end. Re-selecting the session from the sidebar
  shows the same messages (no flash of empty state). After restart, messages
  persist. The session history window is `{ messageStart: 0, hasMoreBefore: false }`.
- **Specs linked**: `03-runtime/04-data-storage.md`, `04-ux/01-ui-ia.md`
- **Acceptance**: C (chat stream), F (persistence), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`session-fork.test.mjs`
  `fork actions commit the child through one durable helper`); UI scenario Draft

#### E2E-071c: A branch survives a navigation that lands during the fork

- **Preconditions**: A completed conversation with several exchanges, and at
  least one other session in the sidebar.
- **Steps**: 1) Start Branch from here on the source session. 2) While the fork
  request is in flight, immediately click another session in the sidebar (or
  press the history-back shortcut). 3) Wait for both to settle. 4) Inspect the
  sidebar. 5) Open the branch and scroll its transcript.
- **Expected**: The later navigation wins the view, and the branch is still
  listed in the sidebar with its title, with no manual refresh. Opening it shows
  its complete copied transcript from cache. Nothing is lost and no duplicate
  branch row appears if the fork is repeated.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`, `03-runtime/04-data-storage.md`
- **Acceptance**: C (chat stream), F (persistence), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`session-fork.test.mjs`
  `a fork is recorded even when a newer navigation took over`); UI scenario Draft

#### E2E-071d: Opening a long session stays responsive and shows its newest turn

- **Preconditions**: One session whose transcript is far longer than the
  renderer page size (several hundred messages, including large tool results).
- **Steps**: 1) Open the long session from the sidebar. 2) Observe the first
  painted frame and the scroll position. 3) Scroll to the top edge to page older
  history, repeatedly, until the first message is reached. 4) Switch to another
  session and back, recording the frame and offset on return. 5) Scroll up a
  measured amount, switch away, and switch back again. 6) Send a new prompt and
  let it complete.
- **Expected**: The session opens at its newest turn without a blank or
  top-of-history frame, and opening it does not visibly slow down as the
  conversation grows. Each older page prepends without moving the message the
  user is reading. Paging back reaches the true first message with none skipped
  or duplicated. Re-selection paints from the retained pane: the first frame back
  is the same frame that was left, at the same scroll position, with no dim, no
  blank or skeleton frame, and no rebuild of the rows. A pane the user had
  scrolled up in returns to that measured offset rather than the bottom, and a
  pane left pinned re-anchors to the bottom. The new turn appends normally.
- **Specs linked**: `03-runtime/04-data-storage.md`,
  `03-runtime/06-host-rpc-protocol.md`, ADR 0137
- **Acceptance**: C (chat stream), F (persistence), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`transcripts::tests::layout_window_reads_only_the_requested_tail`,
  `sessions::tests::bounded_reads_use_physical_line_positions_not_the_dedup_counter`);
  UI scenario Draft

#### E2E-071e: Regenerating from a paged-back transcript replaces the right turn

- **Preconditions**: A session long enough that opening it loads only a bounded
  window, with several completed exchanges above that window.
- **Steps**: 1) Open the session and page older history until an earlier user
  turn is visible. 2) Regenerate that turn (or edit and resend it). 3) Wait for
  the new answer. 4) Walk the revision pager back to the original. 5) Reopen the
  session.
- **Expected**: Exactly the selected turn and its answer tail are replaced; no
  unrelated earlier or later exchange is truncated or archived. The pager
  restores the original tail. After reopening, the transcript matches what was
  shown, with no missing messages.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`, `03-runtime/04-data-storage.md`
- **Acceptance**: C (chat stream), F (persistence), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`transcript-truncation.test.ts`,
  `transcript-style.test.mjs`); UI scenario Draft

#### E2E-071f: Long-transcript scrolling and minimap hover stay smooth

- **Preconditions**: One session with several hundred messages, including large
  tool results and at least one code block, so the minimap rail shows a dense
  dash stack.
- **Steps**: 1) Open the session. 2) Scroll continuously through the whole
  transcript, up and down. 3) Sweep the cursor slowly along the minimap rail from
  top to bottom and back. 4) Hover a dash until its preview popover appears, then
  click it. 5) Resize the window and repeat the rail sweep. 6) Type a long
  multi-line draft so the composer grows, then sweep the rail again. 7) Switch to
  another session and back.
- **Expected**: Scrolling holds a steady frame rate with no progressive
  slowdown as more history is traversed. The rail sweep magnifies dashes smoothly
  and does not degrade as the dash count grows; the dash stack never shifts
  vertically while magnifying. The popover names the correct turn and clicking
  scrolls to it. After a window resize, and after the composer grows under a
  multi-line draft, magnification still tracks the cursor against the dashes' new
  positions rather than their old ones. Returning to the session reveals its
  retained pane at the position it was left, with no rebuild of the earlier
  history and no dim. Switching back and forth repeatedly, the transcript text
  never jumps or scrolls up and down after the first painted frame. Scrolling up
  keeps the chosen position across later switches instead of being pulled back to
  the bottom.
- **Specs linked**: `04-ux/08-component-spec.md`, ADR 0137
- **Acceptance**: C (chat stream), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`interaction-performance.test.mjs`
  `minimap hover magnification never measures geometry per dash`,
  `session switch bounds the first transcript commit instead of rebuilding it`,
  `session-switch hydration expands without moving the transcript`,
  `minimap re-measures dash centers when the rail's own box changes`);
  UI scenario Draft

#### E2E-071g: Retained session panes are bounded and evict the oldest

- **Preconditions**: At least five sessions with distinct transcripts, each
  longer than one viewport, so a scroll position and a final record identify each
  one unambiguously.
- **Steps**: 1) Open sessions A, B, and C in that order, scrolling each one up a
  measured amount. 2) Switch back to A, then B, and confirm each returns to its
  own offset. 3) Open D and then E, so A and B fall outside the retained budget.
  4) Return to A. 5) Return to E, then D, and confirm they are still warm. 6)
  Repeat the whole cycle once more and watch for a stuck progress track, an error
  toast, or a blank chat area.
- **Expected**: Only the visible pane and the two most recently visited ones are
  retained; visiting beyond that budget evicts the oldest pane. A warm return
  paints the retained frame and offset immediately. Returning to an evicted
  session behaves exactly like a cold open: the visible pane stays on its own
  session under the thin progress track, the composer is inert until the
  destination commits, and the destination then paints at its newest turn with no
  error, no empty frame, and no restored offset from before eviction. Nothing is
  dimmed at any point, hidden panes stay non-interactive and out of the
  accessibility tree, and repeated cycling neither leaks a growing number of
  mounted transcripts nor leaves a pane showing another session's rows.
- **Specs linked**: `04-ux/08-component-spec.md` §1.6 / §3.5 / §7,
  `04-ux/09-interaction-patterns.md` §5, ADR 0130, ADR 0137
- **Acceptance**: C (switch sessions), Quality
- **Milestone**: M5
- **Status**: Draft

#### E2E-071h: Reopening a session while its response is streaming

- **Preconditions**: Session A has a completed transcript and is producing a
  long assistant response; at least one other session is available.
- **Steps**: 1) While A is streaming, open another session. 2) Wait long enough
  for A to emit several assistant or tool updates without finishing. 3) Open A
  again before the response ends. 4) Continue watching A until the turn
  completes. 5) Switch away and back once more.
- **Expected**: A's retained/live pane is revealed without a blank, skeleton,
  dim, or top-of-history flash. The first frame includes the latest in-memory
  assistant/tool tail available before the click. The delayed durable detail
  response may add completed rows, but it never replaces the partial reply with
  an older transcript; subsequent stream updates continue from the same row and
  the completed answer is not duplicated. A's background events do not change
  the other session's transcript, composer, workspace, or focus.
- **Specs linked**: `04-ux/08-component-spec.md`,
  `04-ux/09-interaction-patterns.md`, ADR 0137
- **Acceptance**: C (chat stream), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`session-transcript.test.mjs`,
  `session-switch-performance.test.mjs`); UI scenario Draft

#### E2E-073: Icon-only message toolbars and editing a user prompt

- **Preconditions**: An idle conversation contains two completed user/assistant
  exchanges; one user turn was sent as a slash-template invocation.
- **Steps**: 1) Hover a completed assistant row and a user row, then hover and
  keyboard-focus each action chip. 2) Choose Edit on the first user prompt. 3)
  Press Escape, reopen Edit, retry the prompt unchanged. 4) Reopen Edit, change
  the text, and retry with Cmd/Ctrl+Enter. 5) After the new answer completes,
  use the `current / total` pager to return to the original exchange and
  forward again. 6) Reload the session. 7) Choose Edit on the slash-command
  turn and inspect the seeded text. 8) Try Edit while a turn is running.
- **Expected**: Every toolbar chip shows its glyph only, with the label
  appearing as a tooltip on hover and on keyboard focus; no chip renders
  caption text. The assistant toolbar offers Copy, Fork, Regenerate; the user
  toolbar offers the pager (when variants exist), Copy, Edit, Delete. Edit
  replaces the prompt bubble with a wider inline textarea with Retry and Cancel
  controls; Escape or Cancel restores the bubble unchanged. Retry truncates the
  transcript from that prompt and streams a new answer whether or not the text
  changed, leaving a `current / total` pager on the user turn that restores the
  original prompt with its full answer tail in place — surviving reload.
  The slash turn seeds the typed `/command` form and re-expands the template on
  retry. Edit is disabled while a turn is running.
- **Specs linked**: `04-ux/08-component-spec.md`,
  `03-runtime/01-ipc-protocol.md`, `03-runtime/04-data-storage.md`,
  `08-meta/decisions-log.md` (D137, D274)
- **Acceptance**: C (chat stream), F (persistence), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`transcript-style.test.mjs`); full UI scenario Draft

#### E2E-069: Platform-specific sidebar header behavior

- **Preconditions**: PI-Desktop is open with the expanded sidebar and a chat
  session is active.
- **Steps**: 1) Open Extensions on macOS windowed mode. 2) Inspect the expanded
  sidebar titlebar. 3) Confirm no PI-Desktop logo/title is visible and Search
  then Collapse sidebar appear at the right of the traffic lights. 4) Enter
  fullscreen and inspect the same row. 5) On Windows/Linux, confirm the brand
  remains visible; activate it with a pointer, then with keyboard focus and
  Enter/Space.
- **Expected**: macOS uses one 46px row with native lights at left, a usable
  drag region, and separate accessible Search and Collapse buttons at right;
  the Logo/Home brand is absent in both windowed and fullscreen modes.
  Windows/Linux render the canonical 20px logo beside the 15px shell name; the
  complete brand has a localized Home accessible name, visible hover/focus
  feedback, and returns the main pane to chat without clearing the active
  conversation or workspace. Collapse remains immediately after Search. The
  logo itself is theme-aware: light mode shows `src/assets/brand/logo-light.png`,
  dark mode shows `src/assets/brand/logo-dark.png`, swapping live with
  `data-theme` (no reload).
- **Specs linked**: `04-ux/01-ui-ia.md`, `04-ux/07-ui-design-system.md`,
  `04-ux/08-component-spec.md`
- **Acceptance**: Quality
- **Milestone**: M5
- **Status**: Unit-covered (`renderer-branding.test.mjs`,
  `sidebar-navigation.test.mjs`); rendered interaction scenario Draft

#### E2E-098: Sidebar collapse and expand animate as a docked transition

- **Preconditions**: PI-Desktop is open with the expanded sidebar and an active
  chat session; `prefers-reduced-motion` is off.
- **Steps**: 1) Click Collapse sidebar in the expanded sidebar header (or press
  the sidebar toggle shortcut). 2) Watch the sidebar during collapse. 3) Confirm
  the main pane expands and the collapsed titlebar now shows an Expand control.
  4) Press the sidebar toggle shortcut again from the collapsed state: each
  press must strictly alternate collapse and expand, so the second press
  re-expands the sidebar (regression: it must never re-collapse). 5) Collapse
  and re-expand once more via the shortcut, then repeat the full round trip
  with the pointer controls. 6) Repeat on Windows/Linux.
- **Expected**: Collapse plays the `sidebar-out` keyframe (opacity + ≤8px slide
  plus width/flex allocation) while the aside stays in the tree, then unmounts
  once the animation ends; the main pane fills the freed space continuously.
  Expand plays the `sidebar-in` keyframe and
  the controls return to the expanded header. On Windows the dock stays opaque
  during exit (`sidebar-out-windows`), matching the work-panel dock behavior. No
  layout jump precedes the animation, and focus returns to the sidebar/Expand
  control predictably.
- **Specs linked**: `04-ux/08-component-spec.md`, `04-ux/07-ui-design-system.md`
- **Acceptance**: Quality
- **Milestone**: M5
- **Status**: Unit-covered (`sidebar-collapse-animation.test.mjs`); rendered
  interaction scenario Draft

#### E2E-118: Collapsed sidebar tightens the centered chat content band

- **Preconditions**: PI-Desktop is open with an active chat session at a
  viewport wide enough for the expanded 760–768px chat content band; reduced
  motion is off.
- **Steps**: 1) Record the width of the centered transcript or empty-home
  composer band with the sidebar expanded. 2) Collapse the sidebar. 3) Inspect
  the same content band while the dock transition runs and after it settles.
  4) Expand the sidebar and inspect the return transition.
- **Expected**: The outer main pane fills the space released by the sidebar,
  while the centered chat content band transitions from its expanded
  760–768px ceiling to a 640px ceiling in the collapsed state. The transcript,
  empty-home stack, and Composer use the same collapsed width envelope; no
  content jumps, horizontal overflow, or clipped controls appear. Expanding
  restores the expanded ceiling.
- **Specs linked**: `04-ux/01-ui-ia.md`, `04-ux/07-ui-design-system.md`,
  `04-ux/08-component-spec.md`
- **Acceptance**: Quality
- **Milestone**: M5
- **Status**: Unit-covered (`sidebar-collapse-animation.test.mjs`); rendered
  interaction scenario Draft

#### E2E-070: Native select menus follow the Windows theme across the app

- **Preconditions**: PI-Desktop is running on Windows with light and dark
  themes available.
- **Steps**: 1) In light theme, open native selects in Settings → Basics,
  Settings → Model configuration, Settings → Import, and one scheduled-task
  form. 2) Repeat every surface in dark theme. 3) Open each list after
  switching themes without restarting the app.
- **Expected**: Every closed trigger and opened native option list uses the
  active theme's readable foreground/background pairing. No dark-theme list
  falls back to a light Windows surface with light text, no light-theme list
  uses dark-theme ink, and changing theme updates subsequent openings. The
  same result holds for native selects outside Settings.
- **Specs linked**: `04-ux/06-settings-ia.md`,
  `04-ux/07-ui-design-system.md`
- **Acceptance**: Quality (cross-platform theme readability)
- **Milestone**: M5
- **Status**: Unit-covered (`settings-general.test.mjs`); Windows rendered
  scenario Draft

#### E2E-071i: Long session opens under a settle veil and sends clear instantly

- **Preconditions**: One session with several hundred messages including code
  blocks and tool results; a configured model; the host made slow (for example a
  throttled sidecar or a large pending tool output) so a prompt round trip takes
  visibly longer than a frame.
- **Steps**: 1) From the home surface, open the long session and record the
  first painted frames. 2) Wait for the transcript to appear. 3) Leave and
  re-open the same session while its history page is being revalidated. 4) Type
  a multi-line prompt so the composer grows, then press Enter. 5) While the
  host is still busy, press Enter again on the now-empty box. 6) Make the host
  reject a send (for example disable the model's provider) and press Enter with
  a new draft. 7) Open a session with fewer than fifteen messages.
- **Expected**: The first frame of the long session is an opaque skeleton of
  alternating user and assistant lines under the composer; no transcript text is
  visible during the frames in which the history expands or row heights settle,
  and the skeleton fades out within roughly 600ms onto a transcript already
  positioned at its newest turn. The rows never move up and down after the
  reveal. While the multi-line draft grows, the newest turn moves up with the
  composer instead of disappearing behind it. Re-opening during revalidation
  and a repeated older-page response leave exactly one row per message id,
  including the existing user row. Pressing Enter clears the box and shows the
  user row at the bottom of the transcript in the same frame, before the host
  has answered; when the host echo arrives the row does not duplicate or jump.
  The second Enter on the empty box does nothing and queues no duplicate. When
  the send is rejected, the user row disappears and the draft
  returns to the box with the caret at its end. The short session shows no
  skeleton.
- **Specs linked**: `04-ux/08-component-spec.md`,
  `04-ux/09-interaction-patterns.md`, `08-meta/decisions-log.md` (D287, D288)
- **Acceptance**: C (chat stream), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`transcript-settle.test.mjs`,
  `composer-send-state.test.mjs` `send clears the composer before the round
  trip and restores a rejected draft (D287)` and `the user row is inserted
  before the host round trip and echoed under the same id (D288)`,
  `session-transcript.test.mjs` (`repeated transcript rows keep one position and
  the latest value`); UI scenario Draft

#### E2E-072: Keyboard shortcut mappings persist and stay conflict-safe

- **Preconditions**: App running on macOS and on one Windows/Linux target with
  Settings open; no custom shortcut overrides are stored.
- **Steps**: 1) Open Settings → Shortcuts and inspect Keyboard shortcuts. 2) Change
  Search to an unused modifier chord. 3) Invoke the new chord and then the old
  chord. 4) Attempt to assign that chord to the command shortcut (now opened via
  global search). 5) Attempt a bare letter and a reserved editing chord. 6)
  Disable Search and confirm its row shows Unbound. 7) Confirm neither the
  default nor custom Search chord invokes Search, then restart and check that it
  remains disabled. 8) Restore Search individually and confirm its default
  returns; choose Restore defaults and confirm all rows return to defaults. 9) On
  macOS inspect the corresponding native application-menu accelerator after
  each save/reset. 10) On Windows disable the plugin launcher and confirm its
  old global binding, focused fallback, and Alt+Space host fallback are all
  inactive. 11) Press and release Ctrl/Command alone, confirm an IME candidate,
  and hold the back/forward chord long enough to generate repeats.
- **Expected**: Actions are grouped as Navigation, Agent, and Window with
  platform-native key labels; recording has visible focus and `Escape` cancels;
  the custom Search chord takes effect immediately, replaces the old chord,
  survives restart, and updates the macOS menu; duplicate, modifier-free, and
  reserved assignments show an inline error without changing either action;
  Unbound displays as a localized explicit state, participates in no conflicts,
  dispatches no old or default chord, persists across restart, removes the
  macOS accelerator, and disables the Windows launcher fallback layers;
  individual and global reset restore the shared defaults; Keyboard shortcuts is
  its own Settings destination. Modifier-only and IME keydowns dispatch nothing,
  and a held history chord traverses only once per physical press.
- **Specs linked**: `04-ux/06-settings-ia.md`, `04-ux/07-ui-design-system.md`,
  `03-runtime/01-ipc-protocol.md`
- **Acceptance**: F (settings persistence), Quality (keyboard accessibility)
- **Milestone**: M5
- **Status**: Unit-covered (`keyboard-shortcuts.test.ts`,
  `settings-keyboard-shortcuts.test.mjs`, host settings RPC test); rendered scenario Draft

#### E2E-073a: Developer mode gates the developer-tools console

- **Preconditions**: App running on macOS and on one Windows/Linux target;
  developer mode is absent or false in persisted settings and Settings ->
  Info is open.
- **Steps**: 1) Find the Developer card through Settings search. 2) Confirm the
  Open console action is disabled and invoke F12 plus the platform secondary
  shortcut. 3) Enable developer mode and open the console from Settings.
  4) Close it and reopen it with F12; on Windows/Linux repeat with
  Ctrl+Shift+I, and on macOS inspect and invoke the View-menu developer-tools
  item. 5) Restart the app and invoke an enabled entry point. 6) Disable
  developer mode while the console is open. 7) Attempt the console IPC directly
  while disabled.
- **Expected**: No disabled entry point opens developer tools, and macOS omits
  the View-menu item. Enabling the persisted switch unlocks the localized
  Settings action and applicable platform shortcuts; each toggles the same
  window console after restart. Disabling the switch closes the console,
  disables the Settings action, removes the macOS menu item, and makes direct
  IPC requests fail closed.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `04-ux/06-settings-ia.md`, `04-ux/08-component-spec.md`,
  `04-ux/09-interaction-patterns.md`
- **Acceptance**: F (settings persistence), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`settings-general.test.mjs`,
  `window-menu.test.mjs`); native interaction scenario Draft

#### E2E-074: Concurrent session events and permissions never steal focus

- **Preconditions**: Sessions A and B exist in Agent mode and can run
  concurrently; A is visible with a draft in its composer.
- **Steps**: 1) Start turns in A and B, then return to A. 2) Let B emit streamed
  messages, tool activity, completion, and a permission request. 3) Confirm A
  remains visible and continue editing its draft. 4) Trigger a permission
  request in A as well. 5) Open B explicitly, resolve only B's request, then
  return to A and resolve A's request. 6) Rapidly select A then B while session
  details load in opposite completion order. 7) While B is loading, resolve A's
  Write/Edit request so its tool completion creates Review, then let B emit a
  BrowserPreview artifact while A is visible. Switch back to each session.
- **Expected**: B's background events update only B's row and retained state;
  they do not change A's active session/project/page, transcript, draft, scroll,
  or keyboard focus, and no global modal appears. Opening B reveals only B's
  inline card with its original countdown. Both requests remain independently
  actionable, and resolving B does not clear A. The final rapid selection stays
  on B even when A's older load finishes later. Only explicit notification or
  session activation may navigate. A's post-approval Review is retained only in
  A without a transient open/close flash in B; B's BrowserPreview carries B's
  session identity, updates only B's retained Browser resource, and never opens,
  navigates, focuses, or resizes A's panel. Explicitly returning to either
  session restores its own open state, tabs, active tab, and Browser resource.
- **Specs linked**: `04-ux/01-ui-ia.md`, `04-ux/03-permission-ux.md`,
  `04-ux/08-component-spec.md`, `04-ux/09-interaction-patterns.md`
- **Acceptance**: C (session isolation), E (permission isolation), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`permission-inline.test.mjs` for scoped state,
  inline rendering contract, absolute countdown, and latest-selection guard;
  `work-panel.test.mjs` and `browser-preview-tool.test.mjs` for session-scoped
  artifact retention and routing); full UI scenario Draft

#### E2E-075: Sidebar section context menus create sessions and projects
- **Status**: Manual
- **Priority**: P1
- **Covers**: A, C, D / US-UI-57
- **Preconditions**: App running with the expanded home sidebar visible.
- **Steps**:
  1. Right-click the `Sessions` heading label (not a session row).
  2. Choose the single create item.
  3. Right-click empty chrome in the standalone session list.
  4. Right-click the `Projects` heading label.
  5. Choose the single create item and cancel or complete the project picker.
  6. Right-click empty chrome in the project list (outside any project group).
- **Expected**:
  - Sessions context menus apply the temporary-group empty-session reuse rule
    and focus the composer; a new durable row is visible before any message.
  - Projects context menus open the same folder picker as the heading
    folder-plus control.
  - Existing row context menus and heading glyph buttons remain available; the
    section menus stay one-item and theme-matched with other sidebar menus.
  - Section, session-row, and project-row right-click menus open to the right
    of the pointer when space permits, and remain fully within the viewport at
    the right edge.
  - Escape and outside click dismiss the menu without creating anything.

#### E2E-076: Startup splash appears then yields to the main shell
- **Status**: Partially automated (`startup-splash-motion.test.mjs` covers splash markup, motion tokens, reduced-motion, and catalog keys; `macos-sidebar-vibrancy.test.mjs` covers the darwin glass splash and shell cross-fade; full window timing remains Draft)
- **Priority**: P1
- **Covers**: A, Quality / US-UI shell polish
- **Preconditions**: App launch path available (dev or packaged).
- **Steps**:
  1. Launch PI-Desktop.
  2. Observe the first painted renderer surface before bootstrap completes.
  3. Wait until sessions/settings bootstrap finishes.
  4. Repeat with OS `prefers-reduced-motion: reduce` when available.
  5. On macOS, compare the splash surface with the sidebar glass after the shell appears.
- **Expected**:
  - Before ready: full-window splash with brand mark, shell name, tagline, and accessible starting status (`data-testid="startup-splash"`).
  - After ready: splash exits with a short fade (or instantly under reduced motion) and the main shell (or settings page) is interactive underneath.
  - On macOS the splash uses the same glass tint and sheen as the sidebar over native `under-window` vibrancy; the mounted shell stays hidden until the splash exit fade, then cross-fades in. Other platforms keep the opaque `--ds-bg-primary` fill.
  - No plain unbranded “Starting…” centered text as the only boot UI.
  - Overlay/dialog enter motion uses shared tokens; reduced motion keeps state changes without decorative duration.
- **Specs linked**: `04-ux/07-ui-design-system.md` §8, `04-ux/02-i18n-english-first.md`, decisions-log D146 / D304
- **Acceptance**: A (app startup), Quality
- **Milestone**: M5
#### E2E-099: Brand logo follows the active theme
- **Status**: Draft
- **Priority**: P3
- **Covers**: Quality / US-UI shell polish
- **Preconditions**: App running; theme can switch between light and dark (and system) without restart.
- **Steps**:
  1. In light mode, open the app shell, an empty chat home, and the expanded sidebar (Windows/Linux) or startup splash.
  2. Inspect the rendered `BrandLogo` source in the sidebar and startup splash,
     and inspect the light eight-frame `HomeMascotLogo` GIF in the empty-home
     hero. Hover the mascot and verify that its cadence does not change.
  3. Switch the theme to dark (Settings → Basics → Appearance, or system appearance change).
  4. Re-inspect the same surfaces without reloading.
  5. Switch back to light and re-inspect.
- **Expected**:
  - Light and dark mode render `src/assets/brand/logo-light.png` /
    `src/assets/brand/logo-dark.png`
    live in the sidebar and startup splash without a window reload.
  - The empty-home hero renders the 100px eight-frame mascot GIF for the
    active theme (`home-mascot-light.gif` / `home-mascot-dark.gif`) with a
    short idle hold and a looping wave. Switching theme swaps the pair live
    without a window reload. Pointer hover does not change the cadence;
    under reduced motion the matching still first frame remains visible.
  - Sizes stay stable across theme changes (sidebar 20px, hero 100px, splash
    64px), and the marks stay decorative with no click, keyboard, or focus
    behavior.
- **Specs linked**: `04-ux/08-component-spec.md` §3.7, `04-ux/07-ui-design-system.md`
- **Acceptance**: Quality
- **Milestone**: M5
#### E2E-077: Theme-aware selection and CJK section labels

- **Status**: Partially automated (`user-select.test.mjs`, `interaction-polish.test.mjs`)
- **Priority**: P2
- **Covers**: A, Quality / US-UI shell polish
- **Preconditions**: App running with at least one selectable transcript or input; language can be switched to `zh-CN`.
- **Steps**:
  1. Select text inside a transcript message or the composer.
  2. Inspect sidebar Sessions/Projects section labels in English.
  3. Switch the app language to `zh-CN` and re-check the same labels.
  4. Hover jump-latest (when visible), stop, search rows, and profile menu items.
- **Expected**:
  - Selection highlight uses a neutral text-primary wash (not browser-default blue).
  - Caret/form accent colors stay on the monochrome token ramp.
  - English section labels may use uppercase + wide tracking; `zh-CN` labels use normal tracking without forced uppercase.
  - Listed chrome controls ease background/color changes via shared motion tokens.
- **Specs linked**: `04-ux/07-ui-design-system.md`, `04-ux/08-component-spec.md`
- **Acceptance**: D147
- **Milestone**: M5
- **Status detail**: Source-level coverage for CSS contracts; visual selection paint remains manual.

#### E2E-078: Work panel and settings light-surface polish

- **Status**: Partially automated (`surface-polish.test.mjs`)
- **Priority**: P2
- **Covers**: D, Quality / US-UI shell polish
- **Preconditions**: App running; theme can switch to light; a work-panel tab can be opened.
- **Steps**:
  1. Switch to light theme.
  2. Open Settings and inspect form fields, toggles, segment controls, and shortcut keycaps.
  3. Open the work panel (Review / Files / Browser) beside a chat session.
  4. Hover file-tree rows or diff headers; focus the browser URL field.
  5. Open a confirmation/provider dialog and inspect the scrim.
- **Expected**:
  - Work panel body reads as quiet `#fafafa` inset paper with a white header band.
  - Settings fields, browser URL, segment tracks, and shortcut keycaps use light inset fills; focused fields lift with a neutral ring.
  - Toggle on-state keeps a white knob on the near-black track.
  - Hover fills on file-tree/diff/resize ease with shared motion tokens.
  - Light dialog scrim is softer than the dark 45% veil (~28% ink).
- **Specs linked**: `04-ux/07-ui-design-system.md`, `04-ux/08-component-spec.md`
- **Acceptance**: D148
- **Milestone**: M5
- **Status detail**: Source-level coverage for CSS contracts; visual surface checks remain manual.

#### E2E-079: User-facing catalog copy in English and Chinese

- **Status**: Partially automated (`packages/i18n/test/user-facing-copy.test.mjs`, `catalogs.test.mjs`)
- **Priority**: P2
- **Covers**: A, Quality / US-UI copy
- **Preconditions**: App running; language can switch between English and zh-CN.
- **Steps**:
  1. Inspect empty-home hint, sidebar temporary-chat section, and status/connection toasts.
  2. Open Settings → AI providers and the marketplace refresh action.
  3. Switch the app language to zh-CN and re-check the same surfaces.
- **Expected**:
  - Copy explains outcomes in plain product language (AI provider, project, marketplace, connected/limited) rather than host/backend/repo jargon.
  - English and zh-CN catalogs keep identical keys and interpolation variables.
  - Crash chrome and empty-home titles remain catalog-backed in both locales.
- **Specs linked**: `04-ux/02-i18n-english-first.md`
- **Acceptance**: D149
- **Milestone**: M5
- **Status detail**: Source-level coverage for catalog contracts; visual wording review remains manual.

#### E2E-081: Send re-pins transcript and jumps to bottom

- **Preconditions**: Long transcript that overflows one viewport; provider configured.
- **Steps**:
  1. Start at the pinned bottom and use a trackpad to scroll upward with a
     small initial movement; observe the first movement and the
     jump-to-latest control.
  2. Type a new prompt in the composer and send it.
  3. Observe transcript position while the turn starts and streams.
  4. Scroll upward again with a small trackpad movement while streaming, wait
     for more content, then click jump-to-latest.
- **Expected**:
  - The first upward movement immediately releases follow mode and remains
    stable; it does not snap back, reverse direction, or oscillate while a
    pending stream or resize follow frame completes.
  - New streamed content does not move the manually positioned viewport, and
    jump-to-latest appears as soon as follow mode is released.
  - On send, the transcript re-pins, hides jump-to-latest, and jumps to the bottom so the new user message (and following stream) is visible.
  - Streaming continues to follow while pinned.
  - Manual scroll mid-stream pauses follow and shows jump-to-latest again; clicking it resumes follow.
- **Specs linked**: `04-ux/08-component-spec.md`, `04-ux/09-interaction-patterns.md`
- **Acceptance**: C (chat stream), Quality / D151
- **Milestone**: M5
- **Status**: Partially automated (`apps/desktop/test/transcript-scroll.test.mjs`);
  full trackpad interaction remains Draft

#### E2E-082: New reasoning session defaults to the binding thinking level

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

#### E2E-083: Long streaming turns keep shell interaction responsive

- **Preconditions**: Provider configured; an active session has enough user,
  assistant, and tool rows to overflow several viewports; work panel can be
  opened; both normal and reduced-motion preferences are available.
- **Steps**:
  1. Start a long assistant response that emits frequent streamed updates.
  2. While it streams, hover and focus sidebar rows, type in the composer when
     enabled, open/collapse the work panel, and scroll the transcript away from
     and back to latest.
  3. Observe the minimap, completed history rows, composer surface, and shell
     chrome throughout the stream.
  4. Navigate to Plugins or Settings and back, then repeat with reduced motion.
- **Expected**:
  - The current assistant row reveals content progressively and pinned follow
    stays at latest without visible oscillation.
  - Replaceable message/tool partials are coalesced to the next paint, while
    terminal, permission, planning, and error states remain immediate.
  - A failed tool row remains error-hued and locally expandable, but never marks
    the containing activity group as terminally failed. The group reports only
    processing duration; terminal turn styling comes from the terminal agent
    outcome surfaces.
  - Sidebar, composer, completed message/activity rows, work panel, titlebar,
    and global overlays do not visibly repaint or lose pointer/keyboard
    responsiveness for each token update.
  - Completed history remains in its stable render boundary while the active
    tail changes; history stays selectable, copyable, and anchored in the
    minimap without being rebuilt as a React subtree for every token.
  - Pressing and releasing standard, icon, sidebar, send, stop, and message
    action controls uses one eased transform rather than a snapped scale;
    active streaming labels keep their readable text while their compact status
    markers pulse at or below 1 second; loading skeletons retain their pulse.
  - Minimap overflow and active-marker state remain correct without marker
    jitter while streamed content changes height.
  - Destination, panel, focus, pressed, jump, and error feedback use one short
    bounded transition; no composer blur trails the transcript.
  - The initial shell does not eagerly evaluate secondary destination modules;
    first navigation may show a compact localized loading indicator, then
    preserves normal page interaction after the local chunk resolves.
  - Reduced motion preserves every state change and uses instant programmatic
    scrolling with near-zero transition duration.
- **Specs linked**: `04-ux/07-ui-design-system.md`,
  `04-ux/08-component-spec.md`, `04-ux/09-interaction-patterns.md`
- **Acceptance**: C (chat stream), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`interaction-performance.test.mjs`); rendered
  streaming scenario Draft

#### E2E-084: Long tool loop compacts before the provider context limit

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
- **Expected**:
  - Each `turn_end` is evaluated before another provider request and never
    marks the overall task idle; composer/config controls remain blocked until
    `agent_end`, `error`, or manual-only `compaction_end`. In-run follow-up
    assistant turns compact through `prepareNextTurn` (pi 0.84.4+ skips that
    hook on a terminating turn); a new user prompt still compacts before its
    first provider request.
  - Every successful compaction adds exactly one divider row to the transcript,
    positioned immediately after the last message that checkpoint covers, and
    raises exactly one warning toast. Two checkpoints produce two rows, in
    order, and neither row replaces or hides a message.
  - The `new_context` call appears as a normal tool activity row, returns
    immediately, and the checkpoint is created at the following turn boundary
    rather than mid-turn.
  - Opening the context usage inspector after a checkpoint shows one line with
    the compaction count and the newest summary's token estimate; before any
    checkpoint that line is absent.
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
  - Restart restores the summary and the recorded active/completed retention
    mode, and every earlier compaction row is still drawn. A regenerate/fork
    before a checkpoint boundary drops that record specifically; records
    anchored on surviving messages are preserved/remapped.
  - The exact provider overflow removes only the failed assistant from model
    context, retries once after compaction, and does not loop on a second
    overflow.
  - If automatic summary generation fails, a durable retained-tail fallback
    checkpoint is appended, the run stays active, and one warning explains
    that older model context was reduced; if fallback persistence or the safe
    budget guard fails, `CONTEXT_COMPACTION_FAILED` is emitted once.
  - If the newest checkpoint is already the transcript leaf when a follow-up
    prompt crosses the hard budget, the runtime rebuilds a smaller tail from
    the full transcript and carries the existing summary forward instead of
    reporting that there is no new context to compact.
  - The budget reminders appear at most once each per checkpoint window, never
    in the transcript, and never in a persisted system prompt.
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

#### E2E-AGENTS-001: Project instruction chain configures an agent session

- **Preconditions**: A project contains root `AGENTS.md`, nested
  `packages/api/AGENTS.md`, and a provider is configured.
- **Steps**:
  1. Start an Agent-mode conversation and submit a task covered by the root
     instruction.
  2. Let the agent read or edit `packages/api/handler.ts`.
  3. Add `packages/api/AGENTS.override.md`, then have the agent access another
     file in that directory.
  4. Edit the root instruction while the session is idle, then submit a
     follow-up task.
- **Expected**: The initial runtime receives the root chain. Before the file
  tool executes, the nested instruction is appended after its root source and
  therefore takes precedence. In one directory, `AGENTS.override.md` wins over
  `AGENTS.md`; `CLAUDE.md` and `.claude/CLAUDE.md` are fallback names. The idle
  follow-up uses changed root content rather than reusing the prior runtime.
  Empty, unreadable, oversized, and out-of-root instruction files do not block
  the turn; combined UTF-8 content is capped at 32 KiB. If path-specific
  resolution exceeds its two-second deadline or the host is unavailable, the
  file tool continues with the base chain and does not retain a sibling
  directory's rules. Repeated file tools in the same directory during one
  prompt reuse one path-resolution claim; the next prompt resolves again so
  changed instruction files are observed. The resolver uses the session-bound
  project root passed at runtime launch and does not issue a per-file
  `session.get` RPC.
- **Specs linked**: `03-runtime/02-agent-runtime.md`
- **Acceptance**: C (chat/stream), F (persistence)
- **Milestone**: M5
- **Status**: Partially automated (`project-instructions.test.ts`,
  `runtime.test.ts`); full
  provider/UI journey Draft

#### E2E-AGENTS-002: Global settings and project menus manage instruction files

- **Preconditions**: PI-Desktop is running; a project can be opened.
- **Steps**:
  1. Open Settings -> Instructions without an active project and save global
     content.
  2. Start a new agent session and verify its instruction context includes the
     global source.
  3. Open the Projects view and use a project's more menu to edit and save its
     displayed `AGENTS.md`.
  4. Submit a prompt in a new or idle session.
- **Expected**: The global editor targets only `~/.pi/agent/AGENTS.md`. The
  project editor is available only from a known project's Projects-view more
  menu and targets only that project's root `AGENTS.md`. Both editors show
  their resolved paths, preserve the typed text, and save through the dedicated
  IPC rather than a general file write API. Global content precedes project
  content in the next runtime; the saved project content follows it and takes
  precedence on conflicts. The project editor is a viewport-level dialog.
- **Specs linked**: `03-runtime/02-agent-runtime.md`, ADR 0037
- **Acceptance**: C (chat/stream), D (workspace), F (persistence)
- **Milestone**: M5
- **Status**: Unit-covered (`project-instructions.test.ts`); UI journey Draft

#### E2E-085: Expanded sidebar typography keeps list content compact

- **Preconditions**: The expanded sidebar contains at least one standalone
  session, one retained project with a session, and one empty project group;
  light and dark themes are available.
- **Steps**:
  1. Open the app at the default window width and inspect session titles,
     project/group titles, empty-state copy, section labels, and the footer's
     Settings, Plugins, and notification icons.
  2. Switch between light and dark themes, then narrow the window to the
     minimum supported expanded-sidebar width.
  3. Compare the sidebar hierarchy with 14px chat body text and inspect long
     session/project names.
- **Expected**:
  - Footer action icons use the shared 32px hit target and compact 14px icon
    sizing; Plugins sits immediately to the right of Settings.
  - Session titles, project/group titles, and empty-state copy use `--text-md`
    (13px); section labels and secondary metadata remain at `--text-sm` (12px).
  - The hierarchy remains readable in both themes, row pitch stays compact at
    approximately 28–32px, and long labels truncate without shell reflow.
- **Specs linked**: `04-ux/07-ui-design-system.md`,
  `04-ux/08-component-spec.md`, D161
- **Acceptance**: Quality
- **Milestone**: M5
- **Status**: Unit-covered (`sidebar-navigation.test.mjs`); rendered visual
  scenario Draft

#### E2E-086: Assistant Mermaid fences render safely without blocking streams

- **Preconditions**: A provider can stream an assistant answer containing a
  valid Mermaid flowchart, an invalid Mermaid fence, and ordinary fenced code;
  light and dark themes are available.
- **Steps**:
  1. Stream a valid `mermaid` fence slowly and observe it before and after the
     closing fence arrives.
  2. Scroll the completed diagram into view, toggle source, copy the source,
     and switch between light and dark themes.
  3. Scroll upward so transcript follow is paused, then bring another completed
     diagram near the viewport.
  4. Render invalid and over-20,000-character Mermaid sources plus a payload
     attempting an HTML label, external image, link, or Mermaid config override.
  5. Expand thinking content containing a `mermaid` fence.
- **Expected**:
  - The partial stream remains a normal source code block; only the complete
    answer fence starts rendering, and only near the viewport. Ordinary code
    fences and thinking Mermaid fences retain their source presentation.
  - The diagram uses bounded card chrome, remains within the transcript width,
    switches theme without stale colors, and exposes keyboard-accessible
    diagram/source and copy controls. Copy returns the original fence source.
  - Diagram height changes keep a pinned transcript at the bottom but never
    resume follow after the user scrolls upward.
  - Invalid, oversized, or unsafe input cannot fail the assistant turn, execute
    a link, load embedded media, add foreign HTML, or weaken strict settings;
    it falls back to readable copyable source when rendering is unavailable.
- **Specs linked**: `04-ux/08-component-spec.md` §8.7,
  `04-ux/09-interaction-patterns.md` §2, `05-security/01-security.md` §2, D165
- **Acceptance**: C (chat & stream), Security, Quality
- **Milestone**: M5
- **Status**: Unit-covered (`mermaid-rendering.test.mjs`); rendered security and
  visual scenario Draft

#### E2E-092: Packaged runtime is self-contained without duplicate dependencies

- **Preconditions**: Native macOS arm64 and Intel x64, Windows x64, and Linux
  x64 packages built from clean release-host directories; a clean application
  profile;
  English and zh-CN available; external network access can be disabled while
  loopback remains available; a deterministic loopback OpenAI-compatible
  fixture provider returns code, KaTeX, Mermaid, and a Bash command.
- **Steps**:
  1. Record every compressed artifact format plus the unpacked application,
     ASAR, Electron runtime, locale, and unpacked-native sizes on each native
     runner.
  2. Inspect ASAR and resource inventories for sidecar, host, production
     modules, source maps, tests/examples/declarations, Chromium locales, and
     native prebuild targets.
  3. On each macOS package, run `file` (or `lipo -info`) against the app
     executable and `Resources/bin/pi-desktop-host-core`; confirm arm64 and
     x86_64 packages contain only their declared architecture and that the
     Rust host matches the Electron app. Confirm the release directory has
     both DMG and ZIP artifacts and one merged `latest-mac.yml` feed.
  4. Inspect the renderer output for its size controls: emitted JS is minified,
     no `.woff` or `.ttf` files are present, the KaTeX `woff2` faces remain, and
     the brand marks are the renderer-sized `assets/brand/logo-*.png` rather
     than the 1024px installer icons.
  5. Configure the loopback fixture provider, disable external egress, and
     launch from a clean profile. Switch between English and Simplified
     Chinese, request the deterministic response, render common
     JavaScript/TypeScript, Python, Rust, shell, Mermaid, and unknown-language
     fences plus KaTeX and a Mermaid diagram, run the Bash fixture, and verify
     host and agent-sidecar health.
  6. Confirm typography and branding survive the stripped font fallbacks: KaTeX
     math renders with its own faces, Chinese text in both the UI chrome and
     assistant output stays readable under each bundled font selection, and the
     sidebar plus startup-splash logos render crisply on a HiDPI display.
- **Expected**: Each macOS package contains exactly one bundled agent sidecar,
  one Rust host matching its declared architecture, and only configured
  Chromium locale packs. The release output contains both native macOS
  architectures, DMG/ZIP artifacts, and one merged updater feed. Renderer
  dependencies exist through Vite output rather than duplicate raw
  `node_modules`; dependency source maps, tests, examples, declarations,
  a second agent-runtime tree, and reliably excludable non-target native assets
  are absent. Curated Shiki grammars highlight locally while an unknown fence
  stays readable as plain text. The renderer ships minified chunks, carries no
  legacy `woff`/`truetype` payload, keeps every KaTeX `woff2` face, and imports
  only renderer-sized brand marks; math, Chinese text under each bundled font,
  and the chrome logos all render correctly. The offline shell starts and all
  fixture capabilities use local packaged assets; provider/update network
  failures do not block startup.
- **Specs linked**: `02-architecture/01-architecture.md`,
  `02-architecture/02-tech-stack.md`, `03-runtime/07-process-model.md`,
  `04-ux/02-i18n-english-first.md`, `05-security/01-security.md`,
  `06-delivery/06-release-runbook.md`, D008
- **Acceptance**: A (app startup), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`packaging-footprint.test.mjs` validates static
  dependency and builder configuration); native inventory and packaged offline
  launch Draft

#### E2E-093: Mutating tools serialize and recover from stale edit context

- **Preconditions**: A project-bound Agent session has a writable workspace;
  the provider fixture can emit two same-session `Write`/`Edit` calls in one
  tool batch; a second edit can be given a stale `tag`; a Bash command can
  return a non-zero exit code with diagnostics.
- **Steps**:
  1. Start a task that emits two mutations for the same session while also
     emitting independent read/search calls.
  2. Inspect tool timing and the transcript while the first mutation runs.
  3. Force the second `Edit` to carry a `tag` that no longer hashes the file,
     with anchors that recovery cannot remap, then allow the agent to re-read
     the file and retry from the current contents.
  4. Run a Bash command that exits non-zero and inspect its tool result and
     inline state.
  5. Repeat with an `ops` payload whose ranges overlap.
  6. If the task uses a dedicated worktree outside the advertised workspace,
     verify its guarded Bash edit and resulting `git diff`.
- **Expected**:
  - Read/search calls may overlap, but only one `Write`/`Edit` executes for a
    session at a time; queued mutations do not consume another global
    mutation slot while waiting.
  - The stale-tag edit fails without changing the file and returns
    `EDIT_TAG_MISMATCH` carrying the live tag and current content at the
    anchors; the overlapping-range payload fails with `EDIT_RANGE_INVALID`
    before any write.
  - The non-zero Bash command is marked failed while retaining its exit code,
    stdout, and stderr for the agent and diagnostics.
  - The retry performs one fresh read and operates on the current file; once
    that path has spent its recovery graces, the next same-path failure — or a
    second failed shell patch command — returns a terminating tool result plus a
    visible `MUTATION_RETRY_BUDGET_EXHAUSTED` row, stops the mutation workflow,
    and does not repeatedly modify an old patch artifact or its hunk headers.
  - The final file contains exactly the intended change, and diff/review data
    contains no partial or interleaved mutation.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md`,
  `03-runtime/06-host-rpc-protocol.md`, `03-runtime/08-error-codes.md`
- **Acceptance**: E (tools & permissions), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`tool_budget.rs`, `tools/mod.rs`,
  `agent-runtime/runtime.test.ts`); full provider/UI journey Draft

#### E2E-096: Recover transient provider stream failures in place

- **Preconditions**: A project-bound Agent session uses a deterministic
  provider fixture that emits a partial assistant stream, terminates once, then
  succeeds on the next request; a second fixture run can terminate five times; a
  third fixture returns `OpenAI API error (502)` before headers on one attempt
  and mid-stream on the next; a fourth fixture returns six consecutive 502s; a
  fifth fixture returns a 503 with `Retry-After`; timing logs are enabled.
- **Steps**:
  1. Start an Agent turn with the one-termination fixture and observe the
     partial assistant response.
  2. Wait for the bounded retry and inspect the transcript, session state, and
     model timing log after recovery.
  3. Repeat with the five-termination fixture and inspect the terminal error
     message/event and its diagnostic details.
  4. Run the mixed-phase 502 fixture and inspect the request count and timing
     log for both the pre-header and the mid-stream 502.
  5. Run the persistent six-502 fixture and inspect the terminal error.
  6. Run the 503 `Retry-After` fixture and inspect the observed wait.
  7. Reload the session and verify that only the completed response or the
     single terminal failed assistant remains durable.
- **Expected**:
  - `terminated` is classified as `STREAM_FAILED`, and an upstream gateway
    `502`/`503`/`504` as retryable `PROVIDER_ERROR`.
  - Non-429 transient failures share one bounded budget of four retries after
    the initial attempt, for five provider attempts total, shared by request
    setup and stream delivery. Each retry waits for an abortable bounded
    backoff, removes the failed assistant from model context, and produces no
    duplicate assistant bubble or terminal error notification.
  - A mid-stream 502 is retried rather than surfacing immediately. The
    mixed-phase fixture spends one counter across both phases and makes five
    attempts in total, not one retry per phase. Observed waits without a
    `Retry-After` header are 1, 2, 4, then 8 seconds, identical in both phases.
  - Only the failed request is replayed: the session, its transcript, and any
    completed tool call are untouched across every retry.
  - The recovered turn emits one terminal lifecycle and keeps the same visible
    assistant message id. The timing log records `outcome=retry` for each retry
    with its attempt number, and the final outcome.
  - The fifth termination emits one terminal `STREAM_FAILED` assistant error
    and lifecycle event; the persistent 502 fixture emits one terminal
    `PROVIDER_ERROR`. Both carry `retryAttempt: 4`. Available details include
    phase, stream timing, and provider status, without credentials or an
    unrestricted provider body.
  - The 503 fixture waits for the server's `Retry-After` instead of the client
    backoff. Non-429 server and fallback waits are capped at 8 seconds.
  - A mid-stream HTTP 429 is covered by E2E-149's separate five-retry path; the
    two budgets do not draw from each other.
  - Authentication, model-selection, context, and malformed-request failures
    do not enter either provider replay path, including a non-retryable
    `PROVIDER_ERROR` from a malformed 400/422 request.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `03-runtime/02-agent-runtime.md`, `03-runtime/08-error-codes.md`,
  `08-meta/decisions-log.md` (D186, D259), ADR 0050, ADR 0128
- **Acceptance**: C (chat & stream), F (persistence), H (diagnostics), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`agent-errors.test.ts`, `provider-retry.test.ts`,
  `runtime.test.ts`, `subagent.test.ts`); full provider/UI journey Draft

#### E2E-149: Recover provider rate limits (429) silently in place

- **Preconditions**: A project-bound Agent session uses deterministic provider
  fixtures for a setup HTTP 429 and a mid-stream HTTP 429. Each fixture can
  succeed after a retry and can return six consecutive 429 responses. Fixtures
  cover `retry-after-ms`, `retry-after` seconds, and HTTP-date headers, expose
  timing logs, and support aborting during the wait. A builtin subagent uses a
  fixture with the same responses.
- **Steps**:
  1. Start an Agent turn with a setup-429 fixture whose next request succeeds.
  2. Repeat with a mid-stream-429 fixture whose next request succeeds.
  3. Inspect the transcript, lifecycle events, request count, and timing log
     for both recoveries.
  4. Repeat with six consecutive 429 responses, then inspect the terminal
     assistant error and diagnostic details.
  5. Start the subagent fixture, then repeat the persistent six-429 case.
  6. Start another 429 turn and abort while it is waiting; inspect that no
     later provider request or terminal retry is started.
  7. Repeat with authentication, model-selection, malformed-request, and
     context-error fixtures.
- **Expected**:
  - Every 429 is classified as retryable `PROVIDER_RATE_LIMITED` in both setup
    and post-start recovery, including a response body that omits rate-limit
    wording when the captured HTTP status is 429. Diagnostics retain
    `providerStatus: 429`.
  - Setup and mid-stream failures share one budget of five retries after the
    initial attempt. A persistent fixture therefore makes six provider
    attempts, never multiplies attempts through nested pi-ai retries, and
    emits no intermediate assistant error, lifecycle `error`, `turn_end`, or
    `agent_end`.
  - A recovered attempt removes the failed assistant from model context and
    reuses its visible assistant message id. The transcript has one assistant
    bubble and one terminal lifecycle; the timing log records each retry with
    its phase, delay, and attempt number.
  - Delay precedence is `retry-after-ms`, `retry-after` seconds, HTTP-date,
    then exponential backoff with positive jitter. Server and fallback waits
    are capped at 30 seconds and the wait is abortable.
  - Exhaustion emits one terminal `PROVIDER_RATE_LIMITED` assistant error and
    lifecycle event with `retryAttempt: 5` and `providerStatus: 429`; no sixth
    retry occurs. The outcome card exposes one localized **Continue** action and
    no **Regenerate** action. Activating it appends the localized continuation
    prompt (`Continue the user's unfinished task.` / `继续用户未完成的任务`) to the
    same session and starts the next turn without discarding the failed turn.
  - The subagent uses the same five-retry budget and one visible child bubble;
    its final report is failed only after the budget is exhausted, while
    intermediate 429s never become a parent-visible error report.
  - Aborting during a backoff cancels the pending timer and starts no later
    provider request. Authentication, model-selection, malformed-request, and
    context fixtures make no automatic retry.
  - The 429 budget is separate from the non-429 transient budget in E2E-096.
    A 429 does not consume transient retries and a 502 does not consume 429
    retries.
- **Specs linked**: `03-runtime/02-agent-runtime.md` (D245),
  `03-runtime/08-error-codes.md`, `08-meta/decisions-log.md` (D245), ADR 0091
- **Acceptance**: C (chat & stream), H (diagnostics), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`provider-retry.test.ts`, `runtime.test.ts`,
  `subagent.test.ts`); full provider/UI journey Draft

## 7A. M6 Plan and shell scenarios

#### E2E-104: Legacy contract values migrate to schema v11

- **Preconditions**: Schema-v8 fixtures contain sessions, app defaults, and
  scheduled records with legacy `chat` values plus transcripts and permissions;
  schema-v7 and schema-v9 fixtures cover both guarded entry paths.
- **Steps**: 1) Start host-core and allow the guarded migration (v7 first
  reaches v8). 2) Inspect sessions, settings, scheduled modes,
  `plan_approvals` fields/indexes, and the exact readable v8/v9 backup. 3)
  Restart and inspect the same records. 4) Repeat with malformed app settings,
  malformed scheduled config, invalid top-level operating modes, and an unknown
  or wrong-platform default shell. 5) Repeat with a platform-valid persisted
  shell marked temporarily unavailable and nested extension `mode` fields.
- **Expected**: Every legacy mode is `plan`, Agent remains the new-session and
  new-task default, transcripts/permissions survive, `plan_approvals` retains
  approval data and has artifact/execution fields, v8→v11 is one atomic
  transaction after its WAL checkpoint and v8 backup, v9 and v10 create
  readable backups, and migration failure leaves the source schema
  authoritative. Every malformed or
  invalid fixture fails closed before schema promotion. The temporarily
  unavailable platform-valid shell remains persisted for runtime fallback, and
  nested extension modes remain unchanged.
- **Specs linked**: `00-baseline.md`, `03-runtime/04-data-storage.md`,
  `03-runtime/01-ipc-protocol.md`, `04-ux/06-settings-ia.md`, ADR 0053
- **Acceptance**: F (persistence), H (diagnostics)
- **Milestone**: M6
- **Status**: Automated (passed 2026-08-05): host-core 139/139, including 15
  focused DB tests, covers schema-v7→v8→v11, v8→v11, v9→v11, and v10→v11
  guarded paths,
  exact readable backups, fail-closed rollback, restart, transcript, settings,
  scheduled-mode, approval-field, and index tests

#### E2E-105: Plan policy remains host-authoritative

- **Preconditions**: A project-bound session is idle in Plan with BrowserPreview,
  a plugin tool, and a forged `requestedMode = "agent"` fixture.
- **Steps**: 1) Inspect visible Plan tools. 2) Use Read/Glob/Grep and
  BrowserPreview. 3) Attempt Write, Edit, plugin, and
  unknown tools through the host with every permission mode. 4) Run Bash under
  Ask, Accept edits, and Auto.
- **Expected**: Plan denies Write/Edit/plugin/unknown tools regardless of the
  forged mode, grants, or Auto; Bash follows the selected permission mode. The
  runtime remains one pi Agent and all denials are audited.
- **Specs linked**: `03-runtime/02-agent-runtime.md`,
  `03-runtime/03-tools-and-permissions.md`, `03-runtime/05-host-core-rust.md`,
  `03-runtime/06-host-rpc-protocol.md`, `05-security/01-security.md`, ADR 0053
- **Acceptance**: E (tools and permissions), Security
- **Milestone**: M6
- **Status**: Automated (passed 2026-08-04): `test:e2e:plan` plus host-core
  permission/policy and agent-runtime tool-composition tests

#### E2E-106: SubmitPlan rejects into editable planning and resubmits a new artifact

- **Preconditions**: A project-bound session is idle in Plan with a provider;
  `.pi/plan/` is absent or empty and the workspace permits host artifact
  creation.
- **Steps**: 1) Let the Agent call `SubmitPlan` with fixed title, Markdown, and
  question. 2) Inspect the new `.pi/plan/*.md` file byte-for-byte and the
  `plan_approvals` row. 3) Inspect the card's title and artifact opener; confirm
  the question/description, validity/deadline, and status are absent and only
  Approve and Reject are offered. 4) Open the approval mode menu, choose Auto,
  and verify the next approval defaults to Auto. 5) Reject the
  proposal. 6) Confirm durable mode is Plan, live state is editable `planning`,
  the approval gate is cleared, and a later prompt is accepted. 7) Let the
  Agent revise and call `SubmitPlan` once in that new turn with a complete
  snapshot. 8) Approve the second proposal with the remembered Auto mode.
- **Expected**: Host preserves the exact submitted Markdown bytes in a new
  unique artifact, records its relative path/hash/size with structured
  title/question, and never lets the renderer or sidecar write or replace it.
  The title-derived artifact filename is recognizable from the title, including
  non-ASCII title characters. The card shows the title and opens the artifact;
  it does not require inline question/Markdown/hash/size or a validity/deadline
  indicator. The selected approval mode is remembered locally for the next
  approval.
  Rejection is terminal for the first row, leaves durable mode Plan, and returns
  live state to editable planning. The later prompt/resubmission creates a
  second complete Markdown snapshot and a different `.pi/plan/*.md` artifact;
  the first artifact bytes remain unchanged. Approving the second proposal with
  the remembered Auto mode still changes the same Agent to Agent and queues execution.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `03-runtime/02-agent-runtime.md`, `03-runtime/04-data-storage.md`,
  `03-runtime/06-host-rpc-protocol.md`, `04-ux/03-permission-ux.md`,
  `04-ux/08-component-spec.md`, `05-security/01-security.md`, ADR 0053
- **Acceptance**: C (conversation/stream), E (permissions), F (persistence)
- **Milestone**: M6
- **Status**: Automated (passed 2026-08-05): `test:e2e:plan` verifies the Host
  artifact/approval lifecycle. The optional live `test:e2e:plan-ui` case
  requires an env-provided OpenAI-compatible provider; the authorized run with
  model `gpt-5.6-luna` passed 6/6 with zero console diagnostics. It used the
  real controlled Composer and Send, the live Agent called `EnterPlanMode` then
  `SubmitPlan`, normal rendered Ask approval resolved through preload/Main,
  approved execution emitted the exact durable marker, and a private
  env-gated WeakMap check proved the same `DesktopAgentRuntime` object before
  and after approval. Main/Host/sidecar PIDs remained stable; credentials never
  entered CDP or output. The default no-key run remains 5/5 with the live case
  explicitly skipped.

#### E2E-107: Plan approval uses one absolute 30-minute expiry

- **Preconditions**: A pending Plan request exists with a controllable clock.
- **Steps**: 1) Record `createdAt` and `expiresAt`. 2) Reload the renderer and
  reopen the request. 3) Advance time to the deadline without resolving. 4)
  Attempt approval after expiry.
- **Expected**: Renderer reload rehydrates only the still-pending row while the
  host remains alive, and the displayed countdown retains the original absolute
  deadline; rejected, expired, approved/completed, and interrupted terminal
  cards are not part of reload hydration. Expiry records `expired`, leaves the
  session Plan, returns `PLAN_APPROVAL_TIMEOUT`, and rejects the late response
  without changing mode or permission.
- **Specs linked**: `03-runtime/06-host-rpc-protocol.md`,
  `03-runtime/08-error-codes.md`, `03-runtime/10-session-state-machine.md`,
  `04-ux/03-permission-ux.md`, ADR 0053
- **Acceptance**: E (permissions), H (diagnostics), Security
- **Milestone**: M6
- **Status**: Automated (passed 2026-08-04): `test:e2e:plan-ui` covers pending
  renderer reload; `test:e2e:plan` and the deterministic host-core late-expiry
  test cover the absolute deadline, timeout persistence, and fail-closed
  resolution. No terminal-card reload hydration is claimed.

#### E2E-108: Startup fence interrupts pending Plan work

- **Preconditions**: A Plan request is pending with a live approval waiter and
  running planning turn; host and renderer can restart independently.
- **Steps**: 1) Reload the renderer and list the live request. 2) Restart the
  host/app before resolution. 3) Inspect the `plan_approvals` row, turn, and
  session after startup. 4) Submit the pre-restart response.
- **Expected**: Renderer reload while the host remains alive preserves the
  still-pending row and original deadline. Full Host/app restart transactionally
  marks the pending row and turn interrupted/aborted before RPC service, leaves
  the session Plan, and returns `PLAN_APPROVAL_STALE` for the old response. No
  actionable stale card or execution is restored, and the UI is not required to
  present the interrupted terminal snapshot after restart. No process epoch
  field is persisted or sent.
- **Specs linked**: `03-runtime/04-data-storage.md`,
  `03-runtime/06-host-rpc-protocol.md`, `03-runtime/07-process-model.md`,
  `03-runtime/10-session-state-machine.md`, `04-ux/08-component-spec.md`, ADR 0053
- **Acceptance**: F (persistence), H (diagnostics), Security
- **Milestone**: M6
- **Status**: Automated (passed 2026-08-04): `test:e2e:plan` performs a real
  Host restart and host-core recovery tests verify interrupted durable state;
  the pending renderer-reload assertion is covered by the E2E-107 UI lane.

#### E2E-109: Approved Plan execution is not replayed after restart

- **Preconditions**: A Plan request has been approved with Ask and is captured
  once in `queued` and once in `running` state.
- **Steps**: 1) Restart the host during each state. 2) Inspect the
  `plan_approvals.execution_state` and turn records after startup. 3) Observe
  provider/tool invocations and session mode. 4) Start a new user turn
  explicitly.
- **Expected**: Queued/running execution fields become `interrupted`,
  associated turns abort, no provider/tool call is replayed, and the session
  remains Agent because approval already committed. A new turn is accepted only
  after the user starts it; no interrupted terminal card or stale action is
  required after restart.
- **Specs linked**: `03-runtime/04-data-storage.md`,
  `03-runtime/06-host-rpc-protocol.md`, `03-runtime/07-process-model.md`,
  `03-runtime/10-session-state-machine.md`, ADR 0053
- **Acceptance**: C (conversation/stream), F (persistence), H (diagnostics), Security
- **Milestone**: M6
- **Status**: Automated (passed 2026-08-04): `test:e2e:plan` restarts real queued
  and claimed executions and verifies no replay plus Agent retention

#### E2E-110: Scheduled Plan is rejected before any work

- **Preconditions**: A scheduled task is Plan and an unattended runner is
  available; provider, artifact, and queue writes can be observed.
- **Steps**: 1) Trigger the task through the unattended path. 2) Inspect the
  provider trace, `.pi/plan/`, and `plan_approvals` table. 3) Switch the
  task/session explicitly to Agent and run it again.
- **Expected**: Plan is rejected before provider, artifact, approval, or queue
  work with `PLAN_REQUIRES_INTERACTIVE_SESSION`; no background auto-approval
  occurs. Explicit Agent selection permits normal unattended policy.
- **Specs linked**: `03-runtime/04-data-storage.md`,
  `03-runtime/08-error-codes.md`, `04-ux/01-ui-ia.md`, ADR 0053
- **Acceptance**: F (persistence), H (diagnostics), Security
- **Milestone**: M6
- **Status**: Automated (passed 2026-08-04): `test:e2e:plan` verifies Plan
  rejection before side effects and explicit Agent execution independent of the
  global default

#### E2E-111: Active-turn, pending-approval, and configuration boundaries are enforced

- **Preconditions**: A session has one active Agent turn and another session is
  idle; a Plan run can be made pending/queued/running.
- **Steps**: 1) Attempt a second prompt, mode/provider/model/permission/shell
  configuration change, and second Plan submission during the active turn. 2)
  Let the turn become pending approval and repeat the prompt and configuration
  attempts. 3) Reject the approval. 4) Submit a later prompt and let the Agent
  create a revised Plan snapshot. 5) Repeat configuration after the session is
  editable planning.
- **Expected**: Active-turn/configuration changes, prompts, and a second Plan
  submission fail with `AGENT_BUSY`/`CONFLICT` while the turn or active pending
  approval exists; only the originating session is blocked. Reject returns the
  durable session to Plan and the live state to planning, clears the gate, and
  permits the later prompt/new artifact. Terminal proposal snapshots do not
  disable input, the Composer mode chip, or model selection during the current
  renderer lifetime. Idle/planning configuration succeeds and no cross-session
  event or workspace root leaks.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `03-runtime/02-agent-runtime.md`, `03-runtime/06-host-rpc-protocol.md`,
  `03-runtime/10-session-state-machine.md`, `04-ux/08-component-spec.md`, ADR 0053
- **Acceptance**: C (conversation/stream), E (permissions), Quality
- **Milestone**: M6
- **Status**: Automated (passed 2026-08-04): `test:e2e:plan` verifies Host
  boundaries and `test:e2e:plan-ui` verifies pending-only gating plus editable
  rejected/terminal states during the current renderer lifetime

#### E2E-111a: A staged mode switch does not move the live planning indicator mid-turn

- **Preconditions**: A project-bound session is running an Agent turn with a
  provider; the renderer shows the working indicator and no
  `Plan / planning` indicator.
- **Steps**: 1) While the Agent turn is still running, switch the Composer mode
  chip from Agent to Plan. 2) Inspect the transcript status area before the
  turn ends. 3) Let the turn reach its terminal event. 4) Inspect the status
  area again while idle, then send a new prompt.
- **Expected**: The staged Plan choice updates the chip immediately, but the
  live planning indicator stays away while the in-flight Agent turn runs; it
  does not show `Plan / planning` until the new prompt starts under the staged
  mode. After the terminal event flushes the configuration the session is
  durable Plan with editable planning state, and the sent prompt surfaces the
  `Plan / planning` indicator.
- **Specs linked**: `03-runtime/02-agent-runtime.md`,
  `03-runtime/10-session-state-machine.md`, `04-ux/08-component-spec.md`
- **Acceptance**: C (conversation/stream), Quality
- **Milestone**: M6
- **Status**: Draft

#### E2E-112: Selectable shell catalog persists the default

- **Preconditions**: Host has an available platform catalog entry, a fixture can
  make a persisted choice unavailable, and a project-bound Agent session is
  idle. The Windows lane exercises the multi-choice ordering.
- **Steps**: 1) Inspect the catalog for the platform-valid IDs
  `windows-powershell`, `cmd`, `git-bash`, and `bash`. 2) Verify settings
  rejects an unavailable or wrong-platform ID. 3) Select an available shell
  and persist `defaultCommandShell`. 4) Make that persisted choice unavailable,
  restart, and verify the catalog selects the first available platform shell
  with `fallback: true`. 5) Execute the unchanged `Bash` tool.
- **Expected**: Settings persists only a valid stable shell ID; unavailable
  entries remain unavailable with guidance and a later unavailable persisted
  choice uses the intentional first-available fallback. The host invokes the
  effective shell while the tool/protocol name stays `Bash`, and shell
  selection follows the idle configuration boundary.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `03-runtime/03-tools-and-permissions.md`, `03-runtime/06-host-rpc-protocol.md`,
  `04-ux/06-settings-ia.md`, `04-ux/08-component-spec.md`, ADR 0054
- **Acceptance**: B (model/config), E (tools/permissions), F (persistence)
- **Milestone**: M6
- **Status**: Automated (passed 2026-08-04): `test:e2e:plan` verifies catalog,
  validation, persistence, and restart; the deterministic host-core catalog
  test verifies first-available fallback when a stored shell becomes unavailable

#### E2E-113: Stale shell identity fails closed

- **Preconditions**: A Bash turn has a pinned effective shell ID/dialect; the
  fixture can change the effective catalog selection before spawn.
- **Steps**: 1) Change the effective shell ID or dialect. 2) Execute Bash with
  the old expected ID. 3) Inspect process creation, fallback attempts, audit,
  and UI error. 4) launch a fresh turn and retry.
- **Expected**: The first call returns `COMMAND_SHELL_CHANGED`, starts no
  process, and does not change shell after the turn pin. The audit records the
  selected ID and dialect. A fresh turn snapshot is required for a later run.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md`,
  `03-runtime/05-host-core-rust.md`, `03-runtime/06-host-rpc-protocol.md`,
  `03-runtime/08-error-codes.md`, `05-security/01-security.md`, ADR 0054
- **Acceptance**: E (tools/permissions), H (diagnostics), Security
- **Milestone**: M6
- **Status**: Automated (passed 2026-08-04): `test:e2e:plan` verifies stale
  dialect rejection before marker creation plus host-core stale ID/dialect tests

#### E2E-114: Bash streams stdout and stderr independently

- **Preconditions**: A selected shell is available and a deterministic command
  writes interleaved stdout and stderr chunks.
- **Steps**: 1) Execute the command through `Bash`. 2) Observe host/RPC/UI
  output events. 3) Inspect the final bounded result and transcript row.
- **Expected**: stdout and stderr remain separate, ordered per tool call, and
  visible while the process runs. Final output preserves truncation metadata;
  no chunks cross sessions or turns and the Bash protocol name is unchanged.
- **Specs linked**: `03-runtime/06-host-rpc-protocol.md`,
  `03-runtime/09-logging-and-observability.md`,
  `03-runtime/16-tool-result-limits.md`, `04-ux/09-interaction-patterns.md`, ADR 0054
- **Acceptance**: C (stream), E (tools), Quality
- **Milestone**: M6
- **Status**: Automated (passed 2026-08-04): `test:e2e:plan` verifies distinct
  stdout/stderr notifications and final tool identity; host/runtime stream tests
  cover bounded accumulation and session isolation

#### E2E-115: Bash timeout uses 60 seconds and a bounded override

- **Preconditions**: A selected shell can run a command longer than 60 seconds;
  host clock is observable.
- **Steps**: 1) Run without a timeout override. 2) Observe the 60-second
  deadline. 3) Run with an in-range override. 4) Submit zero, negative, and
  over-300-second overrides.
- **Expected**: Missing timeout uses exactly 60 seconds and returns
  `TOOL_TIMEOUT` after process-tree shutdown. In-range values work within
  1–300 seconds; out-of-range values fail validation and never spawn.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md`,
  `03-runtime/06-host-rpc-protocol.md`, `03-runtime/08-error-codes.md`,
  `03-runtime/16-tool-result-limits.md`, `05-security/01-security.md`, ADR 0054
- **Acceptance**: E (tools), H (diagnostics), Security
- **Milestone**: M6
- **Status**: Automated (passed 2026-08-04): long-timeout `test:e2e:plan`
  measured the no-override timeout at 60,024 ms and verified in-range plus
  invalid bounds without delayed marker writes

#### E2E-116: Bash abort shuts down the complete process tree

- **Preconditions**: A Bash command starts a child and grandchild that emit
  delayed output; the originating session is running.
- **Steps**: 1) Start the command. 2) Abort the active turn. 3) Inspect process
  descendants, output events, audit, and turn state after the shutdown grace.
- **Expected**: The process group/job tree is terminated, no descendant remains,
  no later output arrives, the turn returns `TURN_ABORTED`, and the workspace is
  not rolled back automatically.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md`,
  `03-runtime/07-process-model.md`, `03-runtime/08-error-codes.md`,
  `03-runtime/16-tool-result-limits.md`, `05-security/01-security.md`, ADR 0054
- **Acceptance**: C (abort), E (tools), H (diagnostics), Security
- **Milestone**: M6
- **Status**: Automated (passed 2026-08-04): `test:e2e:plan` aborts a real
  descendant process tree and verifies no late marker/output; host-core tests
  verify cancellation registry cleanup

#### E2E-117: Agent/Plan/Goal UX and locales contain no Chat controls

- **Preconditions**: App can run in English and zh-CN with an idle session,
  Plan artifact fixture, shell settings, and global search's Commands section
  available.
- **Steps**: 1) Inspect Agent/Plan/Goal, permission, artifact approval, and shell
  controls in English. 2) Enter Plan and inspect planning/approval/queue/
  terminal states while the renderer remains alive. 3) Approve and reject a
  proposal, confirming that the approval surface disappears after host
  confirmation. 4) Inspect the Commands section and confirm it contains exactly
  `builtin.session.new`, `builtin.agent.compact`, and the three
  `builtin.mode.*` commands, with only `/new`, `/compact`, `/agent-mode`,
  `/plan-mode`, and `/goal-mode` in the builtin `/` group. Confirm the removed
  command IDs and `newChat` / `openProject` / `openSettings` dispatch aliases are
  absent. Use `/plan-mode` / `/agent-mode` slash aliases to switch the active
  idle session, confirming the Composer chip changes immediately. Type a prompt
  after either alias in the same draft and send it; confirm the mode changes and
  the prompt remains as a visible user turn. Send an alias alone and confirm it
  remains a local mode switch without creating an empty transcript turn. If
  prompt dispatch fails, confirm the complete draft remains editable. 5) Reload
  after a terminal proposal and inspect the session while asserting that
  Electron Main and Host process identities did not change. 6) Repeat in
  zh-CN. 7) Search visible commands for the removed Chat mode and
  request-changes controls. Host/app restart recovery is exercised separately
  by E2E-108 and E2E-109.
- **Expected**: Agent is the default; the left-of-input Composer chip is the
  sole active-session Agent/Plan/Goal control; Plan and Goal show
  Ask/Accept edits/Auto, the submitted title, an artifact opener,
  remembered approval mode, approve/reject only, shell catalog/fallback status,
  and localized failed-closed states. No
  Chat mode, `/chat-mode`, request-changes action, inline Markdown/hash/size
  requirement, or stale actionable queue is exposed; terminal checkpoint
  metadata may remain non-actionable only for the current renderer lifetime,
  while the composer approval surface is removed after host-confirmed
  resolution.
  Renderer reload does not rehydrate rejected, expired, approved/completed, or
  interrupted terminal cards. Host/app restart does not replay work or restore
  stale actions, and the UI is not required to present the interrupted terminal
  snapshot; `page = "chat"` remains an internal route.
- **Specs linked**: `01-product/01-product-scope.md`, `04-ux/01-ui-ia.md`,
  `04-ux/04-builtin-commands.md`, `04-ux/03-permission-ux.md`,
  `04-ux/06-settings-ia.md`, `04-ux/08-component-spec.md`,
  `04-ux/02-i18n-english-first.md`, ADR 0053, ADR 0054
- **Acceptance**: C (conversation), Quality
- **Milestone**: M6
- **Status**: Automated (passed 2026-08-04): raw-CDP
  `test:e2e:plan-ui` uses an env-gated Electron Main probe against the existing
  Host, asserts stable Electron/Host PIDs, covers pending restore, live terminal
  controls, rejected and approved/completed terminal-card absence after
  renderer reload, EN/zh-CN, and 1280×800 / 900×700 rendering. E2E-108/E2E-109
  cover Host restart interruption, stale-action rejection, and no replay.

#### E2E-118: A regenerated turn keeps its final answer after the branch archive

- **Preconditions**: A project-bound Agent session whose transcript already has
  one completed exchange, a provider that streams a multi-tool turn long enough
  for the final assistant message to land through the persistence outbox, and
  read access to `<data_dir>/sessions/<id>.jsonl`,
  `<id>.revisions.jsonl`, and the `messages` index.
- **Steps**: 1) Regenerate the assistant answer so the root user turn carries
  `revisionCount` / `activeRevision` and revision 1 is archived. 2) Let the
  re-run finish a turn that ends with tool calls followed by a final assistant
  message. 3) Immediately after `agent_end`, inspect the transcript file, the
  `messages` rows, and the archived revision payload. 4) Reload the session.
  5) Page the root bubble back to revision 1 and forward again.
- **Expected**: The final assistant message is present in the transcript file,
  in the index, and as the last message of the archived branch. Every message of
  the turn keeps its owning `turn_id`. The root carries `revisionCount = 2` and
  `activeRevision = 2`, reload shows the complete turn, and paging restores each
  branch whole. No `session.replaceMessages` call is made on the
  turn-completion path.
- **Specs linked**: `03-runtime/04-data-storage.md` §4.9/§7,
  `03-runtime/06-host-rpc-protocol.md` §4, ADR 0041, ADR 0060
- **Acceptance**: C (conversation), F (persistence), H (diagnostics), Quality
- **Milestone**: M6
- **Status**: Covered by host-core unit tests (2026-08-06):
  `save_active_branch_revision_keeps_a_message_appended_after_its_read` archives
  with a message appended after the read and asserts the transcript, the
  archived payload, and the index `(seq, turn_id)` rows;
  `replace_messages_preserves_owning_turn_ids` covers the remaining rewrite
  callers. UI paging remains manual.

#### E2E-119: Parallel subagents report back without entering the parent's context

- **Preconditions**: A project-bound Agent session with the user home containing
  `~/.agents/subagents/scout.md` (read-only, no `tools` key), `~/.agents/subagents/fixer.md`
  (`tools: Read, Edit`), `~/.agents/subagents/pinned.md` (`model:` naming a second
  configured provider) and `~/.agents/subagents/broken.md` (missing `name`); a provider
  whose stream can be driven to emit two `Task` calls in one assistant message;
  permission mode `ask` so a delegate's `Edit` is gated; read access to
  `<data_dir>/sessions/<id>.jsonl` and the `messages` index.
- **Steps**:
  1. Prompt a turn in which the assistant emits two `Task` calls — `scout` and
     `pinned` — in one message. Observe the delegation card while both run and
     after each one settles; collapse it, then expand each node.
  2. Prompt a turn whose assistant message emits a single `Task` call — `scout`
     — and compare its presentation with step 1's.
  3. Prompt a turn in which two `fixer` delegates each edit a different file, and
     answer only the first permission card.
  4. Answer the second card, then prompt a third turn where two `fixer`
     delegates edit the **same** file.
  5. Start a fan-out and press Stop while one card is on screen and another is
     queued.
  6. Prompt a `Task` call naming `broken`, then one naming an agent that does not
     exist, then one whose definition pins an unconfigured provider.
  7. Switch the session to Plan, then to Goal, and inspect the tool catalog.
  8. Reload the session and re-expand the delegation card and every `Task`
     node.
- **Expected**:
  - Both delegates in step 1 run concurrently, and `pinned` streams on its own
    provider/model while the parent keeps the session's.
  - The two `Task` calls in step 1 form one full-width delegation card. While
    active it opens once and its header updates the subagent and settled counts;
    after settlement it keeps the user's expansion choice and reports aggregate
    success, warning, or issue state plus elapsed time.
  - The lone `Task` in step 2 draws the same card with a single delegate node —
    same root, connector, outcome, runtime and step count — and never the
    compact one-line tool row (D265). Its aggregate line is worded for one
    subagent, so no locale reads "1 个 Subagents" or "Subagents working".
  - The expanded card shows one main-agent root connected to `scout` and
    `pinned` in parent-row order, with no invented edge between delegates. Each
    node shows its agent, short description, explicit outcome, duration and step
    count. Expanding a node shows the brief, report exactly once, and
    `status`/`turns`/`toolCalls`. Delegate rows appear only inside that node,
    never in the turn stream or the minimap.
  - If the parent keeps working after those `Task` calls — thinking, `Read`,
    `Grep`, or a lifecycle row — that work is a separate processing group, not
    rows inside the delegation card (D319). The card's tile, “Subagent working”
    header, and topology canvas contain only the `Task` nodes.
  - The parent's next request contains the reports and **no** delegate message or
    tool row; the rows are nonetheless present in the transcript file and the
    index with `meta.parentToolCallId` and `meta.agentName`.
  - Only the head permission card is rendered; it names the asking delegate and
    the number waiting behind it. Answering it reveals the next card, and neither
    answer resolves the other request.
  - `scout` cannot call `Edit` or `Write` at all; `fixer` can. Same-file edits in
    step 4 apply in a defined order and neither loses the other's write.
  - Stop denies both the shown and the queued request, and both delegates end
    `aborted` in text and icon inside their own `Task` nodes — the parent turn
    ends once and the aggregate card settles with a warning.
  - `broken` is absent from the catalog with a launch diagnostic and the session
    keeps its other three delegates; an unknown agent and an unresolvable model
    pin each fail as a `Task` tool error naming the cause, with no fallback to
    the session provider and no turn failure.
  - `Task` is absent from the catalog in Plan and Goal.
  - After reload the card is collapsed by default; re-expanding preserves node
    order, attribution, outcome and nested content exactly as they appeared
    live.
- **Specs linked**: `03-runtime/02-agent-runtime.md` §5f/§7.2b/§8,
  `03-runtime/03-tools-and-permissions.md` §10.2,
  `03-runtime/04-data-storage.md` §4.7a, `04-ux/03-permission-ux.md` §6a,
  `04-ux/08-component-spec.md` §9.9, ADR 0062, decisions-log D201, D265, D319
- **Acceptance**: C (conversation), E (tools & permissions), F (persistence),
  Security, Quality
- **Milestone**: M6
- **Status**: Covered by unit tests (2026-08-06): `packages/shared`
  `subagent-definition.test.ts` and `packages/agent-runtime`
  `subagent-definitions.test.ts` (frontmatter, tool filtering, caps, malformed
  documents, global-user-shadows-builtin); `subagent.test.ts` (report bounding, turn
  cap, abort, event attribution, prompt framing) and `path-lock.test.ts`
  (same-path ordering, concurrency cap); desktop `permission-inline.test.mjs`
  (queue order, id-matched removal, tool-call removal, abort denying the queue,
  card copy), `subagent-wiring.test.mjs` (main-process discovery and model pins)
  and `subagent-transcript.test.mjs` + `assistant-turns.test.mjs` (nesting,
  single report print, memoization, the card gate that admits a lone delegation
  and the count-aware aggregate copy in both locales), plus
  `subagent-topology.test.mjs` (delegate detection, structured outcomes and
  aggregate counts). Full multi-provider fan-out and rendered topology
  interaction remain manual.

#### E2E-145: Tool results read as structured blocks, never JSON

- **Preconditions**: A project-bound Agent session with permissions allowed for
  the turn; a plugin tool whose result is an arbitrary record is installed; the
  workspace contains a file large enough to trip host truncation.
- **Steps**:
  1. Run one turn that reads a source file, globs a directory, greps a token,
     greps again with `outputMode: filesWithMatches` and `count`, edits a
     workspace file, edits a scratch-root file, runs a failing shell command,
     and calls the plugin tool.
  2. Inspect each collapsed activity row, then expand every row in light and
     dark.
  3. Click a Glob path and a Grep hit heading.
  4. Trigger a high-risk tool so the inline permission card appears.
  5. Read a truncated file and copy each block.
- **Expected**:
  - No expanded row shows escaped JSON, and no payload appears twice.
  - Read/Write show highlighted content; Bash shows command, output, and
    error-hued stderr as separate blocks with empty channels omitted; Glob shows
    a path list; Grep shows hits grouped per file with line numbers in `content`
    mode, a path list in `filesWithMatches`, and per-file totals in `count`; the
    failing command carries an `exit 1` chip.
  - The workspace edit shows no inline diff (its ReviewChangeCard owns it); the
    scratch edit shows a compact diff and a `scratch` chip.
  - The plugin result renders label/value fields and labeled blocks, not a blob.
  - Clicking a path opens it in the work panel; paths outside the workspace root
    are not clickable.
  - The permission card's args preview uses the same blocks.
  - Host truncation markers stay visible, a `truncated` chip appears, a host
    `notice` renders as a neutral note under the block it qualifies, capped
    lists report the hidden remainder, and copy yields the full payload.
- **Specs linked**: `04-ux/08-component-spec.md` §9, §10.2,
  `08-meta/decisions-log.md` (D192)
- **Acceptance**: C (chat & stream), E (tools & permissions), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`tool-presentation.test.mjs`,
  `transcript-style.test.mjs`); full UI journey Draft

#### E2E-146: A turn that produces no visible text re-runs once

- **Preconditions**: A project-bound Agent session uses a deterministic provider
  fixture that ends one turn with no tool call and no text — once with reasoning
  content present, once with nothing at all; a second fixture run ends both the
  first turn and the re-run that way; timing logs are enabled.
- **Steps**:
  1. Start an Agent turn with the reasoning-only fixture and watch the
     transcript while the runtime recovers.
  2. Inspect the transcript, session state, and model timing log afterwards.
  3. Repeat with the nothing-at-all fixture.
  4. Repeat with the twice-silent fixture and inspect the terminal error message,
     its details disclosure, and its action button.
  5. Click the error's retry action.
  6. Reload the session and verify what stayed durable.
- **Expected**:
  - The recovered turn keeps the same visible assistant message id, emits one
    terminal lifecycle, and shows no error. The user sees only the answer.
  - The empty assistant is removed from model context before the re-run, so the
    provider never receives two assistant messages in a row, and it is never
    appended to the durable transcript.
  - The timing log records `outcome=silent` with `thinkingOnly` true for the
    reasoning-only fixture and false for the nothing-at-all fixture, then the
    re-run's own outcome.
  - The second silence emits one terminal retriable `EMPTY_MODEL_RESPONSE`
    assistant error and lifecycle event; the message names both attempts, and
    the retry action re-sends the last prompt.
  - A turn whose text is empty because it requested tools is untouched, and so
    is an aborted or already-failed turn.
  - Only one re-run happens per prompt, including after context-overflow
    recovery within the same prompt.
- **Specs linked**: `03-runtime/02-agent-runtime.md` §5e, §7,
  `03-runtime/08-error-codes.md` §3.2, `08-meta/decisions-log.md` (D193)
- **Acceptance**: C (chat & stream), F (persistence), H (diagnostics), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`runtime.test.ts`); full provider/UI journey Draft

#### E2E-147: Scoped search stays inside its budget and the agent narrates

- **Preconditions**: A project-bound Agent session; the workspace contains a
  multi-megabyte source file, a minified bundle with a `.map` sibling (one line,
  megabytes long), a binary file, and a dependency tree excluded by `.gitignore`.
- **Steps**:
  1. Inspect `tools.list` for `Read`, `Glob`, and `Grep`.
  2. Read the multi-megabyte file, then read it again from the reported next
     offset.
  3. Grep a token that hits the minified bundle and its `.map`.
  4. Grep the same token with `path` pointing into the ignored dependency tree,
     then with `include` narrowing to one extension, then with
     `outputMode: filesWithMatches` and `count`.
  5. Glob a broad pattern, and Glob with `path` and `limit`.
  6. Read the binary file.
  7. Run a shell command that prints far past the shell budget on stdout, then
     one that fails after printing progress noise on stderr, and open the spill
     file named in each marker.
  8. Ask a question that needs several tool batches, and watch the transcript
     between batches.
- **Expected**:
  - Every description carries its parameters and the real limit numbers.
  - No single tool result exceeds its budget: 128 KB for Read/Glob/Grep, 96 KB
    for Bash. Read reports `offset`, `lineCount`, `fileBytes`, and a next-offset
    `notice`; the second read continues without overlap; `totalLines` is always
    reported from the first read so the model knows the file scale upfront. A
    filled default or requested window reports `truncated: false` even when the
    file continues.
  - No file size is ever refused. Lines from the bundle and the `.map` arrive
    clipped at 16,384 chars and the clip count appears in `notice`, so one line
    cannot consume the result.
  - An explicit `path` reaches into the ignored tree; without it the same search
    returns nothing from there. `include`, `outputMode`, and `headLimit` each
    shrink the payload, and results order newest-modified first. When `rg` is
    on PATH, Grep uses it and still matches that contract; when it is missing
    or exits 2, Grep falls back in-process (D315).
  - The binary read fails with `TOOL_BINARY_CONTENT` and no binary reaches the
    model; Grep skips it silently.
  - Bash stdout keeps its head, stderr keeps its tail, both markers name which
    end survived and the spill path, and each spill file opens with the fuller
    output.
  - The agent answers in the language the user wrote in, precedes each tool
    batch with a sentence about what it is doing, never leaves more than one
    batch without new visible text, and ends with a self-contained result.
- **Specs linked**: `03-runtime/16-tool-result-limits.md`,
  `03-runtime/02-agent-runtime.md` §7, `08-meta/decisions-log.md` (D194, D306, D315)
- **Acceptance**: C (chat & stream), E (tools & permissions), Quality
- **Milestone**: M5
- **Status**: Unit-covered (host-core `tools` tests, `runtime.test.ts` prompt
  assertions); full provider/UI journey Draft

#### E2E-100: A pasted MCP server runs, and only where it is scoped

- **Preconditions**: Two projects on disk, `~/work/api` and `~/personal/site`.
  A local stdio MCP server available on PATH. An Agent session per project.
- **Steps**:
  1. Extensions → MCP → Import from JSON. Paste a `mcpServers` document holding
     three servers: one valid stdio entry, one remote HTTP entry at a trusted LAN
     address such as `http://192.168.1.20:8080/mcp` with no `type`, and one stdio
     entry with no `command`.
  2. Confirm the import, then open the imported stdio server and press Test
     connection.
  3. Leave the server at **Everywhere** and ask the agent in each project to
     list its available tools.
  4. Set the server to **These projects**, with only `~/work/api` picked.
  5. Ask again in each project.
  6. In the already-open `~/personal/site` session — assembled while the server
     was global — ask the agent to call one of the server's tools by name.
  7. Edit the server's `env` and save; ask in `~/work/api` again.
  8. Rename the server and re-scope it; ask once more.
  9. Point the server's command at a binary that does not exist, save, and open
     a new session.
- **Expected**:
  - Two servers import; the third is listed as skipped with "a stdio server
     requires command". The LAN HTTP entry lands as `http` with its url intact,
     and the editor shows the unencrypted-connection warning.
  - Test reports connected with the tool names it found, and the row's glyph
     turns from connecting to ready.
  - While global, both sessions see `mcp_<serverId>_<tool>` names.
  - After narrowing, only the `~/work/api` session sees them; the summary chip
     reads "1 project" and names it.
  - The stale call from step 6 fails with `TOOL_NOT_FOUND` and "not active for
     this session" — scope holds at dispatch, not only in the catalog.
  - The `env` edit drops the connection: the next assembly re-handshakes, and
     the tool's behaviour reflects the new value. The rename in step 8 does not
     reconnect anything.
  - The broken command records `failed` with a message, contributes no tools,
     and is not re-dialled on the following session assembly; pressing Test
     retries it.
- **Specs linked**: `07-plugins/01-plugin-system.md` §12,
  `03-runtime/01-ipc-protocol.md` §12a, `08-meta/decisions-log.md` (D192, D193)
- **Acceptance**: E (tools & permissions), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`apps/desktop/test/user-mcp.test.mjs`,
  `packages/shared/src/mcp-import.test.ts`, host-core `mcp_servers` tests); full
  UI journey Draft

#### E2E-101: A user skill is written once and scoped per project

- **Preconditions**: Two projects on disk. An Agent session in each.
- **Steps**:
  1. Extensions → Skills → New. Save with an empty description.
  2. Fill in a description, write a body, and save.
  3. Ask the agent in each project to use the skill by name.
  4. Set the skill to **These projects** with only the first project picked,
     then switch it Off and back to **These projects**.
  5. Ask again in each project.
  6. In the first project's session, narrow the skill to the *second* project
     and immediately ask the agent to invoke it.
  7. Paste a body over 128 KB.
  8. Switch the app language to 中文 and revisit every surface above.
- **Expected**:
  - Saving without a description is refused with a message naming the field:
    the description is the only part that enters the prompt.
  - The base prompt carries the skill's id, name and trimmed description and
    not its body; the body arrives only through the `Skill` tool.
  - Toggling Off and back restores the picked project without re-picking it.
  - After narrowing, only the scoped project's session can invoke it; the other
    gets "not enabled for this project".
  - Step 6 fails in the already-open session too — the scope is re-read when the
    body is loaded, not trusted from the catalog that listed it.
  - The byte counter warns before the 128 KB cap and the save is refused past it.
  - Every label, empty state, error and count renders in Chinese, with counts
    reading naturally at 0, 1 and many.
- **Specs linked**: `07-plugins/01-plugin-system.md` §12.3,
  `03-runtime/01-ipc-protocol.md` §12b, `08-meta/decisions-log.md` (D174, D192,
  D194)
- **Acceptance**: E (tools & permissions), Quality
- **Milestone**: M5
- **Status**: Unit-covered (host-core `user_skills` tests,
  `apps/desktop/test/extensions-page.test.mjs`); full UI journey Draft

#### E2E-102: Composer file and image paste keeps structured attachment metadata

- **Preconditions**: The app is running with an Agent session in a project and
  a home composer available. The OS clipboard contains a text snippet no
  longer than the configured large-paste threshold, one or more local files
  (including a filename with whitespace), and an image in separate paste
  attempts. Record the app data directory and the session id.
- **Steps**:
  1. Paste text-only within the configured threshold and confirm the text is
     inserted by the native textarea path.
  2. Paste one local file, then paste multiple files including a spaced name.
  3. Paste an image from the OS screenshot/clipboard provider.
  4. Inspect the draft before sending: confirm each materialized item is a
     removable leaf-name chip and no scratch absolute path occupies the
     textarea. Hover/focus chips to inspect their full paths, remove one, then
     send the prompt and inspect the session message's attachment metadata.
  5. Inspect `<data_dir>/scratch/<sessionId>/pasted/` and compare the saved
     bytes with the source files/image. Check the project `git status`.
  6. Delete the session, then confirm its scratch directory and pasted files
     are removed.
- **Expected**:
  - Text-only paste within the configured threshold remains native and is not
    routed through the file bridge. Oversized text behavior is covered by
    E2E-102g.
  - Each file/image is saved with a sanitized, UUID-backed unique name under
    the session scratch root, while its chip shows only the sanitized original
    leaf name. Duplicate leaf names remain separate references.
  - The dispatched prompt carries ordinary files through the existing path
    reference flow and carries pasted files/images as structured attachments;
    the persisted user message contains refs and metadata, never binary bytes.
    The agent can use its normal file tools to read the materialized files.
  - A home paste creates or reuses a durable session before writing. The
    workspace remains clean and no workspace artifact row is created.
  - Deleting the session removes the pasted files with the rest of scratch.
- **Specs linked**: `04-ux/08-component-spec.md` §11.7–11.8,
  `03-runtime/01-ipc-protocol.md` §13c,
  `03-runtime/03-tools-and-permissions.md` §4b,
  `03-runtime/04-data-storage.md`, `08-meta/decisions-log.md` (D197, D209,
  D243), ADR 0059, ADR 0070, ADR 0101
- **Acceptance**: C (conversation & stream), E (tools & permissions),
  F (persistence), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`apps/desktop/test/composer-paste-files.test.mjs`);
  full UI journey Draft (do not run E2E locally unless explicitly requested)

#### E2E-102a: Composer file reference results use compact leaf names

- **Preconditions**: The app is running with an Agent session in a workspace
  containing nested files, duplicate leaf names in different directories, and
  a directory whose name contains whitespace.
- **Steps**: 1) Type `@` and filter to the nested and duplicate entries. 2)
  Inspect the visible rows, then hover for full-path tooltips and inspect their
  accessible names. 3) Accept a file and confirm a leaf-name chip appears while
  the textarea omits its path. Accept a directory result and continue to a
  child file. 4) Send the completed references and inspect the persisted user
  message.
- **Expected**:
  - Each result persistently renders only its leaf name; directories retain a
    trailing `/`, and no parent path consumes horizontal row space.
  - The tooltip and accessible name retain the complete relative path so
    duplicate leaf names remain distinguishable.
  - File acceptance retains the original complete `entry.path` behind the chip;
    directory acceptance retains literal path continuation. At dispatch the
    sent and persisted prompt contains each complete path with existing
    whitespace quoting, and the agent can read both selected files normally.
- **Specs linked**: `04-ux/08-component-spec.md` §11.8,
  `04-ux/09-interaction-patterns.md` §8a, `03-runtime/01-ipc-protocol.md` §13c,
  `08-meta/decisions-log.md` (D124, D209), ADR 0024, ADR 0070
- **Acceptance**: C (conversation & stream), Quality
- **Milestone**: M5
- **Status**: Unit-covered
  (`apps/desktop/test/composer-file-reference-display.test.mjs`); full UI
  journey Draft (do not run E2E locally unless explicitly requested)

#### E2E-102b: Unanswered Stop restores compact file-reference drafts

- **Preconditions**: An Agent session can delay its first assistant event. The
  draft contains ordinary text, one workspace reference, two pasted references
  with duplicate leaf names, and a canonical path containing whitespace.
- **Steps**: 1) Send the mixed draft and stop before assistant text, thinking,
  or any tool row begins. 2) Inspect the restored composer and transcript. 3)
  Send the restored draft again and inspect the persisted user message. 4)
  Repeat, allow partial assistant output to begin, then stop.
- **Expected**:
  - Unanswered Stop removes the just-sent user row and restores the original
    ordinary text plus leaf-name chips in stable order.
  - Relative and scratch absolute paths never appear in the restored textarea;
    duplicate labels remain distinct references.
  - Resending serializes each exact canonical path once with existing
    whitespace quoting.
  - Stop after reply start preserves the partial aborted transcript and does
    not restore or duplicate text or chips.
  - Scratch bytes remain under the existing session lifecycle.
- **Specs linked**: `04-ux/08-component-spec.md` §11.5/§11.8,
  `04-ux/09-interaction-patterns.md` §3.2/§8a.2,
  `03-runtime/10-session-state-machine.md`, `08-meta/decisions-log.md` (D209),
  ADR 0070
- **Acceptance**: C (conversation & stream), F (persistence), Quality
- **Milestone**: M5
- **Status**: Unit-covered
  (`composer-file-reference-display.test.mjs`, `transcript-style.test.mjs`);
  full UI journey Draft (do not run E2E locally unless explicitly requested)

#### E2E-102c: Vision-capable models receive pasted images as image input

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
  roundtrip); provider/UI journey Draft (do not run E2E locally unless
  explicitly requested)

#### E2E-102d: Non-vision and oversized images use the path fallback

- **Preconditions**: One known non-vision model and one known vision-capable
  model; an Agent session; a normal PNG and a deterministic image just above
  the 20 MiB inline bound.
- **Steps**:
  1. Select the non-vision model, paste the normal PNG, and inspect Composer's
     removable image chip.
  2. Send the prompt and inspect the sidecar/provider request.
  3. Select the vision model, paste the oversized image, and send it.
  4. Retry each turn after disposing/recreating the runtime.
- **Expected**:
  - Composer shows the pasted image as a removable chip without a separate
    vision-status explanation. Both cases show a safe `@path` fallback and no
    image block/base64 payload.
  - The non-vision request references the session scratch file; the oversized
    vision request references a safe path while the image remains available to
    the normal file tools.
  - Retries and runtime recreation use the content-addressed image ref and a
    session `replayed/` path where needed; no duplicate binary blobs are made.
  - The transcript still stores attachment metadata/ref and the UI does not
    claim that the image was sent visually.
- **Specs linked**: `03-runtime/01-ipc-protocol.md` §5.1,
  `03-runtime/03-tools-and-permissions.md` §4b,
  `03-runtime/02-agent-runtime.md` §5c,
  `03-runtime/04-data-storage.md`, ADR 0101
- **Acceptance**: B (model config), C (conversation & stream), E (tools &
  permissions), F (persistence), Security
- **Milestone**: M5
- **Status**: Draft (do not run E2E locally unless explicitly requested)

#### E2E-102e: Unknown model ids fail closed for vision transport

- **Preconditions**: A custom provider/model id absent from the pi-ai catalog,
  discovery data that incorrectly labels it `vision`, and a pasted PNG.
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
  `04-ux/08-component-spec.md` §11.8, ADR 0101
- **Acceptance**: B (model config), C (conversation & stream), E (tools &
  permissions), Security
- **Milestone**: M5
- **Status**: Unit-covered (`model-capabilities.test.ts`); provider/UI journey
  Draft (do not run E2E locally unless explicitly requested)

#### E2E-102f: Oversized image references do not block session startup

- **Preconditions**: A project contains an image larger than the 20 MiB inline
  bound; a known vision-capable model is selected; the session has a valid
  provider and workspace.
- **Steps**: 1. Reference the oversized image from the Composer and send a
  prompt. 2. Observe the turn lifecycle while the attachment is prepared. 3.
  Dispose/recreate the runtime and send a follow-up about the image. 4. Inspect
  the session transcript, the content-addressed attachment blob, and the
  session `replayed/` path.
- **Expected**: The session accepts the prompt and reaches the provider without
  hanging the Electron main process or crashing the sidecar. Main hashes and
  copies the image without constructing a whole-file in-memory buffer. The
  provider receives the safe `@path` fallback rather than an oversized image
  block/base64 payload. Runtime recreation copies the stored blob into the
  scratch fallback path without reading the whole blob into memory. The durable
  message retains only attachment metadata and the content-addressed ref.
- **Specs linked**: `03-runtime/01-ipc-protocol.md` §5.1,
  `03-runtime/02-agent-runtime.md` §5, `03-runtime/04-data-storage.md`,
  ADR 0101
- **Acceptance**: C (conversation & stream), E (tools & permissions),
  F (persistence), Quality
- **Milestone**: M5
- **Status**: Unit-covered; full UI journey Draft (do not run E2E locally unless
  explicitly requested)

#### E2E-102g: Large text paste becomes an inline session-scratch reference

- **Preconditions**: The app is running with an Agent session in a project and
  a home composer available. The large paste threshold is first left at its
  default, then changed to a small test value. Record the app data directory,
  session id, and a multiline Unicode text fixture.
- **Steps**:
  1. Open Settings → AI → Defaults and confirm the large paste threshold is
     600. Set it to a deterministic lower value, save it, then return to the
     composer.
  2. Paste text exactly at the threshold and confirm native textarea behavior;
     paste text one character above it at the beginning, middle, and end of
     drafts, including multiline and Unicode content.
  3. Inspect the draft after each oversized paste: confirm the exact prefix and
     suffix remain, a generated `@temporary-name` plus a space appears at the
     original selection, the textarea does not contain the scratch absolute
     path, and the composer reports its busy/error state correctly during the
     transfer.
  4. Inspect the session `scratch/<sessionId>/pasted/` file bytes, send the
     mixed draft, and inspect the renderer request, persisted user message,
     and agent-readable path. Switch projects and sessions before sending a
     cached draft, then remove the generated token and confirm it is no longer
     dispatched.
  5. Delete the owning session and confirm its temporary paste files are
     removed.
- **Expected**:
  - The threshold is persisted as an AI default, defaults to 600 on older
    settings, and accepts only integer values from 1 through 1,000,000.
  - Text at or below the threshold remains native. Text above it is saved
    byte-for-byte as UTF-8 `text/plain` under the owning session's scratch
    `pasted/` directory, without changing the project or creating an artifact.
  - The inline token is inserted at the exact paste selection, including in the
    middle of a multiline draft. Dispatch resolves its canonical path in place
    exactly once; it is neither appended as a basename nor duplicated as an
    attachment. Removing or editing out the token removes that mapping.
  - Session switching, project switching, unanswered Stop restoration, and
    session deletion respect the existing session ownership and cleanup rules.
- **Specs linked**: `04-ux/06-settings-ia.md`,
  `04-ux/07-ui-design-system.md` §8.1, `04-ux/08-component-spec.md` §11.7–11.8,
  `04-ux/09-interaction-patterns.md` §8a,
  `03-runtime/01-ipc-protocol.md` §8,
  `03-runtime/04-data-storage.md` §7, `08-meta/decisions-log.md` (D262),
  ADR 0059, ADR 0070, ADR 0131
- **Acceptance**: C (conversation & stream), E (tools & permissions),
  F (persistence), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`composer-trigger.test.ts`,
  `apps/desktop/test/composer-paste-files.test.mjs`); full UI journey Draft
  (do not run E2E locally unless explicitly requested)

#### E2E-103: Settings Agent pages manage file-backed capabilities

- **Preconditions**: The app is running with two registered projects, A and B,
  and an Agent session available in each. The fixtures use only
  `~/.agents/skills`, `~/.agents/servers`, `~/.agents/subagents`, and the two
  projects' `.agents` directories; no `.pi` capability directory exists.
- **Steps**:
  1. Open Settings > Agent and verify Skills, MCP, and Subagents are three
     independent navigation destinations. Open Extensions and verify that only
     Installed and Marketplace tabs are present.
  2. Open Skills. Confirm one toolbar sits above one panel, the panel shows a
     global group header rooted at `~/.agents/skills` and a project group header
     rooted at project A's `.agents/skills`, both flow in one column at natural
     page height, and the project picker changes the selected project. Confirm
     the Skills toolbar has the same single primary action shape as MCP, with
     the concise New label; the level-specific Import action is available in
     each Skills group header.
     On first paint confirm skeleton rows appear; on a later refresh confirm
     the rows already on screen stay and the list dims instead.
  3. Exercise the level filter and the search field. Confirm All / Global /
     Project carry counts that agree with the rendered rows, that selecting a
     level hides the other group without hiding the toolbar or its actions, that
     search narrows both groups and its counts, that clearing the search
     restores every row, and that a search with no matches reports it and
     suggests widening the filter.
  4. Toggle a global skill off while project A is selected. Confirm the switch
     flips immediately without the list reverting to skeletons, the row is
     dimmed, a toast names the skill, every other row stays interactive while
     the request is in flight, and the global document remains unchanged. Switch
     to project B and confirm the global skill remains enabled there. Force a
     host rejection and confirm the switch returns to its previous position.
  5. Create a skill from the page. With the filter on Global confirm the primary
     action names the global destination and the new document lands in
     `~/.agents/skills`; with the filter on Project confirm it names the project
     and lands in project A. With Project selected and no project chosen,
     confirm the attempt reports it instead of failing silently. Edit the new
     skill, save, and confirm the body round-trips.
  6. From a project skill's overflow menu choose Reveal and confirm the project
     file is revealed, not a global file of the same id. Choose Remove and
     confirm the first press only arms and relabels the item, the second press
     deletes, and dismissing the menu disarms it.
  7. Put a same-name project skill in A and disable it. Confirm the effective
     runtime catalog does not fall back to the global skill; the project record
     shadows first and filtering happens second.
  8. Use the Import action to choose exactly one Markdown file. Confirm it is
     physically copied to the level the filter points at, appears immediately,
     and a second file cannot be selected in the same picker invocation.
  9. Open MCP. Add a project server and a global server, edit the project server,
     and test an existing connection from the row's overflow menu. Confirm the
     modal locks the id while editing, rejects a same-level duplicate id or
     label, and reports ready or failed through the row badge and a toast.
     Delete a server through the same two-press menu action and confirm its file
     is gone.
  10. Delete a skill or MCP file outside the app, reload its page, and confirm the
      row disappears and its local state has no orphaned entry. Confirm deleting
      a global file also removes its project overrides.
  11. Open Subagents. Confirm it is one global-only panel rooted at
      `~/.agents/subagents`, with no level filter, no project picker, and no
      project-level controls. Confirm the group header carries the global level
      label and item count, that create/edit/delete/reveal all work from the
      page, that leaving the turn limit empty writes a definition with no
      `maxTurns`, and that an empty directory resolves
      `settings.subagentsEmpty` to localized empty-state copy rather than
      displaying a raw translation key.
  12. Narrow the window to the toolbar's stacking breakpoint. Confirm the
      segmented control spans the width, search moves below it, actions wrap
      left-aligned, group headers drop the resolved path, and the page gains no
      horizontal overflow. With a pointer that cannot hover, confirm the row's
      edit and overflow controls are visible without hovering.
- **Expected**:
  - The three Settings pages use no tabs for switching capabilities, flow at
    natural page height for empty and populated states, support dark and light
    themes, and begin with quiet page-specific descriptions plus
    project-over-global scope copy where relevant. Each page is one toolbar
    above one panel: the toolbar carries the level filter with live counts, one
    search field with a clear affordance, the project picker, and the primary
    actions; the panel divides levels with group headers naming the level, its
    resolved `.agents` path, and a localized count. Rows use quiet capability
    icons, a level badge plus localized source/transport badges, descriptions,
    and persistent enablement switches; edit and the overflow menu stay quiet
    until the row is hovered, focused, or has its menu open, and are always
    visible where hover is unavailable. Skeleton rows appear on first paint
    only, later refreshes dim the rows already on screen and announce the
    refresh, busy state is confined to the row with the in-flight request, and
    counts are exposed to assistive technology. Empty states stay centered
    inside the panel without a decorative frame and offer the page's primary
    action, and no capability-specific color system is introduced.
  - Create, edit, and delete are available for all three capabilities without
    leaving Settings. New capabilities land at the level the filter points at,
    destructive actions require two presses of the same relabelled menu item,
    and revealing a project-level skill opens that project's file rather than a
    global file sharing its id.
  - Capability files contain configuration/frontmatter only; enablement is
    persisted in the app-local `agent-capabilities` state files.
  - Project records shadow global records by id or name even when disabled,
    and the next runtime activation reflects the same result as the UI.
  - Physical import is single-file and level-specific, and disk deletion is
    removed by scanning rather than represented as a pending row.
- **Specs linked**: `03-runtime/01-ipc-protocol.md` §12a–§12d,
  `03-runtime/02-agent-runtime.md` §5f, `04-ux/01-ui-ia.md` §3.5–§3.6,
  `04-ux/06-settings-ia.md` §2 (Agent capability destinations), §4.21–§4.25,
  `07-plugins/01-plugin-system.md` §12.2–§12.3,
  `08-meta/decisions-log.md` (D193, D194, D202, D257), ADR 0112, ADR 0126
- **Acceptance**: D (workspace), E (tools & permissions), F (persistence),
  Quality
- **Milestone**: M6+
- **Status**: Source/unit covered by
  `apps/desktop/test/agent-capability-settings.test.mjs`,
  `apps/desktop/test/extensions-page.test.mjs`, and host-core capability tests;
  full native-picker, rendered modal, project-switch, and runtime journey remain
  Draft (do not run E2E locally unless explicitly requested)

#### E2E-120: Global plugin launch, next-turn editing, and stopped throughput

- **Preconditions**: Install and enable a panel plugin whose Chinese display
  name is `无限画布`, plus a second panel plugin (for example `邮件助手`).
  Configure a provider that streams slowly enough to stop a partial answer. Run
  once on macOS and once on Windows.
- **Steps**:
  1. Immediately after PI-Desktop finishes booting, leave it unfocused and press
     Option+Space on macOS or Alt+Space on Windows while another application
     owns the foreground window. Confirm the first invocation promptly reveals
     a fully rendered, centered launcher on the pointer's display without a
     blank initialization frame, native close, minimize, maximize, resize, or
     taskbar controls. Confirm Windows does not show the active application's
     system menu.
  2. Search separately for `无限`, `wuxianhuabu`, and `wxhb`. Use Up/Down and
     Enter for one run and click for another; confirm the existing plugin panel
     opens. Confirm Chinese IME candidate Enter does not open a result.
  3. Open the launcher again with an empty query and confirm the plugin opened
     in step 2 is the first result. Open the other panel plugin, then reopen
     the launcher and confirm the two plugins appear in reverse opening order.
     Restart the application and confirm the same most-recently-used order
     survives the restart.
  4. Start an Agent answer. While it streams, type the next draft and change
     Thinking, permission mode, and Agent/Plan/Goal. Confirm every selection is
     editable, Stop remains present, and Send cannot dispatch.
  5. Stop after partial output. Confirm the partial answer remains, the queued
     configuration becomes durable only after termination, and the next turn
     uses the final selection rather than any intermediate selection.
  6. Inspect the stopped answer's conversation statistics, reload the session,
     and inspect again.
- **Expected**:
  - Early warm-up starts before backend boot completes and removes BrowserWindow
    and renderer loading from the first shortcut's visible path. On macOS the
    panel is activated once without a second app/window-stack hop, so the reveal
    does not visibly stutter. Launcher search returns only enabled, ready panel
    plugins and every invocation starts with an empty, focused query ordered by
    most-recently-used history across restarts; typing a query still ranks
    relevance first. Escape and focus loss hide it without closing the main
    application.
  - No running turn observes the staged mode/model/thinking/permission change,
    and a second prompt cannot be sent concurrently.
  - Changing Thinking during a stream keeps the selected model's enabled levels
    visible. The submenu never collapses to Off-only, including for unpinned
    sessions that inherit the app default model.
  - Stopped throughput is present before and after reload. It uses exact output
    usage when the provider supplied it; otherwise the UI labels the persisted
    four-code-point estimate as approximate.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `03-runtime/02-agent-runtime.md` §5b/§9,
  `04-ux/07-ui-design-system.md` §8.2–8.3,
  `04-ux/08-component-spec.md` §11,
  `04-ux/09-interaction-patterns.md` §1/§3, D211, D212, D219, ADR 0072,
  ADR 0073
- **Acceptance**: C (conversation & stream), F (persistence), G (plugins),
  Quality
- **Milestone**: M6
- **Status**: Unit/source-contract covered; full cross-platform UI journey Draft
  (do not run E2E locally unless explicitly requested)

#### E2E-121: Goal approval resumes autonomous acceptance-criteria execution

- **Preconditions**: A project-bound session has a configured provider and is
  idle in Agent mode; the workspace permits host artifact creation and has no
  prior test goal artifact.
- **Steps**: 1) Switch the session to Goal and let the Agent call
  `EnterGoalMode`, then `SubmitGoal(title, markdown, question)`. 2) Inspect the
  exact Markdown bytes in the new `.pi/goal/*.md` artifact and the matching
  `plan_approvals` row. 3) Confirm the shared approval card exposes only
  Approve/Reject and that Goal denies Write/Edit/plugin tools while Bash follows
  the selected permission mode. 4) Approve with Ask and observe the same Agent
  resume in Agent mode. 5) Inspect the final response for criterion-by-criterion
  verification or an explicit boundary, then reload the session.
- **Expected**: Goal uses the Plan approval pipeline without a second planner;
  the artifact is immutable and the row records `kind = goal`, path, hash,
  size, and execution state. Approval is a separate user decision, transitions
  the session to Agent, and starts autonomous work only after approval. The
  transcript remains reviewable after reload and no scheduled/unattended Goal
  run can bypass the approval boundary.
- **Specs linked**: `03-runtime/02-agent-runtime.md`,
  `03-runtime/03-tools-and-permissions.md`, `03-runtime/04-data-storage.md`,
  `03-runtime/06-host-rpc-protocol.md`, `03-runtime/10-session-state-machine.md`,
  `04-ux/01-ui-ia.md`, `04-ux/08-component-spec.md`, D198
- **Acceptance**: C (conversation & stream), E (tools & permissions),
  F (persistence), H (diagnostics), Security
- **Milestone**: M6+
- **Status**: Unit/source-contract covered (`packages/agent-runtime` and
  host-core Goal tests); full UI journey Draft (do not run E2E locally unless
  explicitly requested)

#### E2E-122: Plugins request and deliver native notifications

- **Preconditions**: An installed plugin declares and is granted `notify`; the
  desktop platform supports Electron native notifications; the OS notification
  permission is in its initial or previously denied state.
- **Steps**: 1) From the plugin process, call
  `getNotificationPermission()`. 2) Call `requestNotificationPermission()` and
  observe the native permission/probe result. 3) Call
  `showNativeNotification({ title, body })`. 4) Repeat with a plugin that lacks
  `notify`, and on a platform where native notifications are unsupported.
- **Expected**: The first status is `unknown`, `denied`, or `unsupported`; the request
  returns a best-effort `granted`, `denied`, or `unsupported` result; a granted
  plugin receives `{ shown: true, permission: "granted" }` for native delivery,
  while denied/unsupported delivery returns `shown: false` without crashing the
  plugin. Missing `notify` fails with `PERMISSION_DENIED`. Native plugin
  notifications do not add durable task inbox rows or activate a chat session.
- **Specs linked**: `07-plugins/01-plugin-system.md`,
  `07-plugins/03-plugin-api.md`, `07-plugins/13-plugin-permissions-matrix.md`,
  ADR 0074
- **Acceptance**: E (tools & permissions), G (plugins), Security, Quality
- **Milestone**: M6+
- **Status**: Unit/source-contract covered; full cross-platform OS permission
  journey Draft (do not run E2E locally unless explicitly requested)

#### E2E-148: Plugin settings and local shortcuts are editable

- **Preconditions**: An enabled plugin declares string, boolean, JSON, and
  `shortcut` settings; the shortcut points to a declared plugin command.
- **Steps**: 1) Open Plugins and open the plugin settings surface. 2) Change a
  normal field and the shortcut, then save. 3) Reload the plugin list and press
  the new shortcut while the app window is focused. 4) Try a reserved app
  shortcut and repeat with the plugin scoped away from the current project.
- **Expected**: Controls are generated from the manifest, values persist in the
  plugin-private settings file, and `plugin:settingsChanged` is delivered. The
  new shortcut invokes the plugin command only in the focused app window and
  matching activation scope. Reserved/conflicting bindings are rejected; no OS
  global shortcut is registered.
- **Specs linked**: `07-plugins/02-plugin-manifest-schema.md`,
  `07-plugins/03-plugin-api.md`, `07-plugins/11-plugin-storage-isolation.md`,
  ADR 0159
- **Acceptance**: F (persistence), G (plugins), Security, Quality
- **Milestone**: M6+
- **Status**: Source-contract and focused integration coverage; full desktop
  journey Draft (do not run E2E locally unless explicitly requested)

#### E2E-151: Multiple vendor accounts stay isolated through login, use, and removal

- **Preconditions**: A build with `registerBunOAuthFlows()` running at startup
  and a real subscription for at least one PKCE vendor (Anthropic) and one
  device-code vendor (xAI or GitHub Copilot). No provider row exists yet for
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
  account. 5) Resolve
  and use each account separately, including model discovery and one streamed
  turn per account. 6) Start the device-code login on a second vendor, then
  press Cancel while the dialog is polling; confirm no row or credential is
  left. 7) Remove the first Anthropic account, then confirm its provider row
  and OAuth secret are gone while the second Anthropic account remains usable.
  8) If the removed account was default, confirm Defaults points to another
  ready provider or shows no default. 9) Grep sidecar and renderer logs for
  token material.
- **Expected**: Each successful login creates a distinct row with
  `authKind: "oauth"`, `hasSecret` and `hasOauth` both true, a non-secret
  account label, and `baseUrl`/`apiStyle`/`defaultModelId` filled from that
  account's own catalog. Each row has its own
  `secret:provider:<providerId>:oauth` ref and row-scoped pi-ai collection;
  resolving one account never returns the other account's token. The model list
  is the authenticated catalog (a Copilot account lists only what its
  subscription includes), not a `/models` probe. Matching models.dev metadata
  supplies each newly logged-in binding's limits, modalities, and thinking
  levels; an ID missing from models.dev uses the conservative generic
  text-only/non-reasoning shape. The account editor updates only non-secret
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
  needs live vendor accounts (do not run E2E locally unless explicitly
  requested)

#### E2E-152: A plugin contributes a work panel view

- **Preconditions**: A development plugin declaring `ui.view` and one
  `contributes.views` entry whose `entry` is a small HTML page calling
  `window.pluginBridge.invoke("ui.showToast", …)`. Two projects open, with the
  plugin's activation scope limited to the first.
- **Steps**:
  1. Load the plugin as a development plugin. Confirm the Plugins page shows a
     work-panel-views capability badge.
  2. Press `Cmd/Ctrl + J` to reveal the work panel and open the header menu.
     Confirm a "Plugin views" group appears between the built-in tools and the
     open-resources group, with the view's localized title and its icon (or a
     lettered tile if the manifest names an unknown token).
  3. Activate the row. Confirm the plugin's page renders inside the panel body
     with no window-control capsule and no reserved 46px band, and that its
     button reaches the host toast.
  4. Drag the inner panel divider and resize the conversation area. Confirm
     the page tracks the panel rect without lag or tearing, then drag the outer
     right window edge and confirm the panel width changes while the base chat
     width stays fixed.
  5. Open global search, then Settings. Confirm the page is hidden while each
     overlay is up and returns when it closes.
  6. Re-pick the same view from the menu. Confirm it returns to the live page —
     same scroll position, no reload — rather than stacking a second tab.
  7. Switch to the second project. Confirm the view disappears from the menu and
     from the empty-panel entry list.
  8. Switch back, reopen the view, then disable the plugin. Confirm the tab
     closes and the view's renderer process exits (Activity Monitor / Task
     Manager).
  9. Re-enable, reopen, then edit the plugin's HTML on disk to trigger a
     development reload. Confirm the view reloads rather than going blank.
- **Expected**: A plugin view is reachable, isolated, correctly positioned, and
  bounded by the plugin's lifecycle and activation scope. The panel remains an
  in-flow internal column; its renderer-owned divider resizes the panel and
  native window edges never change that target. It never renders while a
  blocking overlay is open, and it never obtains window controls.
- **Specs linked**: `07-plugins/02-plugin-manifest-schema.md` §4/§5,
  `07-plugins/13-plugin-permissions-matrix.md` §2,
  `04-ux/08-component-spec.md` §5, ADR 0104, ADR 0092
- **Acceptance**: G (plugins), Security, Quality
- **Milestone**: M6+
- **Status**: Unit coverage in
  `apps/desktop/test/plugin-work-panel-views.test.mjs` (addressing, menu
  grouping, isolation parity, scope filtering, lifecycle teardown),
  `packages/plugin-sdk` and host-core manifest validation; the desktop journey
  is Draft (do not run E2E locally unless explicitly requested)

#### E2E-153: The bundled Files plugin replaces the built-in Files tool

- **Preconditions**: A packaged build (so `resources/plugins` is copied outside
  the asar) and a project with nested directories, a `node_modules`, a `.env`,
  and a binary file.
- **Steps**:
  1. Open the Plugins page. Confirm **Files** is listed with source "builtin",
     enabled, showing a work-panel-views capability, and that it offers no
     Uninstall action.
  2. Reveal the work panel and open the header menu. Confirm the Tools group
     lists only Terminal and Browser, and that Files appears under
     Plugin views. Trigger an agent edit and confirm Review opens itself under
     Open resources — it is an artifact surface, not a launcher entry.
  3. Open the Files view. Confirm the tree lists the project, expands
     directories lazily, and omits `node_modules`, `.git`, and `.env`.
  4. Confirm the toolbar shows the project name and Refresh action. Trigger
     Refresh and confirm the button locks with a restrained spinner until the
     root and expanded folders finish loading. Expand a directory with the mouse
     and keyboard; confirm rows expose expanded state, folders appear before
     files, and a failed directory offers an inline Retry.
  5. Click a text file. Confirm the focused viewer shows Back, the relative path,
     file size, line numbers, bounded text, and **Show in folder**. Click that
     action and confirm the file manager opens with the selected file revealed.
     Click the binary file and confirm it reports as binary rather than printing
     replacement characters; the same action still reveals it in the file
     manager. Switch the app to Simplified Chinese and confirm the Files toolbar,
     empty/loading/error, viewer, and reveal-action states are localized.
  6. Click a file path in the conversation. Confirm it still opens a host
     `file:<path>` tab under Open resources — transcript artifacts did not move
     to the plugin.
  7. Disable the Files plugin. Confirm the view disappears from the menu and the
     panel, and that transcript file links still work.
  8. Re-enable it, then restart the app. Confirm the enabled state and the tree
     return, and that the registry did not gain a duplicate row.
- **Expected**: A first-party panel surface runs entirely on the public plugin
  contribution channel, is user-disableable, cannot be uninstalled, and survives
  restart. Its file access obeys the declared `fs.read` scope and the standard
  deny-lists.
- **Specs linked**: `07-plugins/03-plugin-api.md` §3,
  `07-plugins/13-plugin-permissions-matrix.md` §2,
  `04-ux/08-component-spec.md` §5, ADR 0104, ADR 0105, ADR 0109, ADR 0111
- **Acceptance**: G (plugins), D (workspace), Security, Quality
- **Milestone**: M6+
- **Status**: Unit coverage in `apps/desktop/test/bundled-plugins.test.mjs`,
  `apps/desktop/test/plugin-fs-scope.test.mjs` (`fs.list`, `fs.openDefault`, and `fs.reveal` guards), and host-core
  `bundled_plugins_refresh_from_disk_but_keep_user_state`; the packaged journey
  is Draft (do not run E2E locally unless explicitly requested)

#### E2E-154: Model additions use models.dev metadata and generic unknown IDs

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
     and inspect its generic fallback card.
- **Expected**: models.dev fields prefill known model bindings and remain the
  sole metadata source. Provider keys are never included in the fixed
  models.dev request. Provider discovery remains available only to supply
  custom/account-specific IDs; those IDs receive the generic text-only,
  non-reasoning defaults. pi-ai supplies the selected transport and OAuth/account
  availability, not model metadata.
- **Specs linked**: `03-runtime/11-provider-model-system.md` §6.2,
  `03-runtime/13-model-catalog-and-selection.md` §11.1–§12, ADR 0134
- **Acceptance**: B (model config), C (conversation & stream), Security
- **Milestone**: M6+
- **Status**: Unit/source-contract covered; full provider-dialog journey Draft
  (do not run E2E locally unless explicitly requested)

## 8. Traceability Matrix





| Acceptance | Scenarios |
|---|---|
| A — App startup | E2E-001, E2E-002, E2E-003, E2E-004, E2E-067, E2E-076, E2E-079, E2E-092, E2E-097, E2E-143, E2E-150, E2E-168 |
| B — Model config | E2E-005, E2E-006, E2E-007, E2E-038, E2E-050, E2E-052, E2E-055, E2E-066, E2E-080, E2E-082, E2E-102c, E2E-102d, E2E-102e, E2E-151, E2E-154, E2E-163, E2E-166, E2E-172, E2E-174 |
| C — Conversation & stream | E2E-008, E2E-008a, E2E-009, E2E-010, E2E-011, E2E-011a, E2E-011b, E2E-011d, E2E-011e, E2E-011g, E2E-031, E2E-040, E2E-047, E2E-048, E2E-048A, E2E-049, E2E-052, E2E-053, E2E-054, E2E-055, E2E-059, E2E-059a, E2E-060c, E2E-060d, E2E-061, E2E-061a, E2E-062, E2E-064, E2E-065, E2E-068, E2E-071, E2E-073, E2E-074, E2E-075, E2E-081, E2E-083, E2E-084, E2E-086, E2E-087, E2E-088, E2E-088b, E2E-089, E2E-090, E2E-094, E2E-095, E2E-096, E2E-097, E2E-098, E2E-099, E2E-102, E2E-102a, E2E-102b, E2E-102c, E2E-102d, E2E-102g, E2E-106, E2E-109, E2E-111, E2E-114, E2E-116, E2E-117, E2E-118, E2E-119, E2E-120, E2E-121, E2E-AGENTS-001, E2E-142, E2E-144, E2E-145, E2E-146, E2E-147, E2E-151, E2E-154, E2E-155, E2E-158, E2E-159, E2E-161, E2E-162, E2E-166, E2E-172, E2E-173, E2E-174, E2E-177, E2E-178, E2E-179, E2E-180, E2E-182 |
| D — Workspace | E2E-012, E2E-013, E2E-022B, E2E-024I, E2E-047, E2E-049, E2E-057, E2E-058, E2E-060, E2E-068, E2E-075, E2E-078, E2E-153, E2E-158, E2E-182 |
| E — Tools & permissions | E2E-008a, E2E-014, E2E-015, E2E-016, E2E-017, E2E-018, E2E-019, E2E-024I, E2E-024K, E2E-040, E2E-049, E2E-074, E2E-093, E2E-097, E2E-099, E2E-100, E2E-101, E2E-102, E2E-102d, E2E-102e, E2E-102g, E2E-103, E2E-105, E2E-106, E2E-107, E2E-111, E2E-112, E2E-113, E2E-114, E2E-115, E2E-116, E2E-119, E2E-121, E2E-122, E2E-142, E2E-145, E2E-147, E2E-155, E2E-158, E2E-166, E2E-181 |
| F — Persistence | E2E-020, E2E-021, E2E-021a, E2E-036, E2E-037, E2E-038, E2E-040, E2E-042, E2E-047, E2E-048, E2E-051, E2E-054, E2E-056, E2E-061, E2E-062, E2E-064, E2E-066, E2E-068, E2E-071, E2E-072, E2E-073, E2E-082, E2E-084, E2E-096, E2E-098, E2E-102, E2E-102b, E2E-102c, E2E-102d, E2E-102g, E2E-103, E2E-AGENTS-001, E2E-061a, E2E-073a, E2E-104, E2E-106, E2E-107, E2E-108, E2E-109, E2E-110, E2E-112, E2E-118, E2E-119, E2E-120, E2E-121, E2E-123, E2E-142, E2E-146, E2E-148, E2E-151, E2E-158, E2E-160, E2E-168, E2E-171, E2E-177, E2E-178 |
| G — Plugins | E2E-022, E2E-022A, E2E-022B, E2E-022C, E2E-023, E2E-024, E2E-024B, E2E-024C, E2E-024D, E2E-024E, E2E-024W, E2E-024F, E2E-024G, E2E-024H, E2E-024I, E2E-024J, E2E-024K, E2E-024L, E2E-024M, E2E-024N, E2E-024O, E2E-024P, E2E-025, E2E-026, E2E-105, E2E-117, E2E-120, E2E-122, E2E-123, E2E-024Q, E2E-148, E2E-152, E2E-153 |
| H — Diagnostics | E2E-027, E2E-031, E2E-034, E2E-042, E2E-096, E2E-098, E2E-104, E2E-107, E2E-108, E2E-109, E2E-110, E2E-113, E2E-115, E2E-116, E2E-118, E2E-121, E2E-146, E2E-155, E2E-159, E2E-176 |
| Security | E2E-028, E2E-029, E2E-030, E2E-024J, E2E-024K, E2E-024M, E2E-049, E2E-068, E2E-086, E2E-102c, E2E-102d, E2E-102e, E2E-105, E2E-106, E2E-107, E2E-108, E2E-109, E2E-110, E2E-112, E2E-113, E2E-115, E2E-116, E2E-117, E2E-119, E2E-121, E2E-122, E2E-123, E2E-142, E2E-148, E2E-151, E2E-153, E2E-158 |
| Quality | E2E-032, E2E-033, E2E-039, E2E-043, E2E-044, E2E-045, E2E-046, E2E-047, E2E-048, E2E-048A, E2E-049, E2E-050, E2E-053, E2E-055, E2E-056, E2E-057, E2E-058, E2E-059, E2E-060, E2E-061, E2E-062, E2E-063, E2E-064, E2E-065, E2E-066, E2E-067, E2E-068, E2E-069, E2E-070, E2E-071, E2E-072, E2E-073, E2E-074, E2E-075, E2E-076, E2E-077, E2E-078, E2E-079, E2E-080, E2E-081, E2E-082, E2E-083, E2E-084, E2E-085, E2E-086, E2E-092, E2E-093, E2E-094, E2E-095, E2E-096, E2E-097, E2E-098, E2E-099, E2E-100, E2E-101, E2E-102, E2E-102a, E2E-102b, E2E-102c, E2E-102d, E2E-102e, E2E-103, E2E-AGENTS-001, E2E-021a, E2E-024N, E2E-024O, E2E-059a, E2E-060b, E2E-060c, E2E-060d, E2E-061a, E2E-073a, E2E-111, E2E-114, E2E-117, E2E-118, E2E-119, E2E-120, E2E-122, E2E-123, E2E-142, E2E-143, E2E-144, E2E-145, E2E-146, E2E-147, E2E-148, E2E-150, E2E-151, E2E-153, E2E-155, E2E-158, E2E-159, E2E-160, E2E-161, E2E-162, E2E-163, E2E-168, E2E-172, E2E-173, E2E-174, E2E-011g, E2E-176, E2E-177, E2E-178, E2E-179, E2E-180, E2E-181, E2E-182 |

| Milestone | Scenarios |
|---|---|
| M1 | E2E-001, E2E-002, E2E-003, E2E-028, E2E-029 |
| M2 | E2E-004, E2E-005, E2E-006, E2E-007, E2E-008, E2E-009, E2E-010, E2E-011, E2E-011a, E2E-011b, E2E-011d, E2E-011e, E2E-011g, E2E-020, E2E-021, E2E-021a, E2E-027, E2E-031, E2E-036, E2E-037, E2E-042, E2E-087, E2E-088, E2E-088b, E2E-089, E2E-090, E2E-144 |
| M3 | E2E-012, E2E-013, E2E-014, E2E-015, E2E-016, E2E-017, E2E-018, E2E-019, E2E-040 |
| M4 | E2E-022, E2E-023, E2E-024, E2E-025, E2E-026, E2E-030, E2E-038 |
| M5 | E2E-008a, E2E-032, E2E-033, E2E-034, E2E-039, E2E-043, E2E-044, E2E-045, E2E-046, E2E-047, E2E-048, E2E-048A, E2E-049, E2E-050, E2E-051, E2E-052, E2E-053, E2E-054, E2E-055, E2E-056, E2E-057, E2E-058, E2E-059, E2E-060, E2E-061, E2E-062, E2E-063, E2E-064, E2E-065, E2E-066, E2E-067, E2E-068, E2E-069, E2E-070, E2E-071, E2E-072, E2E-073, E2E-074, E2E-075, E2E-076, E2E-077, E2E-078, E2E-079, E2E-080, E2E-081, E2E-082, E2E-083, E2E-084, E2E-085, E2E-086, E2E-092, E2E-093, E2E-096, E2E-097, E2E-098, E2E-099, E2E-100, E2E-101, E2E-102, E2E-102a, E2E-102b, E2E-102c, E2E-102d, E2E-102e, E2E-AGENTS-001, E2E-059a, E2E-060b, E2E-060c, E2E-061a, E2E-073a, E2E-094, E2E-095, E2E-143, E2E-145, E2E-146, E2E-147, E2E-177, E2E-178, E2E-180, E2E-181, E2E-182 |
| M6 | E2E-104, E2E-105, E2E-106, E2E-107, E2E-108, E2E-109, E2E-110, E2E-111, E2E-112, E2E-113, E2E-114, E2E-115, E2E-116, E2E-117, E2E-118, E2E-119, E2E-120, E2E-103, E2E-172 |
| M6+ | E2E-121, E2E-122, E2E-148, E2E-150, E2E-151, E2E-154, E2E-155, E2E-158, E2E-159, E2E-160, E2E-161, E2E-162, E2E-163, E2E-166, E2E-168, E2E-173, E2E-174, E2E-176, E2E-179 |
| Post-MVP | E2E-022A, E2E-022B, E2E-022C, E2E-024I, E2E-024J, E2E-024K, E2E-024L, E2E-024M (plugin roadmap R2/R3/R6) |

The `US-UI-*` visual scenarios (§UI shell visual scenarios) trace to the
Codex parity decisions in [decisions-log §D](../08-meta/decisions-log.md)
rather than the A–H criteria; their gold source is the capture suite.

---

## 9. How AI Must Update This Doc

When adding or changing a feature that affects user-visible or protocol-visible behavior:

1. **Add a new scenario** using the template in §6. Assign the next available ID (`E2E-<N>`).
2. **Link it** to the relevant acceptance criterion (A–H) and milestone (M1–M6
   or M6+ for the current product increment).
3. **Set status** to `Draft` unless an automated test already exists.
4. **Update the traceability matrix** in §8.
5. **Commit** the update as part of the change (per [ai-development-workflow](03-ai-development-workflow.md) R3).

---

## 10. Future Automation Mapping

When E2E automation is implemented (post-M5):

- Each `Draft` scenario → Playwright test file.
- Scenario ID becomes test case name: `e2e-001-app-launches`.
- Fixtures and test data paths defined in a `tests/e2e/fixtures/` directory.
- CI gate: all E2E scenarios must pass before release.

Automation section will be expanded in a future ADR when the tooling decision is finalized.

---

## 11. Acceptance Criteria

This test plan spec is accepted when:

- [ ] All MVP acceptance criteria (A–H) have at least one E2E scenario.
- [ ] All security acceptance items have at least one E2E scenario.
- [ ] Every scenario links to at least one spec document.
- [ ] Traceability matrix is complete (scenarios ↔ acceptance ↔ milestones).
- [ ] Scenario template is defined and all entries follow it.
- [ ] AI update rules are documented and cross-linked to workflow spec.
- [ ] Environment requirements match baseline (native macOS arm64/Intel x64,
  clean profile).

## UI shell visual scenarios

### US-UI-01 Codex-aligned shell chrome
- Open the desktop app on macOS dark theme.
- Expect charcoal main surface (`#181818`), left sidebar with current-project
  and Temporary session groups, and a floating bottom composer
  with mode/model controls and no workspace rail.
- Expect no blue-slate marketing chrome; primary send control is a circular inverted button.

### US-UI-02 Empty thread hero
- Open or create a thread with zero messages.
- Expect the centered hero copy "What can I help you build?", a short muted
  supporting line, with no developer starter cards. The optional project name
  remains a dotted-underline action when a workspace is open.

### US-UI-03 Sidebar destinations
- Expect the expanded home sidebar to show Sessions and Projects without
  standalone Plugins, Pull requests, or Scheduled rows.
- Click the plug-shaped Plugins icon in the sidebar footer, immediately to the
  right of Settings, and expect it to replace the main pane with a dedicated
  page.
- Open Settings → Project archive and use it to open, switch, and close a local
  folder workspace.

### US-UI-04 Composer without workspace context
- With a git workspace open, composer does not show project, Local, or branch
  labels above the prompt surface.
- Operating-mode selector switches between Agent, Plan, and Goal; both contract
  modes keep the permission-mode chip and explain their Bash tradeoff.

### US-UI-05 Locale chrome
- On a zh-CN system locale, sidebar labels render in Chinese (项目 / 临时会话),
  without 拉取请求 or 已安排 entries. The footer plug-shaped Plugins icon
  exposes the localized accessible name 插件.
- Empty-thread hero and supporting line are localized Chinese copy; project
  name remains a dotted-underline action when a workspace is open.
- Composer omits the 本地 workspace label and shows Agent/Plan/Goal plus the
  active model ID; both locales expose the Plan and Goal approval copy.

### US-UI-06 Session auto-title
- Create a new task and send a first prompt such as "同步代码".
- Expect its project or temporary session row title to become a truncated form
  of that prompt instead of remaining "New task".
- Rename a task from its session menu, then send a first prompt if it was still
  using a default title. Expect the custom label to remain unchanged while the
  default-title task receives the normal first-prompt title.

### US-UI-08 Shortcut-only destination history
- Navigate Settings → Project archive → a project session → Plugins.
- Expect no back/forward buttons in the expanded sidebar or main titlebar.
- Press `Cmd/Ctrl+[` and `Cmd/Ctrl+]`; expect them to traverse that history.

### US-UI-09 Grouped session title backfill
- Open an older session that previously showed "New task"/"New chat" but has a first user message.
- Expect its scoped sidebar row to display a truncated first-user-message title
  after session list load.

### US-UI-11 Empty draft reuse
- Click New task twice.
- Expect only one empty "New task" draft in the current project or Temporary
  group and the home hero remains visible. Empty drafts in another scope are
  not reused.

### US-UI-12 Composer without workspace rail
- On empty home, project home, and in a thread, expect no project / Local /
  branch context rail above the composer.
- The prompt shell remains one uninterrupted rounded surface with no reserved
  rail height, attached top lip, rail shadow, bottom seam, or separators.

### US-UI-13 Light theme shell parity
- Set theme to system/light on a light macOS appearance.
- Expect sidebar `#f3f3f3`, main `#ffffff`, text `#1a1c1f`, white floating composer, and home hero with project underline.
- Sidebar project/session labels, footer Settings/Plugins/notification
  icons, current-project identity, thread titles, and composer controls must remain
  readable dark-on-light (≥4.5:1). Never white/translucent text on the light
  sidebar.
- The macOS traffic-light row keeps Search and Collapse sidebar readable at the
  right on light chrome without rendering the Logo/Home brand.

### US-UI-14 Semantic chrome tokens
- Toggle theme system → light → dark without restart.
- Shell chrome (sidebar items, composer runtime controls, icon buttons)
  follows semantic `--ds-text-*` / `--ds-bg-*` tokens in both themes; no
  hard-coded white (`gray-0`) text on light surfaces.

### US-UI-15 Codex density + elevation
- Sidebar rows use a compact ~28–32px pitch with the 12–14px hierarchy from
  US-UI-69 and 8px horizontal padding (Codex `radius-token-row` 10px).
- Floating composer uses Codex elevation-prominent: 0.5px stroke + soft 3px/20px shadow (not heavy 10–30px drop).
- Empty hero title is 28px / 34px line-height, weight 400.
- Window restores ≥1000×700 (target 1200×800) if Stage Manager collapses it.

### US-UI-16 Sidebar footer utility layout
- On the light/dark home shell, the sidebar footer is a transparent utility
  band with no separator. Settings, Plugins, and notification actions
  are grouped on the left, while the build/version chip is right-aligned.
- The notification Bell remains visible in the left action group with its
  unread badge and opens the inbox above the footer; the main titlebar has no
  duplicate Bell.
- Clicking the build/version chip checks for updates when current, or opens
  Settings → Info when an actionable update is available.
- Traffic lights sit at Codex `{x:16,y:16}` with a 46px toolbar; the expanded
  macOS sidebar places Search plus Collapse sidebar at the right in that same
  row, with no Logo/Home brand or back/forward buttons.

### US-UI-17 PI-Desktop home hero logo
- On empty chat home, the 100px `HomeMascotLogo` GIF renders above the title
  as an eight-frame waving mascot with a short idle hold. Light and dark
  themes each use a dedicated GIF and still PNG.
- Pointer hover does not change the cadence or geometry; reduced motion shows
  the matching still first frame. The mascot remains decorative.
- Title is 28px / weight 400; active project name uses dotted underline (1px, offset 4px).
- Composer does not render attachment or appshot controls before their payload
  reaches pi end to end.

### US-UI-18 Composer has no inert actions
- On chat home and a docked thread, inspect every composer control.
- Expect no file, photo, or appshot controls while those payloads are
  unsupported by the pi runtime. Exact reasoning-capable models expose the
  current Thinking level immediately to the right of Agent / Plan / Goal; unsupported
  models show no trigger. Unknown compatible models can explicitly enable
  thinking from the model menu, and changes update the durable session.
- Expect no project, Local, or branch context labels in the composer.
- Every visible composer control changes the active session, opens its menu, or
  submits/aborts the current turn.



### US-UI-19 Permanent Stage Manager bounds restore
- On macOS with Stage Manager, shrink or unfocus the PI window until width < 1040 or height < 700.
- Expect the shell to re-assert a Codex-like footprint (~1200×800, min 1040×700) and keep restoring while still collapsed (not only during the first 20s after launch).

### US-UI-20 Dark floating composer box
- Switch to dark theme on chat home.
- Expect main `#181818`, sidebar `#000000`, and the floating composer plate at elevated-primary (`#212121f5` / gray-800 96%) with elevation-prominent stroke + soft lift so the box reads against the main surface.

### US-UI-21 Composer model menu configures pi
- Create a session with provider A/model A, then open the Composer-right model ×
  reasoning menu.
- Expect the top bar to show only the task title and window actions. The
  Composer-right model × reasoning chip shows provider A/model A and the current
  reasoning level. Its menu starts with only Model and Reasoning level entries;
  Model opens the searchable provider-group list and Reasoning level opens the
  capability-filtered radio list in the same popover.
- In the searchable provider-group list, expect each provider heading to
  read as the visual parent: its `--text-md` treatment is stronger than the
  indented model rows' normal-weight `--text-sm` treatment. In zh-CN, headings
  must not force uppercase or wide Latin tracking.
- Select provider B/model B, send a prompt, and expect the main-to-sidecar
  `agent.prompt` payload and pi runtime to use B for that session.
- Switch away and back; expect B and its clamped reasoning level to remain
  selected. Selecting a model or reasoning level returns to the root without
  closing the Composer menu; outside click and Escape close it. While a turn
  runs, expect the combined control to remain available only for next-turn
  configuration unless a pending approval gates it.

### US-UI-22 Profile footer menu
- On the sidebar footer, click the `Custom` / `Local profile` trigger.
- Expect a 280px opaque elevated menu 8px above the footer. It repeats the local
  identity in a non-interactive header, then shows a divider and Settings,
  Logs, and Theme actions in that order.
- Arrow keys wrap through the three actions; Home/End jump to the boundary.
  Escape closes the menu and restores trigger focus. An outside pointer press
  closes it without stealing target focus.
- Settings navigates to the settings page, Logs opens local logs, and Theme
  cycles the current theme after closing the menu.

### US-UI-23 Project archive index
- Open Settings → Project archive.
- Expect the Settings title "Project archive" plus the one-workbench
  composition (D168/D267): a quiet intro line carrying the page description
  only, with no hero block, gradient banner, or page-level counter run; one
  toolbar with a Recent / Name sort
  segmented control, a search field, its clear affordance, the live match count,
  and the primary "Add project"; and one panel whose sections run Pinned, All
  projects, Archived as in-panel header strips, each present strip showing its
  label and row count. With no project at all the panel shows one quiet
  empty state with its own primary action.
- Expect each row to carry a colored glyph, the project name with its Active /
  Open / pinned / Archived tags, one meta line with the shortened monospace
  path, branch, and session count, a relative last-active time, and the
  hover-revealed New task and row-menu actions. Ordinary rows use a Folder glyph;
  pinned rows use a filled Star glyph and retain the pinned text tag. Archived rows stay listed and
  softened rather than hidden.
- Expand a non-active project and open one of its sessions; expect the app to
  activate that project before selecting the session, so workspace tools and
  session scope use the same project.
- Switch the sort to Name and expect rows to reorder inside every section with
  no row hidden; clear the search and expect the complete index back.

### US-UI-24 Settings full-page shell
- Open Settings (footer profile → Settings).
- Expect **full-page** Codex settings (no app sidebar/nav). Left rail has Back
  to app, search, and exactly Basics / 全局 AI / Shortcuts / Model configuration /
  Import / Project archive / Info in that order; content pane shows section title and the
  destination's settings or archive content.
- Return to the app shell and expect Plugins to remain an independent
  sidebar-footer destination.
- Drag the empty 46px top band over either the rail or content pane; the native
  window moves while Back, search, and navigation remain clickable.

### US-UI-27 Dark destination pages
- Force dark theme and open Plugins and Settings → Project archive.
- Expect black sidebar, main `#181818`, and destination cards/rows readable on elevated dark plates (not flat same-gray).

### US-UI-28 Home empty composer association
- On empty chat home (light + dark), expect the hero, optional onboarding
  checklist, and home composer in one scrollable vertical flow (D111/D204/D206),
  without a large empty gap or starter-card layer.
- The composer remains a standalone plate without an attached workspace rail.
- Starting a transcript restores the bottom-docked composer with fade veil.

### US-UI-29 Light composer plate legibility
- On light theme empty home, the white composer shell uses one uniform solid
  fill with no internal gradient or background image.
- The shell still reads as an elevated box through a hairline stroke and
  restrained soft shadow against the `#ffffff` main surface.
- Toolbar controls and placeholder remain legible (not pure white-on-white).

### US-UI-30 Composer placeholder copy
- Empty home and session composers start with their localized welcome copy:
  `chat.placeholderHome` / `chat.placeholder`.
- The selected guidance stays unchanged until the page/session context changes;
  switching context advances to localized `/`/`@` command/file guidance and the
  keyboard hint `Shift+Enter for newline · Use Send to submit`, with an opacity fade.
- Waiting, focusing, editing, clearing, or composing does not change the copy.
- Placeholder ink is legible on light and dark floating plates.

### US-UI-31 Home empty vertical stack (D111/D204/D206)
- Given empty chat home, when the window is ~1200×690, the hero and optional
  onboarding checklist render in a centered scrollable content stack above a
  bottom-reserved home composer (not dual-grow absolute portal regions).
- No starter cards or absolute overlay are present; the onboarding checklist
  remains actionable and the composer is directly available.

### US-UI-32 Dark floating box elevation
- Given dark theme empty home, when the composer shell is painted, it uses elevated-primary `#212121` on `#181818` with elevation-prominent stroke+lift identical to light (no heavier custom dark shadow).

### US-UI-33 Scoped sidebar session groups
- The home sidebar has no Recents aggregate.
- It shows one independently collapsible header per retained project path with
  nested sessions and one `Temporary sessions` / `临时会话` header for
  path-less sessions.
- Project and Temporary headers expose compact scope-specific `+` controls;
  project/session overflow menus expose pin/archive actions; nav row pitch
  remains ~32px and session row pitch ~28–31px.

### US-UI-34 Home has no developer starter cards (D206)
- On empty chat home (light + dark), no developer starter grid, card, or
  contextual quick-action row renders between the hero and composer.
- Task entry starts directly in the bottom composer, while the optional
  onboarding checklist remains actionable when present.

### US-UI-35 Empty composer plate density
- Empty-home composer is compact and content-driven with an empty or one-line
  draft; it does not reserve the former fixed ~148px empty plate.

### US-UI-36 Hero Y + night box elevation
- At ~1200×690 light home, the hero forms one centered block; the home
  scroller does not clip its top or overlap the bottom composer, and no starter
  grid is rendered.
- Dark home composer plate reads as elevated-primary `#212121f5` with elevation-prominent against `#181818` (not flat same-surface).
- Light composer renders as one uninterrupted solid surface with no context
  rail or independent top elevation.
- Model chip shows the active model ID; its menu contains only runnable
  provider/model choices and Agent.
- Placeholder and approval chip remain legible on light and dark plates.

### US-UI-39 Home mark + hero title optical
- Empty-home PI-Desktop mark is visible (not near-invisible); stroke density remains readable without a decorative ghost effect.
- Empty-home title with a project uses a readable project label span (short basenames may display as `PI-Desktop` for optical parity).

### US-UI-40 Home content width vs rem root
- At 1200×690 light empty home, composer plate outer width is ~744–760px (not ~640px).
- Home suggestion grid spans the same content column as the composer plate.

### US-UI-41 Dark hero + night box readability
- Dark empty home hero title ink is light-on-dark (`--ds-text-primary` / near white), not hardcoded `#1a1c1f`.
- Night composer plate is elevated-primary `#212121f5` on main `#181818` with elevation-prominent; light theme is not forced to the night plate fill.

### US-UI-42 Light scoped session creation chrome
- On the light sidebar, the Sessions and Projects scoped create controls remain
  icon-only with semantic hover wash; no standalone New task row is rendered.




### US-UI-43 Empty home plate Y + night elevated-primary
- Open empty home at ~1200×690 light theme.
- Composer plate is bottom-aligned and content-driven: an empty or one-line
  draft uses the compact shell rather than a fixed ~140px minimum; the surface
  remains uniformly solid with no decorative wash.
- Switch dark theme: night plate is elevated-primary (`#212121f5` / gray-800
  96%) with the same restrained elevation and no internal gradient.


### US-UI-44 Settings compact directory + merged sections
- Open Settings light theme at ~1200×690.
- Full-page shell: rail ~260px on `#f3f3f3`, main `#fff`; Back to app; search pill; General active pill with icon.
- Rail order is exactly General / 常规, AI, Shortcuts / 快捷键,
  Instructions / 指令, Models / 模型, Skills / 技能, MCP,
  Subagents / 子智能体, Import / 导入, Projects / 项目, and Info / 信息;
  the rows are grouped under muted Preferences / 偏好, Agent / 智能体,
  Workspace / 工作区, and System / 系统 headings without divider lines,
  duplicate destinations, or placeholder rows. The selected page keeps its
  descriptive title, such as Model configuration or Project archive.
- General content: large title and an **Appearance** card with working
  system/light/dark controls. 全局 AI holds Permissions, Defaults, and the
  Command shell row; Context management has no settings card. Shortcuts holds
  the Keyboard shortcuts card.
  File-open target, language
  override, menu-bar behavior, and bottom-panel behavior are absent until
  host-backed implementations exist.
- Model configuration contains the default model selector, separate vendor
  account management with add/edit dialogs, and card-based AI service management
  with an add-provider dialog. The Defaults card reuses the compact geometry of
  every other settings row: the "Default model" label sits above the provider -
  model id line, and the quiet Change action remains separate from the current
  value. Change opens a floating listbox anchored to it: the card's height
  never changes, the model-level list is grouped by provider and scrolls once
  the configured models exceed its bounded height, it flips above the trigger
  near the viewport bottom, it is not clipped by the settings panel, and Escape,
  an outside press, or scrolling the trigger out of view closes it while focus
  returns to Change.
- Plugin load/enable/disable/uninstall remains available from the app shell's
  independent Extensions destination; its Marketplace tab also owns the
  official/mirror/custom catalog source picker, so Settings has no duplicate
  Extensions destination.
- Dark: rail `#000`, main `#181818`, cards elevated `#212121`.

### US-UI-38 Composer workspace context omitted
- On empty home, project home, and after starting a transcript, the composer
  never renders a project / Local / branch capsule.
- Workspace identity remains visible through the home hero or sidebar rather
  than being duplicated above the prompt.

### US-UI-37 Empty draft row + resize
- Empty composer prompt rows show no leading brand icon and retain visible
  placeholder ink (not a blank white/night hole).
- Auto-resize never collapses empty textarea below ~28px.
- Disabled send control is a solid gray chip on light (`#8e8e90`), full opacity with white arrow.
- Dark night plate remains elevated-primary `#212121f5` with readable elevation-prominent on `#181818`.

### US-UI-31b (superseded)
- Superseded by US-UI-31 home empty vertical stack (D111).



### US-UI-45 Composer width remains stable when the minimap appears
- Open empty home and record the composer plate width. Open a short transcript
  that fits one viewport, then grow it until the left-edge conversation minimap
  appears.
- The empty-home and docked composer plates use the same horizontal gutter and
  maximum content width. Their shell, textarea, placeholder alignment, toolbar
  padding, minimum input height, theme fill, and shadow are visually identical;
  only the parent placement and localized welcome copy differ. The minimap
  remains out of flow on the transcript's left edge and does not squeeze or
  resize the composer.
- When transcript content first overflows, the native scrollbar gutter is
  already reserved on both sides, so the transcript and composer keep one
  horizontal center instead of jumping left.

### US-UI-46 Home-with-project composer chrome
- Open a project on empty home (no transcript).
- Expect no workspace controls attached to the plate; there is no legacy draft
  mark, and the placeholder uses the PI-Desktop copy.
- Model chip shows the active model ID; the footer uses the circular local-user
  glyph, two-line Custom / Local profile identity, disclosure chevron, and
  separate Help → Settings Info control.

### US-UI-47 Projects index parity
- Open Settings → Project archive.
- Expect the Settings section title, search pill, Add project button, and the
  complete durable project list including archived rows.
- Rows expand for recent tasks; activating a project or one of its sessions
  uses `setProject` without re-picking via dialog and keeps session/workspace
  context synchronized. Sidebar pin/archive/close metadata remains local to
  the renderer and never hides or deletes a durable Project-archive row.


### US-UI-48 Home starter glyphs and labels are absent (D206)
- On empty home, no developer starter icon plate, title/description, or
  starter-card glyph renders in light or dark themes.
- The hero, optional onboarding checklist, and bottom composer remain the only
  empty-home task-entry surfaces.


### US-UI-49 Scoped sidebar row chrome
- Hover or select a project or temporary session row.
- Expect restrained title rows with active/hover background and compact
  overflow actions for pin/archive (not a Recents aggregate).
- Multiple retained project groups may be visible at once; sessions remain
  under exact-path groups, while closed-project sessions remain available in
  Settings → Project archive.


### US-UI-50 Destination title scale
- Open Settings → Project archive and Plugins.
- Expect large section titles (~28px) consistent with Codex destination/index pages.
- Dark home scoped session-creation controls remain quiet icon actions without
  a standalone New task row.

### US-UI-52 Settings gold chrome metrics (D070)
- Open Settings light Basics at ~1200×690.
- Expect ~275px `#f4f4f4` rail, single active Basics pill, Back + search.
- Expect the working theme selector without inert toggle or open-target rows.
- Expect Permissions + Basics + Appearance elevated cards; Agent,
  Import, and Info remain the only other destinations.
- Resize between 1040px, 1200px, and 1600px widths; the content cards fill the
  available right pane at each size without changing the rail or introducing
  horizontal scrolling.

### US-UI-53 Settings dark shell (D070)
- Dark theme Settings Basics: black rail, elevated cards, blue on-toggles, Back returns to chat.
- Row descriptions use theme-aware secondary text and remain clearly readable on
  the `#212121` card surface; they must not fall back to low-contrast muted ink.

### US-UI-54 Toast variants + lifecycle (D085)
- Trigger a success (save provider), an error (run with an invalid key), and an
  info toast from a test plugin.
- Expect a top-center stack on an elevated plate with a tinted variant icon (green ✓ / red ! / info) and an X dismiss per card; newest enters at the top-center anchor and pushes older cards down.
- Success/info auto-dismiss ~4s, error lingers ~8s; hovering a card pauses its countdown; X removes it immediately.
- With the stack overlapping the frameless titlebar band, hover still pauses
  the countdown and every X remains clickable instead of dragging the window.
- Repeating the same action restarts the existing toast instead of stacking a duplicate; stack never exceeds 4.
- Capture rig scenes `pi-toasts-light` / `pi-toasts-dark` show the stack in both themes.

### US-UI-55 Composer textarea growth (D089)
- In both home and thread-docked composers, an empty or single-line draft
  displays one visible text line.
- Enter or paste two through seven visual lines; the textarea grows with the
  wrapped content without manual resizing.
- Add an eighth visual line; the textarea stays at seven visible lines and
  scrolls internally instead of growing the composer further.
- Delete back to one line or submit the draft; the textarea contracts to its
  one-line default.
- With a large workspace open and the `@` file menu filtering, type sustained
  text; the caret keeps up with typing without visible stalls and the menu's
  row order is unchanged. Growth through seven lines, internal scrolling past
  the seventh, and contraction on delete or submit behave as above (D264).

### US-UI-56 Codex transcript tool activity
- In light and dark themes, tool calls use transparent compact activity rows,
  not elevated cards or colored success rails.
- Consecutive calls appear inside one default-collapsed processing group. Its
  active header shows `Processing · {elapsed}` and its completed header shows
  `Processed for {elapsed}`, plus a localized step count.
- The row shows a semantic 15–16px icon, progressive/past-tense action,
  ellipsized monospace argument hint, quiet disclosure chevron, and localized
  running/error/denied state.
- Fork-family tools show the GitFork branch icon instead of the generic tool
  glyph.
- Expanding a completed call reveals output before input. Both sections are
  independently copyable and capped with internal scrolling.
- Reloading the session preserves the action label and argument hint instead of
  degrading the row to a generic `Tool`.
- Run a turn that emits assistant text, calls multiple tools, and resumes with
  more assistant text. During streaming and after session reload, expect one
  assistant article for the whole user turn, with fragments and activity in
  original order but only one trailing model/usage row and one Copy/Fork/Retry
  toolbar. Copy includes all assistant text fragments in order.

### US-UI-57 Multi-project sidebar groups
- Open projects A and B without closing either.
- Expect a `Sessions` heading above `Projects`, containing path-less
  conversations plus new-session and sort actions. With more than five
  standalone conversations, expect a five-row-high list that scrolls to every
  remaining row without growing further.
- Right-click the `Sessions` heading or empty standalone list chrome and expect
  a one-item create menu that creates/reuses a path-less temporary session.
- Expect the following `Projects` heading to retain its new-project folder
  action, one path-keyed group per retained project, and an active-state marker
  on exactly one group. Its list consumes the remaining height and scrolls
  independently. Adjacent project groups read as a compact continuous tree
  without detached card spacing.
- Right-click the `Projects` heading or empty project-list chrome and expect a
  one-item create menu that opens the same project picker as the folder-plus
  action.
- Expect project and session lists to scroll inside the sidebar body without
  clipping behind the footer; sidebar Search/Collapse remain in the sidebar
  header. When the work panel is open, expect its sole collapse control in the
  session pane top-right rather than the work-panel content header, flush against
  the divider at the main pane's right edge.
- Collapse A by clicking its directory label, expand it from the chevron area,
  then activate B and return to A. Only A's child rows collapse; project `+`
  and overflow actions do not toggle it; the
  active project, topbar path, and transcript switch together; the composer
  remains free of workspace identity chrome.
- Close B and reopen it from Settings → Project archive. Closing removes only the sidebar tab;
  durable project/session rows remain available.

### US-UI-58 Sidebar organization actions
- Open a project and conversation overflow menu.
- Expect localized Pin/Unpin, Archive/Restore, and (for conversations) Delete
  actions with keyboard-reachable menu semantics.
- Open the sort menu from the standalone `Sessions` heading, pin one
  project/session, and choose each user-facing sort mode (Recently updated,
  Created date, Oldest first, Name). Pinned rows remain first.
- Archive a row, verify it is absent by default, enable Show archived, and
  restore it. The transcript and project binding remain unchanged.
- A legacy `manual` preference loads without presenting a drag-reorder
  affordance.

### US-UI-59 Session-rooted background tools
- Start a visible turn in project A, switch to project B while it runs, and
  inspect both sidebar status indicators.
- Expect A's turn to continue in the background, B's composer/context to show
  only B, and tool output/artifacts from A to remain rooted in A without
  opening or activating a work-panel tab over B.
- Open a Temporary session and invoke a workspace-required tool; expect the
  normal `WORKSPACE_REQUIRED` result rather than inheritance from B.


### US-UI-60 WorkBuddy transcript plates (D101)
- Open a mixed transcript in light and dark themes.
- Expect right-aligned compact user plates, transparent full-width assistant
  prose, denser row spacing, and hover-only copy chips under each turn.
- While an assistant answer streams, expect the same transparent full-width
  prose as a completed turn — no left rail and no whole-turn tile. The tile
  belongs only to a subagent/delegation card (D319, D323).


### US-UI-60b Assistant markdown prose redesign
- Open an assistant answer with headings, table, code fence, blockquote, and task list.
- Expect the refined `.prose-chat` hierarchy and inset code chrome in both themes.
- Expand thinking markdown and confirm it stays visually subordinate to the answer.


### US-UI-60c Compact assistant error card
- Trigger a retriable provider/model failure in the transcript in light and dark themes.
- Expect the assistant error to use a restrained inline surface with a thin error rail. The localized summary, stable code, and details disclosure share one compact header; the card does not render a second bottom action row.
- Confirm the details remain expanded on first render, keep the redacted provider response and provider/model IDs, and expose an icon-only copy control with an accessible label/tooltip. On a narrow window, the header actions wrap without horizontal overflow.
- Expect the compact assistant error card itself to expose one localized **Continue** action beside the details disclosure. Click it and expect the app to append the localized continuation prompt (`Continue the current task` / `继续当前任务`) to the same session and start the next turn without truncating the failed turn.
- For a terminal `PROVIDER_RATE_LIMITED` (including HTTP 429), expect the TurnOutcomeCard to expose exactly one localized **Continue** action and no **Regenerate** action.
- Click **Continue** and expect the app to append the localized continuation prompt (`Continue the user's unfinished task.` / `继续用户未完成的任务`) to the same session and start the next turn without truncating the failed turn.


### US-UI-61 Assistant context summary + retry (D103, D184, D244)
- Complete an assistant turn that reports usage.
- Expect a model badge and compact Context inspector under the answer. The
  trigger shows the remaining context percentage; clicking it (or activating it
  from the keyboard) shows used/remaining/window tokens, two unboxed turn/speed
  values, one inline exact provider-usage summary, and one aggregate tool-usage
  summary with types, calls, and approximate tokens. Per-tool rows, bars,
  badges, and explanatory estimate copy are not shown.
- Hovering the trigger changes nothing; the open panel closes on a second
  activation, an outside click, or Escape.
- Move the trigger near each viewport edge and scroll or resize while the panel
  is open; expect the body-level overlay to flip, clamp, and remain fully
  visible instead of being clipped by the transcript scroll container.
- Hover the action row and click Retry; the nearest preceding user prompt is
  re-sent.


### US-UI-62 In-place regenerate (D105)
- On a multi-turn transcript, regenerate an earlier assistant answer.
- Expect the later turns to disappear and the chosen user prompt to re-run in
  place, without stacking a second copy of the prompt.


### US-UI-63 Regenerate history pager (D109)
- Regenerate an assistant answer twice.
- After each retry, hover or focus the root user bubble and expect its action
  toolbar to expose a `1/N` pager for restoring earlier variants.


### US-UI-64 Empty home no composer overlap (D111/D204/D206)
- Open empty home at ~1200×690 and at a shorter height (~900×640).
- Expect the hero and optional onboarding checklist in a scrollable content
  region, with the home composer visibly reserved at the bottom and no starter
  cards.
- Short windows scroll the content region rather than stacking the composer over
  the checklist; when the checklist is absent, no empty spacer remains.


### US-UI-65 Durable notification inbox (D117/D130)
- Verify a focused-current completion leaves the inbox unchanged, then
  populate it through background/unfocused completed and failed task rows,
  including one long session title. Inspect the expanded sidebar footer and
  popover in light/dark themes at default and narrow supported widths.
- Expect no titlebar bell, a stable 32px footer bell in the former Help position,
  a non-overlapping `1`–`99` / `99+` badge,
  dense 360px-or-narrower list, localized kind/session/time/error content, and
  distinct text/icon/unread-dot semantics without nested cards or clipped text.
- Switch All/Unread; use Tab, arrow keys, Home/End, Enter/Space, Escape, and
  outside click. Focus order remains predictable, row activation opens the
  correct session, and Escape restores focus to the bell.
- Mark all read and Clear expose icon tooltips/accessible names, disabled and
  empty states remain understandable, and reduced-motion mode changes the
  popover instantly without suppressing focus or unread state.

### US-UI-66 Application update notice layout
- In a conversation with the docked composer visible, exercise manual
  `available`, in-app `downloading`, and `downloaded` update fixtures in light
  and dark themes at default and minimum supported window sizes. Grow the
  composer draft to its maximum visible height.
- Expect one compact update notice below the titlebar in the main pane's
  top-right safe area. It never intersects the composer, including while the
  draft grows, and it does not cover an open work panel.
- Expect a stable update icon/title/message hierarchy, determinate progress for
  `downloading`, the applicable View release or Restart to update action, and a
  24px dismiss control with an accessible name. Dismissing one status stage
  does not suppress a later stage for the same version.
- When the fixture includes `releaseNotes`, expect a "What's new" section under
  the status message on both the banner and Settings → Info Updates row, using
  the product UI locale (EN or zh-CN). A fixture without notes omits the
  section. Switching language re-resolves the same version's notes without a
  new check.

### US-UI-67 Distinct sidebar task status indicators (D135)
- In light and dark themes, keep session B selected while session A progresses
  through in-progress, completed, a new in-progress turn, failed, and aborted
  states. Repeat with reduced motion enabled and inspect keyboard focus.
- Expect A to show an orange breathing dot while in progress, a green check on
  completion, and a red circled alert on failure. Starting a new turn clears
  A's earlier terminal mark; abort leaves no completed or failed mark.
- Expect selected idle B to show a static accent-blue outlined ring and active
  row background. If selected B starts work, its orange in-progress dot takes
  precedence until the turn settles; its latest terminal result remains hidden
  behind the selected ring while selected.
- Every indicator exposes localized In progress / Selected / Completed / Failed
  text through its accessible name and tooltip. Reduced motion makes the orange
  dot static without changing its color or meaning. Row height, title truncation,
  pin icon, hover actions, and focus ring remain stable in both themes.
- Open a conversation with a completed or failed mark and expect that terminal
  mark to clear immediately while its durable task notification becomes read.
  Refresh notifications and restart the app; the acknowledged mark must not
  return. A terminal notification marked read from the inbox likewise produces
  no sidebar terminal mark.

### US-UI-68 Session-scoped inline permissions and artifacts (D138/D142)
- Run two sessions concurrently and keep A visible while B reaches a tool
  approval request. Inspect light/dark themes at default and narrow widths.
- Expect no backdrop, modal, page/session switch, work-panel hide, transcript
  replacement, or composer-focus change in A. B retains its pending state.
- Open B explicitly and expect one inline permission card after B's latest
  activity, with readable risk, args, workspace, countdown, and wrapping action
  controls. Switching away and back preserves the absolute deadline.
- Make A and B pending together, resolve each independently, and confirm neither
  action removes or changes the other card.
- Resolve A's Write/Edit permission and switch to B before completion. Expect no
  transient Review panel in B and no panel/window flash; returning to A restores
  A's resulting Review tab and prior panel selection, while B's tabs and Browser
  resource remain unchanged.

### US-UI-69 Sidebar type balance (D144/D161)
- Open the expanded sidebar in light and dark themes at default and minimum
  supported widths with at least one session, one project group, and the local
  profile footer visible.
- Expect Plugins, footer profile name, and profile menu actions to render at
  the body chrome size (`--text-base` / 14px).
- Expect session/thread titles, project/group titles, and empty-state copy at
  `--text-md` / 13px, with uppercase section labels (`SESSIONS` / `PROJECTS`)
  at `--text-sm` / 12px — never below `--text-md` for primary list content.
- Confirm row pitch remains compact (≈28–32px), titles still truncate cleanly,
  and collapsed icon-rail controls stay legible without reflowing the shell.

### US-UI-70 Disable text correction on editable fields (D145)
- Open empty home, a docked transcript, Settings search, Plugins market search,
  Projects archive search, global search (which now includes commands), provider model combo,
  message-edit textarea, and the work-panel browser URL bar in light and dark.
- Expect every text `input`/`textarea` to expose `spellcheck="false"` (React
  `spellCheck={false}`) plus `autocorrect="off"` and `autocapitalize="off"`.
- Expect no red spelling underlines while typing code-like tokens, paths, model
  ids, or URLs; checkboxes and non-text controls remain unchanged.

### US-UI-71 Composer runtime chip descenders (D150)
- Open empty home and a docked thread with a model ID that contains descenders
  (for example `gpt`, `gemini`, or any id with `g`/`y`/`p`/`q`/`j`).
- Inspect Agent/Plan/Goal, Thinking (when present), permission mode, and the
  model chip in light and dark.
- Expect every chip label to show full glyph ink — bottoms of `g`/`y`/`p` are not
  clipped by the 28px capsule — while long model IDs still ellipsize horizontally.
- **Specs linked**: `04-ux/07-ui-design-system.md` §8.2, `04-ux/08-component-spec.md` §11.5, decisions-log D150
- **Milestone**: M5
- **Status**: Partially automated (renderer source test: chip line-height + no leading-none)

### US-UI-72 Apple-inspired global corner hierarchy (D210)
- Open the empty home, a populated transcript, Settings, Plugins, Project
  archive, a menu, and a dialog at the default supported desktop size in light
  and dark themes.
- Expect fixed corners to follow the global 4/6/8/10/12/14/16/18/20/24px
  ladder, with visually larger or more elevated surfaces receiving the larger
  radii.
- Standard compact and medium buttons and fields remain rounded rectangles,
  not capsules. Pills, segmented selections, status labels, progress tracks,
  switches, equal-width circular icon controls, and dots retain their explicit
  capsule or circle shape.
- Where a rounded child sits against a rounded parent corner, expect the radii
  to read concentrically with the intervening inset. Full-width sidebar,
  titlebar, and work-panel edges remain square rather than becoming floating
  cards.
- Resize to the minimum supported window and inspect menus/dialogs near each
  edge. Rounded surfaces must not clip text, focus rings, actions, or scrollable
  content.
- **Specs linked**: `04-ux/07-ui-design-system.md` §6.2, ADR 0071
- **Milestone**: M5
- **Status**: Partially automated (radius token and shared-control source test)

### US-UI-73 Composer mode selector has stable width
- Open the empty home and a docked thread in both English and zh-CN.
- Switch the Composer mode chip through Agent/Plan/Goal several times.
- Expect the mode chip to keep one fixed width sized for the longest built-in
  label (English "Agent" / zh-CN "智能体"); the adjacent Thinking and
  permission controls, send button, and composer shell do not move or resize.
- In Goal, expect the permission chip to remain visible with the same geometry,
  show Full auto / 全自动, and stay disabled without opening a permission menu.
  The Plan/Goal approval card remains the separate execution-policy control.
- **Specs linked**: `04-ux/08-component-spec.md` §11.3
- **Milestone**: M5
- **Status**: Partially automated (renderer style/source contract)

### US-UI-74 macOS native sidebar vibrancy
- Open the desktop app on macOS in both light and dark appearances with the
  sidebar expanded, then exercise the existing collapse/expand path.
- Expect the main window to use native `under-window` vibrancy with a thin
  theme tint behind `.sidebar` and any rendered `.sidebar-rail`: desktop
  content stays perceptible through the material and the surface carries a
  top-to-bottom sheen rather than a flat fill. The dock carries no seam or
  hairline — the glass meets the opaque main pane flush, so no hard divider
  separates the two panes.
- Expect `.main-pane`, `.main-titlebar`, and `.conversation-topbar` to remain
  solid theme surfaces without whole-window transparency or a strong artificial
  blur/card treatment. Sidebar collapse/expand, resize, traffic-light placement,
  and drag/no-drag hit regions remain unchanged.
- **Specs linked**: `04-ux/08-component-spec.md` §1.7, §3.4
- **Milestone**: M6
- **Status**: Partially automated (`macos-sidebar-vibrancy.test.mjs` source contract); native visual verification Draft

#### E2E-123: asktool collects multiple answers and returns skipped placeholders

- **Preconditions**: Agent, Plan, or Goal mode; a configured provider; a
  session with an active transcript.
- **Steps**: 1) Ask the agent to call `asktool` with a single-select question,
  a multi-select question, and an option list for each. 2) Confirm each card
  shows the fixed custom-input choice. 3) Answer the first question, click
  Next, and select two answers on the multi-select question. 4) Skip the final
  question without entering text. 5) Inspect the completed tool row and the
  next model response.
- **Expected**: One question is visible at a time; the small indicators show
  answered, current, and skipped states in the composer approval area, at the
  same dock position used by Plan and Goal approval. The request has no
  countdown. Question text and options render at the compact card body size
  (`--text-md`, one step below the surrounding chat body), matching the
  permission card scale in the same dock area. The card shell uses the slim
  rail (2 px accent, 14 px × 16 px padding). Option rows and action buttons
  use the app's compact control density (30 px rows, 15 px marks, 8 px row
  gaps, compact buttons), and the card keeps a relaxed internal rhythm
  (12/14 px indicator margins, `--leading-normal` question line-height). The
  question's option list is bounded to the available viewport height; when a
  fixture contains enough options to overflow, only that list scrolls and the
  question header, custom-answer input, and Skip / Next / Submit actions remain
  reachable. Scrolling the list does not move the conversation page or hide the
  action row. The tool output is ordered as
  `question：answer`, uses `、` between multiple answers and `\n---\n`
  between questions, and
  keeps `question：` for the skipped question. Decline all produces empty
  placeholders for every question and still completes the tool call.
- **Specs linked**: `03-runtime/17-asktool-questions.md`,
  `04-ux/11-asktool-question-card.md`, ADR 0077
- **Acceptance**: E (interactive tool output), C (inline card)
- **Milestone**: M5
- **Status**: Draft (unit coverage active; desktop journey pending)

#### E2E-124: Window controls minimize to the taskbar and close to the chosen surface

- **Preconditions**: Built desktop app on macOS, Windows, and Linux; English
  and zh-CN locales are available; a normal main window is open.
- **Steps**: 1) On Windows, leave the focused main window visible and click its
  taskbar button; confirm it minimizes while the PI-Desktop taskbar entry
  remains. Click the same taskbar button again and confirm the window restores
  and focuses. Cover the window with another app, click the PI-Desktop taskbar
  entry, and confirm it comes to the front without entering the tray. 2) On
-  macOS, click the traffic-light minimize control and confirm it hides the
  window to the tray. On Windows/Linux, use the renderer minimize control and
  confirm the native taskbar entry remains available; click it again and
  confirm the same window restores and focuses. 3) Select Close to tray and
  close the Windows/Linux window; confirm it leaves the taskbar and is
  restored by the tray icon. Select Quit and repeat; confirm the process exits.
  4) Open the tray menu and choose Show, then repeat with Quit. 5) Repeat in
  zh-CN and invoke macOS app activation while the window is tray-hidden.
- **Expected**: Windows native taskbar toggling and the Windows/Linux renderer
  minimize controls keep the taskbar entry and round-trip through native
  minimize/restore; a taskbar click on a covered window brings it to the front.
  Close to tray is the only Windows/Linux close path that hides the window,
  while Quit exits. On macOS the menu bar icon is a readable transparent
  monochrome PI mark without the rounded application tile, and native minimize
  remains tray-resident. Show/click/double-click/app activation restores the
  existing window; the localized menu contains Show PI-Desktop and Quit
  PI-Desktop. Quit runs the normal shutdown sequence and leaves no orphan host,
  sidecar, or tray process.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `03-runtime/07-process-model.md`,
  `04-ux/08-component-spec.md`, `04-ux/09-interaction-patterns.md`,
  `08-meta/decisions-log.md` (D216, D230, D252, D256), ADR 0078, ADR 0090,
  ADR 0117, ADR 0123
- **Acceptance**: A (app lifecycle), Quality
- **Milestone**: M6+
- **Status**: Unit/source-contract covered; native cross-platform tray journey
  Draft (do not run local E2E unless explicitly requested)

#### E2E-150: A second launch surfaces the running app instead of starting one

- **Preconditions**: Built desktop app on macOS, Windows, and Linux, installed
  with the default data directory; one instance is running with at least one
  session in its sidebar.
- **Steps**: 1) Launch the app again from the platform's normal entry point
  (Start menu/desktop shortcut, `.AppImage`, `open -n` on macOS) and observe
  both the window and the process list. 2) Minimize the window into the tray,
  then launch again. 3) On Windows/Linux with close behavior `tray`, close the
  window, then launch again. 4) While the app is running, launch a build with
  `PI_DESKTOP_DATA_DIR` set to an empty directory. 5) Quit the app, confirm no
  process remains, and launch once more.
- **Expected**: Steps 1–3 never create a second window, tray icon, host-core,
  agent sidecar, or log file: the existing window is restored and focused, the
  duplicate process exits, and the running instance's session list, in-flight
  turn, and `pi.sqlite` are untouched. Step 4 starts normally as an independent
  instance against its own data directory. Step 5 starts a clean single
  instance, proving the lock is released on exit and never leaves a stale block.
- **Specs linked**: `03-runtime/07-process-model.md`,
  `08-meta/decisions-log.md` (D236, D002), ADR 0094
- **Acceptance**: A (app lifecycle), Quality
- **Milestone**: M6+
- **Status**: Unit/source-contract covered; native cross-platform relaunch
  journey Draft (do not run local E2E unless explicitly requested)

#### E2E-125: Complete bilingual VitePress documentation remains usable

- **Preconditions**: Docs dependencies are installed and the VitePress preview
  server is running from the repository.
- **Steps**: 1) Open `/` at 1440×900 and verify the English landing page,
  system map, read-by-intent journeys, reference shelf, global search,
  Guide/Specs/ADRs navigation, and language selector. 2) Switch to `/zh-CN/`
  and verify the translated hero, mirrored topic map, and Chinese specification
  links. 3) Open `/spec/03-runtime/01-ipc-protocol`, switch languages, and
  verify that `/zh-CN/spec/03-runtime/01-ipc-protocol` contains translated prose,
  preserved code identifiers, and a link back to the English source. 4) Search
  in each locale and open a matching result. 5) Repeat the homepage and a long
  table-heavy specification at 390×844 in light and dark mode.
- **Expected**: Both locale entry points and every English/Chinese specification
  pair render without broken links or page-level horizontal overflow. Landing
  and reading columns are visually centered within their available layout; the
  mobile hero presents text before the system visual. Search returns local
  results. The mobile navigation opens and closes without shifting or obscuring
  the page. Code blocks and tables remain readable through contained scrolling,
  theme contrast stays clear, and every Chinese spec identifies the English
  page as its canonical source. Directly refresh `/zh-CN/spec/README`,
  `/zh-CN/spec/03-runtime/01-ipc-protocol`, `/zh-CN/adr/`, `/spec/README`, and
  `/adr/README` on Vercel; each route resolves through the documented
  `cleanUrls` configuration instead of returning 404.
- **Specs linked**: `02-architecture/04-documentation-site.md`, ADR 0079
- **Acceptance**: Quality, documentation discoverability, responsive layout
- **Milestone**: M6+
- **Status**: Browser-rendered desktop/mobile verification is authorized for
  this documentation redesign; remote deployment refresh checks remain Draft.

#### E2E-126: Appearance card selects a global UI font

- **Preconditions**: App running on macOS with an installed system font
  distinct from the bundled families (for example PingFang SC); a clean
  `~/.pi-desktop` profile.
- **Steps**:
  1) Open Settings → Basics and confirm the Appearance card shows a Font row
     below Theme and Language with a trigger labeled "System default".
  2) Open the Font picker and confirm it lists System default, the bundled
     open-licensed families (Geist, Inter, Noto Sans SC, LXGW WenKai) marked
     with their license, and installed system families; confirm the search
     input filters families and the current selection shows a check badge;
     confirm the menu opens as a floating layer above the card (not clipped or
     squeezed inside it) and stays readable when the card is near the bottom
     edge of the window; with many installed families, confirm the list opens
     without an input stall and scrolls immediately (only the visible rows
     are rendered, with an overscan buffer).
  3) Select Geist and confirm the trigger label and the whole UI re-render in
     Geist without a reload, including CJK fallback rendering for Chinese text.
  4) Select an installed system family and confirm the UI switches to it; the
     family stays selected after reopening the picker.
  5) Restart the app, reopen Settings, and confirm the selected font is still
     applied (persisted `AppSettings.fontFamily`).
  6) Select System default and confirm the UI returns to the built-in token
     stack immediately; restart, reopen Settings, and confirm the default is
     still applied (the override is cleared, persisting an empty
     `AppSettings.fontFamily`).
- **Expected**: The Font row is a searchable picker whose trigger previews the
  current family in that face; options are System default, bundled OFL families,
  and installed system families enumerated by Electron main via
  `pi-desktop/app/systemFonts` (cached 60 s, hidden `.`-prefixed families
  excluded); selection persists as a CSS stack in `AppSettings.fontFamily` and
  overrides `--font-sans` live; Chinese text stays readable through the CJK
  fallback tier; the menu is a body-level floating layer that is never clipped
  by the settings card; the option list is windowed with fixed row heights
  and an overscan buffer so only the visible slice is in the DOM, keeping
  opening, scrolling, and typing responsive regardless of how many families
  are installed; System default clears the override by persisting an empty
  stack.
- **Specs linked**: `04-ux/06-settings-ia.md`, `04-ux/07-ui-design-system.md`,
  `03-runtime/01-ipc-protocol.md`, ADR 0083
- **Acceptance**: A (core shell), H (localization)
- **Milestone**: M5+
- **Status**: Documented

#### E2E-127: macOS keeps the app in the Dock and Cmd+Tab

- **Preconditions**: Built desktop app on macOS; the plugin launcher shortcut
  (Option+Space) is registered; at least two Spaces and one other application
  running fullscreen.
- **Steps**:
  1) Launch the app without opening the launcher and confirm it appears in the
     Dock and in the Cmd+Tab switcher (`lsappinfo list` reports
     `type="Foreground"`, not `type="UIElement"`).
  2) Press Option+Space, confirm the launcher panel appears focused with a
     typable input, dismiss it, and confirm the app is still in Cmd+Tab.
  3) Put the main window in fullscreen, press Option+Space, and confirm the
     panel floats above it.
  4) Switch to a second regular Space and confirm Option+Space shows the panel
     there.
  5) Minimize the main window into the tray, switch to another app, then Cmd+Tab
     back to PI-Desktop and confirm the window returns focused; repeat with a
     Dock click and with the tray Show item.
  6) With the main window hidden, press Option+Space and confirm only the
     launcher appears — the main window stays hidden until it is restored.
- **Expected**: The process never adopts the accessory activation policy, so
  Dock and Cmd+Tab presence survives launcher warm-up and every launcher
  invocation; the launcher stays focusable, covers all regular Spaces and the
  app's own fullscreen window (overlaying another app's fullscreen Space is
  out of scope and activates PI-Desktop instead); activation from Cmd+Tab, App
  Exposé, the Dock, or the tray restores a tray-hidden window, while launcher
  and plugin-panel activation leaves it hidden.
- **Specs linked**: `03-runtime/07-process-model.md`, ADR 0086, ADR 0078,
  ADR 0080
- **Acceptance**: A (core shell)
- **Milestone**: M5+
- **Status**: Documented

#### E2E-128: Revealed work panel with no resource offers available views

- **Preconditions**: App running with a project open and an active conversation
  that has produced no file, URL, or review artifact, so the session's work
  panel context holds no tabs.
- **Steps**:
  1) Press `Cmd/Ctrl + J` and confirm the panel appears with an empty body that
     shows a tiled icon, the title "No resource open", one line of supporting
     copy, and Browser/in-scope plugin-view rows — not a blank area below the
     title bar.
  2) Tab into the available rows and confirm each takes a visible focus ring
     and that hovering a row shows only a background fill.
  3) Activate Browser or a plugin view and confirm its singleton tab is created
     and selected; the empty body and its view list disappear.
  4) Open the header context menu, activate the same view again, and confirm it
     selects the existing tab rather than creating a second one.
  5) Close the view tab and confirm the panel hides when it was the last tab,
     then press `Cmd/Ctrl + J` again and confirm the empty body returns.
  6) Repeat step 1 in Chinese and in both light and dark themes, and at the
     244px panel minimum, confirming the copy wraps rather than clipping.
- **Expected**: `Cmd/Ctrl + J` reveals the panel without creating a tab, and the
  no-resource body lists the same Browser/plugin-view entries as the header
  menu; a row creates or selects that singleton view exactly as the menu does.
  The empty body is not exposed as a `tabpanel`; its rows are buttons in a
  `role="group"` labelled Tools. Panel empty states share the app's empty-state
  proportions with no action button in the "open a project" states.
- **Specs linked**: `04-ux/08-component-spec.md` §5.2, §5.2.1, §5.3, §5.4, §5.5,
  `04-ux/07-ui-design-system.md`, ADR 0108
- **Acceptance**: A (core shell), H (localization)
- **Milestone**: M5+
- **Status**: Documented


#### E2E-129: A run row shows its command once and copies it from the head

- **Preconditions**: App running with a project open and a conversation that has
  produced at least three command rows: one that succeeded with output, one that
  failed with both output and errors, and one still running.
- **Steps**:
  1) Leave the running row collapsed while it produces output and confirm the
  row remains a compact one-line status; then click its disclosure while the
  command is still running and confirm the current output appears immediately.
  1a) Keep the command running through enough output to exceed the output area's
  visible height and confirm the output stays inside its capped scroll region,
  rather than pushing the transcript out of view. Confirm later output replaces
  the same body in place while the row remains open.
  1b) Expand the successful row and confirm the body shows the command's output
     as plain text — no `Output` heading, no bordered card, no per-block copy
     button — and that the command is not repeated inside the body, with no
     argument list in its place.
  2) Confirm each row's head states its outcome to the right of the summary:
     `Done`, `Failed`, `Denied`, or `Working…`, each with a dot in the matching
     tint, and that the running row shows the pulsing dot instead of the row
     spinner.
  2a) Run a command that exits non-zero (`pnpm test` on a failing suite, or
     `false`) and confirm the row reads `Failed` with the error dot and opens
     itself, even though the tool call completed. Confirm the exit-code chip and
     the worded outcome agree.
  2b) Interrupt a long command so the shell is killed with no exit code, and
     confirm the row reads `Failed` rather than `Done`.
  3) Hover the successful row and confirm a copy button and the chevron appear
     between the summary and the row's right edge; move the pointer away and
     confirm both fade while the status label stays visible.
  4) Activate the copy button and confirm the clipboard holds the command as it
     was issued — a multi-line command keeps its line breaks, unlike the
     single-line summary in the head — and that the button acknowledges the copy
     before returning to its idle icon.
  5) Confirm the hover fill covers the whole head, including the copy button and
     chevron, and that a row with nothing to expand takes no fill at all.
  6) Tab through the row and confirm the header is the only stop that toggles
     the body, the copy button is reachable and takes a visible focus ring
     (revealing itself on focus), and the chevron is never a tab stop.
  7) With a screen reader, expand and collapse the row and confirm the outcome
     is announced once, not twice.
  8) Ask the agent to run a command that requires approval and confirm the
     permission card still shows the command it is asking about.
  9) Enable "reduce motion" and confirm the running dot holds still and the copy
     button appears without a fade.
  10) Repeat steps 1–3 in Chinese and in both light and dark themes.
- **Expected**: A command appears exactly once per row, in the head, alongside a
  copy control that yields it verbatim and a worded outcome that does not rely
  on the dot's color. The outcome reports what the command did — a non-zero or
  missing exit code reads `Failed` regardless of the tool call's own status — and
  a row with nothing to report states nothing instead of claiming `Done`. The
  running row is collapsed by default, and expanding it during execution shows
  the cumulative `details.output` stream in the stdout channel. The body keeps
  the live output in a capped internal scroll region and updates in place without
  rerendering unrelated rows; the completed `details.stdout` value wins over any
  older partial snapshot. The expanded body holds only what the command printed,
  as bare text, and a command that printed nothing opens empty rather than
  falling back to its arguments.
  Approval cards are unaffected, since they have no head of their own.
- **Specs linked**: `04-ux/08-component-spec.md` §9.2, §9.3, §9.5, §9.10
- **Acceptance**: E (tools & permissions), H (localization)
- **Milestone**: M5+
- **Status**: Documented

#### E2E-130: Read mints a tag that an Edit consumes without re-reading

- **Preconditions**: A project-bound Agent session with a writable workspace and
  a source file of at least 300 lines. The provider fixture can emit an exact
  `Edit` payload.
- **Steps**:
  1. `Read` the file with no `offset` and record the `[path#TAG]` header, the
     `tag` field, and the `N:` prefixes on the returned lines.
  2. Emit `Edit` with that `tag` and a single `PUT N.=M:` whose body replaces two
     lines inside the read window.
  3. Confirm the successful result reports a new `tag`, then emit a second `Edit`
     with the returned tag and a `PUT >$:` append, with no intervening `Read`.
  4. `Read` a 200-line window at an `offset`, then `Edit` a line inside that
     window using the tag from the windowed read.
  5. Reopen the file on disk and compare it to the intended content byte for
     byte.
- **Expected**: The header tag is the whole-file tag, not the window's, so a
  windowed read anchors correctly; line numbers are absolute and unaffected by
  `offset`. Both edits apply, the second without any re-read, and each success
  returns the post-write tag. The file on disk matches the intended content
  exactly, with its original line endings and BOM state preserved.
- **Specs linked**: `03-runtime/18-line-anchored-edit-contract.md` §3, §4.2, §5,
  §6, §9, `03-runtime/16-tool-result-limits.md` §5, ADR 0087
- **Acceptance**: E (tools & permissions)
- **Milestone**: M5+
- **Status**: Documented

#### E2E-131: An edit on never-displayed lines is rejected and the retry succeeds

- **Preconditions**: A session that has read only lines 1–50 of a 400-line file.
  A second fixture file has one line longer than 16,384 characters.
- **Steps**:
  1. Emit `Edit` with the correct `tag` and a `PUT 300.=301:` op.
  2. Inspect the error code and confirm the message inlines the current content
     of lines 300 and 301.
  3. Retry the identical `Edit` payload, unchanged, including the same `tag`.
  4. Emit `Edit` with the correct tag and a `PUT 5.=60:` op spanning 56 unseen
     lines, and inspect the reveal.
  5. Retry that identical payload unchanged.
  6. `Read` the second fixture, confirm the long line is clipped and counted in
     `notice`, then `Edit` that clipped line.
- **Expected**: Step 1 fails with `EDIT_LINES_UNSEEN` and the file is unchanged.
  Step 3 applies, because the complete reveal merged those lines into the
  session's provenance. Step 4 fails with a reveal truncated at 40 lines that
  says to re-read the range, and step 5 fails again — a truncated reveal merges
  nothing, so the guard cannot be walked past in under-cap slices. Step 6 fails
  with `EDIT_LINES_UNSEEN`: a clipped line was never displayed.
- **Specs linked**: `03-runtime/18-line-anchored-edit-contract.md` §4.3, §9.1,
  §11, §12, `03-runtime/16-tool-result-limits.md` §2, ADR 0087
- **Acceptance**: E (tools & permissions), Quality
- **Milestone**: M5+
- **Status**: Documented

#### E2E-132: Gap inserts, deletes, and multi-op payloads apply against one snapshot

- **Preconditions**: A read file whose content is known line by line.
- **Steps**:
  1. Emit one `Edit` combining `PUT <1:`, `PUT >40:`, `CUT 12.=14`, and
     `PUT 80.=80:` in a single `ops` payload.
  2. Compare the result against the same four changes computed against the
     original line numbering.
  3. Emit `PUT >$:` on the same file and confirm the append lands after the final
     line with exactly one terminating newline.
  4. Emit an `ops` payload whose body row starts with a literal `-` written as
     `+- item`, and one with a literal `+` written as `++ item`.
  5. Emit an `Edit` whose `PUT` body exactly reproduces the range's current
     content.
- **Expected**: Every anchor indexes the tagged snapshot, so no op shifts
  another and the combined result equals the four independent changes. `+-` and
  `++` write a single leading `-` and `+`. Step 5 returns `EDIT_NO_CHANGE` rather
  than reporting a successful write of nothing, and leaves no review record.
- **Specs linked**: `03-runtime/18-line-anchored-edit-contract.md` §7.2, §7.3,
  §7.4, §8.1, §9.3, ADR 0087
- **Acceptance**: E (tools & permissions)
- **Milestone**: M5+
- **Status**: Documented

#### E2E-133: Block ops resolve, echo their span, and decline instead of guessing

- **Preconditions**: Read fixtures in a supported grammar (a Rust file with a
  decorated/attributed function), a Markdown file with nested headings, and a
  file in a language outside the supported grammar list.
- **Steps**:
  1. Emit `PUT N*:` anchored on the `fn` line of a function whose declaration
     carries an `#[attribute]` line above it, and inspect the echoed
     `{anchorLine, start, end, op}`.
  2. Repeat anchored on the attribute line and compare the echoed span.
  3. Emit `PUT >N*:` on the same opener and confirm the insertion lands after the
     block's last line at sibling indentation.
  4. Emit `CUT N*` anchored on a lone `}` closer.
  5. Emit `PUT N*:` on a `##` heading in the Markdown fixture and confirm the
     span reaches the next same-or-higher heading, not the next deeper one.
  6. Emit `PUT N*:` in the unsupported-language file.
  7. Introduce a syntax error into the Rust fixture, re-read, and emit a block
     op.
- **Expected**: Step 1's span starts at the `fn` line and excludes the
  attribute; step 2's includes both — the difference is visible in the echo
  before the model has to infer it. Steps 4, 6, and 7 fail with
  `EDIT_BLOCK_UNRESOLVED` and a message naming the plain-range alternative;
  neither approximates a span. Range and gap ops still work in the unsupported
  language.
- **Specs linked**: `03-runtime/18-line-anchored-edit-contract.md` §8.2, §11,
  §12, ADR 0087 §4
- **Acceptance**: E (tools & permissions), Quality
- **Milestone**: M5+
- **Status**: Documented

#### E2E-134: Registers move code within a call and across calls

- **Preconditions**: Two read files in the same session.
- **Steps**:
  1. In one `Edit`, emit `CUT 20.=30` followed by `PUT <5 ` with no register
     label, and confirm the lines moved within the file.
  2. In one `Edit`, emit two `CUT` ops with no labels followed by one unlabeled
     paste.
  3. Emit `CUT 40* @fn` on the first file, then in a separate `Edit` call emit
     `PUT <10 @fn` on the second file.
  4. Emit `PUT <10 @missing` for a register that was never set.
  5. Emit `PUT 10.=12 @fn` with a body row attached.
  6. Emit `PUT <1 ` with no label in a fresh `Edit` call that performed no
     capture.
  7. Delete the source file, then paste `@fn` again in a later call.
- **Expected**: Step 1 applies as one move with no duplicated or orphaned lines.
  Step 2 fails with `EDIT_REGISTER_AMBIGUOUS` instead of using the most recent
  capture. Step 3 completes the cross-file move across two calls, each with its
  own permission gate, review record, and artifacts row. Steps 4 and 6 fail with
  `EDIT_REGISTER_EMPTY` — the anonymous register did not survive the earlier
  call. Step 5 fails with `EDIT_PARSE_FAILED`. Step 7 still pastes: a register
  holds captured content, not a live reference.
- **Specs linked**: `03-runtime/18-line-anchored-edit-contract.md` §7.5, §8.3,
  §11, §13.2, ADR 0087 §5
- **Acceptance**: E (tools & permissions)
- **Milestone**: M5+
- **Status**: Documented

#### E2E-135: A drifted file recovers when remapping is provable and fails when it is not

- **Preconditions**: A read file whose tag is recorded. An external process can
  modify the file between the read and the edit.
- **Steps**:
  1. Insert 10 unrelated lines above the edit target from outside the session,
     then emit the original `Edit` with the stale `tag`.
  2. Inspect the warning on the successful result and confirm the change landed
     at the shifted location, not at the original line numbers.
  3. Repeat with a change that modifies one of the anchor lines themselves.
  4. Repeat with a change that inserts lines *between* two anchors of a
     multi-op payload, so the anchors would move by different offsets.
  5. Repeat with a `CUT` whose captured interior lines were externally edited.
  6. Repeat after the session itself has written the file twice, using the tag
     from the first write.
  7. Repeat with a duplicated anchor line whose one neighboring context line
     matches but whose other does not.
- **Expected**: Step 1 applies with a line-remap plus external-change warning.
  Steps 3, 4, 5, and 7 fail closed with `EDIT_TAG_MISMATCH` and current content;
  none of them writes. Step 6 applies with a session-chain warning instead of an
  external-change warning, because the corrective advice differs. No recovery
  path ever writes the tagged snapshot's content over the live file.
- **Specs linked**: `03-runtime/18-line-anchored-edit-contract.md` §9, §10, §11,
  ADR 0087 §6
- **Acceptance**: E (tools & permissions), Quality
- **Milestone**: M5+
- **Status**: Documented

#### E2E-136: A stale tag still applies for head and tail inserts

- **Preconditions**: A read file whose tag is recorded, plus an external writer.
- **Steps**:
  1. Modify the middle of the file externally, then emit `PUT >$:` with the stale
     tag.
  2. Repeat with `PUT <1:` and the same stale tag.
  3. Repeat with a payload that mixes `PUT >$:` and an anchored `PUT 50.=50:`.
  4. Emit an `Edit` whose `tag` is well formed but was never recorded for that
     path in this session.
  5. Emit an `Edit` with a `tag` that is not four hex digits.
- **Expected**: Steps 1 and 2 apply with a drift warning, because neither anchor
  can be moved by content drift. Step 3 does not take the position-stable path:
  it goes to recovery and, failing that, to `EDIT_TAG_MISMATCH`. Step 4 returns
  `EDIT_TAG_UNKNOWN` and step 5 returns `EDIT_TAG_REQUIRED`; neither is reported
  as a generic `TOOL_FAILED`.
- **Specs linked**: `03-runtime/18-line-anchored-edit-contract.md` §9, §11,
  `03-runtime/08-error-codes.md` §3.4
- **Acceptance**: E (tools & permissions)
- **Milestone**: M5+
- **Status**: Documented

#### E2E-137: Boundary repair fixes an off-by-one edge and refuses a tie

- **Preconditions**: A read source file with nested closing delimiters.
- **Steps**:
  1. Emit a `PUT N.=M:` whose range includes one trailing `}` that the body does
     not restate, and inspect the result and its warning.
  2. Emit a `PUT N.=M:` whose body restates a line that sits immediately outside
     the range.
  3. Emit a payload constructed so that two distinct repaired texts tie at the
     minimum repair cost.
  4. Emit a payload against a file that already fails to parse, and confirm the
     repair does not retain a row on parse-success evidence alone.
- **Expected**: Steps 1 and 2 apply with a warning naming exactly what was
  repaired, so a silent structural change is impossible. Step 3 returns
  `EDIT_REPAIR_AMBIGUOUS` rather than choosing; step 4 does not invent a
  retention. In every case the file either contains the repaired result described
  in the warning or is untouched.
- **Specs linked**: `03-runtime/18-line-anchored-edit-contract.md` §8.4, §11,
  ADR 0087
- **Acceptance**: E (tools & permissions), Quality
- **Milestone**: M5+
- **Status**: Documented

#### E2E-138: Move, remove, and rollback keep review evidence honest

- **Preconditions**: A project-bound session with Review visible and a read file
  inside the workspace root.
- **Steps**:
  1. Emit `Edit` with a `PUT` op plus `MV DEST` in the same `ops` payload.
  2. Inspect the review records for the tool call and the Review panel rows.
  3. Roll the change back and confirm both the source and the destination
     return to their pre-call state.
  4. Emit `Edit` with `REM`, then roll it back.
  5. After a rollback, emit an `Edit` using the tag the session held before the
     rollback.
  6. Emit `Edit` on a path that does not exist but whose basename and tag match
     exactly one file this session recorded, and inspect the warning.
  7. Repeat step 6 with two recorded candidates sharing that basename and tag.
- **Expected**: Step 1 records a source deletion and a destination creation under
  one tool call; step 3 restores both or neither. Step 4's rollback restores the
  captured bytes, hash-guarded on the full digest rather than the 16-bit tag.
  Step 5 fails rather than editing against content the rollback replaced. Step 6
  rebinds to the real file with a warning, and the write-permission gate is
  evaluated against the rebound path; step 7 declines instead of picking one.
- **Specs linked**: `03-runtime/18-line-anchored-edit-contract.md` §9.2, §13.1,
  `03-runtime/03-tools-and-permissions.md` §4c, ADR 0043, ADR 0087
- **Acceptance**: E (tools & permissions), Quality
- **Milestone**: M5+
- **Status**: Documented

#### E2E-139: Snapshot provenance is per session and bounded

- **Preconditions**: A subagent-capable session (§5f), a second session on the
  same workspace, and a fixture with more files than the snapshot store's path
  bound.
- **Steps**:
  1. Read a file in the parent session, then have a delegate `Edit` that file
     using the parent's tag without reading it first.
  2. Read a file in session A and emit the same `Edit` payload from session B.
  3. Read more distinct paths than the store retains, then edit the
     first-read path with its original tag.
  4. Read one path five times with changing content between reads, then edit
     using the tag from the first read.
  5. Read a file, then read the identical unchanged file twice more at
     different offsets, and confirm one tag covers all three windows.
  6. Restart the app, then emit an `Edit` with a tag from before the restart.
  7. Write a file through a path that a save hook reformats, then `Edit` using
     the tag the write returned.
- **Expected**: Steps 1 and 2 fail — provenance is per reader, and no session
  hands another its tags. Steps 3, 4, and 6 fail with `EDIT_TAG_UNKNOWN` and an
  instruction to re-read, never with a wrong write. Step 5 applies anywhere in
  the union of the three windows without a fourth read. Step 7 applies, because
  the recorded tag describes the bytes that actually landed, and the drift is
  reported as a one-line warning rather than a whole-file diff.
- **Specs linked**: `03-runtime/18-line-anchored-edit-contract.md` §4.2, §4.4,
  §5.4, §13.5, `03-runtime/02-agent-runtime.md` §5f, ADR 0087 §3
- **Acceptance**: E (tools & permissions), Quality
- **Milestone**: M5+
- **Status**: Documented

#### E2E-140: Recoverable edit failures each get one retry before the guard counts

- **Preconditions**: A session with one file read, and a way to make the file
  drift on disk between calls.
- **Steps**:
  1. Let the file drift, then emit an `Edit` with the now-stale tag whose anchors
     cannot be remapped, so it fails with `EDIT_TAG_MISMATCH`.
  2. Re-read, then emit an `Edit` anchored on lines the session never displayed,
     so it fails with `EDIT_LINES_UNSEEN` and a truncated reveal.
  3. Emit an `Edit` on that same path with a malformed op header.
  4. Emit a second `Edit` with a malformed op header.
- **Expected**: Steps 1 and 2 return their own codes with no `terminate` hint —
  each recoverable code spends its single grace on that path, and the turn keeps
  going, so the agent can act on what the error handed it. Step 3 counts as
  attempt 1 and still does not terminate. Step 4 terminates. A successful `Edit`
  inserted anywhere before step 4 resets the count, so the following failure is
  attempt 1 again.
- **Specs linked**: `03-runtime/18-line-anchored-edit-contract.md` §9.3, §11,
  `03-runtime/03-tools-and-permissions.md` §4d, ADR 0087
- **Acceptance**: E (tools & permissions), Quality
- **Milestone**: M5+
- **Status**: Documented

#### E2E-141: An exhausted retry budget ends the turn with a visible, retriable row

- **Preconditions**: A session where `Edit` on one path fails with a
  non-recoverable code every time.
- **Steps**:
  1. Emit two failing `Edit` calls on the same path within one prompt.
  2. Observe the transcript after the agent loop stops.
  3. Send a follow-up prompt in the same session.
  4. Repeat with two failing `apply_patch` shell commands instead of `Edit`.
- **Expected**: The second call carries the termination hint and the loop stops,
  but the turn does not merely complete: the transcript ends on an assistant
  error row with `MUTATION_RETRY_BUDGET_EXHAUSTED`, marked retriable, naming the
  path and the next action, and the same code arrives as an error event. The turn
  is recorded as failed rather than completed with no final message. Step 3
  proceeds normally — the guard's counters are per prompt. Step 4 produces the
  same row with `details.kind` of `patch-command`.
- **Specs linked**: `03-runtime/18-line-anchored-edit-contract.md` §9.3,
  `03-runtime/03-tools-and-permissions.md` §4d,
  `03-runtime/08-error-codes.md` §3.3, ADR 0087
- **Acceptance**: E (tools & permissions), C (chat & stream)
- **Milestone**: M5+
- **Status**: Documented
#### E2E-156: Edit tool succeeds on files with CRLF line endings

- **Preconditions**: A workspace containing a file with Windows-style CRLF
  (`\r\n`) line endings.
- **Steps**:
  1. Use Read to display the file content (Read strips `\r` before returning).
  2. Issue an Edit with `old_string` and `new_string` using LF-only endings
     (as the model always produces from Read output).
  3. Inspect the file on disk after the edit.
- **Expected**: The Edit succeeds with `replacements: 1`. The written file
  preserves CRLF line endings throughout — both in modified and unmodified
  lines. No `MUTATION_RETRY_BUDGET_EXHAUSTED` error occurs.
- **Specs linked**: `03-runtime/18-line-anchored-edit-contract.md` §3.1,
  `03-runtime/03-tools-and-permissions.md`
- **Acceptance**: E (tools & permissions)
- **Milestone**: M5
- **Status**: Documented

#### E2E-142: Background delegation converges through TaskWait and honors permission scopes

- **Preconditions**: A project-bound Agent session whose permission mode can be
  switched between `ask`, `accept-edits`, and `auto`, with a provider whose
  stream can be driven; the four builtin subagents (`explorer`,
  `code-reviewer`, `test-runner`, `fixer`) and a global
  `~/.agents/subagents/readonly.md` definition. Builtins use the default
  `permission: inherit` behavior.
- **Steps**:
  1. Prompt a turn in which the assistant emits two `Task` calls — `explorer`
     on one direction and a second `explorer` on another — in one assistant
     message, then, without ending the turn, continues its own tool calls and
     converges with `TaskWait`.
  2. Confirm the parent's visible text keeps streaming between `Task` and
     `TaskWait` (no dead turn), that the two `Task` rows form one delegation
     card that opens once, and that `TaskWait`'s row shows both reports.
  3. With the session in `ask`, prompt a turn that delegates to `fixer` with a
     multi-file spec. Confirm its `Write`/`Edit`, `Bash`, and external-path
     calls each render a card naming `fixer`. Switch the session to
     `accept-edits` and confirm only `Write`/`Edit` inside the workspace are
     auto-allowed. Switch it to `auto` and confirm the same delegate's
     `Write`/`Edit`, `Bash`, and external `Glob`/`Write` calls all resolve
     without a second authorization card.
  4. Prompt a turn that starts three delegates and then calls `TaskWait` with
     `mode: "any"`, `minCompleted: 1`; confirm it returns as soon as the first
     settles and that the still-running delegates keep running.
  5. Prompt a turn that starts a delegate and then ends the turn without
     `TaskWait`/`TaskStop`; confirm the delegate is stopped at run end and its
     node reads `aborted`, and that the next turn's model context contains no
     delegate rows.
  6. Prompt ten `Task` calls in one turn and one more; confirm the eleventh
     fails as a tool error naming the 10-delegate cap, and that `TaskStop`
     frees a slot so an eleventh delegation can start.
  7. Reload the session; confirm the delegation card, its nodes, and the
     `TaskWait` rows persist and re-render collapsed, and that `TaskWait`
     re-reads a settled delegation's report by id without re-running it.
  8. Prompt a turn where the agent starts two Task calls and then emits visible
     text before calling TaskWait (so Task and TaskWait land in different
     activity parts); confirm the topology card shows "completed" status on
     both nodes once TaskWait returns, not stuck at "running", and that each
     node shows a non-zero runtime duration derived from the delegation
     lifecycle timestamps rather than the immediate `Task` start call.
  9. Edit `~/.agents/subagents/readonly.md` to declare `permission: auto` and reload the
     catalog; confirm the definition still loads but carries a warning, and
     that its delegate still resolves under the session's effective mode (a
     `Write` inside the workspace still raises a permission card).
  10. Prompt a turn that starts a delegate, lets `TaskWait` time out so the
      node still says running, then calls `TaskStop`; confirm the topology
      node and the `TaskStop` row both read `stopped` (not `running`). End the
      turn and reload the session; confirm the card is not labelled working
      and does not keep ticking elapsed.
- **Expected**: `Task` returns immediately with a `delegationId` and the parent
  keeps working; `TaskWait` converges with per-delegation reports and statuses;
  `TaskList`/`TaskStop` drive the lifecycle; a `TaskStop` result and a finished
  turn never leave a live “Subagent working” card; builtin `fixer` inherits the
  selected session permission mode, so `auto` also covers explicit external
  paths without a duplicate authorization prompt while `ask` and
  `accept-edits` retain their approval boundaries; a global definition's
  declared scope is dropped; the per-session running cap of 10 is enforced; no
  delegate outlives its turn; reloaded transcripts keep their delegation
  topology.
- **Specs linked**: `03-runtime/02-agent-runtime.md` §5f/§5f.1/§7.1,
  `03-runtime/03-tools-and-permissions.md` §10.2, `08-meta/decisions-log.md`
  (D242 amends D231), ADR 0089 and ADR 0100
- **Acceptance**: C (conversation), E (tools & permissions), F (persistence),
  Security, Quality
- **Milestone**: M6+
- **Status**: Draft (unit coverage in `packages/agent-runtime`
  `runtime.test.ts` subagent suite and host-core `rpc/mod.rs` delegate-scope
  tests; desktop journey pending)

#### E2E-162: An expanded delegate run scrolls without growing the transcript

- **Preconditions**: A project-bound Agent session with a mocked provider stream
  where one `explorer` delegate performs 40 tool calls and returns a long
  report, plus a `TaskWait` whose joined reports approach the 50k-character
  bound.
- **Steps**: 1) Note the transcript scroll position and the parent's next row,
  then expand the delegation node. 2) Scroll to the end of the delegate's rows
  and keep scrolling. 3) Tab to the run's row area and scroll with the keyboard.
  4) Confirm the run heading and the collapse rail remain visible while the rows
  scroll. 5) Expand the `TaskWait` row and inspect the joined reports and a
  30-entry roster table. 6) Repeat at a short viewport height and at a narrow
  chat width.
- **Expected**: Expanding the node does not push the parent's next row out of
  view: the delegate's rows scroll inside a bounded area at most 420px or 48dvh
  tall. Reaching the end of that area does not chain into scrolling the
  transcript behind it. The area is reachable and scrollable by keyboard with a
  visible focus ring, and the run heading plus the hairline collapse rail stay
  visible and unclipped throughout. The lifecycle row's joined reports and its
  roster table each scroll within their own bounded block rather than stretching
  the page, and the report block remains copyable. At a short viewport the run
  area shrinks with `dvh` instead of overflowing, and at a narrow width no
  horizontal page overflow appears.
- **Specs linked**: `04-ux/08-component-spec.md` §9.9, ADR 0062,
  decisions-log D271
- **Acceptance**: C (conversation), Quality

#### E2E-173: An expanded live delegate run follows its latest output

- **Preconditions**: A project-bound Agent session with a mocked provider
  stream where one `explorer` delegate is still running: it has already
  produced enough thinking and tool rows to overflow the bounded
  `.subagent-run-rows` area, and it continues to append rows and stream an
  answer after the card is expanded.
- **Steps**: 1) Expand the running delegation node and leave the nested
  scroller untouched. 2) Watch new nested rows arrive (thinking, tool calls,
  streamed answer). 3) Scroll the nested area upward to reread an earlier
  tool row while the delegate is still producing output. 4) Click the nested
  jump-to-latest control. 5) Repeat with keyboard scrolling (`Tab` to the
  labelled run group, then `PageUp` / `ArrowUp`). 6) Confirm the parent
  transcript's own follow state is unchanged: if it was pinned it stays
  pinned; if the user had scrolled the transcript up, it stays unpinned.
- **Expected**: Expanding pins the nested scroller to the newest row. While
  pinned, new nested output stays in view without the user scrolling. The
  first real upward gesture pauses nested follow, leaves earlier rows in
  view as new output appends below, and shows a jump-to-latest control over
  the nested scroller (not the parent transcript's control). Clicking it, or
  scrolling back within 48px of the nested bottom, re-pins and jumps to the
  latest nested row. A layout clamp or programmatic follow `scrollTo` does
  not release nested follow. The parent transcript's pin / jump-to-latest
  state is independent. The run heading and collapse rail remain visible and
  unclipped.
- **Specs linked**: `04-ux/08-component-spec.md` §9.9,
  `04-ux/09-interaction-patterns.md` §9.1, decisions-log D271 / D302
- **Acceptance**: C (conversation), Quality
- **Milestone**: M6+
- **Status**: Unit/source-contract covered (`subagent-transcript.test.mjs`,
  `transcript-scroll.test.mjs`); desktop journey pending

#### E2E-161: A delegation lifecycle row reads as a subagent row

- **Preconditions**: A project-bound Agent session with a mocked provider stream
  that starts two delegates (`explorer`, `fixer`) with `Task`, then calls
  `TaskList`, `TaskWait` and `TaskStop`.
- **Steps**: 1) Start both delegates and inspect the collapsed `TaskList` row
  while both are running. 2) Let `explorer` complete and `fixer` fail, then
  inspect the `TaskWait` row's summary, badge and expanded body. 3) Start a
  third delegate reusing the `explorer` definition, call `TaskList`, and read
  the summary. 4) Stop a running delegate and inspect the `TaskStop` row.
  5) Confirm the delegation card's own subagent count is unchanged by all three
  lifecycle rows. 6) Repeat in Chinese.
- **Expected**: Every lifecycle row summarizes by agent name — never by its
  `delegationIds` argument, and no bare UUID appears in a collapsed row. Its
  badge uses the shared subagent status vocabulary: running while any member
  runs, `Failed` / “失败” once a member failed even though a sibling completed,
  and `Stopped by request` / “已按请求停止” for the stopped delegate — including
  when the persisted `TaskStop` snapshot still says `running`. The topology
  card's node matches that stopped outcome and is not labelled working after
  the turn ends. A repeated
  definition is counted (`explorer ×2`) rather than listed twice. The expanded
  body shows the joined reports as a notice followed by one named row per
  subagent with status, runtime and turns, and contains no pretty-printed
  `delegations[]` JSON. The delegation card still reports the number of `Task`
  calls only, so lifecycle rows never inflate the topology counts.
- **Specs linked**: `04-ux/08-component-spec.md` §9.9,
  `03-runtime/02-agent-runtime.md` §5f, ADR 0062, ADR 0089, decisions-log D269
- **Acceptance**: C (conversation), Quality

#### E2E-155: Subagent timeout policy preserves active work and reports expiry

- **Preconditions**: A project-bound Agent session with a delegate definition
  using short test-only `idle-timeout` and `max-duration` overrides; a mocked
  provider stream and a Bash-capable `explorer` definition.
- **Steps**: 1) Run a delegate past 20 turns while it continues emitting
  lifecycle events and confirm it remains active. 2) Let it go idle past the
  configured idle window and inspect `TaskWait`, `TaskList`, the timing log and
  the delegation topology. 3) Run a delegate whose Bash call remains active
  past the idle window and confirm it is not idle-terminated. 4) Let a tool
  execution cross the total-duration limit. 5) Repeat with explicit
  `maxTurns`, invalid timeout frontmatter, and `maxTurns: none`. 6) Stream one
  `message_update` token per interval longer than the idle window would allow
  in silence, with no other event between them, and confirm the delegate is
  never idle-terminated. 7) Let a `TaskWait` expire while its delegate is still
  streaming and read the note the parent receives.
- **Expected**: Unlimited delegates run past 20 turns; idle expiry returns
  `timed_out` with `SUBAGENT_IDLE_TIMEOUT`, duration expiry returns
  `timed_out` with `SUBAGENT_DURATION_TIMEOUT`, and both preserve the latest
  partial report. Tool execution pauses only the idle timer, not total
  duration. Explicit `maxTurns` still returns `truncated`; invalid timeout
  values warn and use defaults; `none` is unlimited. A delegate that only ever
  streams tokens keeps running indefinitely: any agent event re-arms the idle
  timer, so the watchdog fires on silence alone and slow streaming is never
  mistaken for a hang. `TaskWait` expiry reports “Still running after Ns” and
  states that this is not a failure and the delegates keep working, and the
  builtin turn backstops (`explorer` 60, `code-reviewer` 50, `test-runner` 40,
  `fixer` 80) end a non-converging delegate as `truncated` with its partial
  report. The UI shows “Timed out” / “已超时” with the warning outcome styling,
  and Explorer's catalog includes `Bash` while code-reviewer remains read-only.
- **Specs linked**: `03-runtime/02-agent-runtime.md` §5f,
  `03-runtime/08-error-codes.md`, `03-runtime/09-logging-and-observability.md`,
  ADR 0119, decisions-log D254
- **Acceptance**: C (conversation), E (tools & permissions), H (diagnostics), Quality
- **Milestone**: M6+
- **Status**: Covered by unit tests; full desktop journey pending

#### E2E-157: Sidebar scrollbars stay quiet while remaining discoverable

- **Preconditions**: PI-Desktop is open with the expanded sidebar, more
  temporary sessions than the five-row cap, and enough retained project
  sessions to overflow the Projects region.
- **Steps**: 1) Inspect the idle Sessions and Projects scrollbars in light and
  dark themes. 2) Move the pointer into each list and then away from it,
  confirming that only the hovered list's thumb appears. 3) Move the pointer
  back into each list, drag its thumb through the region, and keyboard-focus a
  row to confirm the focused list keeps its thumb available. 4) Scroll the
  list with the wheel or trackpad after moving the pointer away from the thumb.
- **Expected**: Both regions remain independently scrollable and the footer
  stays fixed. At rest each scrollbar is trackless, 6px wide, and transparent;
  hovering or focusing the owning list reveals only its thumb, and dragging
  keeps it visible so navigation remains visually quiet without changing the
  scroll region's width. Chat, code, and Settings scrollbars follow the same
  rest/reveal rule at 8px: transparent until their scroller is hovered or
  scrolling (D300).
- **Specs linked**: `04-ux/07-ui-design-system.md`,
  `04-ux/08-component-spec.md`, `04-ux/09-interaction-patterns.md`
- **Acceptance**: Quality (sidebar polish and independent navigation)
- **Milestone**: M6+
- **Status**: Unit-covered (`interaction-polish.test.mjs`); rendered scenario
  pending

#### E2E-158: Temporary sessions use isolated scratch workspaces

- **Preconditions**: PI-Desktop has a project open, a temporary session can be
  created, and the host data directory is known. The temporary session starts
  with an empty transcript.
- **Steps**:
  1. Create or select a temporary session while the project remains recently
     active, then inspect the empty-home hero.
  2. Confirm the hero uses the temporary-session copy and has no project
     underline or folder-open action; confirm a project session and no active
     session still use their own hero states.
  3. In the temporary session, use Read/Glob/Grep on a file under its
     `<data_dir>/scratch/<sessionId>` root, then Write/Edit a file with a
     workspace-relative path and run a bounded Bash command.
  4. Inspect the tool results and filesystem, then switch back to the project
     and confirm the project root and git status are unchanged.
  5. Enter Plan or Goal in the temporary session and confirm submission still
     fails with the existing project-root requirement.
- **Expected**: A path-less session binds every native tool to its own
  `scratch/<sessionId>` directory, never to the visible or recently active
  project. Relative paths work inside that scratch root, containment and
  permission rules remain active, and no project artifact is created. The
  temporary hero is localized and has no project action; project and no-session
  hero states remain unchanged. Plan/Goal retain their project-root boundary.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md` §4/§4b,
  `03-runtime/10-session-state-machine.md`, `04-ux/01-ui-ia.md`,
  `04-ux/02-i18n-english-first.md`, ADR 0124
- **Acceptance**: C (conversation), D (workspace), E (tools & permissions),
  F (persistence), Security, Quality
- **Milestone**: M6+
- **Status**: Unit-covered (`crates/host-core/src/rpc/mod.rs`,
  `temporary-session-workspace.test.mjs`); rendered desktop journey pending

#### E2E-159: A long transcript keeps a bounded mounted window

- **Preconditions**: PI-Desktop is open on a session whose transcript is
  substantially longer than one `session.get` page (several hundred messages,
  including fenced code blocks and expanded tool activity), on a memory-
  constrained Windows machine where the regression was reported.
- **Steps**:
  1. Activate the session and confirm the first paint lands at the newest
     message without a top-of-transcript flash.
  2. Record the renderer's transcript row count and heap usage, then scroll
     upward continuously to the oldest loaded message and past it so older pages
     are fetched.
  3. At each point where the view stops advancing, confirm it resumes: earlier
     rows appear without the rows under the cursor being pushed down, and the
     earlier-messages indicator appears only when a page is actually fetched.
  4. Re-record the row count and heap usage after paging far back, then scroll
     back to the bottom and send a new prompt.
  5. While the answer streams, confirm following stays pinned and typing in the
     composer stays responsive. Scroll up mid-stream and confirm follow releases
     and the jump-to-latest pill appears.
  6. Hover and click conversation minimap dashes at several heights, then switch
     to another session and back.
  7. Activate a long session whose newest page collapses to less than one
     viewport (one tool-heavy turn) and confirm the outline is present with its
     earlier-history continuation, that clicking it reveals earlier turns, and
     that it keeps advancing without a manual scroll gesture until the whole
     history is loaded and mounted.
  8. Confirm the continuation disappears once nothing earlier remains, and that a
     short completed conversation that fits one viewport still shows no rail.
- **Expected**: Mounted transcript rows stay bounded by the window rather than
  growing with how far back the user scrolled, so the recorded row count and heap
  usage after paging far back stay close to the values recorded before it.
  Upward travel is continuous: growing the window and fetching a page both keep
  the viewport anchored to the row being read. Every minimap message dash jumps to
  a real row. Streaming stays smooth with the composer responsive, pinned-follow
  and jump-to-latest behave as specified, and switching away and back paints the
  retained pane at the position it was left. Earlier history is never stranded: with rows withheld or an older
  page pending, the outline stays available with an actionable earlier-history
  continuation and keeps advancing when the top boundary remains visible, even
  when the mounted tail does not overflow one viewport (D269). The continuation
  and the rail disappear once the full history is loaded and mounted and the
  transcript fits one page.
- **Specs linked**: `04-ux/08-component-spec.md` §7 and §8,
  `03-runtime/04-data-storage.md`, ADR 0120, ADR 0127, ADR 0130, D108, D269
- **Acceptance**: C (conversation), H (diagnostics), Quality
- **Milestone**: M6+
- **Status**: Unit-covered (`transcript-window.test.mjs`,
  `conversation-minimap.test.mjs`, `interaction-performance.test.mjs`); rendered
  desktop journey and the low-memory Windows measurement pending

#### E2E-160: Dragging the window across displays keeps the dropped position

- **Preconditions**: PI-Desktop is open on a machine with two displays arranged
  side by side, ideally with different work areas (a menu bar or taskbar on one
  only, or different resolutions). Run the case once with the work panel closed
  and once with it open at a committed width.
- **Steps**:
  1. Note the window position on the first display, then drag it by its
     titlebar onto the second display and release the pointer.
  2. Confirm the window stays where it was released: no jump, no snap to the
     display edge, and no vertical shift inherited from the first display.
  3. Drag the window so it straddles the boundary between the two displays and
     release it, then confirm it settles fully inside one display's work area
     without changing size.
  4. With the panel open, repeat the cross-display drag and confirm the panel
     remains an internal column at its committed renderer width; no reservation
     is re-planned and no panel-specific native geometry is applied.
  5. Drag the window back to the first display and confirm the application
     bounds continue to follow the dropped position without panel expansion.
  6. Leave the window on the second display, quit, and relaunch.
  7. Disconnect the second display while the window is on it, then reconnect it.
- **Expected**: Every pointer release leaves the window at the position the user
  dropped it on the display they dropped it on. A straddling drop is normalized
  into one work area without a resize. Relaunch reopens the window on the
  display it was last used on rather than the one it started on. Removing the
  display the window occupied still relocates it to a live display, and
  reconnecting preserves the same application bounds contract; no work-panel
  reservation is restored.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `04-ux/09-interaction-patterns.md` §8, ADR 0132, ADR 0151
- **Acceptance**: F (persistence), Quality
- **Milestone**: M6+
- **Status**: Unit-covered (`work-panel-window.test.mjs`: cross-display drag
  adoption, previous-display replan regression, work-area clamping); the
  two-display desktop journey and the relaunch/hotplug legs are pending

#### E2E-167: Native edge resize stays smooth and persists the settled bounds

- **Preconditions**: PI-Desktop is open in a normal, non-maximized window on
  macOS, Windows, or Linux. Run the case with the work panel closed and once
  with it open at a committed width.
- **Steps**:
  1. Drag each reachable window edge and one corner slowly, including a brief
     pause during the gesture, then release.
  2. Confirm the window follows the pointer continuously and does not jump to
     the default size or display edge while the pointer is down.
  3. With the work panel open, drag its inner divider slowly in both directions
     and confirm the panel width changes inside the existing window while the
     native bounds stay fixed. Repeat below the panel minimum and above its
     maximum, then verify the target clamps to `244..720px`.
  4. Close and relaunch the app after the resize settles.
- **Expected**: Native edge and corner hit regions remain available in frameless
  chrome, the minimum size remains 1040×700, and the recovery watchdog does not
  compete with a slow resize stream. The renderer-owned divider updates the
  bounded panel target without changing native bounds; the last settled window
  bounds and the committed panel width reopen after relaunch. No temporary
  work-panel reservation width is persisted or restored.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `04-ux/01-ui-ia.md`, `04-ux/07-ui-design-system.md`,
  `04-ux/08-component-spec.md`, `04-ux/09-interaction-patterns.md`,
  ADR 0029 / ADR 0151
- **Acceptance**: A (app shell), F (persistence), Quality
- **Milestone**: M6+
- **Status**: Unit/source-contract covered; native desktop edge/corner journey
  remains pending

#### E2E-168: Expanded sidebar width follows an anchored resize gesture

- **Preconditions**: PI-Desktop is open in the chat shell with the sidebar
  expanded and a retained project/session visible.
- **Steps**:
  1. Drag the sidebar's right-edge handle from its default width toward both
     directions, including a slow drag with a brief pause, then release.
  2. Confirm the main pane reflows continuously and the sidebar does not jump
     when the pointer is pressed.
  3. Repeat with a target below the minimum and above the maximum; release and
     confirm the width stops at 240px and 520px respectively.
  4. Focus the edge handle and press ArrowLeft/ArrowRight, Home, and End;
     inspect the separator's current ARIA value.
  5. Start a resize, press Escape or cancel the pointer, then restart the app.
     Collapse and re-expand the sidebar as a separate check.
- **Expected**: The handle is discoverable on direct hover/focus without a
  full-height white/accent rail when the sidebar body is hovered, has no native
  window drag or text-selection side effect, and remains anchored to the press
  point. MainChat follows the live width. Pointer release saves one clamped
  preferred width; Escape/cancellation restores the starting width without
  saving it. Keyboard changes commit immediately and expose localized width
  semantics. The saved width survives relaunch and is restored after sidebar
  collapse; collapse does not convert the preferred width into the icon-rail
  width.
- **Specs linked**: `04-ux/01-ui-ia.md`, `04-ux/07-ui-design-system.md`,
  `04-ux/08-component-spec.md`, `04-ux/09-interaction-patterns.md`,
  ADR 0141, D280
- **Acceptance**: A (app shell), F (persistence), Quality
- **Milestone**: M6+
- **Status**: Unit/source-contract covered (`sidebar-preferences.test.mjs`,
  `sidebar-resize.test.mjs`); rendered desktop drag and relaunch journey
  remains pending

#### E2E-162: A vendor account and an AI service offer the same model picker

- **Preconditions**: One signed-in vendor (OAuth) account and one API-key AI
  service, both with discoverable models, and at least one of them exposing a
  reasoning-capable model.
- **Steps**: 1) Open Settings → Model configuration. 2) Edit the AI service,
  expand a chosen model's Advanced disclosure, and note its context window, max
  output and thinking chips; cancel. 3) Edit the vendor account and do the same
  on one of its chosen models. 4) Toggle a thinking level on a reasoning-capable
  account model and save. 5) Reopen the account editor and read that model's
  chips. 6) For an OpenAI Codex account, inspect `gpt-5.6-sol` (or another
  account model also published under models.dev's `openai` provider) and confirm
  its published context/output limits and reasoning levels are present. 7) In
  the account editor, hand-type a custom model ID the catalog does not publish,
  enable a thinking level on it, and save.
- **Expected**: Both dialogs render the same picker — the same discovered list,
  the same search, the same free-form custom-model entry, the same chosen pane,
  the same Advanced disclosure and the same chips — so the account editor is no
  longer missing the advanced controls. A level enabled on an account model
  persists and reappears when the editor is reopened, including a level the
  catalog does not publish. OpenAI Codex's `openai-codex` adapter key resolves
  the matching `openai` models.dev record, so `gpt-5.6-sol` is not shown with
  generic 128,000 / 8,192 / no-reasoning defaults. A model with no published
  record keeps its explicit levels and starts with all choices available for
  manual opt-in. The account's default model stays the head binding.
- **Specs linked**: `04-ux/06-settings-ia.md`,
  `04-ux/08-component-spec.md` §19, `03-runtime/11-provider-model-system.md`
  §10, `08-meta/decisions-log.md` (D270 refines D237/D240)
- **Acceptance**: B (model config), Quality

#### E2E-163: Advanced model settings own the default thinking level and attachment capabilities

- **Preconditions**: One AI service with discoverable models, including a
  reasoning-capable model that publishes at least three thinking levels, a
  vision-capable model, and a model models.dev describes as text-only.
- **Steps**: 1) Open Settings → Model configuration, edit the service and expand
  a reasoning-capable model's Advanced disclosure. 2) Enable at least three
  thinking levels and pick a default that is not the lowest enabled level, then
  save. 3) Reopen the editor and read the default selector. 4) Disable the level
  currently chosen as default and read the selector again. 5) Start a new session
  on that model and open the composer reasoning menu. 6) Back in Advanced, on
  the text-only model, turn Image input on, save, reopen and confirm the switch
  reports itself as overridden. 7) Attach an image in a session on that model.
  8) Tick the same box back to the value models.dev publishes, save, and reopen.
  9) Turn PDF input on for a model whose catalog entry omits it, save, and
  attach a PDF. 10) Configure a model, then point the service at an endpoint that
  no longer lists it, reopen the editor and read that model's capability boxes.
- **Expected**: The default thinking level is selectable among the levels the
  binding enables and nothing else; it persists across reopen and is the level
  the home draft chip and a newly persisted session start at, not the strongest
  enabled level. Disabling the chosen default moves it to a still-enabled
  level rather than leaving a level the runtime would clamp away, and the
  selector is absent when a binding enables one level or none. An answered
  Image input switch overrides the published capability in both directions and
  survives reopen, so a model the catalog calls text-only transports the attached
  image as an image content block. Ticking a box back to the published value
  stores "follow the catalog" rather than an equal-valued override, so a later
  catalog correction still reaches the binding without any separate reset
  control. All seven canonical thinking chips remain available even when the
  catalog publishes no reasoning support, so an endpoint can be opted in
  explicitly. PDF input records the capability without changing transport: the PDF
  stays a bounded file reference the model reads with its file tools. Each
  capability is one checkbox with a short label and no per-row explanatory copy.
  A configured model absent from live discovery still shows its published
  capabilities rather than reading as undescribed.
- **Specs linked**: `03-runtime/11-provider-model-system.md` §6.2,
  `03-runtime/12-provider-config-schema.md`, `04-ux/08-component-spec.md` §19
- **Acceptance**: B (model config), Quality

#### E2E-164: Context compaction preserves the active task boundary

- **Preconditions**: A provider fixture can complete multiple sequential tasks,
  trigger an automatic checkpoint at a terminal boundary, trigger an active-turn
  checkpoint during a tool loop, and restart a session.
- **Steps**:
  1. Complete task A and task B in one session with distinct instructions and
     visible completion replies.
  2. Trigger a checkpoint after a completed turn, then send task C and capture
     the next provider request context.
  3. Trigger compaction while task D still has tool results or `toolUse`
     pending, and capture the next provider request.
  4. Restart and reopen the session, then send another prompt.
- **Expected**: A completed-turn checkpoint has an empty retained tail; the next
  request contains its summary plus task C and no bare A/B prompts. An active
  checkpoint retains exactly the latest active user prompt, with no older user
  prompts or pre-boundary assistant/tool messages. Restart honors
  `retainedTailMode`, and legacy multi-user tails normalize to the latest user
  message. The visible transcript remains complete and checkpoint rows remain.
- **Specs linked**: `03-runtime/02-agent-runtime.md`,
  `03-runtime/04-data-storage.md`, `03-runtime/16-tool-result-limits.md`,
  `08-meta/decisions-log.md` (D275), ADR 0136
- **Acceptance**: C (chat/stream), F (persistence), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`packages/agent-runtime/src/runtime.test.ts`,
  `context-compaction.test.mjs`); provider/UI journey Draft

#### E2E-165: Concurrent subagents coordinate through the A2A protocol

- **Preconditions**: Agent mode with two user subagent definitions that each
  declare a working tool plus the `A2A` tool — one write-capable
  (`tools: Read, Edit, A2A`) and one read-only (`tools: Read, Grep, A2A`).
  A third definition declares only `A2A`. A fourth declares no A2A tool. The
  host advertises `"a2a"` at handshake (protocol v10).
- **Steps**: 1) Start both A2A-capable delegates in one assistant message; on
  spawn each is registered with the host-core broker and receives a capability
  token. 2) Each calls `A2A(action="discover")` and finds the other in the
  host's agent registry. 3) One delegate (the requester) sends a message to
  the other (the worker) with `A2A(action="send")`, creating a task addressed to
  the worker. 4) The worker calls `A2A(action="wait")` and receives the
  streaming `a2a.task.event` addressed to it, then reads the task with
  `A2A(action="get")`. 5) The worker finishes the task with
  `A2A(action="complete")` (equivalently `a2a.tasks.status`), driving it to the
  terminal `completed` state; the requester, parked in `A2A(action="wait")`,
  wakes on the terminal `a2a.task.event` routed to it as the worker's
  counterpart and reads the final message. 6) Delegate to the `A2A`-only
  definition. 7) Delegate to the definition with no A2A tool. 8) Inspect the
  parent's own tool list and the reports it receives.
- **Expected**: `discover` returns the other registered agent (each caller's own
  Agent Card excluded), with cards derived from the `SubagentDefinition`. A send
  creates a durable `a2a_tasks` row in state `submitted`/`working` carrying
  `agentName` (the worker) and `requesterName` (the sender); the worker's `wait`
  wakes on the creation `a2a.task.event` addressed to it (`recipient` = its peer
  id) rather than holding to the timeout; `get` returns the task and its bounded
  history. The worker's `complete` drives the task to the terminal `completed`
  state and routes the terminal event to the requester (the caller's
  counterpart), which wakes its `wait`; no further transition is accepted
  (`A2A_TASK_TERMINAL`). The `A2A`-only definition is refused at `Task`
  time as declaring only coordination tools. The definition with no A2A tool
  receives no A2A guidance and behaves exactly as before. `A2A` never appears in
  the parent's tool list, no A2A traffic appears in the parent's model context,
  and A2A tool calls appear in the transcript attributed to the calling delegate
  under its `Task` row. On settle each delegate is deregistered and its token
  invalidated.
- **Specs linked**: `03-runtime/02-agent-runtime.md` §5f.2,
  `03-runtime/06-host-rpc-protocol.md` §4,
  `03-runtime/03-tools-and-permissions.md` §10.2,
  `08-meta/decisions-log.md` (D277, D318), ADR 0147, ADR 0162
- **Acceptance**: E (tools & permissions) + C (chat/stream) + Security
- **Milestone**: M5
- **Status**: Draft

#### E2E-165b: A2A push notification and capability enforcement

- **Preconditions**: Agent mode with two user subagent definitions that each
  declare a working tool plus the `A2A` tool, delegated concurrently in one
  session (one `contextId`). The host advertises `"a2a"` at handshake.
- **Steps**: 1) One delegate sends a message creating a task, then sets a push
  config for that task with `A2A`/`a2a.tasks.pushNotificationConfig.set`. 2) The
  task advances; the broker emits an `a2a.push` notification for the subscribed
  task. 3) A call is replayed with a token that has been invalidated by
  deregister, and a call is made against a task the caller does not own.
- **Expected**: The push config is stored host-side and readable with
  `pushNotificationConfig.get`; a status change delivers an `a2a.push`
  notification shaped `{ recipient, recipientContextId, contextId, taskId,
  token?, status }` to the subscribed agent. A call bearing an invalidated
  token fails with `A2A_UNKNOWN_TOKEN`, and addressing a task the caller does
  not own fails with `A2A_UNKNOWN_AGENT` / `A2A_UNKNOWN_TASK`; a terminal task
  refuses further transitions with `A2A_TASK_TERMINAL`. The capability token is
  never present in the model-visible transcript.
- **Specs linked**: `03-runtime/02-agent-runtime.md` §5f.2,
  `03-runtime/06-host-rpc-protocol.md` §4, ADR 0147, ADR 0162
- **Acceptance**: E (tools & permissions) + C (chat/stream) + Security
- **Milestone**: M5
- **Status**: Draft

#### E2E-165c: A2A coordinates delegates across sessions

- **Preconditions**: Agent mode with two open sessions, each with a user
  subagent definition that declares a working tool plus the `A2A` tool. The
  host advertises `"a2a"` at handshake.
- **Steps**: 1) Start an A2A-capable delegate in session A and another in
  session B. 2) The session-A delegate calls `A2A(action="discover")` and
  finds the session-B agent (card carries a different `contextId`). 3) Session
  A sends a message to that peer with `A2A(action="send")`, creating a task
  whose `contextId` is session A and whose `agentName` is the session-B peer.
  4) The session-B delegate's `A2A(action="wait")` wakes on the creation
  `a2a.task.event` (`recipient` = its peer id, `recipientContextId` = session
  B); session A's runtime does not deliver that event to any local waiter.
  5) Session B finishes the task with `A2A(action="complete")`; session A's
  parked `wait` wakes on the terminal event. 6) A third agent that is not a
  party to the task attempts `get` / `complete` on it.
- **Expected**: Cross-session discover, send, wait, and complete succeed.
  The task is durable under session A's `contextId`. Events are delivered only
  to the runtime whose `sessionId` equals `recipientContextId`. The stranger
  is rejected with `A2A_UNKNOWN_AGENT`. If both sessions requested the same
  definition name, the second register returns a suffix-uniquified `agentId`
  and that is the address used in step 3. Delegate `discover` does not list
  parent cards.
- **Specs linked**: `03-runtime/02-agent-runtime.md` §5f.2,
  `03-runtime/06-host-rpc-protocol.md` §4, ADR 0162
- **Acceptance**: E (tools & permissions) + C (chat/stream) + Security
- **Milestone**: M5
- **Status**: Draft

#### E2E-165d: Parent agents collaborate across conversations

- **Preconditions**: Two Agent-mode sessions on the same host, each with a
  live runtime (at least one agent prompt this process). The host advertises
  `"a2a"` at handshake.
- **Steps**: 1) Session A's parent calls `A2A(action="discover")`. 2) Session
  A sends a note to session B's parent with `A2A(action="send")`. 3) Session
  B is idle; the user later sends a prompt in session B. 4) Session A's
  parent tries `A2A(action="send")` to a running subagent in either session.
- **Expected**: Discover lists the other session's parent (`kind: "parent"`,
  title in the description, a different `contextId`) and does not list
  subagents. The send creates a durable task. Session B's next prompt is
  prefixed with the inbound A2A note so the parent model can reply. Send to
  a subagent fails with `A2A_UNKNOWN_AGENT`. Plan/Goal sessions do not
  expose parent `A2A`.
- **Specs linked**: `03-runtime/02-agent-runtime.md` §5f.2,
  `03-runtime/06-host-rpc-protocol.md` §4, ADR 0164
- **Acceptance**: E (tools & permissions) + C (chat/stream) + Security
- **Milestone**: M5
- **Status**: Draft

#### E2E-166: Subagent model selection

- **Preconditions**: Agent mode; at least one provider has two configured model
  bindings; a builtin subagent definition is available.
- **Steps**: 1) Enable the delegation checkbox for one model binding, save the
  provider, reopen it, and confirm the checkbox remains enabled; restart the
  app, reopen the provider again, and confirm it is still enabled. 2) Start a
  session and inspect the parent agent's system prompt for the delegation model
  summary. 3) Delegate a Task with `model: "provider/modelId"` pointing to the
  enabled binding. 4) Delegate a Task with `model:` pointing to a binding that
  is not enabled for subagents. 5) Delegate a Task with `model:` pointing to a
  model that is not configured at all. 6) Delegate a Task with no `model:`
  parameter and a definition that has a frontmatter model pin. 7) Delegate a
  Task with no `model:` parameter and a definition that has no frontmatter
  model pin.
- **Expected**:
  1. Saving and reopening the provider preserves the
     `availableForSubagents` opt-in, including after an application restart.
  2. The delegation model summary appears in the parent's system prompt listing
     every model marked `availableForSubagents`.
  3. The Task tool accepts the `model` parameter and the delegate runs on the
     specified model, not the session model.
  4. If the model is not configured or not enabled for delegation, the Task
     returns a tool error listing available models.
  5. Resolution priority is Task.model parameter → definition frontmatter pin →
     session model.
  6. On-demand resolution succeeds for models enabled in provider settings via
     the `provider.resolveSubagentModel` RPC.
- **Specs linked**: `03-runtime/02-agent-runtime.md` §5f,
  `03-runtime/11-provider-model-system.md` §7,
  `03-runtime/12-provider-config-schema.md` §2,
  `08-meta/decisions-log.md` (D278)
- **Acceptance**: C (chat/stream) + B (model configuration) + E (tools)
- **Milestone**: M6+
- **Status**: Draft

#### E2E-170: Shell titlebars use borderless chrome

- **Preconditions**: PI-Desktop is open in chat, at least one destination page,
  and Settings on a supported light or dark theme. On Windows/Linux, renderer-
  drawn window controls are visible.
- **Steps**: 1) Inspect the top band on the chat, destination, and Settings
  surfaces. 2) Switch between light and dark themes and repeat. 3) On
  Windows/Linux, inspect the window-control band and its boundary with the
  adjacent surface. 4) Drag the titlebar and activate each window-control
  button.
- **Expected**: The shared 46px top band remains stable and draggable, but its
  lower edge has no visible border line in either theme or route. The
  Windows/Linux control band has no bottom line; only its existing faint side
  seam separates the controls from the adjacent surface. Focus rings, hover
  states, window actions, and content clearance remain unchanged.
- **Specs linked**: `04-ux/01-ui-ia.md`, `04-ux/07-ui-design-system.md`,
  `04-ux/08-component-spec.md`
- **Acceptance**: A (app shell), Quality
- **Milestone**: M6+
- **Status**: Unit/source-contract covered (`topbar-consistency.test.mjs`,
  `settings-drag-region.test.mjs`, `window-menu.test.mjs`); rendered light/dark
  desktop journey remains pending

#### E2E-172: Mid-turn thinking pick does not collapse an unpinned session menu

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
  (do not run E2E locally unless explicitly requested)

#### E2E-174: Binding default thinking level seeds drafts and new sessions

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

#### E2E-175: A paged Read is not shown as truncated

- **Preconditions**: A project-bound Agent session; the workspace contains a
  text file of at least 3000 lines whose lines are shorter than 16,384
  characters, plus a fixture whose first line exceeds that cap.
- **Steps**:
  1. `Read` the long file with no `offset`/`limit`.
  2. `Read` the same file with `offset` equal to the reported next offset and
     a modest `limit`.
  3. `Read` the over-long-line fixture.
  4. Grep a token that matches more than the default `headLimit`.
- **Expected**:
  - Step 1 returns the default 2000-line window, `truncated: false`, no
    truncated chip, `totalLines` of the whole file, and a `notice` naming the
    next offset. It does not tell the model to Grep.
  - Step 2 continues without overlap and stays `truncated: false`.
  - Step 3 sets `truncated: true`, counts the clipped line in `notice`, and
    shows the truncated chip.
  - Step 4 sets `truncated: true` because remaining matches exist, and shows
    the chip.
- **Specs linked**: `03-runtime/16-tool-result-limits.md` §2 / §5,
  `04-ux/08-component-spec.md` §9.2, `08-meta/decisions-log.md` (D306)
- **Acceptance**: C (chat & stream), E (tools & permissions)
- **Milestone**: M5
- **Status**: Unit-covered (host-core `tools` tests)

#### E2E-176: Settings Info opens a prefilled GitHub bug form

- **Preconditions**: Settings can be opened; the machine can launch a system
  browser.
- **Steps**: 1) Open Settings → Info. 2) Confirm the Application row shows the
  current app version. 3) Search settings for the Report a problem label.
  4) Activate Open GitHub.
- **Expected**: The row is indexed by Settings search and stays on Info. The
  action calls `pi-desktop/app/openFeedback` with no URL from the renderer.
  Main opens `https://github.com/vastsa/PI-Desktop/issues/new` with
  `template=bug_report.yml` and prefills `app-version`, `os`, and
  `environment`. The GitHub bug form still requires description, reproduction
  steps, expected, actual, version, and OS; blank issues remain disabled.
- **Specs linked**: `04-ux/06-settings-ia.md`, `03-runtime/01-ipc-protocol.md`,
  `06-delivery/03-ai-development-workflow.md`, `08-meta/decisions-log.md`
  (D313), ADR 0157
- **Acceptance**: H (diagnostics), Quality
- **Milestone**: M6+
- **Status**: Unit/source-contract covered (`github-feedback.test.ts`,
  `feedback.test.mjs`); rendered desktop journey remains pending
  (do not run E2E locally unless explicitly requested)

#### E2E-177: Switching a long running session keeps the newest prompt in view

- **Preconditions**: A session has stayed open long enough that the renderer
  holds more than the newest-100 durable page (hundreds of user/assistant/tool
  rows); a second session exists so a switch is possible.
- **Steps**: 1) Interrupt an in-flight reply if needed, then send a new
  prompt. 2) While that turn is still running, switch to the other session and
  back. 3) Confirm the newest user row (and any streaming tail) is at the
  bottom of the transcript and the session still shows as running. 4) Optional:
  Stop, switch away and back; the same newest rows remain in chronological
  order.
- **Expected**: Revalidation does not append older live history after the
  bounded durable page. The mounted trailing window still shows the just-sent
  prompt and the live tail. The turn continues in the background across the
  switch. Stop is not required to make the prompt visible again.
- **Specs linked**: `04-ux/08-component-spec.md` §1.6 / §3.5,
  `04-ux/09-interaction-patterns.md` (session isolation), ADR 0120, ADR 0137,
  `08-meta/decisions-log.md` (D261, D317)
- **Acceptance**: C (conversation & stream), F (persistence), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`session-transcript.test.mjs` D317 cases); full
  desktop journey Draft (do not run E2E locally unless explicitly requested)

#### E2E-178: A missing sessions row is restored so the outbox can drain

- **Preconditions**: A session has a live `sessions/<id>.jsonl` and queued
  turns in `session-message-outbox.json`, but its row is gone from
  `pi.sqlite` `sessions` (WAL/index loss).
- **Steps**: 1) Confirm the sidebar no longer lists the session and
  `session.appendMessage` would fail `session not found`. 2) Restart the
  app (or otherwise complete a host handshake that flushes the outbox).
  3) Optional: delete the session and confirm its outbox entries are
  dropped rather than resurrected.
- **Expected**: Host boot reinserts the sessions row from the JSONL and
  rebuilds the search index. The outbox drains without pausing at the
  head. The conversation returns to the sidebar with its messages. A
  user-deleted session is not recreated from leftover outbox entries.
- **Specs linked**: `03-runtime/04-data-storage.md`,
  `03-runtime/06-host-rpc-protocol.md`, `03-runtime/07-process-model.md`,
  ADR 0041, `08-meta/decisions-log.md` (D318)
- **Acceptance**: C (conversation & stream), F (persistence)
- **Milestone**: M5
- **Status**: Unit-covered (host-core orphaned-session restore tests,
  `persistence-outbox.test.mjs`); full desktop journey Draft (do not run
  E2E locally unless explicitly requested)

#### E2E-179: Parent tools after a Task fan-out stay outside the delegation card

- **Preconditions**: A project-bound Agent session whose provider stream can
  emit two `Task` calls in one assistant message and then keep working — think,
  `Read`, `Grep` — before a `TaskWait`.
- **Steps**: 1) Prompt a turn that fans out two delegates, then continues with
  parent thinking and workspace reads while at least one delegate is still
  running. 2) Inspect the expanded delegation card and the rows below it.
  3) Let the delegates settle and inspect elapsed time on the card versus the
  parent processing group. 4) Reload the session and re-expand the card.
- **Expected**: The delegation card contains only the main-agent root and the
  two `Task` nodes. Parent thinking, `Read`, `Grep`, and `TaskWait` render in a
  separate processing group, not flush against the subagent tile and not under
  a “Subagent working” header. The card keeps inset from its tile edge. While a
  delegate is still running the card stays labelled working, remains open, and
  ticks elapsed from that fan-out's own timestamps even after the parent has
  moved on. Reload preserves the same split.
- **Specs linked**: `04-ux/08-component-spec.md` §9.9, ADR 0062,
  decisions-log D265, D319
- **Acceptance**: C (conversation), Quality
- **Milestone**: M6+
- **Status**: Unit-covered (`assistant-turns.test.mjs`,
  `subagent-topology.test.mjs`, `subagent-transcript.test.mjs`); desktop
  journey pending (do not run E2E locally unless explicitly requested)
#### E2E-180: Sent file references stay chips and open on click

- **Preconditions**: An Agent session in a workspace that contains a nested
  source file, an HTML file, and a file whose name contains whitespace. The
  composer can also paste an OS file into session scratch.
- **Steps**: 1) Attach a workspace source file, a workspace HTML file, a
  whitespace-named file, and a pasted scratch file via composer chips, then
  send. 2) Inspect the user bubble. 3) Click the HTML chip, then click a
  non-HTML chip.
- **Expected**:
  - Each sent reference renders as a compact leaf-name chip (icon + name),
    not as a full `@path`. The tooltip and accessible name keep the
    canonical path. Quoted and scratch-absolute paths are included.
  - Clicking the HTML chip opens the work-panel browser on that file.
  - Clicking any other allowed file opens it with the OS default application.
  - The persisted user message still contains the canonical `@path` text for
    the agent.
- **Specs linked**: `04-ux/08-component-spec.md` §8.3 / §11.8,
  `04-ux/09-interaction-patterns.md` §8a.2, `03-runtime/01-ipc-protocol.md`,
  ADR 0163, `08-meta/decisions-log.md` (D320)
- **Acceptance**: C (conversation & stream), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`chat-links.test.mjs`, `transcript-file-chips.test.mjs`,
  `fs-panel-guard.test.mjs`); full UI journey Draft (do not run E2E locally
  unless explicitly requested)

#### E2E-181: An imported skill is listed in the next session catalog

- **Preconditions**: Settings > Agent > Skills is open. A conventional
  `<skill>/SKILL.md` document has a non-ASCII frontmatter name and a folded
  YAML description. An empty Agent session is available on the same project
  the skill will be imported into.
- **Steps**:
  1. Import the `SKILL.md` into Global, then into the selected project.
  2. Confirm the Skills page shows the display name, the ASCII id (directory
     name, not `skill`), and the flattened description.
  3. Start a new Agent session on that project and ask the agent to use the
     skill by display name.
  4. Repeat with a second directory skill that also lacks an ASCII name, and
     with a skill whose description is a `|` block.
- **Expected**:
  - Import succeeds. The catalog lists both skills with distinct ids.
  - The next session's system prompt includes each skill's id, name, and
    flattened description. The `Skill` tool loads the body by that id.
  - A misspelled `Skill` id lists user skill ids among the available skills,
    not only plugin ids.
  - Neither document is dropped because its title is non-ASCII or because both
    files are named `SKILL.md`.
- **Specs linked**: `03-runtime/01-ipc-protocol.md` §12b,
  `07-plugins/01-plugin-system.md` §12.3, `08-meta/decisions-log.md` (D174,
  D194)
- **Acceptance**: E (tools & permissions), Quality
- **Milestone**: M5
- **Status**: Unit-covered (host-core `user_skills` / `agent_capabilities`
  tests, `apps/desktop/test/plugin-skills.test.mjs`); full UI journey Draft
  (do not run E2E locally unless explicitly requested)

#### E2E-182: Relative file paths in chat and markdown preview open

- **Preconditions**: An Agent session in a workspace that contains
  `apps/desktop/src/App.tsx`, `docs/adr/0163-transcript-file-reference-chips.md`,
  and `docs/spec/00-baseline.md`.
- **Steps**: 1) Open an existing session whose transcript already contains
  assistant markdown. 2) Prompt a turn whose assistant reply mentions
  `apps/desktop/src/App.tsx` as a bare path, as inline code, and as a
  markdown link. 3) Click each. 4) Open the ADR markdown file in the work-panel
  files viewer and click a `../spec/00-baseline.md` link.
- **Expected**:
  - Opening the session paints the transcript without throwing.
  - Each chat path opens the work-panel files viewer on
    `apps/desktop/src/App.tsx`.
  - The markdown-file `../` link opens `docs/spec/00-baseline.md`, not a
    workspace-root `spec/00-baseline.md`.
  - A `../../../outside.ts` link from `docs/adr` stays inert.
- **Specs linked**: `04-ux/08-component-spec.md` §8.3,
  `08-meta/decisions-log.md` (D322)
- **Acceptance**: C (conversation & stream), D (workspace), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`chat-links.test.mjs`,
  `markdown-prose-style.test.mjs`); full UI journey Draft (do not run E2E
  locally unless explicitly requested)

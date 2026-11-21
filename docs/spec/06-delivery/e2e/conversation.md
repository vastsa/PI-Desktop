# E2E Scenarios: Conversation and Sessions

## E2E-stop-navigation-running-state

Hold the history read after a successful local Stop, switch to another running session, then resolve the older session's history. Verify only the stopped session is settled, the new transcript remains and its toolbar still offers Stop. Also navigate synchronously during the hydration commit to exercise the final state writer. Coverage: `stop-navigation-running-state.test.mjs`, related smart-stop/terminal regressions, and `scripts/e2e-stop-navigation-running-state.mjs` using the production store and ComposerToolbar in Electron.

## E2E-native-stop-refresh-failure

Click the production Composer Stop button for a Native Pi source. Let abort succeed and reject the follow-up session detail read. Verify the toolbar returns to Send, the session running flag clears, the prior transcript remains, and the read error is shown. The regression also covers remote and rejected Stop. Coverage: `native-stop-refresh-failure.test.mjs` and `scripts/e2e-native-stop-refresh-failure.mjs` with real Electron, production store/toolbar and controlled API results.

> Part of the [E2E test plan](../04-e2e-test-plan.md). Sessions, transcripts, the composer, streaming, queueing, context, and review.
> Scenario template, gates, and traceability live in the plan.

## E2E-CHAT-output-token-truncation (#2277)

Use the real Desktop runtime and Pi loop with a controlled provider stream
ending in `length` after text output. Preserve the answer, emit truncation
metadata exactly once, make no extra provider request, and accept a follow-up.
Normal stops and aborts have no truncation annotation; a truncated tool call
is rejected and recovered by Pi without an additional answer warning.
Coverage: `output-truncation.test.ts`. The production persistence test in
`empty-assistant-persistence.test.mjs` retains the text and metadata in the
outbox. `e2e-transcript-render.mjs` renders production AssistantTurn in Electron,
checks the visible localized warning for live and JSON-restored snapshots, and
checks its absence on normal replies. No paid provider is used.
The Host test `output_truncation_survives_host_restart_and_legacy_rows`
deserializes the wire message, appends it to a real transcript, reopens the
database, and checks that true/false flags and absent legacy flags survive.

## E2E-QUEUE-late-read-after-event

Render two queued prompts, hold a production refresh, deliver a queueChanged event removing the first prompt, then return the old read. Only the second remains visible; a later authoritative refresh still applies. `queue-refresh-event-order.test.mjs` covers event/read order, reversed reads and session independence; `e2e-queue-refresh-event-order.mjs` renders production ComposerStatus/useAppStore in real Electron. No prompt is dispatched to a provider.

## E2E-TRANSCRIPT-window-cache-edit-race

Hold a bounded production session read, publish an idle edit cache with a different history window, then return the older window. Navigate/render from cache and observe the edited content. Also cover unchanged hydration and running live-tail merge. `session-window-cache-race.test.mjs` exercises the runtime API; `e2e-session-window-cache-race.mjs` renders the recovered snapshot through production MessageRow in real Electron. The API is controlled and no provider executes.

## E2E-TRANSCRIPT-full-read-cache-race

Hold a full-history read, publish a newer streaming snapshot, then resolve the
old read. The caller receives history while the session cache keeps the newer
snapshot. Coverage: `full-transcript-refresh-race.test.mjs` plus existing
session-runtime update regressions. No provider execution is required.

## E2E-SESSION-metadata-reads-skip-transcript

Seed real host-core with a ~40 MB transcript beside a short session. A
`messageLimit: 1` `session.get` must return the same project, worktree, mode
and model metadata as an unbounded read. Then launch the built desktop app on
that data and drive composer paste and Browser navigate through the real
preload IPC on both sessions: the long session may not add half an unbounded
read's time to either call. Coverage: `pnpm test:e2e:session-metadata-reads`
(`scripts/e2e-session-metadata-reads.mjs`). No provider execution is required.

## E2E-SESSION-rejected-stop-state

Reject a remote Stop at the API boundary: the production session slice keeps
its running state and rethrows the error. Retry successfully: both the active
indicator and owning session running entry clear. Coverage:
`failed-session-stop-state.test.mjs`, without provider execution.

## E2E-STEERING-recovery-reply-order

Feed consumed steering between an earlier reply and the next recovery response.
The earlier reservation settles and the next reply gets a new ID. Cover
provider, overflow, silent and progress recovery in `runtime.test.ts`.
`e2e-transcript-render.mjs` verifies production event projection and the
existing one-bubble overflow recovery when no steering is consumed.

## E2E-COMPOSER-screenshot-without-directory-scan

Paste a native folder, then a synthetic screenshot through real Composer,
preload IPC and the bounded scratch writer in `e2e-composer-paste.mjs`.
Run with `--screenshot-only` to verify the folder and screenshot route while
excluding unrelated MP4 preview. Screenshot metadata never enters native
directory discovery; scratch bytes are verified exactly in Main.
`composer-directory-paste.test.mjs` verifies byte preservation and existing
folder/mixed-selection behavior. No system clipboard contents are changed.

## E2E-COMPOSER-DIRECTORY-PASTE: Native folder cards and lazy context

- **Preconditions**: Synthetic folders/files with spaces, Unicode and XML-significant names.
- **Steps**: Copy and paste single/multiple folders and mixed files in home and
  session composers with text on both sides of the caret. Remove cards by
  mouse/keyboard and restore drafts
  from history. Edit or switch sessions while metadata resolves; delete the owner.
  Send and steer with folder cards, then activate a card in the sent message.
  Repeat ordinary text/image/file pastes.
- **Expected**: Folder cards wrap above the text, fit short names and expose
  full paths and removal. The sent user bubble shows the directory cards and
  only the user text. Local cards reveal the referenced directory in the
  system file manager. Selection
  order and source ownership survive, preserving newer edits. Removed cards send
  no hint. Both send paths carry escaped dir markers and one inspect/read-as-needed
  instruction. No directory arrayBuffer, traversal, recursive copy, Project change
  or filesystem grant occurs. Unavailable paths fail without partial references.
- **Status**: Parser/handler/editor/serialization tests cover deterministic cases.
  `pnpm test:e2e:composer-paste` uses synthetic file-list metadata to verify
  folder placement, removal, transcript rendering and reveal IPC across the
  Electron preload bridge. Native OS clipboard and file-manager display are
  manual scenarios.

> Scope: MVP acceptance scenarios plus current shipped product increments for PI-Desktop
> Status: Accepted (protocol/Electron automation is active; full desktop Playwright remains planned)
> Cross-references: [acceptance-criteria](../02-acceptance-criteria.md) · [milestones](../01-mvp-milestones.md) · [ai-development-workflow](../03-ai-development-workflow.md) · [change-checklist](../05-change-checklist.md)

---

## E2E-TRANSCRIPT-lossless-tool-images

- Entry: `PI_DESKTOP_HOST_BIN=<candidate-host> pnpm test:e2e:tool-result-persistence`
  after building Host, shared, agent-runtime and host-runtime.
- Environment: Real isolated Host, SQLite and JSONL, production Desktop IPC and
  outbox; only Electron shell and unused importer/search services are stubs.
- Build 35 deterministic valid PNGs / 548 rows. Verify the old redundant full
  request exceeds 64 MiB, each stored image occurs once, and restarting restores
  every canonical image, detail field and original JSON text spelling.
- Build a second history whose unique image bytes alone exceed 64 MiB through
  individually legal appends. Exercise bounded ID operations and retained-image
  restoration, revision/fork, missing anchors and duplicate operation retries.
- Unit/process gates also cover old-format files/outbox, corrupted references,
  failed conversion/drain, late callbacks and real sidecar restore errors.
- The original Windows incident did not identify the failed RPC method; this
  deterministic regression does not claim to recover that missing evidence.

## E2E-TRANSCRIPT-scroll-interruption

- **Preconditions:** Real Chromium with the production transcript scroll hook;
  a scrollable transcript, manual disclosure reading, and normal motion.
- **Steps:** Start a smooth navigation toward earlier history. Deliver
  transcript-owned wheel input before yielding to its first animation frame.
  Observe subsequent animation frames and run the long-history streaming probe.
- **Expected:** Input stops the old browser animation at the current offset;
  later frames cannot move the reader toward its stale destination. Streaming,
  disclosure anchoring, pinned follow, and long-history work budgets still pass.
- Repeat owned wheel, scroll-key, scrollbar-surface and touch inputs in the
  main and delegated scrollers. Observe real browser calls to distinguish
  application cancellation from Chromium's own pointer behavior. Button Space,
  button presses, select arrows and nested wheel input must not request an
  ancestor cancellation. Button Space must allow the original navigation to
  finish. `e2e-transcript-turn-completion.mjs` also verifies normal completed-turn
  prompt navigation and a reader's manually retained position.
  Start smooth navigation immediately before toggling a real disclosure in
  both main and delegated scrollers; its clicked title must keep its offset.
- **Coverage:** `node scripts/e2e-transcript-disclosure-anchor.mjs` and
  `node scripts/e2e-transcript-render.mjs`, plus
  `node scripts/e2e-transcript-turn-completion.mjs`. CI runs the completion
  probe in a visible window under Xvfb/Openbox: never-shown Linux windows can
  throttle animation frames despite `backgroundThrottling: false`.
- **Specs:** Interaction patterns §2.2. **Milestone:** Maintenance.
- **Status:** Automated browser regression; the interruption assertion fails
  without explicit cancellation of the browser-owned smooth navigation.

## E2E-TRANSCRIPT-live-turn-not-tail-stays-running

- **Preconditions:** Real transcript projection with the production
  `ChatTranscript`; a running session whose turn has streaming rows, and a
  steering message or system row rendered after that turn.
- **Steps:** While the turn's tool or reasoning rows stream, append a steering
  user message so the turn is no longer the tail entry. Observe the process
  header, the disclosure state, and the turn menu. Then settle the rows;
  separately stop the session mid-turn with rows left streaming.
- **Expected:** The non-tail live turn keeps a running process header with its
  activity marker, its process stays open, and copy/regenerate stay gated on
  completion; the settled turn then reads completed. In a stopped or idle
  transcript the same stuck rows read as an unknown outcome instead (#1923),
  and a reading window over older history never claims live status (#1900).
- **Coverage:** `node --test apps/desktop/test/turn-process.test.mjs` and
  `apps/desktop/test/transcript-live-turn.test.mjs` pin the liveness selection,
  the phase reading, and the wiring contract. Full Electron journey Draft.
- **Specs:** `04-ux/08-component-spec.md` §turn-process; **Milestone:** Maintenance.
- **Status:** Unit and source-contract regression; visual Electron scenario Draft.

## E2E-CHECKPOINT-drain-before-host-exit

- **Entry:** `node scripts/e2e-checkpoint-lifecycle.mjs` after building shared
  and host-runtime dependencies.
- **Sequence:** Hold a streaming checkpoint RPC, start runtime disposal, release
  the save and restart the host peer. Then hold an older turn's save, settle its
  message, start a new reply, and save a second session while the first is held.
- **Expected:** Host disposal waits for the checkpoint acknowledgement; the
  restarted peer reads the saved progress. A new save in the same session waits
  for the older write, so the newest reply remains on disk. The independent
  session saves while the other is blocked.
- **Coverage:** Production `HostProcess`, `TurnEventPipeline` and
  `InflightCheckpointer`, real child processes and temporary disk files; a
  controlled Node JSON-RPC peer replaces Rust host-core. Unit tests cover late
  settlement, snapshots arriving during a drain, failure recovery and throttling.
- **Specs:** `03-runtime/04-data-storage.md` §4.7, ADR 0153.

## E2E-QUEUE-send-now-wakes-subagents

- **Preconditions:** Dedicated request worktree with built workspace packages,
  compatible reused Host binary, temporary HOME/data/project, and a local SSE
  model fixture. Production Composer queue service, Main IPC, AgentHost, Rust
  Host and agent sidecar are used; no installed app or real account is used.
  The fixture requires Linux/macOS HOME isolation and refuses Windows before
  Host startup because known-folder lookup does not honor that isolation.
- **Steps:** Start two background delegates and let the parent enter TaskWait.
  Submit ordinary FIFO input and a correction, then choose Send now on the
  correction. Hold both delegate responses until the parent answers the
  correction. Release both responses and observe report delivery and FIFO drain.
- **Expected:** The correction reaches the same durable turn, TaskWait returns
  interrupted, and neither delegate is aborted. The correction appears once
  in history and leaves the durable queue only after acceptance. Ordinary
  input remains queued until parent settlement. Both reports reach the parent
  and the remaining FIFO input runs once. No graceful stop is requested.
  In rendered Electron, expand the earlier process after the steering reply:
  both delegate nodes remain running with Stop controls, then become completed
  after their reports arrive; the ordinary queued row remains until settlement.
- **Coverage:** `pnpm test:e2e:send-now-subagents` runs the headless process
  journey; append `-- --auto` to repeat with the session in auto mode.
  `queue-pending-actions.test.mjs` covers normal send followed by Send
  now through the production renderer service. AgentHost tests cover click
  order, concurrent delivery/cancellation, stale targets, and permission-mode
  preservation; runtime tests cover input before/during TaskWait and existing
  stop/dispose behavior. `send-now-subagent-rendering.test.mjs` covers the
  steering transcript path, parent settlement, ordinary-turn boundaries,
  compaction, and terminal Task snapshots through the real React rendering.
  The headless command does not replace the rendered Electron check above.

## E2E-CHAT-fork-completed-reply-while-running

- **Preconditions:** Isolated real desktop profile, configured model, two turns
  in one Desktop conversation; the first assistant reply has completed.
- **Steps:** Send the second prompt. While it is still running, click **Branch
  from this reply** on the first reply. Continue chatting in the child, then
  return to the parent.
- **Expected:** The child contains only history through the first reply, can
  continue independently, and starts with no running turn. The parent keeps
  running and retains its second prompt and reply. No live tail is overwritten.
  A whole-session fork and a fork within the active tool loop remain rejected.
  A navigation during the fork response records the child without stealing focus.
- **Coverage:** Host fork regression, renderer session-fork-running tests,
  session IPC contract tests, and real-model desktop acceptance. A local model
  fixture or mocked component result is not real-model acceptance evidence.

## E2E-CHAT-transcript-rewrite-late-events

- **Preconditions:** Isolated session with at least one completed turn and a
  persistence callback from that turn held until transcript replacement or
  revision activation begins.
- **Steps:** Start either transcript replacement or revision activation. Deliver
  the held old-turn event after the persistence outbox has drained but before
  the Host rewrite completes. Complete the rewrite, then start a new turn and
  persist one event. Repeat with the Host rewrite returning an error.
- **Expected:** A successful rewrite does not append the old-turn event to the
  rewritten transcript, while the new turn persists normally. A failed rewrite
  replays the buffered event into the unchanged transcript. Both rewrite
  entrances use the same fence and outbox drain.
- **Coverage:** `session-turn-ended.test.mjs` exercises the event persistence
  fence and rollback with deterministic event delivery; session IPC contract
  tests assert the fence/drain/rewrite ordering. No live provider is required.

## E2E-CONVERSATION-minimap-jump-leaves-follow

- **Preconditions:** One Desktop conversation long enough that the transcript
  overflows its viewport, opened at the bottom so follow mode is pinned, with
  the conversation outline (minimap) visible on the transcript's left edge.
- **Steps:** Click the outline dash of an earlier turn without scrolling the
  transcript first.
- **Expected:** The transcript scrolls to that turn and stays there: the turn
  lands just below the scroller's top edge and the jump-to-latest control
  appears, because the jump leaves follow mode before it scrolls. A pinned
  follow must never re-bottom the view one frame after the click. The outline's
  earlier-history control keeps its existing reveal behavior.
- **Status:** Automated in `pnpm test:e2e:transcript-minimap-jump`, which mounts
  the production `ChatTranscript` in a real Chromium page with a synthetic
  session, clicks an outline dash while follow is pinned, and asserts the
  scroller's distance from the bottom once the exchange has settled.

## E2E-IMAGES-provider-save-feedback

- **Preconditions:** Image configuration UI fixture; English and Chinese.
- **Steps:** Mark image models and save the provider; choose a different image
  default from its summary; pick a candidate the stored list no longer offers;
  then unmark the sole image model and save.
- **Expected:** Provider edits confirm the provider update, including after
  clearing the image selection. Explicit default selection keeps its specific
  image-selection confirmation. A pick the page can no longer accept reports
  that the image model could not be saved instead of keeping the previous
  default silently. Persisted bindings retain their existing behavior.
- **Specs:** 03-runtime/21-image-generation. **Acceptance:** B.
- **Milestone:** Maintenance. **Status:** Automated by
## E2E-IMAGES-remove-configured-model

- **Preconditions:** API-boundary fixture with an image-marked model and another
  configured model on its provider; repeat with legacy single binding and with
  another image candidate on another provider.
- **Steps:** Remove the marked model in the provider editor without toggling its
  image checkbox. Cancel once, repeat and Save, then reopen settings and editor.
- **Expected:** Cancel preserves both configurations. Save removes the model and
  its image candidate and clears the image default, even when another image
  candidate remains on this or another provider. The settings summary therefore
  shows the unavailable state until the user explicitly chooses a new default.
  An unaffected chat default stays unchanged; a removed chat default still falls
  back to the first configured model. Reload preserves results.
- **Specs:** 03-runtime/21-image-generation. **Acceptance:** B.
- **Milestone:** Maintenance. **Status:** Automated in English and Chinese by
  `scripts/e2e-image-generation-ui.mjs`.

## E2E-IMAGES-desktop-conversation

- **Preconditions:** Isolated desktop profile and workspace, built image feature,
  local chat and OpenAI Images HTTP fixtures; no live provider credentials.
- **Steps:** Open Models settings with no image model configured; verify the image
  summary row is absent. Open a provider's Advanced model settings and verify
  **Set as image model** is grouped with the image/document attachment
  capabilities and can be checked for multiple models. Save, use the image
  summary menu to choose one marked model as the default, then submit a
  two-image request through the composer and edit the first output through a
  follow-up message. Collapse tool details.
- **Expected:** After saving, the image summary appears with a 12px default-row
  gap and lists all marked candidates, the selected default is changeable
  without changing the chat default, decoded image previews stay outside
  collapsed process details, multipart source upload is used for editing,
  originals are preserved, and no image HTTP request occurs while unconfigured.
- **Settings interactions:** The unconfigured state renders no image summary.
  Mark candidates in the attachment capability group, save, and select one
  from the summary menu. An existing missing/disabled candidate shows only
  Currently unavailable. Covered in `scripts/e2e-image-generation-ui.mjs`.
- **Image model deselection (#826):** With one provider and one model marked
  for images, uncheck it in the provider editor. Cancel must preserve the image
  default; Save must clear both its candidate and default binding. Reopen settings
  and the editor: the image row stays hidden, the checkbox stays unchecked, and
  the model can be selected as the chat default. Covered in English and Chinese
  by `scripts/e2e-image-generation-ui.mjs` with an API-boundary fixture.
- **Conversation selection:** Every marked image provider/model is absent from
  default and Composer candidates. Other providers retain same-ID models. An
  existing session pinned to any marked image binding is rejected before
  inference.
- **Transport contracts:** Real stdio reverse RPC retains a thrown local image
  error's stable code in the production ParentHostProxy. Local HTTP tests check
  single/multiple binary multipart fields and boundaries, DALL-E `b64_json`
  requests, GPT Image parameter omission, bounded responses, and rejection of
  more than four references before I/O. These are protocol tests, not official
  provider account/live compatibility certification.
- **Proxy fake-IP:** With the explicit Settings → System → Network proxy
  fake-IP option enabled, a URL response resolved to Clash's benchmark range
  is downloaded through the proxy-aware transport; without the option it stays
  `IMAGE_UNSAFE_URL`, and real private addresses remain blocked in both cases.
  Covered by `packages/agent-runtime/src/image-generation/download.test.ts`,
  not by the driver below.
- **Status:** Automated in `node scripts/e2e-image-chat.mjs`; optional screenshots
  use `PI_IMAGE_CHAT_EVIDENCE_DIR`. The images are deterministic raster fixtures,
  not evidence of real-model quality or provider compatibility.

## Conversation Stream & Abort

## E2E-008: New session and send message

- **Preconditions**: Provider configured.
- **Steps**: 1) Create new session. 2) Type a message. 3) Send.
- **Expected**: The transcript immediately shows a compact localized `Working…`
  status after send, before the first assistant or tool event. It remains
  visible through thinking/tool/answer output, or identifies a runtime-reported
  wait. Pending user interaction suppresses it; it disappears when the turn ends.
  The conversation topbar keeps only the task title and window actions; it does
  not add a separate running-state indicator.
- **Specs linked**: `03-runtime/02-agent-runtime.md`, `03-runtime/10-session-state-machine.md`
- **Acceptance**: C (new session, send message)
- **Milestone**: M2
- **Status**: Automated (protocol smoke, live-model lane; requires PI_DESKTOP_TEST_API_KEY)

## E2E-008d: Composer Enter-to-send and modifier send

- **Preconditions**: Provider configured; a session is open.
- **Steps**: 1) Leave Enter-to-send enabled. Type a draft and press Enter.
  2) Disable Enter-to-send in Settings. 3) Type a second draft and press
  Cmd/Ctrl+Enter. 4) Press Enter and Shift+Enter in a third draft, then
  Shift+Enter at the end and type one character.
- **Expected**: Step 1 sends. After the setting is off, Cmd/Ctrl+Enter sends;
  plain Enter and Shift+Enter insert newlines and do not send. IME composition
  and an open autocomplete menu still take precedence over send. The character
  typed on the empty last line stays on that line.
- **Specs linked**: `04-ux/01-ui-ia.md`, `04-ux/08-component-spec.md` §11.5,
  `04-ux/09-interaction-patterns.md` §1.2
- **Acceptance**: C (composer send)
- **Milestone**: M2
- **Status**: Source-level regression (`composer-ime.test.mjs`); full UI
  keyboard journey remains Draft. Protocol smoke does not dispatch key events.

## E2E-008e: Host speech transcribe and speak

- **Preconditions**: A session is open. No `AppSettings.speech` role is bound.
- **Steps**: 1) Call `speech/transcribe` with a scratch wav while unbound. 2)
  Persist an ASR binding (`openai_audio` / whisper) and a TTS binding with a
  host settings write. 3) Transcribe the wav and insert the returned text into a
  draft. 4) Synthesize that draft.
- **Expected**: An unbound role fails `SPEECH_NOT_CONFIGURED` and never calls the
  provider. Transcribe returns text. Synthesize writes session-scratch audio and
  returns a bounded data URL; audio bytes never enter the renderer. Whisper/TTS
  never appear in the chat model picker.
- **Specs linked**: `03-runtime/20-speech.md`, `04-ux/06-settings-ia.md`
- **Acceptance**: C (speech)
- **Milestone**: M2
- **Status**: Source-level regression (`speech-capability.test.mjs`,
  `plugin-speech-adapter.test.mjs`); no renderer entry point exists, and the live
  provider journey remains Draft.

## E2E-008a: First-turn tools load on demand

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
  non-visual HTML files do not trigger a preview call. At the second prompt,
  successful activation markers still in the effective context may restore the
  matching deferred schemas in the first request, including tools that were
  activated but not yet called. New results use `details.addedToolNames`; the
  legacy `details.activated` and top-level `addedToolNames` markers remain
  readable. Failed, interrupted, and missing-result rows do not restore tools.
  Catalog and mode changes also prevent restoration.
  No host permission or workspace escape is granted by restoration.
- **Specs linked**: `03-runtime/02-agent-runtime.md` §7.1,
  `03-runtime/03-tools-and-permissions.md` §2.1, ADR 0048, ADR 0225,
  `08-meta/decisions-log.md` (D185, D400)
- **Acceptance**: C (first turn and stream) + E (tool execution)
- **Milestone**: M5
- **Status**: Unit-covered (`agent-runtime` deferred-tool tests); live-model
  request capture and full Electron journey pending

## E2E-008b: Bundled Browser plugin chrome and CDP

- **Preconditions**: Packaged or checkout build with bundled plugins; Agent
  session with a workspace HTML file; Plan session available.
- **Steps**: 1) Confirm Plugins lists `pi.browser`, enabled, not uninstallable.
  2) With the work panel closed, ask the agent to preview a workspace HTML
  file (`BrowserPreview`) and verify the Browser tab opens in the visible work
  panel. 3) Use ToolSearch `cdp` / `Browser` to snapshot and interact while the
  panel remains visible. 4) Collapse the panel and continue Browser snapshot,
  click/fill, screenshot and navigation. 5) Switch to a second session and call
  Browser; verify it uses that session's own page. 6) Continue the first session's
  Browser actions while the second session is visible; reload the shell and
  return to the first page. 7) In Plan/Goal, exercise the read-only Browser
  actions and verify mutating actions remain denied. 8) Disable
  `pi.browser`. 9) Call `BrowserPreview` and click an http(s) transcript link.
  10) From a third-party or test caller, send
  `Network.getAllCookies` through `pi.browser.cdp`.
- **Expected**: The launcher has no host Browser row. Preview opens the plugin
  view, reveals the work panel, and live-reloads the file. Session-owned Browser
  operations run in the background without opening the panel, borrowing another
  page, or changing focus. Shell reload retains the native page and form data;
  its side-panel tabs can be restored. ToolSearch activates the Browser tool.
  Plan/Goal allow navigate/snapshot/screenshot/console; click/fill/evaluate/cdp
  remain denied. Disable
  hides the view and tools; `BrowserPreview` errors; http(s) chips use
  `openExternal`. Cookie CDP is denied. Guest bounds stay inside the plugin
  view.
- **Specs linked**: ADR 0170, D333, `07-plugins/03-plugin-api.md`,
  `03-runtime/03-tools-and-permissions.md`
- **Acceptance**: E (plugin view + tool) + security allowlist
- **Milestone**: M5
- **Status**: Unit-covered (`bundled-plugins`, `browser-cdp`,
  `browser-preview-tool`); full Electron journey pending

## E2E-008c: Quiet intervals explain active work

- **Preconditions**: A deterministic provider fixture can delay the first
  response, return one retryable failure with a bounded backoff, and a session
  can start one delegated task whose completion is controlled by the fixture.
- **Steps**: 1) Send a prompt and hold the provider before its first assistant
  event. 2) Observe the transcript status row. 3) Release a retryable failure
  and inspect the row during backoff. 4) Start a delegated task and wait for
  the parent to converge on it. 5) Release the fixture and let the turn end.
- **Expected**: The status row names the quiet interval — `Starting…`,
  `Waiting for model`, `Preparing next request…`, `Compacting context…`,
  `Recovering empty response…`, `Retrying model request`, or `Waiting for`
  a named subagent with its latest coarse action — with a monotonic elapsed
  time matching the active phase. A multi-subagent wait lists each running
  target. It uses the same compact inline treatment as `Working…`, never adds
  a duplicate progress card, and clears when assistant output or a terminal
  event arrives. The Stop action remains available throughout.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `03-runtime/02-agent-runtime.md`, `04-ux/09-interaction-patterns.md`,
  ADR 0175, ADR 0198
- **Acceptance**: C (chat stream), Quality (feedback and accessibility)
- **Milestone**: M5
- **Status**: Draft (deterministic fixture pending)

## E2E-009: Streamed tokens visible in UI

- **Preconditions**: Session active; message sent.
- **Steps**: 1) Request a long answer containing Markdown and inline/display
  math using both dollar (`$…$` / `$$…$$`) and TeX bracket (`\(…\)` /
  `\[…\]`) delimiters. 2) Observe the assistant response as it streams. 3) Let
  the answer complete and inspect the renderer console.
- **Expected**: Runtime chunks appear progressively through the incremental
  Markdown renderer and the final response is complete. All four math delimiter
  forms render with KaTeX, with `\[…\]` using display layout. The renderer does
  not start a second animation-frame typewriter loop, raise React error 185, or
  reject Vite-inlined KaTeX fonts under CSP.
- **CJK emphasis regression**: Stream and reload `这是**“重点内容”**，请查看。`,
  `这是**重点。**后续内容。` and `这是**（重点）**后续内容。`; each marked
  phrase is bold without visible markers. Inline/fenced code and escaped
  asterisks remain literal, English emphasis remains intact, and source-copy
  bytes/selection anchors remain unchanged. React/Vite SSR and every-prefix
  grammar tests cover this boundary; native E2E remains unexecuted.
- **Specs linked**: `03-runtime/02-agent-runtime.md`,
  `04-ux/08-component-spec.md`, `04-ux/09-interaction-patterns.md`,
  `05-security/01-security.md`
- **Acceptance**: C (streamed output), Quality
- **Milestone**: M2
- **Status**: Partially automated (protocol live-model stream, renderer source
  regression in `renderer-stream-safety.test.mjs`, and math delimiter rendering
  in `latex-math.test.mjs`; full UI observation remains Draft)

## E2E-010: Stop turns and in-flight tools safely

- **Preconditions**: A session can produce both a deliberately delayed first
  token and a streaming response. A deterministic Host fixture can hold a
  read-only `Grep` call and expose a pending `Write` approval.
- **Steps**: 1) Send ordinary text and click Stop immediately, including while
  the prompt is still being admitted. 2) Confirm the user row is undone and
  the text returns to the composer after that first Stop. 3) Send again, wait
  for partial output, then stop during the stream. 4) Immediately send a new
  prompt after Stop returns, without waiting for an idle delay. 5) Start a
  read-only Grep that does not return, press Stop, then start another prompt.
  Hold its `tools.abort` acknowledgement as well and repeat for Read and Glob.
  6) Start a Write that is waiting for permission, press Stop, then try to
  approve the stale request. 7) Observe the transcript, composer, and workspace.
- **Expected**: The first Stop is honored even if prompt admission is still in
  progress; the unanswered send is undone and its draft restored. The
  streaming send stops with its partial response preserved and no draft
  restoration or duplicate user turn. The read-only tool returns
  `TOOL_ABORTED`, its late result is discarded, and the follow-up starts
  without `AGENT_BUSY`, even while the cancellation acknowledgement is pending.
  Late results or cancellation failures cannot change the follow-up turn.
  Stopping the pending Write cancels its permission;
  approving the stale request fails and creates no file. A mutating operation
  that already started is not reported stopped before its Host result arrives.
  On a headless Host, hold durable-turn creation, user-row append, and sidecar
  history restoration in turn, then request abort during each hold. Release the
  hold and confirm abort settles the runtime before acknowledging cancellation;
  a follow-up input completes under a new durable turn. Repeat with an approved
  plan still being admitted, and ensure its execution settles as interrupted.
  An old turn's delayed abort must leave a newer turn alone, and admission in
  another session must not wait for this session's cancellation.
- **Specs linked**: `03-runtime/02-agent-runtime.md`,
  `03-runtime/03-tools-and-permissions.md`, `03-runtime/06-host-rpc-protocol.md`,
  ADR `tool-abort-abandons-host-call`
- **Acceptance**: C (abort)
- **Milestone**: M2
- **Status**: Runtime and Host cancellation contracts automated by
  `packages/agent-runtime/src/runtime.test.ts` and the pending-Write regression
  in `crates/host-core/src/rpc/mod.rs`. `read-only-stop.test.ts` covers held
  acknowledgements and late failures through real Agent loops.
  After building shared and running `node packages/agent-runtime/scripts/bundle.mjs`,
  `node scripts/e2e-read-only-stop.mjs` runs the production sidecar bundle and
  a localhost provider, holding execution and cancellation responses at the Host
  edge. It verifies follow-up prompts and the Write settlement boundary;
  `packages/host-runtime/src/runtime-service.test.ts` covers headless admission,
  approved-plan startup, stale aborts, and independent sessions. After building
  host-runtime and the sidecar bundle, `node scripts/e2e-headless-startup-abort.mjs`
  exercises the production RuntimeService, stdio transport, sidecar, and local
  provider through startup cancellation and a successful follow-up.
  Rendered Electron interaction remains
  a manual validation run.

## E2E-171: Streaming reply survives quit, crash, and stop

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
  no checkpoint file. A completed reply that had not yet left the outbox at
  quit is still present after relaunch (promoted `complete` if recovered from
  the checkpoint, or drained from the outbox before the first `session.get`).
- **Specs linked**: `03-runtime/04-data-storage.md`,
  `03-runtime/06-host-rpc-protocol.md`, `03-runtime/07-process-model.md`,
  `03-runtime/01-ipc-protocol.md`
- **Acceptance**: C (abort), F (persistence)
- **Milestone**: M2
- **Status**: Draft

## E2E-SESSION-outbox-duplicate-id-does-not-drop-history

- **Preconditions**: Two sessions whose provider tool rows reuse the same
  `toolCallId` as `messages.id` (for example `call_421522`). The first session
  already persisted that id. The second session then runs several turns so
  assistant/tool rows queue behind the colliding append.
- **Steps**: 1) Complete a tool call in session A with id `call_421522`.
  2) In session B, run the same provider tool id, then continue chatting for
  several turns. 3) Quit and reopen. 4) Open both sessions.
- **Expected**: Session A still has its original tool row. Session B kept its
  later turns after reopen; the colliding tool row is stored under
  `{sessionB}:{call_421522}` (or an equivalent remapped id). The persistence
  outbox is empty and did not stay paused on `UNIQUE constraint failed:
  messages.id`. No later assistant/tool row from either session is missing.
- **Specs linked**: `03-runtime/04-data-storage.md`,
  `03-runtime/06-host-rpc-protocol.md`, ADR 0041, D444
- **Acceptance**: F (persistence)
- **Milestone**: M2
- **Status**: Unit-covered (`append_message_remaps_ids_owned_by_another_session`,
  `persistence-outbox.test.mjs`); desktop journey outstanding

## E2E-SESSION-outbox-poison-does-not-drop-history

- **Preconditions**: A session-collaboration delivery turn is running. The user
  steers with Alt+Enter (content that does not match the delivery). Later
  assistant and tool rows from this or another session queue behind that
  append. Optionally the outbox already holds a `PERMISSION_DENIED:` head from
  an older host.
- **Steps**: 1) Start a collaboration delivery turn. 2) Alt+Enter a steering
  prompt. 3) Let the turn produce assistant/tool rows, including in another
  session if convenient. 4) Quit and reopen. 5) Open the affected sessions.
- **Expected**: Steering persists as a human user row with no
  `session_message` origin. The delivery user row still has host-derived
  origin. Later assistant/tool rows survive reopen. The outbox is empty and
  did not stay paused on `PERMISSION_DENIED:`. A `PLUGIN_PERMISSION_DENIED`
  head would still pause rather than drain.
- **Specs linked**: `03-runtime/04-data-storage.md`,
  `03-runtime/06-host-rpc-protocol.md`, ADR 0041, ADR 0239,
  ADR active-turn-steering, D597
- **Acceptance**: F (persistence)
- **Milestone**: M2
- **Status**: Unit-covered (`steering_input_persists_without_inheriting_delivery_origin`,
  `persistence-outbox.test.mjs`); desktop journey outstanding

## E2E-SESSION-outbox-unclassifiable-failure-does-not-stall-the-queue

- **Preconditions**: One queued outbox append fails with an error the outbox
  cannot classify (`Error: stream did not contain valid UTF-8` from a torn host
  transcript), while later appends from other sessions queue behind it.
  Optionally the outbox is already at its 1024-entry cap and the flush log
  shows repeated `session persistence flush paused` for that key.
- **Steps**: 1) Produce the unclassifiable append failure. 2) Keep sending
  messages in two other sessions. 3) Observe `logs/app/persistence.log` for
  `session persistence flush paused` (bounded attempts), then
  `session persistence flush quarantined entry`, and for the absence of
  `session.persistence.outbox.is.full`. 4) Confirm
  `session-message-outbox.dead-letter.json` holds that key with its payload and
  error, and that `session-message-outbox.json` drops below the cap. 5) Restart
  the app and confirm the quarantined append is not replayed. 6) Optional:
  delete the failing session and confirm its dead letter is dropped.
- **Expected**: The failing append is paused four times with a growing backoff
  and quarantined on the fifth consecutive failure, then skipped. Later
  appends from every session drain, no enqueue is rejected with `outbox is
  full`, and the queued outbox file empties. The dead letter survives a
  restart without being replayed.
- **Specs linked**: `03-runtime/04-data-storage.md`,
  `03-runtime/06-host-rpc-protocol.md`, ADR 0041, D318, D444, D597, D656
- **Acceptance**: F (persistence)
- **Milestone**: M2
- **Status**: Unit-covered (`persistence-outbox.test.mjs` bounded retry,
  quarantine, dead-letter persistence and cap tests); desktop journey
  outstanding

## E2E-SESSION-outbox-empty-snapshot-is-atomic

- **Preconditions**: An isolated profile has one queued append or dead letter.
- **Steps**: Delete its session through `PersistenceOutbox.dropSession` and
  terminate the writer after the empty write opens/truncates its target but
  before writing the payload. Restart the outbox. Repeat with an injected
  `EPERM` at rename, then clear normally and restart again.
- **Expected**: Both failures preserve the previous committed bytes. A pending
  append remains replayable; a dead letter remains readable without replay.
  Rename failure rejects the caller. A successful clear commits `[]` and
  remains readable on restart. Already-corrupt files still fail closed.
- **Specs linked**: `03-runtime/04-data-storage.md`, ADR 0041
- **Acceptance**: F (persistence)
- **Status**: Process/filesystem regression coverage in
  `persistence-outbox-atomic-clear.test.mjs`; full Electron and native Windows
  force-close journeys not run.

## E2E-011: Switch between project and temporary sessions

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

## E2E-TRANSCRIPT-restored-live-tail-status

- **Preconditions**: An isolated renderer with two retained session panes, a
  running turn with tool output, and the real Composer and SessionPane.
- **Steps**: Restore a bookmark during selection revalidation; append live
  output; switch away and reveal the running pane; inspect an unread history
  range and an explicit search at the tail; settle and abort the turn. While
  reading above the live tail, click return-to-latest and switch away in the
  same task, before the return-to-latest animation advances a frame. Return
  first with the pane retained, then repeat while a project switch actually
  unmounts the pane and output continues in the background.
- **Expected**: The restored live tail keeps a running process header while
  Stop is available. Content updates and pane reveal do not falsely show
  Finished. The restored range and scroll offset remain owned by the reader.
  Another session, unread pages, and explicit search do not inherit live
  status. Terminal completion and abort show Finished and Stopped respectively.
  An empty restored range stays historical, an ordinary empty canonical range
  shows the initial wait, and a restored navigation-parent copy with the same
  message id keeps the running presentation.
  Return-to-latest synchronously records a pinned bookmark and commits any
  prepared latest view on hide or unmount; both a retained reveal and a fresh
  project remount follow the newest output without a second click. The running
  header and Stop control stay consistent. Readers who did not choose
  return-to-latest keep their existing historical reading position.
- **Automation**: `node scripts/e2e-transcript-reading-position.mjs`
  (`transcriptLiveTailProbe`).
- **Specs linked**: `04-ux/09-interaction-patterns.md` §2.3 / §2.4
- **Acceptance**: C (session switching and running status)
- **Status**: Automated isolated Electron regression

## E2E-207: Open large and long sessions through bounded transcript windows

- **Preconditions**: A session contains a message with at least 50 MB of text
  or tool output and enough additional messages to span several transcript
  pages; a second session contains a long ordinary conversation.
- **Steps**: 1) Open each session from the sidebar while recording the first
  visible transcript frame and renderer responsiveness. 2) Scroll to the top
  of the transcript. 3) Repeat the open/close cycle after the session has been
  cached. 4) Inspect the host request/response or test fixture for the session
  read window. 5) In an isolated Host profile, create a transcript above the
  layout-cache threshold, append more rows, settle a middle Task result with a
  longer value, then restart with a legacy layout file beside the transcript.
  6) Read the newest page, page to the beginning, locate a nested message and
  its owning Task, then read the complete history.
- **Expected**: Opening paints the newest bounded page without transferring
  the complete 50 MB value to the renderer. The large value is visibly marked
  as truncated for display while the transcript and model-facing read remain
  lossless. Reaching the top loads older pages incrementally and preserves the
  viewport position; the final page reports no older history. Reopening a long
  session reuses the bounded cache and does not synchronously construct every
  historical row before the latest messages become usable. Edit, delete,
  revision, and Stop operations rehydrate the full transcript before any
  rewrite, so older messages are never lost because only a window was visible.
  The isolated Host journey returns every message once and in order after the
  middle rewrite, legacy-cache rejection and restart; the Task result is
  terminal, nested-message navigation resolves its owning Task, and paging
  reaches the beginning without a UTF-8 error or omitted row.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `03-runtime/04-data-storage.md`, `03-runtime/06-host-rpc-protocol.md`,
  ADR 0120
- **Acceptance**: C (session open and scroll), F (persistence), Quality
- **Milestone**: M5
- **Status**: Source-level and isolated Host RPC cache regressions covered;
  full large-fixture Electron journey Draft

## E2E-TRANSCRIPT-invalid-utf8-window-remains-readable

- **Preconditions**: An isolated Host profile contains a session transcript
  with valid messages before and after a complete line containing invalid
  UTF-8 bytes. The damaged bytes are inside message text in one fixture and
  make a separate message line unparseable in another. No real user data.
- **Steps**: Open the session through the renderer's bounded `session.get`
  path with `messageLimit`, page across the damaged line, then read the full
  history through the Host API. Compare the transcript file before and after.
- **Expected**: The session stays readable. Valid surrounding messages appear
  in order; parseable damaged text contains U+FFFD, while an unparseable row is
  skipped. The source transcript remains byte-identical and paging positions
  stay consistent.
- **Specs**: `03-runtime/04-data-storage.md` and ADR 0127.
- **Acceptance**: C (conversation and stream), F (persistence), Quality.
- **Milestone**: Maintenance.
- **Automation**: `pnpm test:e2e:transcript-cache` exercises bounded `session.get`
  against an isolated Host and verifies replacement text plus unchanged source
  bytes. `crates/host-core/src/transcripts_layout_tests.rs` covers the invalid
  row and layout reader directly. Full renderer journey remains Draft.

## E2E-011a: New session while another session is still streaming

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
- **Status**: Unit-covered (`composer-send-state.test.mjs`); pending-admission component/store user path
  covered (`queue-pending-actions.test.mjs`); full UI scenario Draft

## E2E-011b: Create a new session from a retained project group

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

## E2E-011c: Session-scoped composer drafts

- **Preconditions**: Provider configured; sessions A and B exist; A has a
  transcript so it uses the docked composer; B is an empty session so it uses
  the home composer; the composer is visible and both sessions are idle.
- **Steps**: 1) Select A and type a prompt without sending it. 2) Switch to B
  and inspect the composer. 3) Type a different prompt in B, then switch back
  to A. 4) Create a new session and inspect its composer. 5) Return to B and
  then delete B; revisit the remaining sessions and the home composer if it is
  available. 6) Type in A, add a workspace file through `@` and a pasted scratch
  file, open Settings (or Plugins), then return to chat. Confirm both file chips
  and the surrounding text remain. Change the workspace of the same draft and
  confirm only its workspace-relative reference is removed.
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
  (`composer-draft-cache.test.mjs`); real React remount and workspace-change
  coverage in `scripts/e2e/composer-paste.tsx` (`pnpm test:e2e:composer-paste`);
  full UI scenario Draft

## E2E-011c-1: Preserve newer drafts after command completion

- **Preconditions**: Sessions A and B exist; the `/compact` API response can be held pending.
- **Steps**: In A, submit `/compact` and hold its response. Replace the command
  text with a new draft, then release the response. Repeat with an image added
  to the unchanged command text, and with navigation to B before completion.
  For the `reentered` variant, while compact is pending replace the editor text
  with temporary text and dispatch `input`, then type the exact `/compact`
  again and dispatch `input` before releasing the response. Finally run the
  command without editing its draft.
- **Expected**: Completion preserves newer text and image attachments in A;
  B's draft is untouched, and returning to A restores its newer draft. The
  `reentered` case still displays `/compact` after success even though its final
  text equals the submitted value. An unchanged submitted command draft clears.
- **Coverage**: `scripts/e2e/composer-submission.tsx`, executed by
  `pnpm test:e2e:composer-paste`; real desktop recording uses isolated data and
  a local model with a controlled response delay.

## E2E-011c-2: Late send failures do not restore stale composer drafts

- **Preconditions**: Session A is idle; the two send results for its composer
  can be held and settled independently.
- **Steps**: Submit draft N, then submit draft N+1 before N settles. Accept N+1
  and reject N. Repeat with N+1 rejected after N remains pending.
- **Expected**: N's late rejection never restores its text or file references
  over N+1. If N+1 is rejected, only N+1's own snapshot is restored.
- **Specs linked**: `04-ux/09-interaction-patterns.md` (session-scoped drafts)
- **Acceptance**: C (composer input and session isolation)
- **Milestone**: M2
- **Status**: Async ownership behavior covered by
  `apps/desktop/test/composer-submit-race.test.mjs`; rendered UI scenario Draft

## E2E-SESSION-reference-conversation-link: A pasted conversation link carries that conversation into the turn

- **Preconditions**: Isolated desktop profile; one project with conversations A
  and B, and a second project with conversation C; a configured model that
  answers from the context it is given.
- **Steps**: 1) In A's conversation overflow menu choose Copy conversation
  link and read the clipboard. 2) Open B, paste the link into the Composer
  draft, send it, and inspect the user message. 3) Ask a follow-up in B without
  repeating the link. 4) Paste C's link into B and send. 5) In A, send A's own
  link. 6) Rename A from its conversation overflow menu, then return to B.
- **Expected**: The clipboard holds `pi-desktop://session/<A's id>`. B's user
  message keeps the link text visible and shows a chat-icon chip labelled with
  the catalog's reference label and A's title; activating the chip opens A. The
  answer uses A's content, and the follow-up still reads the same reference
  without the link being written again. C's link and A's own link attach
  nothing: the message keeps its plaintext and the model receives no excerpt
  from them, because the resolver drops a self-reference before any read and
  discards an excerpt whose conversation belongs to another project.
  Renaming A afterwards renames the chip in B, which names the conversation from
  its current title; the excerpt the model already read keeps the name recorded
  when the reference was made.
- **Specs linked**: `04-ux/08-component-spec.md` §20B,
  `03-runtime/04-data-storage.md`, `03-runtime/02-agent-runtime.md`
- **Acceptance criterion**: C — Conversation & stream
- **Milestone**: M2
- **Status**: Draft — the resolver and the chip are covered at source level by
  `apps/desktop/test/session-references.test.mjs` and
  `apps/desktop/test/session-reference-ui.test.mjs`

## E2E-COMPOSER-input-history-recall

- **Preconditions**: Isolated Electron test profile and the production Composer
  input/draft/history/submit hooks mounted in the renderer fixture. The send
  boundary is deterministic; no provider or network credentials are needed.
- **Steps**: 1) In session A, send `alpha`, `beta`, and `beta` again through
  Enter; press ArrowUp twice and ArrowDown twice. 2) Edit a recalled draft and
  confirm arrows no longer replace it. 3) Send a prompt with a file reference,
  recall it, and inspect the rendered chip. 4) Switch to B, verify A's history
  is absent, send `beta`, and verify B recalls only its own entry. 5) Start the
  first Home prompt with the send boundary held, switch to B before acceptance,
  release it, then open the materialized session and recall the prompt. 6) Exit
  Electron and launch a new process with the same isolated profile; recall A's
  attachment entry and the Home-created session's prompt.
- **Expected**: Duplicate consecutive `beta` is stored once; ArrowUp/ArrowDown
  walk newest-to-oldest and back to an empty draft. Editing ends browsing.
  Attachment text and its rendered file chip return together. Sessions A and B
  remain isolated. The delayed Home send is recorded under the session ID
  materialized by `sendPrompt`, not the session selected when the send finishes.
  Both histories and the attachment survive a real Electron process restart.
- **Specs linked**: `04-ux/09-interaction-patterns.md`,
  `08-meta/decisions-log.md` (D632), `04-ux/08-component-spec.md`
- **Acceptance**: C (composer input and session isolation)
- **Milestone**: M2
- **Status**: Automated by `pnpm test:e2e:composer-paste` (renderer keyboard
  interactions, Home session switch, attachment recall, and second-process
  persistence); store callback race regression is covered by
  `apps/desktop/test/composer-input-history.test.mjs`.

## E2E-011d: New task creates an immediate durable empty slot

- **Preconditions**: Provider configured; at least one real session exists so
  the sidebar history is non-empty.
- **Steps**: 1) Invoke New Task from the sidebar, the top bar, or Cmd/Ctrl+N
  while a retained project is active, then use a project row's `+` action.
  2) Inspect the sidebar history and the composer. 3) Click the same target's
  New Task control several times quickly. 4) Type a message and send it. 5)
  Inspect the sidebar history again and repeat for a different project group.
- **Expected**: Global New Task creates a path-less conversation in the
  temporary group and clears the visible workspace, whatever project was
  active (issue #2455); only a project row's `+` or the empty-home project
  switcher creates inside a project. When the target group's latest session is
  non-empty, the empty home
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
  `session-create.test.mjs`, `session-project-scope.test.mjs`); full UI
  scenario Draft

## E2E-011f2: A conversation leaves or joins a project from its crumb

- **Preconditions**: Two projects are open; one idle conversation with
  messages belongs to the first project and one temporary conversation exists.
- **Steps**: 1) Open the project conversation and choose "Temporary chat" from the
  topbar project crumb. 2) Choose the second project from the same crumb. 3)
  Open the temporary conversation's empty home or topbar and choose a project.
  4) Start a turn and open the crumb while it runs.
- **Expected**: Each move keeps the transcript, title, and model, regroups the
  sidebar row, and the visible workspace follows the active conversation. The
  next turn uses the new project's instructions (or none). A running,
  remote, native, or isolated-worktree conversation shows a static crumb and
  cannot move.
- **Specs linked**: `04-ux/01-ui-ia.md` (§5), `04-ux/09-interaction-patterns.md`
- **Acceptance**: C (session grouping), F (persistence)
- **Milestone**: M2
- **Status**: Source-level regression covered (`session-project-scope.test.mjs`,
  `topbar-title-rendering.test.mjs`, host-core
  `move_session_project_reassigns_only_the_project_and_rejects_running_turns`);
  full UI scenario Draft

## E2E-011e: Empty-session reuse is scoped to the latest session

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

## E2E-012b: Project memory persists only within its project

- **Preconditions**: App running with two retained projects and a configured
  provider.
- **Steps**: 1) Open the first project row menu and choose Project memory. 2)
  Add a memory card, enter a title and project-specific note, then save. 3)
  Reopen the editor, edit the note, add a second card, remove the first card,
  and save. 4) Start or continue a chat in the first project and verify the
  next runtime receives the saved entries as derived context. 5) Switch to the
  second project and start a chat. 6) Return to the first project and reopen
  the editor.
- **Expected**: The editor loads the saved cards after reopening. The first
  project's runtime receives their readable projection as a labelled
  user-context block; the second project's runtime does not. An existing
  legacy plain-text memory opens as one untitled card. Empty memory is valid,
  removing all cards clears the projection, saving replaces the prior value,
  and content above 32 KiB is rejected without a partial save. The create
  dialog's memory hint is concise and does not imply that memory is shared
  across projects.
- **Specs linked**: `03-runtime/01-ipc-protocol.md` (§9),
  `03-runtime/04-data-storage.md` (§4.1),
  `03-runtime/06-host-rpc-protocol.md` (Projects),
  `04-ux/06-settings-ia.md` (Project archive),
  `04-ux/08-component-spec.md` (Sidebar interactions)
- **Acceptance**: C (chat/stream), D (project UI), F (persistence), Localization
- **Milestone**: M5
- **Status**: Unit/source covered; full provider/UI journey Draft

## E2E-011f: Send while running queues per-session prompts and supports Send now

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
  remaining queued row, then choose Send now on a second row. 6) Observe A
  through the next model request within the same turn. 7) Start
  another run in A, clear the draft to expose the single Stop button, press
  Stop, and inspect the queue. 8) Repeat with two queued prompts, let the active
  turn finish without Send now, and delay its host `session.endTurn` response
  until after `agent_end` is delivered. Release finalization and observe both
  follow-ups through their turn boundaries. Repeat with a provider error and an
  immediate abort. 9) With waiting rows, use move up and move down and confirm
  the persisted order follows. 10) Edit a waiting row while the composer holds
  text, then with an empty composer. 11) Delay Host queue admission. Attempt to
  edit/remove the pending row, release admission, then edit/remove the durable
  row. Repeat with a captured file-reference draft. 12) Withhold a local Host
  queue-save request until its existing RPC deadline expires, then retry.
  13) With an empty composer and two waiting rows, press the steering shortcut
  (`⌥/Alt+Enter`): verify the first row is promoted, press it again to promote
  the second, then repeat with only a saving row present. 14) Repeat with a
  draft in the composer and confirm the shortcut steers the draft and leaves
  both rows waiting.
- **Expected**: The single submit slot contains exactly one button in every
  state: disabled Send while idle and empty, enabled Send while running with
  content (which queues the prompt), and Stop while running with an empty
  draft. A's two prompts appear in FIFO order, the removed row never sends,
  and B's queue remains independent. Send now delivers promoted input in click
  order into the current turn without requesting a stop. An active TaskWait
  yields to the input while delegates keep running. Refused input or input
  with a different permission mode remains queued for a later turn.
  A promoted row locks move/edit and Send now, but permits removal; promotion is
  one-way. Move up/down swaps only waiting rows, never crosses the promoted
  block, and persists. Edit is refused with a visible message while the input
  is non-empty, and otherwise removes the row and returns its text plus its
  file-reference chips to the composer. Immediate Stop aborts the current reply
  and preserves A's queued row;
  switching sessions preserves both queues. Ordinary completion, provider
  failure, and abort all resume queued sending automatically after durable
  finalization releases the session. No queued prompt starts while finalization
  is pending; each subsequent turn starts once in FIFO order, without another
  click or session switch. Repeated terminal handling does not double-dispatch.
  Other sessions' queues remain unchanged, and quitting while finalization is
  pending preserves queued work without starting another turn. Pending-admission
  rows disable all five actions, explain Saving in each tooltip, show Saving
  on Send now, and remain visible without restoring a second draft. Once acknowledged, remove deletes the durable row and edit restores
  exactly its captured draft; neither row reappears after refresh. A local Host
  admission timeout clears the pending row, reports the error, and restores
  the rejected composer draft; retry can queue normally. With an empty composer
  the steering shortcut promotes the first waiting row exactly as its Send now
  action does, skipping rows that are saving or already promoted; with a draft
  present it steers the draft and leaves the queue untouched.
- **Specs linked**: `03-runtime/01-ipc-protocol.md` (§5.6),
  `04-ux/08-component-spec.md` (§11),
  `04-ux/09-interaction-patterns.md` (§3.4), ADR 0118, ADR 0213, ADR 0265
- **Acceptance**: C (chat, stream, and session isolation), Quality
- **Milestone**: M6+
- **Status**: Source-level regression and deterministic desktop finalization /
  Agent Host integration covered (`queued-turn-finalization.test.mjs`);
  promotion, reorder, and edit contracts covered at source level
  (`composer-send-state.test.mjs`); the empty-composer send-now shortcut is
  covered by `composer-queued-send-now-shortcut.test.mjs`; full UI scenario Draft

## E2E-QUEUE-promote-orders-delivery-by-click: Two Send now clicks deliver in click order

- **Preconditions**: Provider configured; session A is running a turn with at
  least one completed tool batch; three prompts are queued behind it.
  the first queued row. 3) Confirm the promoted block orders third → first, that
  both rows lock their move/edit actions, and that the remaining row is
  still editable. 4) Observe steering delivery at the next model request.
- **Expected**: The first click is delivered first and the second second — the
  click order is the delivery order, not "last click wins" and not the original
  queue order. Both rows appear as user messages in the same active turn;
  the queue no longer lists either accepted promoted row. Both
  promoted rows show as waiting and cannot be edited or reordered. Removal
  remains available until delivery. Refused steering retains the row for the
  next turn and leaves it cancelable. If cancellation wins admission,
  the input never executes; if delivery wins, cancellation reports that it
  already started. The row disappears only after Host acknowledgement.
  A stalled steering delivery does not block admission or cancellation of other
  queued inputs. Failed durable removal after acceptance reports an error and
  rejects cancellation; a subsequent drain retries cleanup without re-executing
  the accepted input in the live Host. The waiting row keeps its actions and is not delivered before
  either promoted row.
- **Specs linked**: `03-runtime/01-ipc-protocol.md` (§5.6),
  `04-ux/08-component-spec.md` (§11), ADR 0265
- **Acceptance**: C (chat, stream)
- **Milestone**: M6+
- **Status**: Draft; ordering and the adjacent delivery are covered by
  `turn_queue`, `turn-queue`, and `agent-host` unit tests
- **Specs linked**: `03-runtime/01-ipc-protocol.md` (§5.6),
  `04-ux/08-component-spec.md` (§11), ADR 0265
- **Acceptance**: C (chat, stream)
- **Milestone**: M6+
- **Status**: Draft; underlying ordering covered by `turn_queue`,
  `turn-queue`, and `agent-host` unit tests

## E2E-QUEUE-reorder-moves-plain-neighbours: Move up/down reorders the waiting queue

- **Preconditions**: Provider configured; a turn is running with at least three
  prompts queued and no promoted row.
- **Steps**: 1) Move the third row up twice and confirm it becomes first. 2) Move
  the first row up once and confirm nothing moves. 3) Promote a row, then try to
  move the adjacent waiting row across it. 4) Reload the renderer and inspect the
  queue order.
- **Expected**: Each move swaps the row with its adjacent waiting neighbour and
  the Host persists the new order, so a reload reproduces it. The waiting-block
  boundary and the promoted block are immovable: a move at the block edge is a
  no-op that never reaches the Host, and no move changes a promoted row's place.
- **Specs linked**: `03-runtime/01-ipc-protocol.md` (§5.6), ADR 0265
- **Acceptance**: C (chat), F (persistence)
- **Milestone**: M6+
- **Status**: Draft; host-side reorder covered by `turn_queue` unit tests

## E2E-QUEUE-cancel-next-during-start: The next waiting message stays cancelable

- **Preconditions**: An isolated desktop profile and a local provider that can
  hold a reply open; one active turn followed by queued messages A and B.
- **Steps**: Release the active reply. While A is executing, cancel B. Finish
  A and send another message.
- **Expected**: A's early runtime events retain A's identity. B remains queued
  at position 1 until cancellation succeeds, never reaches the provider, and
  disappears from the durable queue. A and the subsequent message complete.
- **Specs linked**: `03-runtime/19-remote-agent-control-protocol.md` (turn states)
- **Acceptance**: C (chat), F (persistence)
- **Status**: Manual local-provider acceptance scenario

## E2E-QUEUE-edit-restores-draft-only-when-input-empty: Edit restores the queued draft

- **Preconditions**: Provider configured; a turn is running with a queued prompt
  that carries text and a file-reference chip; the composer input is empty.
- **Steps**: 1) Type a draft, then choose edit on the queued row. 2) Clear the
  composer and choose edit again. 3) Confirm the queue no longer lists the row
  and the composer holds the row's text and its file-reference chip. 4) Send it
  and compare the transcript with the original queued prompt. 5) Queue an image
  with a file, quit the app normally, reopen it, and edit the restored row.
  Repeat with an image-only row and a text-only row; resend each edited draft.
- **Expected**: With a non-empty input (or an attachment chip) the edit is
  refused with a visible message and the row stays queued. With an empty input
  the row leaves the queue, the Host no longer lists it, and the composer holds
  the exact text plus the original file-reference chip — not the
  serialized prompt the Host received. Re-sending produces the same prompt as the
  queued row would have. After restart, Host-stored content and all attachments
  survive editing and resubmission even though the in-memory draft is gone.
- **Specs linked**: `04-ux/08-component-spec.md` (§11), ADR 0265
- **Acceptance**: C (chat, stream)
- **Milestone**: M6+
- **Status**: Draft; composer-side contract covered by
  `composer-send-state.test.mjs`

## E2E-011g: New Task does not leave the previous transcript on screen

- **Preconditions**: Provider configured; session A has a visible transcript
  (idle or streaming); the group's latest session is non-empty.
- **Steps**: 1) Click New Task (sidebar, top bar, or Cmd/Ctrl+N). 2) Observe
  the chat surface on the next frame, before the new sidebar row is required
  to exist. 3) Type in the composer during that interval. 4) Wait for the new
  row and send. Also send while creation is still pending, and overlap two
  first-input materialization requests with the host response delayed.
- **Expected**: A's transcript is gone on the first frame (empty home, idle
  Send). The composer does not stay on A's draft. After `session.create` the
  same empty session is selected, any text typed during the wait belongs to
  that session, and sending does not create a second row. Repeating New Task
  before sending reuses the row. The host is not asked to `session.list` or
  `session.get` before the empty destination is visible. Overlapping inputs
  share one creation and its session id; the first send does not invalidate
  New Task navigation. Superseded creation returns no target to waiting inputs,
  and a failed create releases the slot so retry can succeed.
- **Specs linked**: `04-ux/09-interaction-patterns.md` (§1.6),
  `04-ux/08-component-spec.md` (§11), ADR 0154
- **Acceptance**: C (session creation), Quality
- **Milestone**: M2
- **Status**: `pnpm test:e2e:composer-paste` covers first Send, oversized
  paste, and navigation cancellation with a delayed create reply over the
  Electron preload bridge. Source-level tests also cover create failure and retry.

## Composer file-reference undo regression

- Add a file reference to an unsent draft, select the chip, delete it, then
  undo and redo with the native editor shortcuts. Undo must restore both the
  chip and the file path used by submission; redo must remove both.
- Switch to another chat and back after undo: the other draft stays empty and
  the source retains the restored reference. Typing a removed chip's private-use
  token as plain text must not restore the attachment.
- Automated by `pnpm test:e2e:composer-paste` (`fileReferenceUndoRedo`).

## Conversation Top Bar

## E2E-087: Conversation top bar renders on the chat route

- **Preconditions**: Provider configured; at least one session exists.
- **Steps**: 1) Open the chat route. 2) Inspect the 46px bar at the top of the
  conversation area. 3) Confirm it shows the concise session/task title and the
  New task / Search buttons; hover or focus each and inspect its tooltip. Confirm
  the sidebar toggle appears **only when collapsed**. 4) Customize each shortcut
  in Settings → Shortcuts and confirm the tooltip updates; disable each binding
  and confirm its shortcut is omitted. 5) Switch to Scheduled, Plugins, or
  Settings and inspect the same top region.
- **Expected**: Every route-owned top region uses the same `--ds-toolbar-height`
  (46px), bg-primary surface, and bottom border; Windows/Linux reserve the
  same 120px native-control band at the right. On the chat route the
  conversation top bar renders with its title and actions only; it has no model
  or Agent|Plan|Goal mode control. The
  left-of-input Composer chip owns the active session's Agent/Plan/Goal switch,
  and the Composer-right combined chip owns model and reasoning selection. The
  task title is the only visible title text and uses the available width,
  with an ellipsis only on overflow. Check an English title longer than 10
  characters in wide and narrow layouts, with the sidebar expanded/collapsed
  and the work panel open/closed; titles must not overlap the action buttons.
  The complete title and project scope remain available through its tooltip.
  New task and Search tooltips show their effective platform-formatted
  shortcuts, including custom bindings; an explicitly unbound shortcut is
  omitted, while the accessible name remains the localized action. The sidebar
  toggle is present only when collapsed (no duplicate of the sidebar's control).
  On every other route the frameless drag band renders instead (no chat top-bar
  controls) while retaining the same surface and alignment. The bar is draggable
  to move the window; interactive controls do not start a window drag.
  macOS leaves the left 88px clear for traffic lights only while the sidebar is
  collapsed (8px in fullscreen); Windows/Linux leave the right 120px clear for
  native window controls.
- **Specs linked**: `04-ux/08-component-spec.md` (§2 Topbar)
- **Acceptance**: C (send/UI), Quality
- **Milestone**: M2
- **Status**: Draft

## E2E-087a: Destination page headers clear the titlebar band on macOS

- **Preconditions**: macOS build; at least one plugin installed.
- **Steps**: 1) Open the Plugins route with the window at its default size.
  2) Inspect the top of the page: the "Plugins" title row, its primary action,
  and the overflow menu button. 3) Scroll the page to the top and confirm no
  page content is hidden behind the 46px band. 4) Repeat on the Scheduled
  route. 5) Open a plugin's detail sheet and inspect its head.
- **Expected**: The page header renders fully below the frameless drag band on
  macOS as it already does on Windows/Linux: the title row is not clipped, and
  the Installed / Marketplace segmented control and search field sit at their
  intended offset instead of at the window's top edge. `.page-frame` reserves
  `--ds-toolbar-height` plus an 8px buffer on darwin, win32, and linux alike.
  Scrolling Plugins and Scheduled use a destination-owned
  scroller rather than the chat transcript scroller, so the bottom rows remain
  fully painted and reachable instead of inheriting the Composer occlusion mask.
  The plugin detail sheet mounts on the viewport overlay host, stays above the
  expanded sidebar and titlebar band, and keeps its own head at the top edge,
  with its close button opting out of the drag rectangle.
- **Specs linked**: `04-ux/08-component-spec.md` (§2.3 Layout)
- **Acceptance**: C (UI), Quality
- **Milestone**: M2
- **Status**: Source-level regression covered
  (`apps/desktop/test/plugins-page-style.test.mjs`,
  `apps/desktop/test/route-scroll.test.mjs`); full UI scenario Draft

## E2E-088: Composer Agent/Plan/Goal chip updates the session

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

## E2E-088a: Composer configuration controls survive project/session initialization

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
  In zh-CN/zh-TW, the Composer permission menu renders the Accept edits option
  as `允许编辑` / `允許編輯` and keeps it on one line.
- **Specs linked**: `04-ux/08-component-spec.md` (§11),
  `04-ux/09-interaction-patterns.md` (§5A), ADR 0137
- **Acceptance**: C (new project/session composer)
- **Milestone**: M2
- **Status**: Draft

## E2E-088b: Composer placeholder guidance follows page and session context

- **Preconditions**: English and zh-CN locales are available; a provider is
  configured; at least one Skill is active; both an empty home and two
  conversations can be opened.
- **Steps**: 1) On empty home, record the welcome placeholder and wait longer
  than 4 seconds to confirm it is unchanged. 2) Open conversation A, record
  its guidance, type and clear text, focus and blur the textarea, and wait;
  confirm the copy is unchanged. 3) Switch to conversation B and then back to
  A, recording each guidance change. 4) Switch between home and a conversation
  and inspect the command/file and keyboard hints. 5) Type `/` and inspect the
  slash menu. Include Skills with long English/CJK descriptions, short/no
  descriptions, a separate title/argument hint, and an exceptionally long slash
  name; also inspect a long filename in `@` mode. Repeat at 800px and 1680px
  viewport widths with 320px and 640px composer widths. 6) Switch to zh-CN and
  repeat the context-switch checks.
- **Expected**: The initially rendered context starts with its welcome copy and stays stable until
  the page/session context changes. Each context switch advances to the next
  localized command/file or keyboard hint with an opacity fade; no timer-driven
  changes occur. The keyboard hint includes Shift+Enter and a submit hint, while the
  command/file hint includes `/` and `@`. The slash menu still contains `/new`,
  `/compact`, `/agent-mode`, `/plan-mode`, and `/goal-mode`, followed by a
  Skills group at the bottom. Selecting a Skill inserts `/skill:<id>`; sending
  it keeps the typed command chip visible and the model calls `Skill` with the
  original ID before answering. Verify builtin, plugin, and user Skill prefixes,
  multiple inline references, and a prompt template sharing the unprefixed
  Skill name; inactive and unknown Skills must not resolve. zh-CN shows the
  matching localized copy, including
  `Shift+Enter for newline · Use Send to submit`.
  Long descriptions use only the space remaining after command names and
  hints, so short names stay fully visible. Descriptions and oversized names
  ellipsize within the row without horizontal overflow; file names retain the
  available row width. Name highlights and click acceptance with input focus
  retained remain intact.
- **Specs linked**: `04-ux/08-component-spec.md` (§11),
  `04-ux/04-builtin-commands.md` (§7–8)
- **Acceptance**: C (send/UI), Localization, Quality
- **Milestone**: M2
- **Status**: Source-covered (`composer-placeholder-context.test.mjs`);
  slash-menu layout covered by `pnpm test:e2e:composer-autocomplete` after
  `pnpm build:js` (real React/Chromium and production CSS, deterministic command
  fixtures; no provider required). Full provider/session scenario Draft;
  branch runs do not replace post-integration E2E

### Connected MCP slash selection (#1377)

- Restart Desktop with an enabled saved MCP server. Without visiting MCP
  settings or sending an ordinary message first, open the slash menu and
  submit a server/tool command. Discovery initializes the connection and the
  first prompt reaches the selected tool; opening the menu executes no tool.

- With a ready user MCP server, type `/` or search its display label. The MCP
  group appears before Skills. Enter and mouse selection insert the encoded
  server command without sending or invoking a tool.
- Send a task after the command. The runtime receives the server-specific
  instruction, exact server IDs, and task; persisted command metadata retains
  the typed text. All six fixture tools are activated without ToolSearch; a
  similarly named server remains unselected. Steering activates only for the
  request consuming the queued message. Plan and Host permissions still apply.
- Submit a server/tool command with no task text or attachment. Main rejects it
  before opening or persisting a turn; adding task text or an attachment allows
  the selected tools to be offered to the model.
- Disconnect, disable, or remove project access between menu selection and
  send. Sending fails before a new turn or history replacement. Steering uses
  the same validation; native Pi cannot silently accept Desktop MCP commands.
- Coverage: `apps/desktop/test/composer-mcp.test.mjs` exercises the real command
  service and prompt/steering IPC with external runtime boundaries stubbed.
  `node scripts/e2e-composer-ime-stack.mjs` exercises the real React editor,
  completion controller and keyboard/mouse acceptance in isolated Electron.
  `node scripts/e2e-composer-mcp.mjs` uses production sidecar transport, an
  isolated Rust Host, a real stdio MCP child and a local SSE model fixture.
  It verifies the sixth tool executes without ToolSearch and its server-only
  nonce reaches the next model request. These fixtures do not prove a real
  provider's tool choice or remote MCP health.
- Select `/mcp:<server>:<tool>` by keyboard and pointer, then submit or steer.
  Main preserves the original command and forwards exact server/tool IDs.
  Only the requested tool activates; similarly named tools, another server's
  tools and removed tools cannot broaden the selection. Whole-server rows
  remain selectable and existing active tools retain their availability.
- Run `MCP_SELECTION_TOOL=1 node scripts/e2e-composer-mcp.mjs` for the
  individual-tool variant of the deterministic sidecar/Host/MCP scenario.

## E2E-089: Composer model menu opens upward and switches model

- **Preconditions**: Chat route active; provider configured with two reasoning
  models whose binding defaults differ.
- **Steps**: 1) Click the Composer-right model × reasoning chip. 2) Confirm the
  menu opens upward from the bottom composer. 3) Enter Model, select a different
  provider/model, and return to the root. 4) Confirm its default thinking level,
  choose another supported level, then reselect the same model. 5) Open Settings
  from the command palette or application menu.
- **Expected**: The trigger uses a Bot icon while retaining the current model
  and reasoning labels. The root shows only Model and Reasoning level entries.
  The Model submenu lists enabled runnable providers and only the model bindings
  saved for each provider, with each model row visibly indented beneath its provider
  heading. Cached or freshly discovered models may supply display names and
  metadata for those bindings, but unconfigured discovery results are absent;
  configured IDs remain available when discovery is unavailable. The root slider
  lists the selected model's supported levels. Selecting a different model
  updates the active session to that binding's default thinking level; selecting
  the already-active model preserves a manually selected level. Settings opens
  from the command palette/menu. The Composer model trigger ellipsizes long IDs.
  Each option shows one display name only, and hovering a long option exposes its
  complete display name in the tooltip without changing the menu layout or adding
  a visible model ID.
- **Specs linked**: `04-ux/08-component-spec.md` (§11, model menu),
  `03-runtime/13-model-catalog-and-selection.md`
- **Acceptance**: C
- **Milestone**: M2
- **Status**: Component-covered by `pnpm test:e2e:composer-model-selection`
  (isolated React/Electron with the real Composer hook); full provider/session
  desktop journey remains Draft.

## E2E-COMPOSER-narrow-controls: Composer controls adapt to a narrow chat column

- **Preconditions**: Chat route active; a configured model is selected; the
  composer is rendered in both empty-home and thread-docked variants.
- **Steps**: 1) Set the Composer container to 560px and inspect the combined
  model × reasoning trigger. 2) Set it to 480px, then 450px. 3) At each width,
  inspect the mode, permission, context, enhancement, and Send/Stop controls;
  open the model menu from the narrow trigger; repeat the visual check in the
  other Composer variant.
- **Expected**: The toolbar remains one non-wrapping row and does not overflow
  its container. At 560px the reasoning label and separator yield first; at
  480px the model label is further capped; at the 450px floor the combined
  model × reasoning trigger is a 32px icon-only control. The full selection is
  still available through the trigger's menu, tooltip, and accessible name.
  Mode and permission labels remain single-line and ellipsized, the context
  ring and action controls retain usable hit targets, and the single Send/Stop
  slot remains reachable. Home and thread-docked composers match.
- **Specs linked**: `04-ux/08-component-spec.md` (§11)
- **Acceptance**: C (send/UI), Quality
- **Milestone**: M2
- **Status**: Automated on task candidate `737435248ebd32e0b2a406f93b7b245784bc4289`
  (base `cea6e02c`): `pnpm test:e2e:layout` 167/167 including the 450px
  model-chip assertion; `pnpm test:e2e:composer-autocomplete` and
  `pnpm test:e2e:composer-paste` passed. Source-covered by
  `composer-responsive.test.mjs`.

## E2E-090: Transcript bottom reserve tracks the docked composer height

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

## E2E-144: Sending a prompt keeps the transcript at the latest turn

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

## Session Persistence

## E2E-020: Session survives restart

- **Preconditions**: Session with message history exists.
- **Steps**: 1) Quit app. 2) Relaunch. 3) Open session list.
- **Expected**: Previous session appears; messages recoverable.
- **Specs linked**: `03-runtime/04-data-storage.md`, `03-runtime/10-session-state-machine.md`
- **Acceptance**: F (session survives restart)
- **Milestone**: M2
- **Status**: Automated (protocol smoke: host-level persistence; full restart lane manual)

## E2E-021: Delete session works

- **Preconditions**: A session exists near the bottom of the expanded Sidebar.
- **Steps**: 1) Open its overflow menu. 2) Verify the menu and Delete action stay
  inside the window. 3) Repeat in a short window and scroll the menu to its last
  action. 4) Delete the session and observe the session list.
- **Expected**: The menu stays within the viewport, the last action is reachable,
  and the deleted session disappears from the list with its data removed.
- **Specs linked**: `03-runtime/04-data-storage.md`,
  `04-ux/09-interaction-patterns.md`
- **Acceptance**: F (delete session)
- **Milestone**: M2
- **Status**: Unit-covered (`sidebar-floating-menu.test.mjs`,
  `sidebar-navigation.test.mjs`); rendered viewport scenario Draft

## E2E-021a: Rename session title persists without changing activity

- **Preconditions**: A project-scoped session and a path-less session exist;
  at least one session has transcript history and one still has the default
  title. The standalone Session Titles plugin is enabled with
  `session.autoTitle`, `agent.complete`, and `models.list`, a deterministic test
  model, a custom prompt template, and thinking set to off.
- **Steps**: 1) Open a Sidebar session overflow menu or right-click a session
  row and choose Rename. 2) Enter a title with surrounding whitespace and
  save. 3) Verify the title in the Sidebar, topbar, Project archive, and
  Search. 4) Restart the app and verify the title again. 5) Try an empty and
  an over-80-Unicode-code-point title. 6) Open **Session Titles: Configure**,
  set the prompt to return a fixed test title, choose the deterministic test
  model, and save. 7) Send the first prompt in the default-title session. 8)
  Confirm the Sidebar and topbar immediately show the normalized
  48-character prompt fallback, then wait for `session:turnEnded` and the
  plugin completion, which replaces that fallback with the deterministic test
  title. 9) Manually rename that session and complete another turn. 10) Send
  the first prompt in another default-title session with the plugin disabled.
- **Expected**: The saved title is trimmed, displayed across every current
  session-summary surface, and persists after restart. The session stays in
  the same project or Temporary group, its transcript/message count and
  recent-activity ordering do not change, and historical notification title
  snapshots are unchanged. Empty and overlong values are rejected. Sending the
  first prompt immediately persists the normalized 48-character prompt fallback
  as a still-replaceable automatic title. With the plugin enabled, that fallback
  is replaced by the deterministic test title after the completed turn; after a
  manual rename, a later plugin completion cannot replace it. A session without
  the plugin keeps its prompt fallback, and a second prompt never changes it.
- **Upgrade regression**: In an isolated v22 fixture, manually rename a session
  to lowercase `new task` before opening it in the current build. After upgrade,
  the title remains `new task` with source `legacy`; first-prompt derivation and
  plugin title writes cannot replace it. New sessions still derive titles.
  Host regression: `v22_database_migrates_session_title_sources_without_losing_titles`.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `03-runtime/04-data-storage.md`, `03-runtime/06-host-rpc-protocol.md`,
  `03-runtime/02-agent-runtime.md`, `07-plugins/03-plugin-api.md`,
  `07-plugins/13-plugin-permissions-matrix.md`, `04-ux/01-ui-ia.md`,
  `04-ux/08-component-spec.md`, ADR 0143, ADR 0323
- **Acceptance**: F (session metadata persistence), Quality (localized task
  management)
- **Milestone**: M2
- **Status**: Draft (run only in a capable environment when this surface changes)

## E2E-021b: Session context menus expose hover submenus

- **Preconditions**: A session exists, including one whose scratch directory
  has not been created yet. The session can create a branch; worktree actions
  are available when it belongs to a Git project.
- **Steps**: 1) Open the session overflow menu or right-click its row. Hover Git
  and verify its second-level actions appear; click/tap Git to open it without
  hover. Use ArrowRight to enter, ArrowLeft to return, and Escape to close only
  the child menu. 2) Open Copy and choose Copy conversation ID, Copy session
  path, and Copy conversation link in turn; paste each clipboard value. 3) Enable
  developer mode, reopen the menu, and choose Open session path. 4) Disable
  developer mode and verify Open session path is absent while Copy remains.
- **Expected**: Git and Copy are menuitem/haspopup triggers; hover and click
  reveal their child menus without dismissing the root. ArrowRight enters a
  child, ArrowLeft and the first Escape return to its trigger, and a second
  Escape closes the root. Child actions remain keyboard reachable and execute
  once. The ID equals the session id, the path equals the Host-resolved scratch
  path for local sessions, and the link is the canonical conversation link.
  Remote sessions omit Copy session path. The system file manager opens
  `<data_dir>/scratch/<sessionId>/` when the developer-only Open session path
  action is chosen. The renderer never sends a filesystem path to Main.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `04-ux/08-component-spec.md`, `04-ux/06-settings-ia.md`,
  `04-ux/09-interaction-patterns.md`
- **Acceptance**: C (sessions), Quality (nested menu interaction)
- **Milestone**: M2
- **Status**: Component interaction automated (`worktree-menu-user-path.test.mjs`,
  `sidebar-menu-panel.test.mjs`, `sidebar-navigation.test.mjs`); full Sidebar
  desktop journey remains Draft

## E2E-021c: Bottom-edge project menus stay beside their anchor

- **Preconditions**: The expanded Sidebar shows a retained project in its lowest visible row, with insufficient room below it for the project menu.
- **Steps**: 1) Open the project's Copy submenu; copy the project name and path
  and verify each pasted value. 2) Right-click the bottom project row and
  inspect the root menu. 3) Close it, open the row's overflow button, and hover
  Copy and Git. Verify both child menus and all actions stay inside the viewport.
- **Expected**: Both root-menu entry points place the menu immediately above
  the row when it cannot fit below; otherwise they open below. Copy yields the
  displayed project name and path. Child submenus remain attached to their
  trigger, flip sides as needed, and are neither clipped nor displaced.
- **Specs linked**: `04-ux/08-component-spec.md`, `04-ux/09-interaction-patterns.md`
- **Acceptance**: Quality (sidebar interaction)
- **Milestone**: M2
- **Status**: Automated (`node scripts/e2e-three-column-layout.mjs --sidebar-only`, `sidebar-floating-menu.test.mjs`, `sidebar-navigation.test.mjs`)

## E2E-036: Settings session-import destination retired

- **Expected**: Settings has no session-import tab or scan panel. Plugin session
  import remains available through the host-owned API and is covered by
  E2E-214 / E2E-215 / E2E-216. The legacy local-session scanner remains covered
  by its importer unit tests.
- **Specs linked**: `04-ux/06-settings-ia.md`, `04-ux/08-component-spec.md`,
  `07-plugins/03-plugin-api.md`, ADR 0319 / D645
- **Status**: Retired by D645; Settings UI removed

## E2E-037: Core session-import project workflow retired

- **Expected**: Project binding and renderer refresh for imported sessions are
  verified through plugin-owned session import in E2E-216. Settings no longer
  invokes the legacy core session scanner/import path. Plugin ownership,
  durable project rows, and project archive behavior remain unchanged.
- **Specs linked**: `03-runtime/04-data-storage.md`,
  `04-ux/01-ui-ia.md`, `07-plugins/03-plugin-api.md`, ADR 0319 / D645
- **Status**: Superseded by E2E-214 / E2E-216

## E2E-038: Settings owns the project archive destination

- **Preconditions**: App running with developer mode enabled, at least one configured provider, one retained project, and one archived project.
- **Steps**:
  1. Open Settings and inspect the complete settings rail.
  2. Open General and change the theme in its Appearance card using the
     searchable theme picker.
  3. Open AI and inspect the Permissions and Defaults cards, including the
     Command shell row; confirm Context management has no settings card.
  4. Open Shortcuts and inspect the Keyboard shortcuts card.
  5. Open Instructions and save global instructions.
  6. Open Models and inspect the provider studio and inline import action.
  7. Open Skills and MCP and confirm each has its own external-import action.
  8. Open Projects and Info in order.
  9. Search Settings for "project" or "archive".
  10. In Projects, compare each group strip's count with its rendered rows.
  11. Switch the sort control from Recent to Name.
  12. Search for a known session title, confirm the owning project is selected
      and its inspector lists matching sessions, then reveal more than eight
      sessions; clear the search with the clear affordance.
  13. Open the inspector menu, dismiss it with Escape and with an outside press.
  14. Restore the archived project, then activate it.
  15. Archive one project session, open it from Projects, and return to Projects.
  16. Return to the app shell and open Plugins.
- **Expected**: The rail contains exactly Appearance, Conversation, Shortcuts, Voice, Behavior, Models, Instructions, Skills, MCP, Subagents, Projects, System, Cloud sync, Remote Hosts, and Info in that order, each with its semantic Lucide icon (Palette / MessageSquare / Keyboard / Mic / Sliders / Bot / FileText / BookOpen / Server / Sparkles / Archive / Monitor / CloudDownload / Globe / Info), and no two destinations share a glyph. The flat directory is visually grouped under four muted, non-interactive headings — Preferences / 偏好 for Appearance, Conversation, Shortcuts, and Voice; Agent / 智能体 for Behavior, Models, Instructions, Skills, MCP, and Subagents; Workspace / 工作区 for Projects; System / 系统 for System, Cloud sync, Remote Hosts, and Info — with whitespace and no divider lines between groups; searching keeps the destination results flat and hides empty groups together with their headings. The selected row carries an accent-tinted pill and an accent glyph, and the content pane opens with that same glyph at page scale beside the title. There is no General and no AI destination (D684): theme and type are Appearance, the transcript and composer rows are Conversation, network/storage/power are System, and the permission mode, default mode and Command shell row are Behavior → Session defaults; an available selected shell is represented by the selector without a duplicate Configured status, while default, fallback, and no-effective-shell states remain explicit; Context management has no settings card; Keyboard shortcuts and global instructions have their own destinations; Developer lives under Info; Projects shows active, closed, and archived durable rows without a visibility toggle, grouping them under the always-visible Pinned / All projects / Archived strips (D168/D267/D455) with per-section counts in a one-column workbench. The destination renders no hero block and no page-level counter run: the intro is one quiet description line, and each group strip's count agrees with its rendered rows; a click selects a row without leaving Settings; sorting by Name reorders rows inside every section without hiding any; search matches project fields and session titles and reports a match count, a session-title result selects its owning project, lists sessions in the inspector by latest activity with relative update times, and reveals history in batches of eight; clearing the search restores the complete index. The inspector menu closes on Escape and on an outside press. Bootstrap completion and background refreshes do not return Settings or Extensions to the chat home; the destination changes only after an explicit navigation action. Restore keeps the archive open and activation returns to chat with the restored project retained in the sidebar. Opening an archived session succeeds before clearing its archived state, returns to chat with that session selected, and makes it visible in the project sidebar; returning to Project archive no longer shows that session as archived. The home sidebar and global page results have no standalone Projects destination; Settings search finds Projects; Plugins remains an independent app-shell destination.
  Cloud sync and Remote Hosts appear in packaged Settings with Experimental
  badges on their navigation rows and page titles; see `04-ux/06-settings-ia.md`.
- **Specs linked**: `04-ux/06-settings-ia.md`, `04-ux/01-ui-ia.md`, `03-runtime/11-provider-model-system.md`
- **Acceptance**: B (model configuration), F (project persistence)
- **Milestone**: M4
- **Status**: Unit-covered (`settings-project-archive.test.mjs`, `project-archive.test.mjs`, `sidebar-navigation.test.mjs`); rendered scenario Draft

## E2E-091: Appearance card selects searchable theme and language pickers

macOS OS-event acceptance: `PI_E2E_SYSTEM_APPEARANCE=1 node scripts/e2e-browser-system-appearance.mjs`.
The opt-in probe temporarily changes OS appearance and restores it in a finalizer.
It mounts the bundled Browser with production lifecycle functions in sandboxed
Electron, checks light/dark/light paint, fixed app/plugin palettes, view recreation,
process restart and listener removal. Host/plugin-registry edges are synthetic;
this does not claim an installed full-app settings journey.

- **Preconditions**: App running on macOS; the harness can exercise English,
  Simplified Chinese, Traditional Chinese, Turkish, German, Spanish, French,
  Korean, and Brazilian Portuguese system locales.
- **Steps**:
  1) Open Settings → Appearance.
  2) In the Appearance card, open the Theme picker. Confirm System, Light, and
     Dark are pinned at the top; select Dark and confirm the trigger shows Dark
     and the UI switches to dark.
  3) Select Light and confirm the UI switches to light. With a Browser tab open,
     select System and change OS appearance light → dark → light. Confirm the
     shell and Browser address/navigation toolbar update together without a
     settings write or restart. Repeat with explicit Light and Dark: OS changes
     must not override the selected app palette.
  4) In the Language row, open the searchable picker. Confirm Auto is pinned
     at the top with the detected native name and that English, 简体中文,
     繁體中文, Türkçe, Deutsch, Español, Français, 한국어, and Português (Brasil)
     are listed by native name. With Simplified Chinese selected as the OS
     locale, selecting Auto applies Simplified Chinese; with Traditional Chinese
     selected, Auto applies Traditional Chinese; with Brazilian Portuguese
     selected, Auto applies pt-BR.
  5) Select English, 简体中文, 繁體中文, Türkçe, Deutsch, Español, Français,
     한국어, and Português (Brasil) in turn and confirm shell chrome switches
     to each locale without a reload. Confirm `zh-Hant` and `zh-HK` resolve to
     繁體中文, `de-DE` to Deutsch, `es-MX` to Español, `fr-CA` to Français,
     `ko-KR` to 한국어, and `pt`, `pt-BR`, `pt_BR`, and `pt-PT` to pt-BR.
  6) Type a native name or English name into the language search and confirm
     unmatched locales disappear. Type a theme name into the theme search and
     confirm unmatched options disappear.
- **Expected**: Theme and Language are searchable picker rows (not a card grid
  and not a native select); each closed trigger sizes to the current label,
  capped by the settings control column, without overflowing the row. Theme lists System, Light, and Dark,
  then any plugin themes after a divider. Auto resolves the OS locale through
  the main process (`app.getLocale()`), passes it safely through the sandboxed
  preload bridge, and reflects the detected native name inline in the menu;
  zh-TW, Turkish, German, Spanish, French, Korean, and Brazilian Portuguese
  are complete shell catalogs, including release-note copy; switching options
  updates the live UI without a reload.
- **Specs linked**: `04-ux/06-settings-ia.md`, `04-ux/02-i18n-english-first.md`
- **Acceptance**: A (core shell), H (localization)
- **Milestone**: M4
- **Status**: Partially automated in `scripts/e2e-settings-scroll.mjs` for pt-BR picker selection and live copy; the full locale list and OS Auto-resolution matrix remain documented.

## E2E-091a: Theme changes keep the Windows frameless background aligned

- **Preconditions**: App running windowed on Windows with the OS in light mode.
- **Steps**: 1) Select Dark in Settings → Appearance → Interface. 2) Inspect the lower-left, lower-right, and resize edges while the shell settles and while collapsing/expanding the sidebar. 3) Select Light and repeat. 4) Switch the OS color preference and select System; repeat after the app resolves the system theme.
- **Expected**: The native BrowserWindow background follows the resolved application theme (`#181818` for dark and `#ffffff` for light), so no white strip appears around the frameless renderer during theme changes or shell animations. macOS keeps its transparent vibrancy behavior unchanged.
- **Specs linked**: `04-ux/06-settings-ia.md`, `02-architecture/01-architecture.md`
- **Acceptance**: A (core shell)
- **Milestone**: M5
- **Status**: Documented; native Windows validation pending

## E2E-039: Settings titlebar drag moves the window

- **Preconditions**: App running windowed on macOS with Settings open.
- **Steps**: 1) Record the window position. 2) Drag the empty 46px band above the settings rail. 3) Drag the same band above the content pane. 4) Use Back, search, Project archive, and navigation controls. 5) In light and dark themes, sample the top row's color above the rail and above the content pane.
- **Expected**: Either top-band drag moves the native window; Back, search, and navigation remain interactive and never initiate a window drag. The top row above the rail matches the rail surface (`#f4f4f4` light / `#000` dark) and the top row above the content pane matches the primary surface, so the band never renders a mismatched color over the rail.
- **Specs linked**: `04-ux/06-settings-ia.md`, `04-ux/01-ui-ia.md`
- **Acceptance**: Quality (key operations feel polished)
- **Milestone**: M5
- **Status**: Draft

## E2E-043: Settings content follows window width

- **Preconditions**: App running windowed on macOS with Settings open.
- **Steps**: 1) Open General at the default window width and record the content-card width. 2) Expand the window to 1600px wide. 3) Open Models, Skills, MCP, and Projects. 4) Shrink the window to the supported 800px minimum.
- **Expected**: The right-side content cards expand and contract with the available pane at every tested width; the 275px rail and pane gutters remain stable; controls remain visible without clipping or horizontal page scrolling.
- **Specs linked**: `04-ux/06-settings-ia.md`, `04-ux/07-ui-design-system.md`
- **Acceptance**: Quality (key operations feel polished)
- **Milestone**: M5
- **Status**: Unit-covered (`settings-responsive-layout.test.mjs`); scenario Documented

## E2E-040: Nested tool activity survives transcript reload
- **Preconditions**: Provider configured; project open; a turn can contain
  progress text, multiple search/tool/thinking items, and a failed or denied tool.
- **Steps**: 1) Stream progress paragraph A, a multi-item search segment,
  progress paragraph B, and a multi-item command segment with adjacent Bash rows.
  2) Inspect the open active group; manually close it while more output arrives.
  3) Complete the turn and confirm exactly one process disclosure owns every
  pre-answer row; close it and confirm the groups and run rows close with it, then
  reopen and confirm the group choice returns. 4) Open one completed group and one
  item, copy its output, close and reopen the group, then open a sibling group
  independently. 5) Switch `Transcript display` across Flat, Commands first, and
  Fully folded and inspect the grouping, group boundaries, where the run rows
  render, and the disclosure count. 6) Repeat with a singleton item and with the
  last activity group's literal final item set to a tool/search, thinking, failed
  tool, and denied tool. 7) Toggle `Show thinking` off and on and inspect the
  active-thinking, failure/recovery and completed states. 8) Remount rows within
  the retained pane, then reload the renderer and reopen the session.
  9) Stream explicitly marked Responses commentary followed by a final answer;
  check that only the process shows the commentary, then copy the answer before
  and after reopening the signed transcript row. Neither copy includes progress.
- **Expected**: A turn renders exactly one process disclosure containing every
  pre-answer row, the `Bash`/run rows included; the trailing answer, assistant
  errors and stopped trailing text stay outside it, as do pending actions. The
  active group stays open while the turn runs. After completion, ordinary groups
  with at most four visible items and Task topology groups remain open; larger
  ordinary groups start closed. Closing the turn's disclosure hides groups and
  run rows under it, and reopening restores their defaults and explicit user
  choices. In
  Fully folded (the default), run rows stay inside their groups and only ordinary
  assistant progress text splits a group. In Commands first, run rows render as
  their own rows beside the groups, adjacent calls stay separate, a row's detail
  stays closed until opened, and a normal assistant progress message or a command
  ends a group. In Flat, no nested group renders and the rows keep transcript
  order inside the outer disclosure. Every mode keeps the disclosure count at one.
  A singleton has no group wrapper. No item payload opens itself except the
  display mode's Thinking default: a tool/search row stays a header until the user
  opens it, while a final thinking item never selects an earlier tool. The header
  reports `Running`, `Finished`, `Stopped`, or `Failed` with failure and stop
  outranking a normal finish, reads `Thinking` while the live step is reasoning,
  never repeats the current command, and omits the duration when none was
  recorded. When `Show thinking` is off, no completed reasoning row renders; only
  the live TextShimmer `Thinking` indicator remains while reasoning streams, and
  turning it back on restores the completed rows. Parent, child and sibling
  choices are independent; closing/reopening a parent preserves descendants, and
  streaming/completion does not override user-owned choices. Retained-pane
  remounts preserve choices; renderer restart reapplies defaults while tool names,
  arguments, results and statuses remain restored. Group headers show bounded
  running and issue summaries without marking the whole turn failed.
- **Specs linked**: `04-ux/01-ui-ia.md`,
  `04-ux/07-ui-design-system.md`, `04-ux/08-component-spec.md`,
  `04-ux/09-interaction-patterns.md`
- **Acceptance**: C (chat stream), E (tools), F (persistence)
- **Milestone**: M3
- **Status**: Draft. Unit and style checks cover the display modes, Thinking
  defaults and header rules; this scenario remains the intended manual
  transcript-reload behavior.

## E2E-041: Conversation minimap navigates long transcripts

- **Preconditions**: A session contains enough user and assistant turns to
  scroll beyond one viewport and densely fill the minimap, including assistant
  responses emitted as multiple fragments around tool activity; a
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
- **Expected**: The rail contains one marker per visible user message;
  assistant and tool rows create no marker. The marker near the upper-third reading
  anchor exposes `aria-current`; hover and focus show the same localized sender
  and preview; nearby markers magnify horizontally without shifting the stack;
  activation smoothly scrolls to that user message;
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

## E2E-042: Pre-v7 storage archives via breaking reset; transcripts live in session files

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

## E2E-252: Session and folder drag/drop across projects

- **Preconditions**: Two projects are open in the sidebar; one holds an idle
  session, and one session somewhere is running a turn.
- **Steps**: 1) Drag the idle session row onto the other project group and drop
  it. 2) Reopen that session and read its transcript. 3) Attempt to drag the
  running session and, separately, open its session menu. 4) Drop a folder onto
  the projects list. 5) Drop a folder on the composer.
- **Expected**: The dragged idle session lists under the target project with its
  transcript, attachments, and tasks unchanged, and the move survives a restart
  because the session's project membership is persisted. The running session is
  not draggable, its context menu has no project-move list, and a move issued
  after a turn starts is rejected as busy rather than rebinding the agent.
  Dropping a folder on the projects list adds or switches to that project
  without creating a duplicate row, and a non-folder drop explains that a folder
  is required. Dropping a folder on the composer offers an explicit choice and
  never attaches directory contents: "Open as project" opens the project, and
  "Reference folder" inserts the literal path. The dragged row paints at reduced
  opacity and the eligible group shows an accent outline.
- **Specs linked**: `04-ux/09-interaction-patterns.md` §8,
  `03-runtime/06-host-rpc-protocol.md` (session.moveProject)
- **Acceptance**: D (project membership and workspace switching), Quality
  (drag/drop feedback and keyboard fallback)
- **Milestone**: M5
- **Status**: Documented; source-contract covered
  (`session-project-move.test.mjs`); automation pending

## E2E-046: PI-Desktop renderer branding and composer icon boundary

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
  gutter. The right Composer toolbar shows a Bot model × reasoning chip and
  the single submit slot; an installed plugin may contribute text actions
  between them. Without such a plugin no prompt-enhancement action appears.
  The footer Settings and Plugins actions are compact icon buttons;
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

## E2E-057: Message-owned review history survives commits and rolls back safely

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
  bottom/global entry. The completion opens nothing: the panel keeps whatever
  the user left it showing, and Review appears only after the user opens it.
  Every review card, inline and in the Review tab, is
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

## E2E-CHAT-turn-changed-files-summary: A finished turn lists the files it changed

- **Preconditions**: A project-bound Agent session with a writable workspace.
- **Steps**: 1) Ask the agent to create one file and edit another; watch the
  turn while it streams. 2) After the reply finishes, inspect the area below
  the answer: only the summary header is visible. Click it to expand, click
  again to collapse, then focus it and repeat with Enter and Space. Confirm
  hidden rows and the Review link cannot receive keyboard focus and the title
  keeps its viewport anchor. 3) Ask for a change touching more than twelve files
  across several directories; confirm its card starts collapsed independently.
  Expand it. 4) Click a row, then the `View all N files in Review` link.
  5) Roll back one file's change in Review and return to the turn.
  6) Ask a question that writes no files. 7) Switch sessions and come back.
- **Expected**: No summary appears while a turn streams or after a failed
  turn. A finished turn that wrote workspace files shows one borderless
  `Changes this turn` card below its answer and above plugin `entryExtra`
  blocks. It starts collapsed with only its chevron, title, file count, and
  summed `+`/`−` visible; directory counts remain visible for dense summaries.
  The full-width header toggles with click, Enter, or Space, exposes its state
  through ARIA, and leaves Review closed. Collapsed details occupy no space
  and cannot receive focus. Each turn's explicit choice is independent and
  survives ordinary rerenders. When expanded, each path appears once with
  its merged status letter and counts; up to four files use relaxed rows,
  more use dense rows with a directory count, and rows past 12 fold into
  `+N more`. A row click opens the session's Review tab scrolled to that file
  with its changes expanded; the link opens Review without expanding. The
  rolled-back file stays listed, struck through. Every earlier finished turn
  keeps its own card, a turn without writes has none, and a session switch
  fetches nothing extra. The per-call review rows are unchanged.
- **Specs linked**: `04-ux/08-component-spec.md` §4.4, D674
- **Acceptance**: D (workspace), Quality
- **Milestone**: M5
- **Status**: Unit/SSR-covered (`turn-changes-card.test.mjs`); isolated Chromium
  pointer, Enter/Space, independent disclosure, hidden-focus, and Review paths
  covered by `turn-changes-disclosure-user-path.test.mjs`; full UI scenario Draft

## E2E-CHAT-completed-turn-scrolls-to-prompt: A finished reply reads from its prompt

- **Preconditions**: An Agent session whose next reply is longer than the
  transcript viewport.
- **Steps**: 1) Send a prompt and let the transcript follow the reply to its
  end. 2) Send a prompt with a reply short enough to fit on screen. 3) Send a
  long prompt again and scroll up while it streams. 4) Stop a long reply
  midway. 5) Queue a follow-up while a long reply streams.
- **Expected**: 1) When the reply completes, its prompt sits at the top of the
  viewport and jump-to-latest appears. 2) The short reply stays at the bottom
  in follow mode. 3) The view stays where the user scrolled. 4) The aborted
  turn stays at the bottom. 5) The follow-up turn keeps following at the
  bottom.
- **Specs linked**: `04-ux/09-interaction-patterns.md` §2.2,
  `04-ux/08-component-spec.md` §4.4, D676
- **Acceptance**: Quality
- **Milestone**: M5
- **Status**: Automated (`pnpm test:e2e:transcript-turn-completion`, real
  `useTranscriptScroll` in Electron; `turn-completion-scroll.test.mjs`)

## E2E-CHAT-html-artifacts: Open generated pages from ordinary and project conversations

- **Preconditions**: Isolated Electron profile, real Host storage and loopback
  model fixture; no credentials or paid provider requests.
- **Steps**: Open assistant Markdown links to ordinary-session scratch HTML,
  primary project HTML, secondary project-folder HTML, project scratch HTML
  and an isolated session's worktree HTML. Repeat with a `file:` URL containing
  Unicode/spaces. Interact with each rendered page using native pointer input.
  Try a missing file, an outside HTML file, an outside text file whose folder
  and name contain spaces and CJK characters, an outside file under a `.ssh`
  folder, an outside extensionless file and the extensionless `.ssh/config`,
  and a positioned HTML source reference. Send a prompt that invokes BrowserPreview through the real
  sidecar in ordinary, project and isolated conversations. Disable Browser and click
  again. Switch conversations between cases.
- **Expected**: Valid pages render and execute in the side browser at their
  canonical path. A missing file reports an error without a guest load. The
  outside HTML, text, `.ssh`, and extensionless files open in the host file
  view (HTML as source, never executed) (ADR 0339).
  A line reference opens source, not execution. Disabled Browser remains
  disabled and reports an error. BrowserPreview uses its originating session's
  roots and delivers a valid resource tab. No visible-project fallback.
- **Automation**: `node scripts/e2e-chat-html-artifacts.mjs`, after building
  Host, runtime and Electron. Captures and synthetic profiles are retained in
  `PI_TEST_OUTPUT` (or the OS temporary directory).
- **Status**: Electron user-path covered on Windows and macOS (on macOS set
  `PI_TEST_OUTPUT` to a real-path directory such as `/private/tmp/...`; the
  `/var` → `/private/var` alias of the default temporary directory makes guest
  URL matching miss); Linux pending.

## E2E-059a: Transcript message plates follow WorkBuddy density

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

## E2E-CHAT-transcript-context-menu: Right-click a message or the transcript

- **Preconditions**: A session contains a completed user prompt and a
  completed assistant answer; the conversation pane is focused.
- **Steps**: 1) Right-click the user plate. 2) Choose Copy, then Select
  message text. 3) Select a phrase in the user plate, right-click that
  plate, and choose Copy; collapse the caret, right-click again, and
  choose Copy. 4) Right-click the assistant turn and choose Copy.
  5) Right-click empty space below the last turn and choose Copy
  conversation. 6) Press Escape on an open menu, then Tab. 7) Right-click
  a markdown link in the answer. 8) Edit the user message, replace its content,
  select a phrase, and right-click Copy. Repeat with a collapsed caret and
  Select message text, then cancel editing and copy the saved message.
- **Expected**: The user menu lists Copy, Select message text, Edit, and
  a separated Delete; the assistant menu lists Copy, Select message text,
  Regenerate, and Branch. Copy writes the live selection in the
  right-clicked turn when the menu opened over one; a collapsed caret
  or a selection outside that row falls back to the whole turn. Copy
  conversation writes the labelled thread. Both show a toast. Select
  text highlights the bubble. Escape and Tab dismiss the menu without
  running an item.
  A link still offers Open in default browser, Open in work panel, and
  Copy link address. Quote, Annotate, and Open side chat are absent
  (ADR 0268). The surface is a viewport-fixed body-level layer and does
  not resize the transcript. During editing, Copy uses the selected draft text
  or the full draft with a collapsed caret; Select message text selects the
  draft. Edit, Delete, and revision actions are absent until editing ends.
  Cancel preserves the original message. Automated Chromium component check:
  `node scripts/e2e-message-edit-copy.mjs`.
- **Specs linked**: `04-ux/08-component-spec.md` §8.3 / §8.5,
  `04-ux/09-interaction-patterns.md` (floating dropdown surfaces),
  ADR 0268
- **Acceptance**: C (chat stream), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`chat-context-menu.test.mjs`,
  `chat-context-menu-items.test.mjs`, `chat-context-menu-surface.test.mjs`);
  full UI scenario Draft

## E2E-CHAT-radial-background-menu: Radial menu on the empty transcript background

- **Preconditions**: Settings → Appearance → Radial context menu is available. A
  session has a completed user prompt, a completed assistant answer, and enough
  history to scroll.
- **Steps**: 1) With the switch off, right-click empty space below the last
  turn and confirm the vertical conversation menu. 2) Turn the switch on and
  right-click the same space; inspect the four sectors and their at-rest
  icon-and-label stacks. 3) Move the pointer through each sector and click
  Copy conversation; reopen, press the right button over a sector and release
  it there, and confirm the action runs. 4) Set Up to Copy last
  answer and Right to Leave empty, then reopen the ring. 5) Click the hub
  without moving, then reopen and press Escape; repeat with an outside click,
  a scroll, and a window resize; reopen and right-press on a sector, then
  release over the hub and confirm nothing runs. 6) Reopen with Shift+F10, walk
  the sectors with the arrow keys, and run one with Enter. 7) Restart the app,
  confirm the switch and the four directions persist, then write an unknown
  action for one direction into the settings file and confirm that direction
  resolves to its default.
- **Expected**: With the switch off the vertical menu opens unchanged. With it
  on, a four-sector ring centred on the pointer replaces it and stays fully
  inside the window near an edge. Every sector shows its action's icon and
  label before any hover; the sector under the pointer highlights as a filled
  sector, with no focus rectangle over it. Clicking runs that action, closes
  the ring, and shows the usual toast where the action copies. A right-press
  started while the ring is open runs the sector it is released on; releasing
  over the hub dismisses without running, and the release trailing the
  right-click that opened the ring runs nothing. A **Leave empty** direction renders a disabled sector and
  runs nothing; Copy last answer is disabled until an answer exists.
  Open browser reveals the work panel on a blank browser tab, the work panel
  direction toggles — it reads Open work panel while the panel is collapsed and
  Close work panel while it is open, and the second click closes it — and Open
  project folder opens the session's project in the OS file manager and is
  disabled for a session without one. A click on
  the hub, an outside press, Escape, Tab, scroll, and resize all dismiss the
  ring without running anything. Arrow keys move the highlight and Enter runs
  the highlighted action. The switch and the four directions survive a restart,
  and an unknown stored action falls back to that direction's default. Message
  rows, links, file references, the sidebar, and the work panel keep their
  vertical menus.
- **Specs linked**: `04-ux/09-interaction-patterns.md` §1.11,
  `04-ux/06-settings-ia.md`
- **Acceptance**: C (chat stream), Quality
- **Milestone**: M5
- **Status**: Chromium component check (`node scripts/e2e-radial-menu.mjs`:
  at-rest sector labels, pointer highlight, click/hub/disabled/Escape paths,
  the right-press marking release paths, arrow-key focus, and viewport
  clamping) plus unit coverage (`radial-menu.test.mjs`,
  `settings-roundtrip.test.mjs`); full desktop journey Draft

## E2E-CHAT-delete-turn-preserves-other-live-outputs

- **Preconditions**: A session has three completed turns. The renderer has
  assistant and tool outputs for all three turns, while persistence is missing
  at least one output because its outbox append is still pending.
- **Steps**: Delete the middle user turn, then reload the session after the
  transcript replacement completes.
- **Expected**: The deleted user turn and its outputs remain absent. The first
  and third turns retain their user, assistant, and tool messages before and
  after reload. A pending append cannot run after transcript replacement and
  restore the deleted turn.
- **Specs linked**: `03-runtime/04-data-storage.md`,
  `03-runtime/06-host-rpc-protocol.md`, ADR 0060
- **Acceptance**: C (chat stream), F (persistence), Quality
- **Milestone**: M6+
- **Status**: Unit-covered (`delete-message-preserves-transcript.test.mjs`,
  `persistence-outbox.test.mjs`); complete desktop journey remains Draft

- **Full-history regression**: Open a 140-message session without scrolling
  back and choose Copy conversation. The clipboard must contain messages
  1–140, not only the loaded tail. Repeat from a search context window and
  with a truncated long message. Preserve visible in-flight text; a failed
  history read must report an error and leave the clipboard unchanged.
  Copy must not load history until selected or change the reading position.
  Run `node scripts/e2e-copy-conversation.mjs`.

## E2E-CHAT-copy-formula-as-tex: Copying rendered math yields its source

Math boundaries remain parseable after copying: touching inline fences get
one separator, and every prose dollar in the copied text is escaped, together
with backslash runs that would otherwise escape a fence.
Annotation whitespace is preserved; widened multiline inline math uses a
literal `<span>` wrapper to prevent a flow opener when pasted at column zero.
TeX newlines are not flattened because they can terminate `%` comments.
The wrapper is Markdown source in `text/plain`, not a `text/html` payload;
compatibility with external editors that disallow inline HTML is not promised.
Regression coverage checks both copy entry points and Markdown round trips
for adjacent formulas, prose dollars on either side, formatting wrappers,
line/block boundaries, padding, and multiline math including TeX comments.
Display math containing `- x`, `+ x`, `* x`, `> x`, or internal blank lines
must remain a single math node after copying. The shared remark grammar
keeps unclosed math in the streaming tail until its fence closes; subsequent
prose and its source offsets remain intact. A footnote whose definition
follows its reference — adjacently or streamed in later — renders as a real
reference and note section rather than a literal `[^1]`, which is what block
splitting costs when a slice is parsed without the rest of the message.
CRLF, ordinary lists, quotes, GFM tables, fenced code and the sources that
must keep splitting are covered by `markdown-blocks.test.mjs`.

- **Preconditions**: An assistant answer contains inline math inside a
  sentence, a display formula on its own lines, a `\[ … \]` formula inside a
  sentence and another on its own lines, a `\( … \)` formula, a formula
  carrying a literal `$`, an inline formula whose value carries a newline and
  another whose value carries one at each edge, a paragraph with
  no math, and — each sharing a selection with a formula — a paragraph whose
  source wrapped across several lines, a bulleted list, a table, a second
  table whose cell holds a `\[ … \]` formula, a fenced
  code block that contains blank lines, and a turn whose prose is interrupted
  by chrome that is unselectable only because it inherits the shell's
  `user-select: none` (a tool row's section head).
- **Steps**: 1) Select the sentence holding the inline formula and press
  Ctrl/Cmd+C. 2) Select the display formula and copy it. 3) Select from the
  middle of a formula to the end of its sentence and copy. 4) Select a
  paragraph, a formula, and another paragraph together and copy. 5) Select
  prose with no formula in it and copy. 6) Copy each of the wrapped paragraph,
  the list, both tables, and the code block. 7) Copy each `\[ … \]` formula, the
  `\( … \)` one, the formula carrying a literal `$`, and the two whose values
  carry newlines. 8) Select a formula backwards — from the end of the
  sentence to its start — and copy. 9) With a formula selected, right-click
  that turn and choose Copy, then right-click a different turn and choose Copy.
  10) Select a turn's whole contents the way the Select text item does, so the
  range is anchored on the turn while the copy is raised on a paragraph inside
  it, and copy. 11) Select without ever leaving one formula — a drag inside its
  rendering — and copy. 12) Render each result back through the same answer
  renderer — what pasting it into the composer and sending it produces — and
  compare the formulas it paints with the ones the selection covered.
- **Expected**: Every formula reaches the clipboard as the TeX it was written
  in — `$…$` inline, `$$…$$` on its own lines — instead of the glyphs KaTeX
  painted, or the same expression twice over from its two trees. A formula
  carrying a literal `$` widens its delimiter run past it, as a code span's
  fence does, and pastes back as the formula rather than as prose; an inline
  formula whose value carries a newline keeps the narrow run, because a `$$`
  run at the start of a line would open a flow block and swallow the
  paragraph; one whose value carries a newline at each edge is written with
  padding of its own, because the grammar drops a line ending there as it
  drops a space. A cut that
  starts inside a formula copies the whole formula, and a selection that never
  leaves one copies that formula alone. Everything else in the
  selection is byte for byte what the platform already copied: a wrapped
  paragraph stays one line, a list keeps one line per item, a table keeps tabs
  between cells and one line per row including the newline the platform closes
  the last row with, and a code block keeps its blank lines. Chrome the copy
  leaves behind stays out of the clipboard whether `base.css` marks it
  `user-select: none` by selector (a code block's language rail) or it is inert
  only by inheriting the shell's default (a tool row's section head, a compact
  thinking row). A selection with no formula in it is written by the platform
  unchanged; a selection that holds one reaches the clipboard as its source
  however deep inside it the copy was raised, so a range anchored on a turn —
  what Select text produces — copies as TeX even though Chromium raises the
  event on a paragraph within it. Right-click Copy and Ctrl/Cmd+C produce the
  same string for one selection, and a right-click on a turn that does not own
  the selection reads no excerpt from it, so Copy falls back to that turn's own
  source. A pasted formula renders as
  the one it came from — same TeX, and display math still display math —
  `\[ … \]` included: it is painted inside its sentence's paragraph, and copies
  with `$$` on a line of its own, which is enough to open a display block when
  it is pasted back. `\( … \)` stays
  inline. A table cell reaches it too, measured rather than assumed: the
  `.katex-display` box breaks the row for the platform's own reading as well,
  so no tab lands beside the fence and the formula copies as display math with
  the neighbouring cell intact on its own line. A backward selection is still
  backward after the copy. The copy
  writes `text/plain` only — no `text/html` flavour is put on the clipboard.
- **Specs linked**: `04-ux/08-component-spec.md` §8.7, ADR 0268,
  decisions-log D619, issue #414
- **Acceptance**: C (chat stream), Quality
- **Milestone**: M5
- **Status**: Automated (`pnpm test:e2e:copy-tex`, real Chromium) plus
  `selection-tex.test.mjs`

## E2E-060d: Assistant meta chips, compact context summary, and retry action

- **Preconditions**: A completed visual turn includes modelId and token usage
  across more than one assistant message; another completed assistant message
  has content but no usage. The selected model has a published 1m-class context
  window, while its provider binding still contains the legacy 128k generic
  seed.
- **Steps**: 1) Open the session. 2) Confirm the completed turn shows a model
  badge and no context inspector under the answer. Confirm the turn usage
  capsule follows the badge with its average speed and compact total, then
  hover or keyboard-focus it and inspect the cache-read/input/output exact
  counts, the turn total, and cache write only when non-zero. Move the pointer
  into the popover and confirm it stays open, then dismiss it with Escape and
  with an outside pointer press. 3) Hover the composer
  toolbar inspector trigger, confirm the panel stays closed, then click it.
  4) Inspect the remaining-token-plus-percentage heading, used/window counts,
  unboxed turn/speed values, total session duration, and three timing rows for
  network/provider wait, streamed model response (including thinking and
  answer), and tool execution, each with its share of session duration. Confirm
  overlapping top-level tool calls are counted once, nested delegate timings
  are excluded, and one inline provider-usage summary plus one aggregate
  tool-usage summary remain. There is no doubled heading rule or inner section
  hairline. For a transcript with more than one loaded page, wait for earlier
  timing metadata to finish loading and confirm the cumulative values include
  it. 5) Scroll the transcript and resize the window while the
  panel is open. Toggle and resize the sidebar and work panel while the panel
  remains open. 6) Move the pointer away from the panel, then dismiss it by
  clicking the trigger again, clicking outside it, and pressing Escape from
  the keyboard. 7) Open the work panel on a browser-preview artifact, open the
  context inspector, and confirm the summary stays inside the conversation pane:
  fully visible, clear of the panel column, and narrowed rather than clipped on
  a narrow pane. 8) Click Retry on that turn while idle. 9) Confirm a session
  without usage still offers Retry on completed turns and omits the composer
  inspector. 10) With an API-key provider whose model has catalog prices, open
  the inspector and the capsule popover; send another prompt with the
  inspector open; switch sessions; repeat on a subscription (OAuth) account.
- **Expected**: Model badge appears under completed assistant answers when a
  model id exists, followed immediately by the turn usage capsule when that
  turn has usage. The capsule's speed is summed output tokens over summed
  response duration, and its total sums input/output/cache read/cache write
  across the visual turn, counting reasoning inside output and excluding
  subagent spend. Its popover stays open while the pointer is over it, closes
  on pointer leave after a grace delay unless the trigger retains keyboard
  focus, on Escape, or on an outside press; it portals to the body, clamps to
  the conversation pane, and is absent on streaming turns. A priced
  pay-as-you-go turn shows its cost after the capsule total (`≈` for a catalog
  estimate) and in a popover cost row with a one-line explanation; the
  inspector shows the newest turn cost and the whole-session total, which
  refreshes in place after the next billed request without a loading flash and
  never shows another session's figure. Subscription usage reads
  "Subscription" with its API-price equivalent in the tooltip, adds nothing to
  the pay-as-you-go amount, and shows no inline capsule cost. Automated by
  `apps/desktop/test/usage-cost-user-path.test.mjs`.
  The compact Context inspector appears in the composer
  right toolbar, left of the model picker, once any usage exists, and always
  mirrors the newest usage-bearing assistant turn. The trigger shows the ring
  plus remaining-capacity percentage (no Context label) and low-space
  warning/error states; click or keyboard activation toggles the same compact
  summary while pointer hover alone never opens or closes it. An open panel
  survives the pointer leaving it and closes on a second trigger activation,
  an outside click, or Escape, which returns focus to the trigger. Session
  duration runs from session creation to the latest activity (or to now while
  running). Network request wait ends at the first model response event; model
  response includes streamed thinking and answer, and tool time excludes nested
  delegates and unions overlapping top-level calls. Each cumulative timing
  percentage is relative to that wall-time span. Earlier transcript pages load
  only while the inspector is open. Provider
  values remain exact, tool values remain visibly approximate through the `~`
  aggregate total, and no per-tool list, source badge, progress bar, or
  explanatory estimate paragraph is rendered. Occupancy, turn total, and
  provider cache/input/output/reasoning/hit-rate are the last usage-bearing
  assistant message, not the summed tool-loop, so cache read stays on the
  same scale as the context window; this last-request value remains distinct
  from the capsule's visual-turn aggregate. The cache hit rate is omitted
  when cache-read metadata is absent rather than inferred. A published 1m-class
  limit (for example `gpt-5.6-luna` at 1,050,000 tokens) is shown instead of
  128k, the same effective window is used by the agent runtime, and a non-default
  Advanced override remains honored. Generation rate remains a completed-turn
  value and does not update during streaming; Retry
  re-sends the nearest preceding user prompt and is disabled while a turn is
  running; the portaled panel stays inside the conversation pane so the work
  panel's native browser or plugin surface can never cover it, narrows with a
  narrow pane instead of crossing that edge, and follows the trigger after
  scrolling or resize; Copy still excludes thinking text.
- **Specs linked**: `04-ux/08-component-spec.md`,
  `04-ux/10-workbuddy-benchmark-ux.md`, `03-runtime/01-ipc-protocol.md`
- **Acceptance**: C (chat stream), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`transcript-style.test.mjs`,
  `context-usage.test.mjs`, `latest-turn-context.test.mjs`, runtime
  usage mapping); full scenario Draft

## E2E-061a: Regenerate replaces the current turn in place

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

## E2E-062: Regenerate history pager restores prior variants

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

## E2E-094: Active turns keep the lower transcript surface clear

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
  tool rows remain inline. One compact tail status remains visible throughout
  the running turn, including partial-answer pauses and completed-tool gaps.
  Runtime phases take precedence over Working or Planning/Goal; pending user
  interaction suppresses the status. Only an actual permission request renders
  an actionable permission card.
  Background activity never changes the visible session, transcript, composer
  focus, or project.
- **Specs linked**: `04-ux/08-component-spec.md`,
  `04-ux/09-interaction-patterns.md`, `03-runtime/10-session-state-machine.md`
- **Acceptance**: C (chat stream), Quality (interaction and accessibility)
- **Milestone**: M5
- **Status**: Unit-covered (`active-turn-surface.test.mjs`); full UI scenario Draft

## E2E-068: Fork a conversation into an independent session

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

## E2E-071: Fork an assistant response without changing its source

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

## E2E-071b: Forked session retains messages after the first AI turn completes

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

## E2E-071c: A branch survives a navigation that lands during the fork

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

## E2E-071d: Opening a long session stays responsive and shows its newest turn

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

## E2E-SESSION-list-refresh-keeps-desktop-responsive: Large session-list refreshes keep Electron responsive

- **Preconditions**: A built Electron desktop, the bundled models.dev catalog,
  and a fresh temporary profile with no configured providers. The probe uses
  only a synthetic `authKind: none` provider and never starts an Agent turn.
- **Steps**: 1) Create 800 empty durable sessions through the Rust Host API,
  distributed over up to thirteen known model IDs. 2) After fixture creation,
  request eight session lists concurrently through the renderer preload bridge.
  3) Measure Electron Main timer gaps and renderer-to-Main version IPC latency
  during those reads. 4) Compare all returned session IDs and capability fields.
- **Expected**: Every list contains all fixture sessions with stable model and
  capability fields. Main remains responsive: no measured timer gap or version
  IPC round trip reaches one second. The probe records individual list/heartbeat
  durations and the largest Main gap. The ordinary sandboxed boot, platform
  window, and menu assertions still pass. The profile is discarded afterwards;
  existing user profiles and running desktop processes are untouched.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `03-runtime/13-model-catalog-and-selection.md`, ADR 0134
- **Acceptance**: C (sessions), Quality
- **Milestone**: M6+
- **Status**: Automated (`scripts/e2e-electron-boot.mjs` via
  `pnpm test:e2e:boot`, using the existing `PI_DESKTOP_BOOT_PROBE` entry point).

## E2E-071e: Regenerating from a paged-back transcript replaces the right turn

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

## E2E-071f: Long-transcript scrolling and minimap hover stay smooth

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

## E2E-071g: Retained session panes are bounded and evict the oldest

- **Preconditions**: At least five sessions with distinct transcripts, each
  longer than one viewport, so a scroll position and a final record identify each
  one unambiguously.
- **Steps**: 1) Open sessions A, B, and C in that order, scrolling each one up a
  measured amount. 2) Switch back to A, then B, and confirm each returns to its
  own offset. 3) Open D and then E, so A and B fall outside the retained budget.
  4) Return to A and scroll to the lower boundary of the restored range without
  clicking any load control. 5) Return to E, then D, and confirm they are still
  warm. 6) Repeat the whole cycle once more and watch for a stuck progress track,
  an error toast, or a blank chat area.
- **Expected**: Only the visible pane and the two most recently visited ones are
  retained; visiting beyond that budget evicts the oldest pane. A warm return
  paints the retained frame and offset immediately. The returned pane keeps the
  page that already holds its anchor, so a warm return never offers to load later
  messages for rows that page already had. Returning to an evicted
  session restores the message and viewport offset recorded before eviction,
  including explicit expanded content, using a bounded historical read if the
  latest page no longer contains the anchor. If the anchor is already loaded but
  outside the mounted window, the saved absolute scroll offset is restored while
  the row window remains bounded. The cold selection's progress track
  and composer fence remain unchanged. No search highlight is introduced, live
  model-input messages are unchanged, and real input or a new turn cancels
  automatic alignment. First visits and pinned revisits still follow latest. Nothing is
  dimmed at any point, hidden panes stay non-interactive and out of the
  accessibility tree, and repeated cycling neither leaks a growing number of
  mounted transcripts nor leaves a pane showing another session's rows.
  A restored historical range has no Load later messages button: reaching its
  lower boundary automatically reads bounded newer pages without moving the
  visible anchor. Short ranges fill the viewport automatically; hidden panes do
  not initiate reads. Pending reads coalesce, obsolete results cannot replace
  a newer navigation, and failures do not cause automatic retry loops. After
  continuation reaches the tail, live updates resume without adding older
  cached rows above the reading position. Explicit search still uses manual
  later-message paging.
- **Specs linked**: `04-ux/08-component-spec.md` §1.6 / §3.5 / §7,
  `04-ux/09-interaction-patterns.md` §5, ADR 0130, ADR 0137
- **Acceptance**: C (switch sessions), Quality
- **Milestone**: M5
- **Status**: Renderer regression automated by
  `node scripts/e2e-transcript-reading-position.mjs` (isolated React/Electron,
  fixture IPC); live UI scenario Draft.

## E2E-071h: Reopening a session while its response is streaming

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

## E2E-CHAT-content-width-handles: Dual edge handles resize the centered chat band

- **Preconditions**: PI-Desktop is open on chat (empty home or a transcript)
  at a viewport wider than 760px. Reduced motion off.
- **Steps**: 1) Confirm no divider is visible at rest. 2) Hover the left
  content edge and confirm a short faint capsule, then the right edge. 3) Drag
  the right handle outward and confirm both edges move, the composer matches,
  and both capsules lengthen slightly while dragging. 4) Open the work panel or
  expand the sidebar until the pane is narrower than the new preference; the band
  compresses without a horizontal scroll. 5) Close the panel / collapse the
  sidebar and confirm the preference returns. 6) Double-click a handle to
  restore 760px. 7) Repeat with Arrow keys on a focused handle.
- **Expected**: Default 760px. Drag floor 560px (or the pane if smaller).
  User bubbles stay compact. Handles stay keyboard-accessible
  (`role="separator"`). Preference persists as `chatContentMaxWidth`.
- **Specs linked**: `04-ux/01-ui-ia.md`, `04-ux/08-component-spec.md`,
  ADR 0277, D439
- **Acceptance**: C (conversation), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`chat-content-width.test.mjs`,
  `packages/shared/src/chat-content-width.test.ts`); rendered scenario Draft

## E2E-071i: Long session opens under a settle veil and sends clear instantly

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

## E2E-SESSION-reopen-restores-running: Recreated windows retain live turn status

- **Steps**: Start a Desktop turn in a session with an older completion
  notification. Close and recreate its renderer while Main keeps the turn
  alive. Inspect the sidebar and select the session before another agent event.
  Repeat after the turn ends, and with a start/end event arriving during bootstrap.
- **Expected**: Live tasks show running, and selecting one restores the running
  composer state. Completed tasks stay idle. A delayed snapshot never overrides
  a start/end event already received by the new renderer.
- **Automation**: `node scripts/e2e-running-session-reopen.mjs` recreates real
  Electron windows with the production bootstrap, Sidebar and selection flow,
  using fixture backend responses. `session-list-runtime.test.mjs` checks the
  Main snapshot; `session-running-bootstrap.test.mjs` covers event races and
  responses from older hosts. The native macOS close gesture remains a manual check.
- **Specs**: `03-runtime/01-ipc-protocol.md`, ADR 0090.

## E2E-081: Send re-pins transcript and jumps to bottom

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
  - Long Markdown responses with nested lists keep their list container line
    boxes stable during streaming; the cursor follows the terminal inline text
    without adding a blank line below a nested list.
  - Manual scroll mid-stream pauses follow and shows jump-to-latest again; clicking it resumes follow.
- **Specs linked**: `04-ux/08-component-spec.md`, `04-ux/09-interaction-patterns.md`
- **Acceptance**: C (chat stream), Quality / D151
- **Milestone**: M5
- **Status**: Partially automated (`apps/desktop/test/transcript-scroll.test.mjs`);
  full trackpad interaction remains Draft

## E2E-CHAT-long-history-stream-keeps-responsive

- **Preconditions**: Isolated Electron fixture with production React,
  `ChatTranscript`, Composer, event slice, store subscription, and session cache;
  synthetic Host reads, clipboard, and DOM input, no credentials or running Desktop.
- **Steps**: Keep three sessions running with 100, 1,000, and 10,784 canonical
  loaded rows. Stream warmed deltas into the foreground and both background
  caches, then switch through real session selection with 100-row revalidation.
  Correct an older row; inspect its minimap preview. Toggle a disclosure, scroll
  away from latest, complete/re-key the tail, copy its turn, and switch back.
  Separately stream a 256-fragment single turn and a 256-tool activity group;
  update a nested child through the real read-only subagent dock, stream the
  giant group's final thinking item, and deliver actual `tool_update` partials
  to a running tool in the middle of that group. Append three tool starts to the
  loaded 10,784-row session and switch away and back.
- **Expected**: Ordinary warmed deltas read zero unchanged bodies; unchanged
  groups do not rerender. Mounted history stays bounded despite full canonical
  input. Background updates never replace the foreground, and revalidation never
  discards its cached live tail. Content, minimap previews, disclosure choice,
  reader scroll ownership, completed Copy text and terminal identity remain
  correct. Changed tools/children/thinking still reach their real components.
  Structural tool appends read zero unchanged completed bodies and survive session
  reselection; immutable text facts are also reused for delegate answers.
- **Specs linked**: `04-ux/08-component-spec.md` §7.6.
- **Acceptance**: C (chat stream), Quality. **Milestone**: M5 maintenance.
- **Status**: Automated fixture in `scripts/e2e/transcript-long-history.tsx`,
  registered in `pnpm test:e2e:transcript`; requires built renderer CSS and the
  existing Electron environment. Assertions are work counts and DOM state, not
  timing thresholds. Event-to-settled-DOM latency, supported long-task entries
  and optional heap samples are diagnostic only. Elapsed-label wall time is
  controlled; the hidden-window fixture explicitly dispatches DOM `focusin`.
  Existing deterministic 120 Hz cadence coverage remains unchanged. This is renderer/store integration, not
  provider/IPC throughput, real-session profiling, or complete shell interaction
  acceptance; those broader E2E-083 facets remain Draft.

## E2E-CHAT-running-status-survives-output-pauses

- **Preconditions**: Production `ChatTranscript`, real store and React DOM in
  Electron; deterministic messages/status transitions, no provider credentials.
- **Steps**: Send a turn, stream partial text, stop delivering deltas, start and
  finish a tool, clear/set runtime phases, resume text, then complete, stop, or
  fail. Repeat with `Show thinking` on and off. Exercise planning, permission,
  question and proposal waits, history reading, and switching sessions.
- **Expected**: Exactly one localized, accessible tail status remains through
  output pauses and completed-tool gaps. Runtime phases take precedence over
  Planning/Goal or Working. Pending user interaction suppresses it; terminal
  turns and history reading remove it. Switching sessions uses that session's
  status only. Existing content and permission actions remain available.
  Active and assistant-error turns mount no empty action toolbar. A partial
  answer has 24 CSS px between its fragment box and the status label
  at the default font scale; settled non-error content retains Copy, Fork,
  and Regenerate. Check the `Show thinking` preference on and off. History reading and
  permission cards retain normal message padding. Ending a turn keeps pinned
  follow at the bottom while restoring the normal toolbar height. A scrolled-up reader keeps the exact text position
  and scroll offset.
- **Specs linked**: `04-ux/08-component-spec.md`, `04-ux/09-interaction-patterns.md`
- **Acceptance**: C (chat stream), Quality (interaction and accessibility)
- **Milestone**: M5
- **Status**: Automated by `pnpm test:e2e:transcript`
  (`scripts/e2e/transcript-status.tsx`). Reproduces issue #669 on upstream
  `ecece8f570fc0c18f21e4941eafe52244a7c6e5f`; no real-provider claim.

## E2E-CHAT-initial-wait-spacing

- Send a user message before any assistant output: retain the original user
  action row and spacing (52px bubble-to-status in the default text fixture).
- At wide and narrow transcript widths, Copy remains focusable and pointer
  reachable; edit/delete/revision controls retain their disabled running state.
  Status and action hit targets never overlap, including revision pagers.
- Right-click the status/background for the conversation menu and the message
  for its own menu. Change runtime phase, receive first output, or stop before
  output: exactly one status follows the active turn and terminal actions return.
- Coverage: `scripts/e2e/transcript-status.tsx`, `pnpm test:e2e:transcript`.

## E2E-CHAT-runtime-status-keeps-row-position

- **Preconditions**: An active session whose transcript is taller than the
  conversation viewport, with a completed tool row owning the tail; the pane is
  built (`pnpm build:js`) and Electron is installed.
- **Steps**:
  1. Mount the production `ChatTranscript` with fixed messages, the tail owned
     by a completed activity group, and the session running.
  2. Record the content height, scroller scroll height/offset, and the first and
     last rendered row positions with no runtime activity reported.
  3. Switch the session's runtime activity to the waiting-for-model phase only;
     let the layout settle.
  4. Clear the runtime activity again and let the layout settle.
  5. Finish the turn (`isRunning` false) and inspect the tail.
- **Expected**:
  - The waiting row occupies the reserved status lane: the content height,
    scroll height, scroll offset, and the position of every already-rendered row
    are unchanged (within 0.01px) while Working switches to the named wait and back.
  - The lane stays reserved and transparent — no background, border, or
    shadow — in both themes. Clearing a runtime phase restores Working.
  - The status row keeps its live-region semantics (`role="status"`,
    `aria-live="polite"`); pending user interaction leaves the reserved lane empty.
  - An idle finished transcript renders no status lane at all, so its layout is
    unchanged.
- **Specs linked**: `04-ux/08-component-spec.md`
- **Acceptance**: C (chat stream), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`active-turn-surface.test.mjs`) and automated
  React/Chromium geometry regression via `pnpm test:e2e:transcript`
  (`scripts/e2e/transcript-render.tsx`, no provider credentials; requires an
  installed Electron and a graphical session, or Xvfb on Linux). The scenario
  fails by 40.125px of content height and 40px of row movement when the reserved
  lane is removed (issue #323).

## E2E-STREAM-long-turn-keeps-realtime

- **Preconditions**: Provider configured; an Agent session can run a long
  autonomous turn with thinking, tools, and at least one subagent.
- **Steps**:
  1. Start a long Agent task that streams thinking and answer text at a high
     upstream token rate and continues through many tool rounds.
  2. Observe streaming latency of later short thinking/answer blocks in the
     same turn, including a nested subagent.
  3. Stop the turn, send a new prompt in the same session, and compare the
     new turn's streaming latency.
  4. Confirm historical activity rows in the still-running turn do not flash
     or rebuild as the tail token updates.
- **Expected**:
  - Upstream 200+ tok/s streams stay visually caught up (batched to the
    display refresh is allowed; a growing backlog is not).
  - Later short chunks in the same long turn do not keep getting slower.
  - Stop plus a new prompt is not required to restore speed.
  - Parent and subagent streams both stay realtime.
  - Transcript text after `message_end` matches the streamed content.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `03-runtime/02-agent-runtime.md`, ADR 0242, D412, issue #299
- **Acceptance**: C (chat stream), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`message-stream.test.ts`,
  `stream-coalescer.test.ts`, `streaming-benchmark.test.ts`,
  `assistant-turns.test.mjs`); rendered long-turn scenario Draft

## E2E-086: Assistant Mermaid fences render safely without blocking streams

- **Preconditions**: A provider can stream an assistant answer containing a
  valid Mermaid flowchart, an invalid Mermaid fence, and ordinary fenced code;
  light and dark themes are available.
- **Steps**:
  1. Stream a valid `mermaid` fence slowly and observe it before and after the
     closing fence arrives.
  2. Scroll the completed diagram into view, toggle source, copy the source,
     and switch between light and dark themes.
  3. Copy SVG and export SVG; parse the clipboard text and downloaded file
     as standalone SVG, verify the diagram labels, explicit dimensions and
     resolved UI font, then repeat in a README preview. Give the preview a
     different font from the document root and themed node colors; open
     exported SVG in an isolated SVG document and compare computed fonts and
     colors. In SVG export fixtures, verify app CSS variables, per-node
     overrides, nested fallbacks, inline styles and presentation attributes,
     export from source
     view, and that the live SVG remains unchanged. Deny clipboard access
     and force download setup failure; verify localized error feedback.
     Repeat while rendering and with invalid input: SVG actions stay disabled.
     Switch diagrams/themes and confirm subsequent exports use the new SVG.
  4. Scroll upward so transcript follow is paused, then bring another completed
     diagram near the viewport.
  5. Render invalid and over-20,000-character Mermaid sources plus a payload
     attempting an HTML label, external image, link, or Mermaid config override.
  6. Expand thinking content containing a `mermaid` fence.
- **Expected**:
  - The partial stream remains a normal source code block; only the complete
    answer fence starts rendering, and only near the viewport. Ordinary code
    fences and thinking Mermaid fences retain their source presentation.
  - The diagram uses bounded card chrome, remains within the transcript width,
    switches theme without stale colors, and exposes keyboard-accessible
    diagram/source and copy controls. Source copy returns the original fence
    source; SVG copy returns XML text and SVG export downloads `diagram.svg`.
    Exported content retains the sanitization applied to the preview.
  - Diagram height changes keep a pinned transcript at the bottom but never
    resume follow after the user scrolls upward.
  - Invalid, oversized, or unsafe input cannot fail the assistant turn, execute
    a link, load embedded media, add foreign HTML, or weaken strict settings;
    it falls back to readable copyable source when rendering is unavailable.
- **Specs linked**: `04-ux/08-component-spec.md` §8.7,
  `04-ux/09-interaction-patterns.md` §2, `05-security/01-security.md` §2, D165
- **Acceptance**: C (chat & stream), Security, Quality
- **Milestone**: M5
- **Status**: Unit-covered (`mermaid-rendering.test.mjs`); README SVG copy/export,
  theme/source updates, and error recovery covered in isolated Electron
  (`mermaid-export-user-path.test.mjs`). Remaining rendered security and
  visual scenario Draft

## E2E-CHAT-opaque-floating-decision-and-retry-surfaces: Dock, Plan approval, and retry surfaces occlude transcript text

- **Status**: Automated (`pnpm test:e2e:composer-occlusion`, `pnpm test:e2e:theme-surfaces`, `apps/desktop/test/plan-mode-source-contract.test.mjs`, `apps/desktop/test/active-turn-surface.test.mjs`)
- **Priority**: P2
- **Covers**: C, Quality / floating composer and retry surfaces
- **Preconditions**: Renderer CSS is the production source under `apps/desktop/src/styles`.
- **Steps**:
  1. Inspect the computed background of `.composer-dock-docked` (fully transparent) and the `.thread-scroll` mask with two different `--composer-dock-height` values, in both built-in themes and a custom theme.
  2. Scroll a long transcript until a row crosses the Composer boundary.
  3. Inspect `.plan-approval-bar` in the composer dock styles.
  4. Inspect `.run-activity-error-popover.message-error` in the transcript styles.
  5. Hover or focus a retrying active-turn row in a live session.
- **Expected**:
  - The dock paints no backing surface. Transcript text fades out across the
    `.thread-scroll` mask at the Composer boundary and cannot remain visible
    below the shell or around its rounded corners. The mask's two stops sit
    `--composer-dock-height + 16px` and `--composer-dock-height - 2px` above the
    scrollport's bottom edge, so a transcript pinned to its end keeps its last
    row fully opaque and the conversation pane's own surface - including a
    contributed theme's background - stays visible behind the dock.
  - The Plan/Goal approval bar paints `--ds-bg-composer` with `--ds-shadow-composer` rather than the in-flow `--ds-tile` wash, so it remains a readable plate over the transparent composer dock.
  - The retry hover tooltip mixes the error tint over `--ds-bg-elevated-opaque`, so transcript text does not show through.
  - The retry tooltip is capped to the room above the tail status row and
    scrolls the remainder, so a long provider message keeps its first lines
    inside the transcript scrollport and below the conversation bar instead of
    being hidden by either.
- **Specs linked**: `04-ux/03-permission-ux.md`, `04-ux/08-component-spec.md`
- **Acceptance**: C, Quality
- **Milestone**: M6
- **Status detail**: Source contracts assert the CSS tokens. Live hover remains a visual check.

## E2E-111: Active-turn, pending-approval, and configuration boundaries are enforced

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

## E2E-111a: A staged mode switch does not move the live planning indicator mid-turn

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
  mode, and the Composer chip does not pulse until that live state projects
  `planning`. After the terminal event flushes the configuration the session is
  durable Plan with editable planning state, and the sent prompt surfaces the
  `Plan / planning` indicator in the reserved tail slot while the chip pulses.
  Tools and answers do not hide it; runtime phases take precedence, and
  pending user interaction or turn completion suppresses it.
- **Specs linked**: `03-runtime/02-agent-runtime.md`,
  `03-runtime/10-session-state-machine.md`, `04-ux/08-component-spec.md`
- **Acceptance**: C (conversation/stream), Quality
- **Milestone**: M6
- **Status**: Draft

## E2E-118: A regenerated turn keeps its final answer after the branch archive

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

- **Bounded-history regression (#1870)**: Regenerate an older prompt, then
  continue until the root is outside the newest 100-message page. Complete
  another turn while viewing that page, then repeat after switching to another
  session. The archive must not append the older user root after the latest
  answer in the active transcript, retained pane, or session cache. If the root
  is loaded, its pager updates in place using its current message identity,
  which can differ from the stable family key. A root removed during the
  archive RPC stays absent. Previous variants remain available after restart.
  With neither a cached nor retained background transcript, the acknowledgement
  must leave the cache absent and allow the next prefetch to read the Host.
  Automated event-to-projection coverage:
  `apps/desktop/test/regenerate-root-projection.test.mjs`.
  `node scripts/e2e-regenerate-root.mjs` exercises the real Host process,
  production main persistence and renderer projections with an isolated
  3,484-message transcript, three follow-up turns, restart, and a revision
  round trip. Set `PI_DESKTOP_HOST_BIN` to a host built from the candidate.

## E2E-246: Retrying a large session truncates without a whole-transcript RPC

- **Preconditions**: An Agent session whose live transcript is thousands of
  messages (large enough that a `session.replaceMessages` JSON-RPC line would
  exceed tens of megabytes), with a completed or failed last user turn.
- **Steps**: 1) Retry or regenerate the last user prompt. 2) Inspect host RPC
  traffic, `turns.status`, the live jsonl, and `message_revisions`. 3) Retry
  again immediately if the first attempt is still on screen as running.
- **Expected**: Electron main calls `session.truncateFrom` with
  `fromMessageId` only — no `session.replaceMessages` and no
  `session.saveRevision` of the discarded array. The kept prefix never appears
  in an NDJSON request. The leftover running turn is `aborted` before
  `beginTurn`. The discarded tail is archived (refresh of the stamped variant,
  or a new inactive variant). A second retry while a cut is in flight does not
  ship another full transcript. The UI error is not
  `host RPC timeout: session.replaceMessages`.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `03-runtime/04-data-storage.md` §4.9/§7,
  `03-runtime/06-host-rpc-protocol.md` §4, ADR 0216, D390
- **Acceptance**: C (conversation), F (persistence), Quality
- **Milestone**: M6
- **Status**: Covered by host-core unit tests (2026-09-10):
  `truncate_from_drops_the_tail_and_archives_the_discarded_branch`,
  `truncate_from_rejects_an_unknown_message`,
  `truncate_from_refreshes_the_stamped_revision`,
  `truncate_from_rpc_cuts_without_shipping_the_kept_prefix`. Desktop journey
  remains Draft.

## E2E-146: A turn that produces no visible text re-runs once

- **Preconditions**: A project-bound Agent session uses a deterministic provider
  fixture that ends one turn with no tool call and no text — once with reasoning
  content present, once with nothing at all; a second fixture run ends both the
  first turn and the re-run that way.
- **Steps**:
  1. Start an Agent turn with the reasoning-only fixture and watch the
     transcript while the runtime recovers.
  2. Inspect the transcript, session state, and terminal diagnostics afterwards.
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
  - The terminal diagnostics identify the empty-response recovery and the
    re-run's outcome.
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

## E2E-COMPOSER-local-file-references: Native file paste keeps paths and sizes

- **Preconditions**: Local project and synthetic disk files, including a sparse
  64 MiB + 1 byte file outside the project, a small text file and an image.
- **Steps**: Copy each file in the OS file manager and paste into Composer;
  also paste a mixed file/folder selection. Remove a card, switch sessions,
  restore input history, queue a prompt and restart before delivery. Modify,
  move, delete or replace a source with a symlink before sending. Separately
  paste a screenshot and a large text selection.
- **Expected**: Native disk files retain original paths and exact byte sizes;
  removable inline cards show human-readable size. No source contents cross
  paste IPC or enter scratch/content-addressed snapshots. Small and large disk
  files use the same reference flow; screenshots and generated text retain their
  existing scratch/image behavior. Dispatch refreshes size, preserves metadata
  through messages and model history, and clearly rejects unavailable or
  redirected sources. Forged ids/paths, another project and remote contexts are
  refused. Agent reads use normal permissions; referencing an external file does
  not grant access. Metadata-only input history restores the live path and size.
- **Targeted coverage**: `composer-file-references.test.mjs`,
  `composer-directory-paste.test.mjs`, `composer-clipboard-directories.test.mjs`,
  draft/history tests and the host attachment roundtrip test. Native clipboard
  gestures and full provider delivery require a separate desktop E2E run.
- **Electron coverage**: `node scripts/e2e-composer-paste.mjs --file-references-only`
  drives real React hooks, native disk-backed `File` objects, preload IPC,
  selection tokens, reference registration, prompt preparation and Composer
  history. A sparse 64 MiB + 1 byte source and a small file outside the project
  retain size cards without renderer byte reads or scratch writes. The fixture
  edits the large source before send and verifies refreshed size in model context.
  A second Electron process recalls the stored metadata and dispatches through
  the persisted reference records. Native clipboard metadata and provider
  delivery are controlled external boundaries; this is not a manual Finder gesture
  or a live external provider call. Full paste coverage also verifies restoring
  the actual pre-preview focus target, including Chromium's editing-host focus.
  Restore the saved selection before focusing the original control so selection
  updates cannot steal its final focus. Stale session/project previews restore
  neither focus nor selection (`composer-image-preview-focus.test.mjs`).

## E2E-COMPOSER-deep-file-mentions: `@` reaches deep files in a large workspace

- **Preconditions**: The app is running with an Agent session in a workspace
  whose index is truncated (more than 8000 files and directories), with a
  script several folders below thousands of shallow assets — for example a
  Unity project's `Assets/_Game/Scripts/Gameplay/Player/FeatureController.cs`.
  Run once with the workspace under git and once without.
- **Steps**: 1) Type `@` and inspect the footnote. 2) Type the script's name
  and pause. 3) Accept the script's row with Enter. 4) Edit the query quickly
  through several prefixes. 5) Repeat in a small workspace and in a remote
  session.
- **Expected**:
  - The bare `@` lists the index and shows the truncation footnote.
  - After the pause the deep script appears as a row, ranked like any other
    match, and the footnote disappears once that search has answered; files
    excluded by `.gitignore` or the ignore set never appear.
  - Accepting it inserts the same file chip as any other reference.
  - Rows never belong to an earlier query. The menu keeps the local matches
    while a search is pending.
  - A small workspace issues no search request; a remote session keeps its
    snapshot and footnote.
- **Specs linked**: `04-ux/08-component-spec.md` §11.8,
  `03-runtime/01-ipc-protocol.md` §13c, `08-meta/decisions-log.md` (D124,
  D669), ADR 0024
- **Acceptance**: C (conversation & stream), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`packages/host-runtime/src/fs-index.test.ts`
  covers the git and walk listings, ignore rules, directories, and the result
  limit); the renderer journey — search after the pause, merge, accept, stale
  answers, the footnote, and the complete-index path — is covered by
  `apps/desktop/test/composer-deep-file-search-user-path.test.mjs` in a real
  Electron renderer. The full desktop journey against a large real tree is
  Draft (run only in a capable environment when this surface changes).

## E2E-102d: Non-vision and oversized images use the path fallback

- **Preconditions**: One known non-vision model and one known vision-capable
  model; an Agent session; a normal PNG and a deterministic image just above
  the 10 MB inline bound.
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
- **Status**: Draft (run only in a capable environment when this surface changes)

## E2E-102f: Oversized image references do not block session startup

- **Preconditions**: A project contains an image larger than the 10 MB inline
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
- **Status**: Unit-covered; full UI journey Draft (run only in a capable environment when this surface changes)

## E2E-SESSION-two-click-delete-arms-first

- **Preconditions**: a project with one idle and one running session, both
  reachable from the sidebar session menu.
- **Steps**: open the idle session menu and press Delete once. Verify it arms,
  then cancel with Escape or wait for expiry and verify the session remains.
  Reopen the menu, press Delete twice, and verify the session is removed. Repeat
  the arm/cancel/confirm sequence for the running session after it becomes idle.
- **Expected**: the first press removes nothing and relabels the item to
  `nav.deleteTaskConfirm` ("Delete?" / "确认删除？") with `data-armed="true"`;
  the menu stays open, and an outside press, Escape, or expiry clears the arm
  without removing anything. Only the second press removes a session and its
  transcript. Project deletion instead requires its explicit confirmation
  dialog (see E2E-PROJECT-delete-removes-project-and-owned-sessions).
- **Specs linked**: `04-ux/09-interaction-patterns.md` §1.6, D421, D431
- **Acceptance criterion**: Quality
- **Milestone**: M6+
- **Status**: Partially automated — `apps/desktop/test/two-step-delete.test.mjs`
  pins the session arm and expiry plus localized labels; the end-to-end journey
  remains Draft
## E2E-138: Move, remove, and rollback keep review evidence honest

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
  8. Emit `MV` to the source itself, `./source`, `sub/../source`, and its
     absolute path, plus a directory symlink (Windows junction) pointing back
     to its directory; on a case-insensitive filesystem also use a case-only
     alias. Repeat with a
     content-changing `PUT` in the same call, then use the original Read tag
     for a valid content edit.
- **Expected**: Step 1 records a source deletion and a destination creation under
  one tool call; step 3 restores both or neither. Step 4's rollback restores the
  captured bytes, hash-guarded on the full digest rather than the 16-bit tag.
  Step 5 fails rather than editing against content the rollback replaced. Step 6
  rebinds to the real file with a warning, and the write-permission gate is
  evaluated against the rebound path; step 7 declines instead of picking one.
  Step 8 returns `EDIT_NO_CHANGE` without writing or deleting the source, and
  the original Read tag remains usable for the following valid edit.
- **Specs linked**: `03-runtime/18-line-anchored-edit-contract.md` §9.2, §13.1,
  `03-runtime/03-tools-and-permissions.md` §4c, ADR 0043, ADR 0087
- **Acceptance**: E (tools & permissions), Quality
- **Milestone**: M5+
- **Status**: Documented

## E2E-139: Snapshot provenance is per session and bounded

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

## E2E-141: An exhausted retry budget ends the turn with a visible, retriable row

- **Preconditions**: A session where `Edit` on one path fails with a
  non-recoverable code every time.
- **Steps**:
  1. Emit three failing `Edit` calls on the same path within one prompt.
  2. Observe the transcript after the agent loop stops.
  3. Send a follow-up prompt in the same session.
  4. Repeat with three failing `apply_patch` shell commands instead of `Edit`.
- **Expected**: The third call carries the termination hint and the loop stops,
  but the turn does not merely complete: the transcript ends on an assistant
  error row with `MUTATION_RETRY_BUDGET_EXHAUSTED`, marked retriable, naming the
  path and the next action, and the same code arrives as an error event. When the
  last error is `EDIT_PARSE_FAILED`, the row's recovery hint explains the syntax
  correction — for example, a body-bearing `PUT 48.=48` must be written as
  `PUT 48.=48:` — and does not tell the agent to re-read solely to repair the
  malformed payload. The turn is recorded as failed rather than completed with
  no final message. Step 3 proceeds normally — the guard's counters are per
  prompt. Step 4 produces the same row with `details.kind` of `patch-command`.
- **Specs linked**: `03-runtime/18-line-anchored-edit-contract.md` §9.3,
  `03-runtime/03-tools-and-permissions.md` §4d,
  `03-runtime/08-error-codes.md` §3.3, ADR 0087
- **Acceptance**: E (tools & permissions), C (chat & stream)
- **Milestone**: M5+
- **Status**: Documented
## E2E-CHAT-history-loading-holds-viewport

- **Preconditions**: A built Desktop checkout and existing compatible Electron
  dependencies. Use the isolated synthetic fixture, never a live user profile.
- **Steps**:
  1. Scroll upward into the adaptive ahead-loading band (base three screens,
     at most twelve screens or `12000px`) while holding Host page IO; continue
     scrolling during IO, then complete the page. Repeat from `4000px` at speed.
  2. Start `node scripts/e2e-transcript-history-loading.mjs --manual` and click
     **Load earlier (hold)** (or reach `<= 120px`). Note the visible turn and
     its viewport offset, continuously roll the wheel upward and downward while
     the page is held, then click **Complete page**. Repeat without scrolling.
  3. Repeat with **Fail page** and an empty page. Confirm the indicator ends and
     new input can scroll or retry, without an automatic loop at rest.
  4. From both an ordinary tail and a paginated historical view (idle and
     running), trigger return-to-latest with normal and reduced motion, and
     interrupt an active trip with genuine main-scroller input vs horizontal,
     zero-delta, or `Ctrl`+wheel input and nested/editable/row controls. While a
     page is pending, return to latest, complete the old page, and also test
     hiding/unmounting mid-trip.
  5. Return after loading older pages, then scroll upward again. Reveal a real
     turn-changes card during the trip and compare with layout growth above the
     visible text. Continue with live output and a canonical rewrite.
- **Expected**: Ahead-loading mounts cached withheld history before Host IO,
  stays single-flight, does not set `overflow-y: hidden` or discard main scroll
  input, tracks the newest actual message anchor across ongoing upward movement,
  and keeps that message within `2px` when the page prepends; there is no
  early-threshold observer or eager draining at rest. The `<= 120px` hard edge,
  explicit earlier-history action, and underfilled observer use the same moving
  anchor without locking overflow or discarding input. Native wheel movement
  must occur during IO, with insertion preserving the resulting reading point.
  Nested scrolling, editable fields and title activation remain independent.
  Return-to-latest uses the same browser-native smooth scrolling as conversation
  turn markers (`auto` under reduced motion), without custom easing, timing, or
  per-frame position writes. Competing follow/layout/turn-completion owners yield; preparing a historical view
  clears `loading` on a new view identity while keeping current messages visible
  until exact-identity arrival, commits on hide/unmount, cancels in place only
  on genuine main-scroller input, and may skip unloaded intermediate ranges when
  a disjoint search/history view joins the live tail. Tail-connected older pages
  and their physical cursor survive arrival, so upward reading does not repeat
  covered reads; they remain outside model input and accept live updates. Pane
  eviction and canonical rewrites still invalidate them. Native `scrollend`
  rechecks the current bottom and smoothly finishes any remaining distance after
  a late card or layout change, without a full-height instantaneous jump.
  Runtime `isRunning` and mounted-window bounds remain unchanged, without idle TTL or reclamation.
- **Automation**: `node scripts/e2e-transcript-history-loading.mjs`, also run by
  `e2e-transcript-render.mjs`, plus `transcript-latest-navigation.test.mjs`,
  `transcript-reading.test.mjs`, and `transcript-scroll.test.mjs`. The direct
  fixture retains hard-edge native Electron wheel bursts, quiet loading, tail
  updates, six delayed layout changes, rejection, empty pages, cached-window
  growth, hide/reveal, input ownership, return-to-latest during IO, and native
  wheel movement during unlocked ahead-loading. The `SessionPane` + real store
  probe (`scripts/e2e/transcript-history-navigation.tsx`) adds four paired
  return-to-latest motion cases (ordinary tail vs paginated history × idle vs
  running, asserting `>= 3` intermediate frames, no reverse `> 2px`, and zero
  empty visible-message frames) and ahead-read cases (standalone user rows and
  mixed grouped answers moving the same visible message `100px` during pending
  IO and keeping drift `<= 2px` after prepend). A preceding-row case then grows
  the newly exposed message by `400px`: retain the original readable message
  until its intended offset leaves the viewport rather than adopting that lazy
  predecessor's unstable geometry. This runs alongside the retained quiet
  stability and pending/settled latest-button cases. Additional regressions cover
  native browser smooth travel across the prefetch threshold, resuming follow
  during pending IO, press-only interruption plus remount, delayed failed search,
  focused and restored disjoint ranges (no automatic forward reads), stream
  growth/completion, hide/unmount, and reduced-motion media emulation. An extra
  latest case changes height above the reader by `2400px`. The minimap jump
  journey then clicks latest and verifies one native smooth command with no
  instantaneous intermediate travel. Separate final travel from arrival drift.
  Delayed-layout checks require nonempty post-layout/prepaint samples within
  `2px`, retaining pre-layout rAF diagnostics rather than treating them as paint.
  Only external Host IPC is controlled;
  the ordinary-motion cases still require intermediate frames. Manual procedures:
  `tests/history-loading-scroll-test-cases.md`.
  The production `SessionPane` resource journey opens collapsed process groups,
  traverses both ends and the middle, and checks measured prose recycling plus
  restoration of visible content without additional history requests.
  `node scripts/e2e-transcript-prose-state.mjs` opens a table preview and Mermaid
  source view, moves their prose offscreen and back, and verifies both states
  survive while ordinary prose still recycles.
  A separate variant includes a 1,600-paragraph final answer. `--manual-smoke` drives the
  manual toolbar through two 100-message pages and reset, sending 24 native
  wheel events in each direction per pending page; directional movement,
  single-flight requests, and frame-gap p95 <= 100ms are checked. This is a
  measured fixture budget, not a universal zero-latency guarantee.
  `node scripts/manual-transcript-desktop.mjs --interaction-smoke` complements
  this with the complete product shell and real Host database: native upward
  wheel input crosses the initial 100-message page without mounting all 1,000
  messages, then the actual latest button reaches the bottom with nonblank
  sampled frames and <=2px tail drift during 600ms after arrival. The isolated
  instance confirms the application's normal quit dialog and exits.
  Late-reading regressions wait until the page has settled, then change content
  above the reading point by 120px, balance it with a -120px change below, and
  change an earlier paragraph inside a long answer. Nonempty pre-paint samples
  must stay within 1px. Six consecutive 20px steps additionally compare the
  actual painted text crop byte-for-byte, not merely the eventual scrollTop.
  Full-Desktop interaction smoke repeats the painted reading check after a real
  Host page. Original native smooth input, resumed follow, search, disclosure,
  hide/reveal and turn-completion paths remain required.
  `node scripts/e2e-transcript-anchor-repair.mjs` additionally mounts the real
  paging hook and Markdown in Chromium. It verifies actual native boundary
  clamping, reconstructed paragraph nodes with unchanged parser source ranges,
  ordinary non-clamping shrinkage, balanced internal reflow, reader movement,
  and unreachable-target legal-boundary fallback without repeated scroll writes.
  A known-character oracle covers long-paragraph width reflow and rejects
  edited/missing text. Identical native wheel input is compared with and without
  same-delivery layout/clamping at equivalent geometry. Reachable readable content
  must stay within <2 CSS px in eight post-layout samples; stable-content painted
  crops must be nonempty and byte-identical. `--inject-drift` adds a real 20px
  displacement after sampling and must fail the final geometry/paint checks.
  This focused fixture uses inline layout, so production CSS/recycling, native
  navigation, disclosure and long-history journeys remain separate required
  checks. Painted crops are not a claim of every-frame or human visual approval.
  The regression runs from the existing `e2e-transcript-render.mjs` CI entry.
- **Specs linked**: `04-ux/09-interaction-patterns.md` §2.2 / §9.1 / §10.4, ADR 0130.
- **Acceptance**: C (conversation), Quality.
- **Status**: Automated Electron fixture and unit regressions implemented; run
  the candidate Electron gate per `AGENTS.md` §16 before landing, and validate
  additional OS/hardware combinations and real conversations manually.

## E2E-164: Context compaction preserves the active task boundary

- **Preconditions**: A provider fixture can complete multiple sequential tasks,
  trigger inline automatic compaction at 90% of `hardLimit` (before the hard
  boundary), exercise an active-turn checkpoint during a tool loop, and restart
  a session. The desktop transcript runner also replays a deterministic local
  provider-overflow recovery through the production runtime event handler,
  transcript store projection, and assistant-turn renderer.
- **Steps**:
  1. Complete task A and task B in one session with distinct instructions and
     visible completion replies.
  2. Advance the context estimate to 91% of `hardLimit`, send task C, and capture
     the first provider request; assert that compaction is installed first.
  3. Trigger compaction during task D after tool results cross the 90% trigger
     while remaining below the hard limit; capture the follow-up provider
     request and confirm it uses the checkpoint.
  4. Force summary plus retained-tail recovery to fail once below `hardLimit`
     and once at/above it; the soft failure may proceed unchanged, while the
     hard-boundary failure must not send the provider request.
  5. Start an approved plan execution with the estimate at 91% of `hardLimit`;
     capture the first request and confirm preflight compaction runs before
     `continue()` while retaining the internal approved-plan instruction.
  6. Restart and reopen the session, then send another prompt.
  7. In the isolated overflow fixture, pause compaction after the first provider
     response exceeds the context window. Inspect the rendered assistant turn,
     then let the retry complete.
- **Expected**: Automatic session compaction starts at
   `floor(hardLimit * 0.9)` for prompt, approved-plan, and in-run turn
   preflights; the estimate includes serialized messages, the active system
   prompt, and tool schemas. A request is never issued at or above `hardLimit`.
   A failed soft-trigger summary may proceed only while below the hard budget,
   and hard-limit failure remains fail-closed. A completed-turn checkpoint has
   an empty retained tail; the next request contains its summary plus task C
   and no bare A/B prompts. An approved-plan checkpoint uses active-turn
   retention so the instruction survives before `continue()`. An active
   checkpoint retains exactly the latest active user prompt, with no older
   user prompts or pre-boundary assistant/tool messages. Restart honors
   `retainedTailMode`, and legacy multi-user tails normalize to the latest user
   message. During recoverable overflow compaction, the existing assistant
   bubble stays streaming without an error card; a successful retry completes
   that same bubble once. A failed retry surfaces its terminal error. If
   automatic summary generation fails at the hard boundary, the
   fallback retains a bounded recent user tail. The visible transcript remains
   complete and checkpoint rows remain.
- **Specs linked**: `03-runtime/02-agent-runtime.md`,
  `03-runtime/04-data-storage.md`, `03-runtime/16-tool-result-limits.md`,
  `08-meta/decisions-log.md` (D623), ADR 0064, ADR 0136
- **Acceptance**: C (chat/stream), F (persistence), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`packages/agent-runtime/src/context-budget.test.ts`,
  `runtime.test.ts`, `subagent-context.test.ts`); isolated overflow recovery
  fixture passed through `pnpm test:e2e:transcript`; broader provider/UI journey Draft

## E2E-177: Switching a long running session keeps the newest prompt in view

- **Preconditions**: A session has stayed open long enough that the renderer
  holds more than the newest-100 durable page (hundreds of user/assistant/tool
  rows); a second session exists so a switch is possible.
- **Steps**: 1) Interrupt an in-flight reply if needed, then send a new
  prompt. 2) While that turn is still running, switch to the other session and
  back. 3) Confirm the newest user row (and any streaming tail) is at the
  bottom of the transcript and the session still shows as running. 4) Optional:
  Stop, switch away and back; the same newest rows remain in chronological
  order. 5) With an older identical prompt already durable, send that same
  text again and immediately switch away and back before its persistence
  acknowledgement is applied.
- **Expected**: Revalidation does not append older live history after the
  bounded durable page. The mounted trailing window still shows the just-sent
  prompt and the live tail. The turn continues in the background across the
  switch. The older same-text row remains distinct and cannot suppress the new
  optimistic prompt; the durable echo replaces that prompt in place. Stop is
  not required to make the prompt visible again.
- **Specs linked**: `04-ux/08-component-spec.md` §1.6 / §3.5,
  `04-ux/09-interaction-patterns.md` (session isolation), ADR 0120, ADR 0137,
  `08-meta/decisions-log.md` (D261, D317)
- **Acceptance**: C (conversation & stream), F (persistence), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`session-transcript.test.mjs` D317 and missed-ack
  same-text cases); full
  desktop journey Draft (run only in a capable environment when this surface changes)

## E2E-183: Switching an idle session keeps a completed reply that is not on disk yet

- **Preconditions**: Two conversations exist. The source has a completed
  user prompt and an assistant reply still on screen. The durable
  `session.get` page for that session still has only the user row (the
  persistence outbox has not flushed the assistant line).
- **Steps**: 1) Wait until the turn is no longer running. 2) Switch to the
  other session and back. 3) Confirm the assistant reply is still visible.
  4) Optional: wait until the outbox drains, switch away and back again;
  the reply remains and now also exists in the JSONL.
- **Expected**: Idle revalidation stitches the live snapshot onto the
  durable page. A completed live-only assistant/tool row is not replaced by
  the user-only durable page. Live provenance is not cleared until that
  page contains every live id.
- **Specs linked**: `04-ux/08-component-spec.md` §1.6 / §3.5,
  `04-ux/09-interaction-patterns.md` (session isolation), ADR 0137,
  `08-meta/decisions-log.md` (D317, D324)
- **Acceptance**: C (conversation & stream), F (persistence), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`session-transcript.test.mjs` D324 case,
  `session-switch-performance.test.mjs`); full desktop journey Draft (do
  not run E2E locally unless explicitly requested)

## E2E-178: A missing sessions row is restored so the outbox can drain

- **Preconditions**: A session has a live `sessions/<id>.jsonl` and queued
  appends in `session-message-outbox.json`, but its row is gone from
  `pi.sqlite` `sessions` (WAL/index loss). The queued head may carry a turn
  id whose row is missing or belongs to another session. For legacy replay,
  the JSONL may already contain repeated copies of that message id.
- **Steps**: 1) Confirm the sidebar no longer lists the session and
  `session.appendMessage` would fail `session not found`. 2) Restart the
  app (or otherwise complete a host handshake that flushes the outbox).
  3) Replay an unindexed message with a stale turn id after writing its
  transcript line more than once, with a later indexed message behind it.
  4) Optional: delete the session and confirm its outbox entries are
  dropped rather than resurrected.
- **Expected**: Host boot reinserts the sessions row from JSONL and rebuilds
  its index. The stale turn link is omitted without losing the message; the
  outbox drains and later messages keep transcript order. Replayed copies are
  updated in place and do not add another line; `last_seq` and search index
  match the deduplicated transcript. A user-deleted session is not recreated.
- **Specs linked**: `03-runtime/04-data-storage.md`,
  `03-runtime/06-host-rpc-protocol.md`, `03-runtime/07-process-model.md`,
  ADR 0041, `08-meta/decisions-log.md` (D318)
- **Acceptance**: C (conversation & stream), F (persistence)
- **Milestone**: M5
- **Status**: Unit-covered (`sessions.rs` stale-turn/replay tests,
  `persistence-outbox.test.mjs` full-cap rejection and drain tests); full
  desktop journey Draft (run only in a capable environment when this surface changes).

## E2E-CHAT-shorthand-file-ref-opens-the-matching-file

- **Preconditions**: A project group whose primary folder holds
  `img/openimage.js`, `src/dir/a.ts`, and a deeper second `dir/a.ts` such as
  `packages/app/dir/a.ts`, and whose second folder holds `lib/only-here.ts`.
  The open session's scratch store holds a file with the same leaf name
  `openimage.js` and one file no project folder has; the attachment store holds
  an `attachments/<sha256>` blob. The transcript renders assistant markdown.
- **Steps**: 1) Prompt a turn whose reply names `openimage.js` as inline code
  and click it. 2) Prompt a turn that names `dir/a.ts` and click it. 3) Prompt
  a turn that names the scratch-only file, click it, then do the same for the
  `attachments/<sha256>` ref. 4) Prompt a turn that names an absolute path to a
  project file whose leaf name also exists in scratch, and click it. 5) Prompt
  a turn that names `missing-helper.js` and click it. 6) Prompt a turn that
  names `only-here.ts` and click it.
- **Expected**:
  - Clicking `openimage.js` opens the project's `img/openimage.js`, although the
    scratch store holds a file with that same leaf name: the project is
    searched to exhaustion before the scratch store is considered at all.
  - `dir/a.ts` matches both `src/dir/a.ts` and
    `packages/app/dir/a.ts`, so the shorthand is ambiguous and opens nothing.
    The exact reference `src/dir/a.ts` opens that path.
  - A reference the project cannot answer resolves in the session scratch
    store; one that neither answers resolves in the attachment store, and an
    `attachments/<sha256>` ref opens that stored blob.
  - An absolute reference that names a real file inside a known root wins
    outright, whichever shorthand would otherwise have matched.
  - `only-here.ts` opens the second folder's `lib/only-here.ts`: the primary
    folder is searched first and to exhaustion, then the project group's other
    folders in the group's own order, and the match names the folder that
    answered (ADR 0263).
  - A file that answered from a sibling folder is addressed to the work panel by
    its absolute path, while a primary-folder file stays project-relative
    (ADR 0263).
  - A reference that matches nothing raises an error toast reading
    `No file matches missing-helper.js` and opens nothing: no new work-panel
    tab, no empty panel, no blank side-browser page, and the work panel and
    transcript keep the content they already had.
- **Specs linked**: `03-runtime/01-ipc-protocol.md` § fs,
  `04-ux/09-interaction-patterns.md` §8a.2, ADR 0124, ADR 0163, ADR 0249,
  ADR 0262, ADR 0263
- **Acceptance**: C (conversation & stream), D (workspace), Quality
- **Milestone**: M5
- **Status**: Unit-covered
  (`apps/desktop/test/chat-ref-resolve.test.mjs`); full UI journey Draft (run
  only in a capable environment when this surface changes)

## E2E-CHAT-spaced-absolute-file-paths

- **Preconditions**: On Windows, open a project rooted at a directory whose
  name contains a space. Create `readme.md` there through a chat Write tool
  call; keep a same-name file in another project directory and one file outside
  every allowed root. Repeat the path-recognition checks with a POSIX project
  path containing a space on macOS or Linux.
- **Steps**: 1) Click the full path in the Write row. 2) Click the same full
  path as inline code and as ordinary text in the assistant reply. On Windows,
  also click it as a Markdown link with an angle-bracketed destination, for
  example `[readme.md](<C:\workspace with spaces\readme.md>)`. 3) Click a
  relative path whose middle directory contains a space, then a first-segment
  spaced path using an explicit `@"..."` reference. 4) Click the outside
  absolute path.
- **Expected**: Every allowed reference opens the exact file in the existing
  side file view; no path is truncated to its suffix or redirected to the
  same-name file. The Windows Markdown link keeps a valid sanitized address
  and reaches the existing file opener with the original drive path. The outside
  path opens that exact file in the host file view (ADR 0339), dotfile folders
  such as `.ssh` included, while a missing file reports that no file matches.
- **Specs linked**: `03-runtime/01-ipc-protocol.md` § fs,
  `04-ux/08-component-spec.md` §8.3.
- **Acceptance**: C (conversation & stream), D (workspace), Quality
- **Milestone**: M5
- **Status**: Unit/component-covered (`chat-links.test.mjs`,
  `chat-ref-resolve.test.mjs`, `tool-row-file-refs.test.mjs`); full UI journey Draft.

## E2E-CHAT-file-ref-opens-the-surface-that-owns-it

- **Preconditions**: The bundled File Manager plugin is loaded and enabled and
  the work panel is closed. The open session's scratch store holds one HTML
  file and one other file, and the attachment store holds one blob. The project
  is a group whose primary folder
  contains an `.html` page and a text file, and whose second folder holds a text
  file of its own. The same session's transcript carries a `Read` row whose
  summary names a project file, a `Glob` result listing project paths, and a
  `Grep` result grouping its hits by file.
- **Steps**: 1) Click a project file reference in an assistant reply. 2) Type an
  unsaved edit into that view and click the same reference again. 3) Click a
  reference that resolves into the session scratch store, then the
  `attachments/<sha256>` reference. 4) Click a workspace `.html` reference in an
  assistant reply and the same reference as a sent user chip; click the scratch
  HTML reference too. 5) Click the file
  path in the tool row's summary, then a path in the `Glob` result's file list
  and a path heading of the `Grep` result. 6) Disable the File Manager plugin,
  then click a project file reference and the tool row summary. 7) Click a
  reference that resolves in the project's second folder, then one that resolves
  in its primary folder. 8) Right-click the sent `@path` chip, the inline-code
  reference, the markdown link, the local image, a tool row's file path, a tool
  result's file list, and an attachment image chip; then right-click a reference
  that matches nothing. On an HTML reference, open the Open with submenu and
  choose File Manager, built-in browser, and default browser; repeat for the
  scratch HTML file. 9) Use Copy full path and Copy relative path, then do the
  same on a reference that resolves in the session scratch store. 10) Choose
  Show in folder on a project file and on a scratch file.
- **Expected**:
  - Right-clicking a file reference offers Copy full path and Copy relative
    path on each transcript surface that names it, plus Show in folder in a
    local session. An unpositioned HTML reference also has a second-level
    Open with submenu for File Manager, built-in browser, and default browser.
    Show in folder reveals the resolved file in the system file manager and a
    missing reference reports itself instead. Each open choice resolves
    the reference first, and a missing reference reports itself without opening
    a same-named file elsewhere.
  - A copy writes exactly what it names: the absolute address for the full copy
    and the project-relative spelling for the relative one; a scratch or
    attachment file reports that it has no relative path instead of copying an
    absolute one under that name.
  - A project file opens in the File Manager work-panel view on that file, with
    its ancestor folders expanded and the file selected; no host `file:` tab is
    added for it.
  - Clicking the same reference again does not reload the view: the unsaved edit
    is still in the editor and no second tab appears.
  - A scratch or attachment file opens in the host `file:` tab under Open
    resources, addressed by its absolute path, never in the File Manager view.
  - A plain click on an unpositioned `.html` / `.htm` reference from any
    project folder or session scratch opens it in the work-panel side browser.
    In the Open with submenu, File Manager opens the resolved file in that
    plugin view, built-in browser opens the same absolute path in the side
    browser, and default browser uses the host's validated OS file-open path.
    A positioned HTML reference keeps its line-aware host file tab behavior.
  - A tool surface reaches the destination of the file it names, not one of its
    own: the tool row's summary path and the paths of the `Glob` file list and
    the `Grep` path headings open the same project file in the File Manager view.
    A summary path that is a link opens the file without expanding the row, and
    only a summary without a resolvable target falls through to the row's own
    disclosure.
  - A reference that resolved in the project's second folder opens in the File
    Manager view on that file, reached by its absolute path, with no host
    `file:` tab; the reference from the primary folder opens in that same view
    addressed project-relative (ADR 0263).
  - With the plugin disabled, a direct project-file click from the reply, tool
    row, or result list starts the bundled File Manager within its existing
    scope and permission grant, then opens the requested file there. If the
    scope or grant excludes the current project, or the view still cannot
    start, the host `file:` tab opens with an unavailable notice.
- **Specs linked**: `04-ux/08-component-spec.md` §8.3, §9.6,
  `04-ux/09-interaction-patterns.md` §8a.2, ADR 0104, ADR 0163, ADR 0241,
  ADR 0249, ADR 0262, ADR 0263
- **Acceptance**: C (conversation & stream), G (plugins), Quality
- **Milestone**: M5
- **Status**: Unit-covered
  (`apps/desktop/test/chat-file-open-with-menu.test.mjs` for menu destinations
  and resolved-path routing, `apps/desktop/test/transcript-file-chips.test.mjs`
  for the wiring, and `apps/desktop/test/tool-row-file-refs.test.mjs` for the
  work-panel entry each shape of resolution produces). The isolated Electron renderer journey in
  `scripts/e2e-file-ref-line-scroll.mjs` verifies a Markdown link enables the
  File Manager on demand and a positioned reference still opens in the host
  viewer. `pnpm test:e2e:transcript` also exercises the rendered second-level
  menu, destination selection, and keyboard focus return; the full
  file-reference journey through all three destinations remains Draft.

## E2E-CHAT-mp4-attachment-opens-in-system-player

- **Preconditions**: A conversation has one pasted MP4 in session scratch and
  two stored MP4 attachments whose content-addressed refs have no extension:
  one larger than 512 KiB and one smaller binary file. All retain `video/mp4`
  metadata.
- **Steps**: Click each attachment in the transcript, then choose **Open with
  default application** in the host file tab. Repeat with a workspace `.mp4`.
- **Expected**: The large attachment reports that inline preview is unavailable
  because of size and the small attachment reports binary content; both offer
  the OS-open action. The host validates realpath containment and hands the OS
  an `.mp4` alias of the same stored bytes. A file outside allowed roots or a
  symlink escape is refused. Failed OS handoff is visible to the user.
- **Specs linked**: `03-runtime/01-ipc-protocol.md` § fs,
  `04-ux/09-interaction-patterns.md` §8a.2.
- **Acceptance**: C (conversation & stream), Quality, Security
- **Milestone**: M5
- **Status**: Electron fixture covered for pasted scratch MP4 and both blob sizes
  (`test:e2e:composer-paste`); full installed-app/player journey Draft.

## E2E-187: History attachments and local markdown images render inline

- **Preconditions**: An Agent session in a workspace that contains
  `docs/pixel.png`. The user has previously pasted an image so the session
  JSONL stores an `attachments/<sha256>` image ref with a stored mimeType.
- **Steps**:
  1. Reopen the session. Confirm the pasted image renders as a chip like any
     other attachment, continuing the body text instead of heading it, and that
     hovering or focusing it reveals its preview card.
  2. Click the chip. Confirm the host files viewer opens on that
     attachment ref and shows the image.
  3. Send a turn whose assistant markdown includes `![](docs/pixel.png)` and
     `![](/etc/passwd)`. Confirm the workspace image renders inline and the
     outside-root path does not load file bytes.
  4. Confirm `fs/readImageDataUrl` with `ref: "/etc/passwd"` and
     `mimeType: "image/png"` returns `missing`, not a data URL.
- **Expected**:
  - Contained image refs display inline within the 5MB cap.
  - Outside-root paths and mime spoofing of non-image extensions stay closed.
  - Clicking a resolved image chip opens the host `file:` tab, not the OS
    handler.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `04-ux/08-component-spec.md` §8.3, ADR 0172, `08-meta/decisions-log.md` (D334)
- **Acceptance**: C (conversation & stream), D (workspace), Security, Quality
- **Milestone**: M5
- **Status**: Unit-covered (`fs-panel-guard.test.mjs`,
  `message-image-display.test.mjs`); full UI journey Draft (run only in a capable environment when this surface changes)

## E2E-218: An installed Composer transform preserves inline attachment chips

- **Preconditions**: A plugin that contributes a Composer transform is
  installed, enabled, and granted `composer.transform`. An Agent session has a
  draft with ordinary prompt text and inline file and image chips.
- **Steps**: 1) Add file and image chips to the draft. 2) Invoke the plugin's
  Composer action. 3) Observe the plugin request and updated draft. 4) Undo the
  transform and confirm the draft and chips return.
- **Expected**: The plugin action is visible only while its plugin is loaded and
  its permission is granted. The transform callback receives the visible draft
  text and optional model key, but no image bytes, attachment metadata, file
  reference token, session id, or conversation history. The file and image
  chips remain in place and removable through the transform and its one-step
  undo. The transform does not create a transcript row. Without the plugin, no
  prompt-enhancement action appears.
- **Specs linked**: `04-ux/12-prompt-enhancement.md`,
  `07-plugins/02-plugin-manifest-schema.md`,
  `07-plugins/03-plugin-api.md`,
  `07-plugins/13-plugin-permissions-matrix.md`
- **Acceptance**: C (conversation & stream), Quality
- **Milestone**: M6+
- **Status**: Covered by `test:e2e:plugin-ui-slots` for plugin-process dispatch,
  draft-only update, inline file/image chip preservation, one-step undo, and no
  transcript row. Attachment sending is covered by the separate Composer send
  E2E.

## E2E-SESSION-independent-top-level-communication: SessionTask discovers and communicates with existing sessions

- **Preconditions**: The marketplace `pi.session-orchestrator` plugin is
  installed and enabled. Two existing Agent sessions were created from the
  normal New Task flow and are not linked as Session Orchestrator workers. The
  caller is an active Agent session with a configured authenticated provider.
- **Steps**: 1) Call `SessionTask` with `action: "list"` and identify both
  existing sessions by their durable `sessionId`. 2) Send a message to one
  independent session and verify it is admitted against that session's inbox.
  3) From the target session, send a reply to the original session. 4) Call
  `status` and `result` with the returned IDs and inspect the two transcripts.
- **Expected**: `list` includes bounded references to existing communicable
  Agent sessions without requiring plugin-owned history or treating them as
  workers. `send` works in either direction using the real target Session ID,
  preserves each target's existing model/project/context/permissions, and
  never creates a replacement session. The host records source and target
  provenance, results remain bound to the actual durable turns, and the list
  response contains no transcript, project path, credentials, or message
  previews. Non-Agent sessions remain rejected by the existing host policy.
- **Specs linked**: `07-plugins/03-plugin-api.md`,
  `07-plugins/04-plugin-security.md`, `03-runtime/01-ipc-protocol.md`,
  `03-runtime/04-data-storage.md`, ADR 0239, ADR 0240
- **Acceptance**: C (conversation & stream), D (plugin security),
  G (plugins), Quality
- **Milestone**: M6+
- **Status**: host discovery and bidirectional delivery are automated by
  `pnpm test:e2e:collaboration`; plugin and host-core regression coverage is
  automated. The live multi-session provider/Electron journey remains runner
  validation under the no-local-E2E policy

## E2E-SESSION-completion-notice-allows-silence: A trusted completion notice may finish without an acknowledgement

- **Preconditions**: A candidate commit has its own built host-core and runtime
  sidecar. The local SSE provider deterministically returns visible text or a
  successful empty response; no live credentials are required.
- **Steps**: 1) Deliver a task through the real Host collaboration ledger and
  sidecar, read its successful result, and complete the coordinator summary.
  2) Resolve the queued completion callback through the production Main input
  resolver and run the recipient against an empty SSE response. 3) Run another
  human request, copied completion framing, a ledger task, and a ledger message
  against empty responses on the same recipient runtime.
- **Expected**: The original result remains unchanged. The completion has one
  provider request, no error, one terminal lifecycle, completed ledger status,
  and no acknowledgement callback. Each ordinary input still retries once and
  ends with `EMPTY_MODEL_RESPONSE`, and no request the recipient sends after
  the silent notice carries an empty assistant message. Unit coverage
  additionally rejects missing reply-to IDs/wrong targets, spends the exception
  on a tool batch, keeps it across a provider retry, revokes it once accepted
  user steering enters the context, and keeps the accepted silence out of the
  runtime entries and pi transcript state.
- **Specs linked**: `03-runtime/02-agent-runtime.md` §5e,
  `03-runtime/08-error-codes.md`, ADR 0239 (D446 amendment)
- **Acceptance**: C (conversation & stream), D (provenance), Quality
- **Milestone**: M6+
- **Status**: Automated by `pnpm test:e2e:session-completion` on the committed,
  rebased candidate in its dedicated worktree. The harness drives real Host
  RPCs, the production provenance resolver, sidecar, and local SSE, and persists
  runtime messages before Host settlement. It does not exercise Electron's
  queue/outbox UI or a live provider. Candidate/base SHAs and results belong in
  the validation report; existing ledger coverage runs separately through
  `pnpm test:e2e:collaboration`.

## E2E-SESSION-hover-card-model-and-links: Session hover cards expose readable model and creation navigation

- **Preconditions**: The app has one collaboration-created session, one
  independent session, and a configured provider/model with readable catalog
  names. The sidebar contains both sessions.
- **Steps**: 1) Hover or keyboard-focus the collaboration-created session.
  2) Inspect the model metadata, creator reference, and created-session list.
  3) Activate the creator and one created-session reference with the keyboard.
  4) Delete (or otherwise remove) one referenced session, or use a session whose
  reference is already stale, then revisit the card. 5) Inspect an independent
  session's card as well.
- **Expected**: The card shows the model's display name, falling back to
  the provider's readable name, instead of the provider ID. A collaboration-created session shows its
  creator, and a creator shows its bounded created-session list. Each live
  reference is a native keyboard-focusable button with an accessible
  open-session name; activating it opens that durable session and focuses the
  Composer. A reference whose session no longer exists is presented as text
  with an "unavailable" indication and is not a keyboard-focusable navigation
  control; activating a session that no longer exists (for example a session
  deleted between the snapshot and the click) surfaces a visible error instead
  of switching to an empty transcript. An independent session remains a valid
  local session without a fabricated creator link. Hover polling remains
  bounded and does not load a transcript: a read that exceeds its deadline is
  abandoned, and an unfocused window keeps a slower idle poll instead of
  stopping or overrunning.
- **Specs linked**: `03-runtime/01-ipc-protocol.md` §5.7,
  `03-runtime/04-data-storage.md`, `04-ux/08-component-spec.md`,
  `04-ux/09-interaction-patterns.md`, ADR 0240
- **Acceptance**: C (conversation & stream), Quality
- **Milestone**: M6+
- **Status**: source-contract and projection tests are automated; rendered
  pointer/keyboard validation remains runner validation

## E2E-222: Remote turn streams ordered durable events and live deltas

- **Preconditions**: An authenticated controller is attached to an idle
  Session with a deterministic fixture Agent whose turn has two model rounds,
  one tool call, and one compaction.
- **Steps**: 1) Attach and subscribe from the current cursor. 2) Call
  `turn/start`. 3) Collect every event envelope until the terminal event,
  separating durable events (with `sequence`) from ephemeral events (with
  `afterSequence`). 4) Compare the final snapshot with the state rebuilt from
  durable events alone. 5) Compare each `payload.event` with the local
  `AgentEvent` recorded by the desktop for the same turn.
- **Expected**: `turn/start` returns quickly with a `turnId`; durable
  sequences are strictly increasing inside one epoch; `item.delta`,
  `tool.progress`, and `turn.activity` carry `afterSequence` and never a
  `sequence`; exactly one `turn.completed` is emitted, at the local
  `agent_end`, and none at the intermediate `turn_end`; the compaction appears
  as an `item` with `itemType: "compaction"`; the terminal state is immutable;
  and the final snapshot equals the state reconstructed from durable events
  plus the content of `item.completed` payloads.
- **Specs linked**: `03-runtime/19-remote-agent-control-protocol.md` §§5–8,
  `03-runtime/10-session-state-machine.md`,
  `02-architecture/05-remote-agent-control.md` §8
- **Acceptance**: C (conversation & stream), Quality
- **Milestone**: Post-MVP
- **Status**: Draft; remote harness required

## E2E-225: A turn continues when its client disconnects and the queue is host-owned

- **Preconditions**: Two authenticated controllers can access the same
  Session; the fixture Agent has a delayed deterministic turn; the local
  desktop renderer is open on the same Session.
- **Steps**: 1) Client A starts the turn. 2) Disconnect A while it is
  running. 3) Observe the Session from client B. 4) Reconnect A as a viewer.
  5) From B, call `turn/start` with `admission: "reject_if_busy"`, then with
  `admission: "queue"` twice. 6) Cancel the second queued turn from B.
  7) Call `turn/stop` from B. 8) Fill the queue to `maxQueuedTurnsPerSession`
  and start once more.
- **Expected**: The turn continues after A disconnects; B observes the same
  turn and durable sequence; A catches up by cursor; the first start returns
  `AGENT_BUSY`; the queued starts return `turn.queued` with positions and the
  desktop renderer shows the same queued prompts; the cancel emits
  `turn.canceled`; `turn/stop` ends the active turn as `completed` at the
  next boundary and the remaining queued turn starts; the overflowing start
  returns `AGENT_BUSY` with `details.queueFull`.
- **Specs linked**: `02-architecture/05-remote-agent-control.md` §§6, 9,
  and 10, `03-runtime/19-remote-agent-control-protocol.md` §§7.3–7.4 and 8
- **Acceptance**: C (conversation & stream), Recovery
- **Milestone**: Post-MVP
- **Status**: Draft; remote harness required

## E2E-250: Context usage display preference switches the inspector's leading figure

- **Preconditions**: An Agent session has completed at least one turn that
  reported token usage. Settings → Conversation → Display is reachable.
- **Steps**:
  1. Confirm the composer toolbar context ring shows remaining capacity
     (ring nearly full, percentage ≈ remaining %, tooltip and aria-label
     use remaining vocabulary).
  2. Open Settings → Conversation → Display and switch the Context usage display
     segmented control from Remaining to Used.
  3. Return to the chat and inspect the context ring: the ring arc now
     fills by `usedRatio` (nearly empty at low occupancy), the percentage
     shows ≈ used %, the popover heading shows used tokens + percentage,
     and the tooltip/aria-label use used-capacity vocabulary.
  4. Confirm warning/critical ring colors still follow remaining capacity:
     at remaining > 25 % the ring stays neutral even when used % is high.
  5. Switch back to Remaining and confirm the original display returns.
- **Expected**: The display mode flips the ring arc, percentage, token
  count, heading, tooltip, and aria-label consistently. Color thresholds
  remain based on remaining capacity in both modes. The default for a
  fresh profile is Remaining.
- **Specs linked**: `04-ux/06-settings-ia.md`, `04-ux/08-component-spec.md`,
  ADR 0223, `08-meta/decisions-log.md` (D398)
- **Acceptance**: C (conversation & stream), Quality (preference)
- **Milestone**: M5
- **Status**: Unit-covered (`context-usage.test.mjs`,
  `settings-general.test.mjs`); full scenario Draft

## E2E-AGENT-alt-enter-steers-active-turn: Enter follows up and Alt+Enter steers the active turn

Steer a long-running local foreground command. Verify cancellation, partial
output and the waiting status, and require confirmed settlement before the next
model request. Repeat with delayed settlement beyond the Stop grace period, an
unconfirmed shell failure, a remote tool, parallel and queued calls, a background
command, a delegate, and an explicit Stop. Accepted input is delivered once.

- **Preconditions**: A session with a configured model and a controllable
  streaming response/tool; an image-capable model for the attachment case.
- **Steps**:
  1. Start a prompt, then type a follow-up and press Enter. Confirm a FIFO row.
  2. During the same turn, type a correction and press Alt+Enter. Repeat with
     an image chip and with two corrections before the current request ends.
  3. Finish the current response/tool batch and inspect the next model input,
     transcript and durable turn id. Let the turn finish and observe follow-up.
  4. Repeat with Enter-to-send off, an open autocomplete menu, Shift+Enter,
     Alt+Shift+Enter and a Chinese IME candidate confirmation. Inspect the Send
     tooltip on macOS (`⌥+Enter`) and Windows/Linux (`Alt+Enter`).
  5. Race steering against turn completion, Stop, and a pending plan approval;
     switch sessions while a rejected request is pending.
  6. Change the next-turn model while running, then steer. Verify the active
     model and permission configuration remain unchanged.
  7. Steer while the parent waits for background delegates; leave them running
     and verify the parent receives the correction before their reports finish.
  8. Reload after completion and simulate a crash after a streaming reply was
     reserved by steering. Inspect row order, recovered text and owning turn.
  9. Reload the renderer after steering is accepted but before its reply starts,
     then press Stop and inspect the persisted transcript.
- **Expected**: Enter queues an ordinary follow-up. Alt+Enter creates a user
  row in the current turn with no queue row or new public `agent_start`.
  Started tools finish, then the next request contains the corrections/images.
  The ordinary FIFO starts only after durable turn finalization. IME and
  newline actions never submit; idle Alt+Enter sends normally. A stale/closed
  target keeps the draft in its own session and never fails the active turn.
  Accepted input is not replayed independently after Stop. Completed replies
  and accepted steering input remain in history after renderer reload and Stop.
  Terminal assistant snapshots replace provisional snapshots in place; crash
  recovery preserves the latest
  checkpoint and adjacent steering rows without duplicates.
- **Specs linked**: `03-runtime/01-ipc-protocol.md` (§5.1a),
  `03-runtime/02-agent-runtime.md` (§4.0), `03-runtime/04-data-storage.md`,
  `04-ux/09-interaction-patterns.md` (§3.5), ADR active-turn-steering
- **Acceptance**: C (conversation & stream), E (tools & permissions), Quality
- **Milestone**: M5
- **Status**: Draft. Existing regression suites cover surrounding behavior;
  the rendered steering journey has not been run
  (do not run E2E locally unless explicitly requested).

## E2E-SESSION-content-search-and-message-navigation

- **Scope**: Desktop global search, host search projections, and original
  conversation navigation (issue #270, ADR session-content-search).
- **Preconditions**: At least 65 visible sessions with a shared body keyword;
  one session has 125 matching user/assistant messages. Include a body-only
  keyword, a metadata-only match, an archived session, a soft-deleted session,
  one/two-character CJK terms, literal `%`, `_`, quotes, and a path. Include a
  long session with a match beyond the latest 100 messages and a message whose
  matching text follows 100,000 characters. Include an actively streaming
  conversation and a fixture with repeated physical message lines.
  Include a nested assistant answer whose Task is outside its 60-line page, a
  later terminal copy of that Task, collapsed activity, hidden Markdown link
  destinations, emphasis delimiters, and file-chip directories.
  Add short matching sentences surrounded by unrelated Chinese/English
  sentences, multiple short lines before a match, a quoted sentence, a file
  path containing periods, and a matching sentence longer than 180 characters.
- **Steps**: Search body-only user and assistant terms, then rename the owning
  session and repeat. Check aggregated counts and sender/time/snippet labels.
  Load every result page. Open a session heading and each of its two snippets;
  verify that each snippet closes search, opens the same original conversation,
  and scrolls to its own matching text. The heading selects its first snippet.
  Check normal Markdown, message actions, and composer. Repeat with two assistant
  fragments in one turn, an old target outside the latest page, and a match after
  100,000 characters. Verify a visible highlight and that layout settling does
  not pull the target away. Read upward and load later messages without gaps.
  Use the latest-message control to resume the live transcript. Scroll within
  the active conversation, reopen search, and select its own result; locate the
  target inside the same pane. Edit, retry, branch, and delete an old message. Reopen search and check the retained query.
  Repeat with CJK and symbols. Verify that a contiguous Chinese phrase matches,
  while inserting a space between its words only matches text with that space.
  Change queries rapidly while delayed first-page
  and later-page requests resolve out of order. Close/reopen during loading.
  Retry after a transient search error.
  Open the nested answer and verify that the owning Task is revealed and its
  existing dock scrolls to the answer. Search the hidden URL, delimiters, and
  chip directory after a long prefix; verify the corresponding visible element
  is highlighted. Interrupt layout correction with a wheel/key gesture.
  Page ordinary history while output streams, then interrupt a pending page with
  search, another result, a new turn, and return to latest. Change a revision
  without changing its message ID. Edit/retry a visible but display-capped
  message and verify that the canonical full text becomes the action input.
  Search a running conversation and return to its live stream, then switch
  conversations. Use arrows, Enter, Escape, Tab, and CJK IME confirmation, and
  exercise page/settings/plugin-command results.
  Search a word in the middle sentence and verify that the
  result shows that sentence with a background highlight on the literal match.
  Repeat after multiple line breaks and at narrow window widths in light and
  dark themes. Long-sentence truncation must keep the whole matching query
  visible; short previews must omit unrelated adjacent sentences.
- **Expected**: Every matching visible session is reachable; counts cover all
  125 messages, with no duplicate session rows. Archived visibility follows
  the existing explicit-search rule and deleted sessions never appear. Each
  snippet opens its owning conversation directly without an intermediate
  context reader, plain-text replacement, or Back to conversation action.
  Each selected snippet lands at its exact message and matching rendered text,
  including old history and individual assistant fragments. Reading-window
  loads do not overwrite live output. New turns return to the live transcript.
  Actions on historical messages work normally and do not leave obsolete rows.
  Nested answers land in the original Task dock; source-only matches land on
  their rendered owner. Ordinary paging retains current streamed content.
  Interrupted reads cannot reopen a dock or restore stale/loading views, and
  same-ID edits replace obsolete displayed content. Message actions never use
  clipped text as input.
  Rapidly selecting another result rejects stale target/page completions.
  Deleting a result before selection reports failure instead of landing at the tail.
  Later query ownership wins over stale results/errors. IME Enter does not
  execute an action. Search transport failures are explicit.
  Existing commands, pages, settings, and keyboard navigation still work.
- **Status**: Draft; Rust and renderer unit regressions cover the data/query
  boundaries. Full rendered E2E requires an explicitly authorized run.

## E2E-TRAY-bounded-session-navigation

- **Scope**: Native tray groups, hidden/recreated window activation, and unread
  semantics (issue #293, ADR tray-session-shortcuts).
- **Preconditions**: At least four running, four unread, and four pinned
  sessions across two projects; include overlaps, read-latest/older-unread
  notifications, archived/deleted sessions, an archived project, empty titles,
  multiline titles, long CJK/emoji titles, and literal ampersands. Also cover
  a single populated group of seven and one of more than nine, with the other
  two groups empty, to exercise reclaimed share. Use an
  isolated profile. Repeat native activation on macOS and Windows/Linux.
- **Steps**: Hide the main window and open the tray menu. Inspect group order,
  counts, duplicates, titles, and unchanged unread records. Choose the third
  row from another project, then View more from Settings with a collapsed
  sidebar and a retained search query. Finish/abort tasks while hidden;
  read a result, pin/unpin, rename, archive/restore, and delete a session.
  Close the macOS window while a task runs and let it finish, then activate
  its tray row while the new renderer bootstraps a pending plan. Delay a Host
  read while a newer preference update, delete, or Host restart arrives.
  Retry a transient read failure by hovering/right-clicking the tray on Windows/Linux; macOS retries from the next session or inbox event instead of mouse-enter.
  Repeat after clearing all group memberships and changing shipped locales.
  Choose Quit then Cancel, then Quit and confirm.
- **Expected**: Running → Unread → Pinned; at most nine rows in total. Each
  non-empty group keeps up to three rows and overflowing groups reclaim the
  share smaller groups leave unused, in priority order: seven running sessions
  with no unread or pinned show all seven, and a single group holding more than
  nine shows nine behind View more. Deduplicate before limits, so hidden
  Running overflow cannot
  appear as Unread/Pinned. Empty groups and stale shortcuts disappear. Unread
  uses the latest terminal result per session, newest first. Titles remain
  one line within the 32-column cap, half as many characters for CJK/emoji,
  including literal ampersands. Opening the macOS
  menu leaves the window hidden and records unread. A row opens exactly that
  session/project, acknowledges it normally, and wins over startup navigation.
  View more returns from Settings, closes search, and expands session navigation. Hidden/closed windows receive fresh groups;
  stale reads, archived/deleted targets, and a failed backend cannot restore
  stale shortcuts. Open, localization, quit cancellation, and shutdown work.
- **Specs linked**: `03-runtime/01-ipc-protocol.md` §13b,
  `03-runtime/07-process-model.md`, `04-ux/08-component-spec.md`,
  `04-ux/09-interaction-patterns.md`, ADR tray-session-shortcuts.
- **Acceptance**: A (app/window lifecycle), C (conversation navigation),
  F (unread persistence), Quality (bounded localized menu).
- **Milestone**: Post-M6 desktop shell maintenance.
- **Status**: Draft; native E2E requires an explicitly authorized run.

## E2E-SESSION-native-pi-continue-appends-original-jsonl

- **Preconditions:** A synthetic Pi v3 session contains branches, compaction
  metadata (including `retainedTail`), model/thinking changes, custom and
  context-bearing custom-message entries, and a valid project cwd. A faux local
  model/auth binding is configured in the fixture Pi agent directory; Desktop
  provider secrets are absent. A fixture extension restores custom state in
  `session_start`, contributes a skill through `resources_discover`, and uses
  the 0.87 `turn_end` boundary to propose a `context_edit` for the settled
  assistant entry.
- **Steps:** Start PI-Desktop with fixture-only agent/session directories;
  refresh sessions; open the native row beside a Desktop row; submit one text
  prompt; stop or let the faux response settle; send the same text again with
  a retryable response before success; reselect/refresh repeatedly; reopen through
  a fresh Pi `SessionManager`; invoke native compact and queue push/list.
- **Expected:** The original fixture JSONL receives native SDK entries whose
  parent starts at the previous current leaf; all prior bytes/unknown entries
  remain unchanged; the new leaf is visible after refresh; no Desktop SQLite
  session or Desktop transcript copy is created; the Desktop-owned row still
  follows its existing runtime and storage path. Native requests expose zero
  built-in or extension model tools; startup and discovered skill are effective.
  Exactly two durable SDK-ID user rows remain, including after abort; smart-stop
  never rewrites native history. Retries/compaction remain running and stoppable
  until one terminal completion; the owned idle lease accepts the second send.
  The `context_edit` is appended under the same lease, affects the next model
  request, and leaves the original assistant row visible in native detail.
  Compact and queue push/list reject before host access. Opaque host-turn queue
  remove/prioritize remain Desktop-only because native paths create no entries.
- **Specs:** runtime §12; storage §12; security §12; ADR 0254.
- **Status:** Documented; run after integration into main.

## E2E-SESSION-native-pi-external-change-fails-closed

- **Preconditions:** A writable synthetic native v3 fixture is listed.
- **Steps:** Acquire Desktop continuation ownership, then simulate a foreign
  append/replacement before the extension's `appendContextEdit`; also attempt a
  second Desktop lease and stale leases whose owners are live, remote,
  malformed, or uncertain.
  Refresh list/detail with a dead same-host owner and unchanged or complete
  append-only extended bytes, then prompt through normal UI capabilities.
- **Expected:** The second writer is refused; external divergence tears down
  continuation with a visible read-only/error reason; no requested entry is
  appended and no bytes are truncated or rewritten; a lease releases on normal
  dispose and is reclaimed after crash only with a dead same-host owner and an
  unchanged target or same-file prefix-preserving complete parent-chain extension.
  The context-edit append is refused by the same byte and parent check as other
  SDK writes. Uncooperative Pi clients can still race the OS append; no
  shared-lock guarantee is claimed.
- **Specs:** runtime §12; storage §12; security §12; ADR 0254.
- **Status:** Documented; run after integration into main.

## E2E-SESSION-native-pi-incompatible-session-is-read-only

- **Preconditions:** Fixtures cover missing cwd, missing trailing newline,
  v1/v2 header, unavailable saved provider/auth, and untrusted project resources.
- **Steps:** Refresh and open each fixture.
- **Expected:** Each remains browseable with a specific reason, the composer is
  disabled, no migration/repair/fallback occurs, and source bytes and mtimes are
  unchanged.
- **Specs:** IPC native routing; runtime §12; storage §12; security §12.
- **Status:** Documented; run after integration into main.

## E2E-SESSION-native-pi-duplicate-id-collapses

- **Preconditions:** An isolated Pi agent directory contains a valid native v3
  session and a copied JSONL file under a nested directory with the same
  `header.id`.
- **Steps:** Start PI-Desktop with the fixture-only agent directory, refresh the
  session list, open the listed native session, and search its transcript.
- **Expected:** The list contains one row for that native id. Detail and search
  resolve through the selected file; duplicate files remain byte-identical and
  are not rewritten or deleted.
- **Specs:** runtime §12; storage §12; ADR 0254.
- **Status:** Source-regression covered; full Desktop journey Draft.

## E2E-SESSION-native-pi-project-session-dir

- **Preconditions:** A local project has `.pi/settings.json` with
  `"sessionDir": ".pi/sessions"` and a valid native v3 JSONL in that directory.
  The default Pi agent session root also contains a valid session. A nested
  JSONL and a symlink that leaves `.pi/sessions` are present. A second fixture
  sets an absolute global `sessionDir` and no project path. A third sets a
  relative global `sessionDir`.
- **Steps:** Refresh the session list, open the project-local session, and fork
  it. Repeat list and open for the absolute global directory. Refresh the
  relative global fixture once with no known project and once after that
  project is known, including a remote project id in the known set.
- **Expected:** The project-local session and the default-root session both
  appear. The nested file and the escaping symlink do not. Opening the
  project-local session returns its transcript. Fork publishes one new JSONL
  beside the parent and does not rewrite the parent. The absolute global
  directory is listed without a project path. The relative global directory is
  listed only for the known local project. Remote project ids are ignored.
  Untrusted project resources stay browseable and read-only.
- **Specs:** runtime §12; storage §12; security §12; ADR 0254.
- **Status:** Source-regression covered by
  `packages/agent-runtime/src/native-pi-session.test.ts` (the project fixture
  asserts `readOnlyReason: project-untrusted` and `canPrompt: false`) and
  `apps/desktop/test/native-pi-sessions.test.mjs`; full Desktop journey Draft.

## E2E-CHAT-disclosure-toggle-keeps-reading-position

- **Scope**: Manual disclosure of a tool, thinking or activity title in a
  transcript or a delegate run dock while the scroller is pinned to the bottom
  (issue #324).
- **Preconditions**: A session longer than one screen, sitting at the bottom with
  follow mode on, holding a tool row, a thinking row and an activity group whose
  expanded detail is taller than its header, plus one expanded delegate run that
  owns a nested scroller. Repeat with a finished turn (`isRunning` false) and
  while the turn streams.
- **Steps**: Click the title of a tool row, a thinking row and an activity group
  while pinned at the bottom, and again after the turn has finished. Repeat with
  the viewport parked in the middle of the transcript, with a keyboard activation
  (Enter, then Space, on a focused title), and from the collapse rail. Expand a
  tool row inside an expanded delegate dock. Then scroll with the wheel, press
  ArrowUp with a title focused, click the jump-to-latest control, and send a new
  prompt.
- **Expected**: The clicked title keeps its on-screen position while the detail
  animates open and closed, and the transcript never re-bottoms underneath it;
  follow mode is left and the newest-message control appears. The held position
  survives every frame of an animated activity group and also covers a
  simultaneous height change above the title. A nested dock holds its own
  position and the transcript behind it does not re-bottom either. Real scroll
  input, the jump control, a new turn and every navigation release the hold and
  follow the live tail again, while a reader who scrolled up keeps their place.
  Space still activates a focused title and arrow keys still scroll.
- **Specs linked**: `04-ux/09-interaction-patterns.md` §9.1;
  ADR transcript-reading-ownership; D287, D302, D430
- **Acceptance**: C (conversation & stream), E (tools & permissions), Quality
- **Milestone**: M6+
- **Status**: Partially automated. `pnpm test:e2e:transcript-disclosure` mounts
  the real transcript scroll hook and a real tool row in a real 600 CSS px
  Electron viewport and clicks the title with a real DOM click, asserting the
  title's offset from the scroller top and the scroll offset for the transcript
  and for a nested follow scroller; without the fix the same fixture reports the
  title moving by the full height of the opened detail. The app stylesheet is not
  linked, so the heights come from inline filler and the components' own
  intrinsic size. `disclosure-anchor.test.mjs` covers the pure anchor and input
  math, and `transcript-disclosure-reading.test.mjs` covers the wiring. Keyboard,
  wheel and animated-activity-group paths remain additional validation.
## E2E-CHAT-turn-process-and-thinking-display

- **Preconditions:** A turn with progress paragraph A, multiple searches plus
  thinking, progress paragraph B, multiple commands plus thinking, and a final
  answer; the `Show thinking` preference on and off; the `Transcript display`
  preference at Flat, Commands first, and Fully folded; a restart with saved
  settings; legacy message-level transcript search targets.
- **Steps:** Confirm a live active group starts open, let that same turn finish
  without interacting, and confirm the process closes so only the final answer
  (and any error or pending-action surface) remains. Reopen it and confirm a
  every settled group folded and every finished reasoning row folded, and that
  each group header names the actions it contains plus the call count
  (`搜索并读取文件 · 12 次操作`). Confirm tool and search payloads stay closed.
  Turn `Auto-fold finished groups` off and confirm every settled group opens
  whatever its size, then turn it back on; turn `Auto-fold finished thinking`
  off and confirm every reasoning row opens, then turn it back on. On a second
  turn, explicitly
  open a completed group and confirm the choice survives subsequent updates; then
  close the turn's disclosure and confirm the group closes with it, and reopen to
  confirm the group choice is restored. In Fully folded, confirm run rows stay
  inside their activity groups and that only ordinary assistant progress text
  splits a group. In Commands first, confirm `Bash`/run rows render as standalone
  rows beside the groups, that a normal assistant progress message or a command
  ends the current group, adjacent calls stay separate, and only the reasoning
  row the turn is still streaming is expanded. In Flat, confirm no nested
  activity group renders, that `Auto-fold finished groups` is absent from AI
  settings, and the outer
  disclosure lists tools, commands, thinking and progress in transcript order,
  and tool details stay collapsed. In every mode confirm the turn renders exactly
  one outer disclosure and that closing it hides, then reopening restores, the
  rows under it. Turn `Show thinking` off and confirm no completed reasoning row
  remains and only a live whole-run TextShimmer `Thinking` indicator appears
  while reasoning streams, with no spinner, pulsing dot or per-character
  animation and a static presentation under reduced motion; turn it back on and
  confirm the completed rows return. Select each `Transcript display` value,
  restart, and confirm it persists; remove the saved value and confirm it
  defaults to Fully folded. Confirm the header reads running, finished, stopped,
  or failed for each case, names compaction and recovery while those stages are
  live, omits the duration when none was recorded, and never repeats the current
  command. Confirm the top-level header shows exactly status, recorded duration
  and direct tool/search count; its caret sits immediately after the tool count;
  a hairline underlines the row; hovering changes only the text colour with no
  background fill; and a failed turn does not add an issue count. Review the
  nested path, including independent group/item toggles, a
  singleton segment, literal-final-item leaf selection, failure/denial/recovery,
  retained-pane remounts, run rows keeping their details closed until opened, and
  a legacy search reveal.
  In AI settings, check the display selector in English and Simplified Chinese
  at 800px, 1000px, and 1440px window widths with 100% and 150% font scales.
  Select all three values and verify each remains visibly selected and saved.
- **Expected:** A turn renders exactly one process disclosure containing every
  pre-answer row, leaving the final answer, assistant errors, stopped trailing
  text and pending actions outside it; when no final answer text exists, the
  process header and those error or pending-action surfaces remain. An untouched
  process closes at completion. In Flat there are no nested activity groups, and
  active tools, commands, thinking and progress rows follow transcript order with
  tool details collapsed. In Commands first, `Bash`/run rows are standalone
  beside the groups, adjacent calls stay separate, and a normal assistant
  progress message or a command ends a group, so the middle progress paragraph
  and each command start a new group. In Fully folded (the default), run rows
  stay inside their groups and only ordinary assistant progress text splits a
  group, so the middle progress paragraph ends the preceding group and the
  following activity starts a new one. A group appears only with at least two
  visible items; a singleton has no group. Every group stays open while its turn
  runs; after completion both nested levels fold, so every settled group and
  every reasoning row that is no longer streaming starts closed, whatever the
  group's size. Only the reasoning a live turn is still streaming starts
  expanded when `Show thinking` is on, and a group does not inherit open state
  from the reasoning inside it, so folding a group hides expanded reasoning.
  Turning off `Auto-fold finished groups` opens every settled group; turning off
  `Auto-fold finished thinking` opens every rendered reasoning row. A settled
  group's header names the actions it contains, capped at three with "and more",
  and appends the operation count as its own non-truncating token; reasoning is
  named but not counted, and the header carries no issue counter.
  Explicit user choices persist and are restored when the enclosing disclosure is
  reopened, and never pin an ancestor; an automatic close is deferred only while
  focus or a selection remains inside. Group defaults do not depend on
  `Show thinking` or on the reasoning a group contains. The header
  reports running, finished, stopped, or failed with failure and stop outranking
  a normal finish, reads `Thinking` while the live step is reasoning, names
  compaction and recovery while those stages are live, omits a duration the
  transcript did not record, and never repeats the current command. It carries
  only status, duration and direct tool/search count, with the caret immediately
  after the tool count, a hairline under the row, text-colour-only hover, and no
  issue count. Nested group headers and run rows share the turn header's left
  edge. When `Show thinking` is off, no completed reasoning row renders, and only
  the live whole-run TextShimmer `Thinking` indicator remains while reasoning
  streams; turning it back on restores the rows. No item payload opens itself
  except the display mode's Thinking default: a tool/search row stays closed until
  the user opens it.
  Parent/child/sibling states remain independent, pane-owned user choices survive
  updates, preference changes and remounts, and renderer restart reapplies
  defaults. Search reveals the turn process and, where one exists, the activity
  group that own the named message once per request; item-level targeting is not
  part of this change, and reasoning hidden by the preference stays hidden until
  the user turns `Show thinking` on. A saved `transcriptDisplayMode` survives
  restart and an absent or unknown value resolves to Fully folded; saved
  `showThinking` survives restart, and an absent value falls back to the legacy
  `thinkingDisplayMode` (`compact` hides, `detailed`/unknown/absent shows).
  The Settings selector grows to its labels beyond the standard 240px field
  cap. Option labels remain single-line and unclipped; the control and whole
  options wrap only as needed, preserving the title/help space and preventing
  horizontal row overflow. Wide windows keep the title and control inline.
- **Validation scope for the 2026-09-20 change:** Nested disclosure and activity
  group presentation only; precise item-level transcript search targeting is out
  of scope and keeps the existing message-level search behavior.
- **Automation:** `pnpm test:e2e:transcript` covers the command-first and
  fully-folded layouts, active-to-completed process disclosure behavior, the
  automatic folding and reading-hold transitions, and the activity issue
  counter's inline layout at 320/800px and 100%/150% zoom in English and
  Simplified Chinese; `pnpm test:e2e:transcript-disclosure` verifies manual-open
  retention and viewport anchoring; `apps/desktop/test/turn-process.test.mjs`
  covers mode segmentation, `apps/desktop/test/activity-group-folding.test.mjs`
  covers the settled group defaults and the issue-counter contract,
  `apps/desktop/test/transcript-display-modes-ui.test.mjs` covers
  the renderer's mode wiring, Thinking defaults and TextShimmer,
  `apps/desktop/test/turn-process-header.test.mjs` covers the top-level header's
  status/duration/tool-count composition and the absence of issue counts,
  `apps/desktop/test/turn-process-header-style.test.mjs` covers its hairline and
  text-only hover,
  `apps/desktop/test/transcript-display-mode-settings.test.mjs` covers the
  Settings row and search indexing, and
  `apps/desktop/test/settings-roundtrip.test.mjs` covers normalization, write
  validation and the fully-folded default.
  `node scripts/e2e-settings-scroll.mjs` additionally exercises the mounted
  Settings page's selector layout and settings-save path across both locales,
  three window widths, and both font scales with isolated Electron state.
- **Specs:** 04-ux/06-settings-ia, 04-ux/08-component-spec,
  04-ux/09-interaction-patterns; ADR turn-process-and-thinking-display.

## E2E-OUTPUT-CAP-716: Keep model requests inside the published context window

- **Preconditions:** A deterministic provider fixture exposes a published context
  window, supports parent and subagent requests, and records request payloads.
- **Steps:** Configure a user context override larger than the published window;
  send a CJK-heavy parent prompt, invoke a subagent, and run a one-shot
  completion. Repeat the parent request with `thinkingLevel: "omit"`. Restore a
  session whose transcript holds many large instruction updates on a Responses
  gateway without mid-conversation system support, then continue it and run a
  subagent whose updates follow its last usage report.
- **Expected:** Each request carries a concrete output budget no larger than the
  remaining published window after input estimation and safety reserve. The
  runtime compacts against the published safety ceiling, and no request is sent
  with `input + output` beyond that ceiling. Small ASCII requests retain the
  configured budget when it fits. The restored session and the subagent send one
  folded instruction message and keep the configured output budget instead of
  the provider's minimum.
- **Specs linked:** `03-runtime/02-agent-runtime.md`,
  `03-runtime/13-model-catalog-and-selection.md`
- **Acceptance:** F (runtime provider requests), C (chat and stream)
- **Automation:** `packages/agent-runtime/src/output-cap-request.test.ts` drives
  the restored-session and subagent steps through a loopback Responses gateway.
- **Status:** Unit-covered; folded-instruction steps covered by a loopback
  gateway; remaining deterministic provider fixture pending

## E2E-CONTEXT-estimate-calibration-stays-safe

- **Preconditions:** Deterministic provider fixture whose reported usage can be
  scripted; a session whose occupancy is close to the hard boundary; no real
  provider credentials.
- **Steps:** Report usage below the prediction repeatedly and confirm the
  displayed occupancy never falls below the floor and compaction still fires;
  report usage far outside the plausible band and confirm the value does not
  move; run a CJK-heavy session and compare the displayed occupancy with the
  reported usage.
- **Expected:** The calibrated occupancy stays within 0.85×–6× of the raw
  estimate, moves up as soon as there is evidence, moves down only after
  agreeing samples, and a projection at 1.18× the hard limit still compacts.
  Misreports move it in neither direction. CJK text no longer reads at a
  quarter of its measured cost.
- **Specs linked:** `03-runtime/02-agent-runtime.md` §5.1,
  `08-meta/decisions-log.md` D606
- **Acceptance:** C (chat and stream), F (persistence), Quality
- **Status:** Unit-covered (`context-calibration.test.ts`, including the CJK and
  boundary cases); desktop E2E pending

## E2E-CONTEXT-restored-checkpoint-tool-pairs

- **Preconditions:** A production sidecar, isolated Host fixture with serialized
  session history/checkpoint, and a loopback Chat Completions gateway that
  rejects tool results without matching preceding calls; no live credentials.
- **Steps:** Restore a checkpoint through an assistant call carrier, then
  through the first of two results. Send two prompts, stop the sidecar, start
  a fresh process and repeat. Compare with a boundary after the full batch and
  a session without a checkpoint.
- **Expected:** All prompts complete. Only post-boundary tool results reach
  the gateway, paired with their original ids, names and arguments; their
  contents survive, historical tools never execute, and the stored fixture
  stays unchanged. Empty call-only boundary rows still apply the summary.
  Signed function calls retain their signatures. A retained-tail carrier is
  deduplicated with the reconstructed call, rather than replayed twice.
- **Automation:** `node scripts/e2e-compaction-restore-tool-pairs.mjs` after
  shared/runtime build and production sidecar bundling. Adapter regressions in
  `compaction-restore-tool-pairs.test.ts` cover empty boundaries, absent
  boundaries, retained tails and signed Gemini calls through public prompts.
- **Specs linked:** `03-runtime/02-agent-runtime.md` §5.1, issue #2306.
- **Limits:** Serialized Host data and the real sidecar/HTTP boundary are
  exercised; this is not a native Windows UI reproduction or a paid-provider run.

## E2E-CONTEXT-reported-occupancy-drives-compaction

- **Preconditions:** A production sidecar, isolated Host fixture and localhost
  Responses gateway. The gateway reports cached input separately from a total
  that omits it; no real provider credentials are used.
- **Steps:** Send a turn whose input, output and cache buckets exceed the
  automatic threshold, then send another prompt. Repeat with ordinary
  under-budget usage and with an incomplete bucket breakdown whose reported
  total exceeds the threshold.
- **Expected:** The first session summarizes and persists one checkpoint before
  the next provider request, which includes the summary and new prompt. The
  under-budget session continues without a checkpoint. A larger reported total
  still triggers the guard when bucket details are missing; billing totals
  remain unchanged.
- **Automation:** `node scripts/e2e-context-usage-compaction.mjs` after building
  shared and the production sidecar bundle. The real Agent-loop tests in
  `context-usage-compaction.test.ts` also cover restored sessions and compaction
  between a tool result and the next request.
- **Specs:** `03-runtime/02-agent-runtime.md` §5.1.

## E2E-IMAGE-generation-and-editing

- **Preconditions:** Built task candidate containing latest origin/main; isolated
  host data directory, local image HTTP fixture, no production credentials.
- **Steps:** Choose a model in Advanced, cancel and verify no change; save and
  replace it through another provider's Advanced settings. Clear the binding via
  the test settings API to verify recovery. Generate same-prompt variants and
  distinct images; confirm each result appears once in the conversation gallery
  while the assistant confirms completion in text. Edit a generated image,
  inspect partial failures, then restart the host/session. Return a
  multi-megabyte `b64_json` image (well above 5.5M base64 characters, below
  the image size cap). Attempt the tool in a durable Plan session and verify no
  HTTP request occurs.
- **Expected:** One image binding persists without changing the chat default;
  generated files, edit sources and transcript references survive restart.
  The large image is saved byte-for-byte instead of failing with
  `IMAGE_REQUEST_FAILED` (#2128).
  Each successful image appears once in its result card instead of being
  repeated as a Markdown embed; unconfigured errors navigate to Models settings.
- **Specs:** 03-runtime/21-image-generation; 03-runtime/13-model-catalog-and-selection.
- **Acceptance:** Configured image generation/editing, safe cancellation and persistence.
- **Milestone:** Post-MVP.
- **Status:** Automated by `scripts/e2e-image-generation.mjs` and
  `scripts/e2e-image-generation-ui.mjs`; backend test uses real Rust/stdio/HTTP/files,
  UI test uses real Chromium and production components with API-boundary fixtures.

| Scenario | Acceptance | Specification | Automation |
| --- | --- | --- | --- |
| E2E-IMAGE-generation-and-editing | Image capability and recovery | 03-runtime/21-image-generation | Host and UI suites above |
| E2E-IMAGES-result-download | Download and locate a generated result | 03-runtime/21-image-generation | `scripts/e2e-image-chat.mjs` |

## E2E-IMAGES-result-download

- **Preconditions:** Agent conversation with two successful generated PNGs and a local image fixture.
- **Steps:** Verify one selected card and two adjacent thumbnails, download the first result, select and download the second, inspect the narrow chat layout, open the selected image in the full-window viewer, navigate both directions, zoom in, close with Escape, and inspect Show in folder.
- **Expected:** The selected card and download target follow thumbnail selection. The selected thumbnail has a light gray ring, and switching loaded images keeps the card and viewer image present with stable fit dimensions throughout. Rapid reverse navigation cancels a pending decode. Both downloaded PNGs match their saved bytes and have safe filenames. Chat and viewer thumbnails remain reachable at narrow widths; viewer selection, zoom and focus restoration work, and the selected image remains selected in chat. The originals remain available. The folder action uses the contained file reveal path.
- **Specs:** 03-runtime/21-image-generation.
- **Acceptance:** Result actions and image browsing work without changing image storage or preview access.
- **Milestone:** Post-MVP.
- **Status:** Download and viewer interactions automated by `scripts/e2e-image-chat.mjs`; folder reveal uses the existing contained IPC path.

## E2E-CHAT-parenthesized-url: Complete URLs in user messages

- **Steps**: Send `https://en.wikipedia.org/wiki/React_(software)` in a user message and click its link. Repeat with the URL wrapped in prose parentheses, followed by a sentence-ending period, and followed immediately by another link or file reference.
- **Expected**: The complete URL, including `(software)`, opens the React software article. The outer prose closing parenthesis and sentence-ending punctuation after the URL parenthesis are not part of the link. Adjacent references remain independently clickable. Nested parentheses, query/fragment parentheses and percent-encoded parentheses remain intact.
- **Coverage**: `chat-links.test.mjs`; native desktop click-through with the normal browser destination.
- **Specs linked**: `04-ux/08-component-spec.md` §8.3.

## E2E-CHAT-user-link-selection: URLs in user messages are selectable text

- **Steps**: Send `介绍一下这个项目：https://github.com/vastsa/PI-Desktop` in a user message. Drag from the start of the message past the end of the URL, then copy. Click the URL once afterwards.
- **Expected**: The selection highlights the prose and the URL together, and the copied text is the whole message including the URL. A plain click on the URL still opens it through the Link open destination.
- **Coverage**: `transcript-style.test.mjs` asserts `.chat-text-link` opts back into text selection over the unselectable `button` baseline; drag-and-copy checked in Chromium against the full renderer stylesheet (issue #1243).
- **Specs linked**: `04-ux/08-component-spec.md` §8.3.

## E2E-SESSION-temporary-attachment-fork: Preview and independent branch inputs

- **Steps**: In a task without a project, paste text above the long-paste
  threshold, send it, and click its transcript attachment. Return from the
  preview, create a branch, and open the same attachment in the child. Delete
  the source task and reopen the child attachment; branch the child again.
- **Expected**: Every preview shows the original saved bytes. Each branch path
  belongs to that branch's scratch input directory. No project is required, and
  no access to another task's scratch directory is granted. A bounded fork
  excludes later-only and unreferenced inputs.
- **Automation**: `scripts/e2e-composer-paste.mjs` covers long-text save, real
  Electron file read, temporary-task preview, and back navigation. Host tests
  `fork_preserves_referenced_pasted_files_independently` and `sessions::fork_files`
  cover ownership, deletion, repeated/bounded forks, retained checkpoint paths,
  expired inputs, rollback, and symlink rejection.

## E2E-MARKDOWN-table-actions

- **Setup**: Render a conversation containing two Markdown tables, including
  aligned columns, formatted text, Chinese text, commas, quotes, and `<br>` cells.
- **Steps**: Copy the first table; download its CSV; expand it; use copy inside
  the modal; close with Escape and with Close. Append a streamed row while the
  preview is open. Repeat the preview at a narrow width in light/dark themes
  and English/Chinese. Deny clipboard writes at the browser boundary.
- **Expected**: Actions operate only on their own table. Markdown retains inline
  syntax and alignment. CSV decodes as UTF-8 and preserves fields and line breaks.
  The modal fits the viewport, traps focus, updates streamed rows, blocks native
  work-panel surfaces, and returns focus on dismissal. Narrow previews keep short
  headers on one line and scroll horizontally with visible scrollbars on
  overflowing axes; sticky headers fully cover the
  rows behind them. Failed copies report an
  error, not success. Existing table wrapping remains intact.
- **Automated coverage**: `node --test apps/desktop/test/markdown-table.test.mjs`
  and `node scripts/test-markdown-table.mjs` after building the desktop. The
  latter mounts the production Markdown component in an isolated Electron
  window and exercises real clipboard/download boundaries. It does not call a
  model or use the user's app profile.

## Composer command source, manual compaction, and empty transcript reads (#795)

**Scope:** the composer's slash dispatch, the manual compaction RPC, and the
renderer's durable transcript reads. No real model or provider is contacted.

| Scenario | Expected |
| --- | --- |
| `/compact` typed while `composer/commands` fails | The submission is refused with `chat.slashCommandSourceUnavailable`, the draft survives, and no prompt reaches the session. The failed read is not cached, so the next submit retries it. |
| A warm command source | A builtin still dispatches locally, while a template and an unknown alias still travel as prompt text. |
| A manual compaction that outlives its transport deadline | The host re-reads the durable compaction record and reports success when a new checkpoint landed, logs the mismatch, and rethrows the timeout when none did. A verdict the sidecar reported itself is never reconciled. |
| A transcript window that reads empty for a session with history | The selection re-reads once, keeps the snapshot the user already has, and otherwise reports `chat.sessionTranscriptEmpty`; the empty page is never cached, so hover prefetch cannot re-serve it. |

**Automation:** `node --test apps/desktop/test/slash-command-source.test.mjs`,
`node --test apps/desktop/test/session-transcript-empty-read.test.mjs`,
`node --test apps/desktop/test/plugin-timeout-budgets.test.mjs`,
`pnpm --filter @pi-desktop/shared test`, and
`pnpm --filter @pi-desktop/host-runtime test`.

## E2E-CHAT-subagent-parent-error-resume

- **Preconditions**: Built agent runtime and a loopback provider fixture; real
  Agent, SDK transport, Task/TaskStop and delegate history. Host Read is a fixture.
- **Steps**: Spawn two delegates, let each finish a Read, then leave both provider
  streams active. Fail the parent request, send a later prompt with both resume
  ids, and inspect the resumed requests. Repeat with user Stop and TaskStop.
- **Expected**: Parent failure returns the session to idle; both delegates settle
  failed with SUBAGENT_PARENT_FAILED and resume with their own prior Read context.
  Explicit Stop/TaskStop produce aborted/stopped; both resume attempts are rejected
  without starting another delegate. No automatic restart occurs.
- **Specs linked**: 03-runtime/02-agent-runtime.md §5f; ADR 0279.
- **Acceptance**: C, E, Quality. **Milestone**: Maintenance.
- **Status**: Automated headless runtime/provider integration via
  `node scripts/e2e-subagent-parent-error.mjs`; no real accounts or Desktop data.
  Runtime tests separately cover exhausted parent 429 and Stop racing settlement.

## E2E-CHAT-subagent-direct-stop

- Environment: isolated Desktop profile, real Main/sidecar/Host and a local
  streaming provider fixture; no real API account or user data.
- Start two delegates, open A's detail panel and stop A. Verify B and the parent
  remain active, A's partial output remains readable, and no model request was
  needed. Stop all from the group header; B stops and the parent remains active.
- Terminal cards remove their Stop controls and persisted Task snapshots record
  `stopped`. An empty explicit ID list is rejected rather than stopping all.
- Run `node scripts/e2e-subagent-stop.mjs`. Runtime tests additionally cover
  cross-session isolation and uncooperative cancellation remaining pending;
  `e2e-subagent-parent-error.mjs` covers explicit cancellation/resume semantics.

## Regenerate archival during quit

- Regenerate a completed answer and quit as soon as the terminal event arrives.
  Restart the isolated profile: both revisions and their final messages remain
  readable, and no `host-core disposed` archival failure appears in the logs.
- Hold the archive RPC while requesting quit. Host disposal waits for successful
  archival; storage errors are logged. An unresponsive archive warns and allows
  quit after the existing two-second bounded wait.
- Automated coverage: `shutdown-regenerate-persistence.test.mjs` and
  `node scripts/e2e-regenerate-quit.mjs` (built Desktop, sidecar and host required;
  Playwright can be supplied through `PI_TEST_PLAYWRIGHT`). Only the model server
  is simulated in the Electron flow. The fixture profile and screenshots stay
  under `.artifacts/` for inspection; no user profile or paid model is used.

## E2E-COMPOSER-configured-context-window

- **Steps:** Save a 500K user context limit for a model whose catalog publishes 1M. Open the Composer model list, then send a short message and inspect context usage. Repeat with a catalog-owned limit and with discovery unavailable.
- **Expected:** The user-configured row and context inspector show 500K; a catalog-owned row follows the published limit; a configured model without discovery retains its saved context label. Model selection remains unchanged.
- **Status:** Automated unit regression in `apps/desktop/test/composer-models.test.mjs` covers user overrides, catalog inheritance, and missing discovery; the full save → picker → message → context-inspector path remains a manual validation scenario.

## Round review reader

Scenario: E2E-REVIEW-ROUNDS (local desktop, implemented)

- Preconditions: candidate JavaScript and Rust Host built; isolated temporary
  profile/data/workspace; no provider or running user instance.
- Command: `node scripts/e2e-review-history.mjs` with `PI_DESKTOP_HOST_BIN` pointing
  at this candidate's Host binary. The runner writes controlled-data preview PNGs
  under `docs/public/screenshots/review-history/`.
- Actions: create modified, newer modified and no-edit rounds through real Host
  RPC; add delegated evidence; select rounds, expand a multi-operation file,
  choose Last round/History, hover the context submenu (only 1/3/5), toggle word
  wrapping, scroll and resize, copy, attempt conflicting rollback, append a
  late delegate result, restart Host and switch sessions. Choose one context line,
  reopen Review, switch conversations and reload the renderer from the same
  isolated profile; verify both the checked menu option and actual diff context
  retain that choice. Missing/invalid/blocked storage is unit-covered by
  `apps/desktop/test/review-preferences.test.mjs`.
- With two populated sessions, visit B, then click a file in A's real transcript
  turn-summary card and return to B. The retained focus request must belong to A;
  B must immediately retain its own recorded files. Cycling Last round → History
  must leave those files unchanged rather than repair an initially empty list,
  and B's selected history totals must agree with its visible file list.
- Open several files from the per-turn summary with enough Review content to
  scroll. Each target comes into view inside Review while the conversation and
  work-panel headers stay visible and the window content reaches the bottom edge.
- Expected: latest skips no-edit rounds; delegates belong to their original user
  round; all file records are accessible; old/new numbers and bounded immutable context
  agree; one gutter uses old numbers for deletions and new numbers otherwise;
  file-type glyphs match between Review and turn summaries; both ellipsis menus
  retain trigger-relative placement across click points and fit narrow windows;
  no full after-image is cached; only the outer review scrolls; headers stick without toolbar overlap in
  normal/narrow layouts; copy and conflict protection survive; history restores.
  Toggle checks trail labels, summary dots have no circle, history options contain
  date/time plus true per-round recorded totals before the check and fit an
  arrow-safe field, including colored right-aligned totals when closed.
  The summary counts visible files rather than operation records (five records
  across four paths, including one zero-counter preview-limited file, show three
  files). Only file groups with additions or deletions greater than zero remain;
  both-zero groups are hidden and excluded from the summary, while raw Host
  evidence and each retained file's complete operation chain remain available.
  Missing/unsafe totals are not invented as zero;
  Host regressions retain saved valid counters despite binary/truncated previews.
  Expanding a long diff does not move header widths or statistics because the
  outer scrollbar gutter is reserved. File icons lead; the reserved disclosure
  immediately after the visible filename appears only on hover/focus, right when closed and down
  when expanded, with a clear gap before statistics. Numbered diff rows have no
  independent add/delete sign column.
  File headers have no idle
  fill, and no execution-root row appears. File menus disable internal open when
  the plugin is absent, open its loaded view when available, and pass the resolved
  current file and session to external open. The third action, Open folder,
  invokes system reveal without requiring a plugin (OS launch/reveal boundaries
  are stubbed). Non-workspace rows hide internal open; their remaining two actions
  exercise the real reviewed-file service and Host snapshot authentication.
  A multi-operation file has exactly one action bar and no record-number heading;
  copy contains every operation, conflicting rollback changes nothing, and a
  successful grouped rollback restores the content before the first operation.
  Scope and historical round controls reuse the shared native Select with local
  customizable-picker styles. Check light/dark palettes and live sidebar color
  changes: selected fills follow the sidebar but differ from the list base, not
  system blue. Only first-row upper and last-row lower corners are rounded;
  interior edges are square, and a single row has all four corners. Verify native
  ArrowUp/ArrowDown, Enter, Escape/focus retention and close-after-selection;
  the scope trigger is 24px high, the round field stays 28px high, and both
  vertically center their text and arrow. Round labels show date/time and recorded totals with
  reserved trigger-arrow space.
  The long-file fixture has 3100 lines with local edits: unchanged head/tail do
  not consume the LCS matrix budget, while original hunk coordinates, 1/3/5-line
  context, copy and guarded rollback still work. Byte/line/middle-cell caps remain. Absolute/outside-root labels show `.../basename`, while the title
  retains the full path; normal workspace-relative labels remain unchanged.
  A real approved outside-workspace Write is included in the historical round:
  its diff remains readable after restart, its label is `.../basename`, and it
  grants no rollback writes. Rust RPC tests cover workspace/scratch/external
  Write and Edit, same-named paths, approval denial, failed Edit, and no Bash capture.
  The visualization RPC Write → Read → Edit path starts with no visualization
  directory and checks non-reversible review evidence for both mutations.
  Ordinary operations keep that root lazy; denied redirected writes leave no
  review snapshots. Run the complete visualization suite, not only review-named
  tests, to cover the pre-existing cross-platform path contract.
  `review-file-open.test.mjs` covers missing/fuzzy paths, worktree/secondary-root
  locations, plugin unload, stale session/project results, and visible failures.
- Additional acceptance: Rust RPC tests cover over 100 turns/changes, dedup,
  invalid evidence and root isolation; context tests cover legacy, binary, resource
  budgets, additions/deletions and newline-only changes. Renderer unit tests cover
  numbered ranges, grouping and cancelled pagination. Existing review/chat/history
  tests remain required regression coverage.
- Specs: ADR 0043; runtime RPC/storage specs; component spec Round review reader.
- Milestone: maintenance. Traceability: acceptance criteria 1–9 of the approved
  native round-review enhancement map to this scenario and the tests above.

## E2E-ISSUE-2163

Bounded tail pages include compactions appended after the last message. Middle pages still read only the active checkpoint and records inside their offsets. Verify append-message/append-compaction, tail reopening and Host restart with `scripts/e2e-compaction-tail.mjs` and `layout_tail_window` tests.

## E2E-ISSUE-2164

While a checkpoint estimate supplies context occupancy, use its recorded provider/model capacity, or the current exact session binding for legacy checkpoints. Keep historical request usage unchanged. Unknown capacity is marked approximate. Verify 20,619 / 1,000,000 = 2%, unknown routes, legacy records and usage after a newer request with `compaction-context-usage.test.mjs`.

## E2E-ISSUE-2086-fork-selection

While the parent is revalidating, invoke sidebar forkSession and complete the Host response. The child becomes active/retained and selectingSessionId clears. If a newer selection supersedes a reply fork, its selection remains. Cover existing running-parent transcript and fork-error paths through session-fork-running.test.mjs.

## E2E-ISSUE-1926-scratch-prefix

Build two actual runtimes with identical configuration and different scratch directories. Their leading runtime system sections match; each trailing context retains its own path. Check PowerShell/POSIX guidance and custom system prompt behavior. Coverage: runtime.test.ts. No paid provider requests or cache-hit claims.

## E2E-ISSUE-2350: Delegation connector centers and stem endpoints

- Serve `apps/desktop` locally and open
  `test/fixtures/subagent-connector-layout.html` in a browser. This isolated
  fixture loads the production stylesheet and publishes `window.layoutResult`.
- Verify `passed: true` and an empty `errors` array across mixed-height
  70/88/112px cards, a single card, and both 760px and 420px topology widths.
  Branches meet card centers, vertical segments remain continuous and end at
  the outer branch centers, and narrow incoming lines share the stem axis.
- Repeat the rendered delegation user path with running/settled workers and
  wrapped descriptions; preserve detail navigation, Stop and responsive layout.
- Qualification: isolated Chromium geometry checks cover this layout regression;
  installed-client and live-provider checks remain separate.

## E2E-PLUGIN-transcript-selection-view

- With an opted-in plugin installed, select part of a message bubble and
  right-click. The item shows its localized title and host icon. Repeat with
  no selection, a selection outside the bubble, and the plugin disabled.
  Each of those menus omits the item.
- Choose the item on a cold view and again on an already open view. Verify the
  same docked tab receives one `view:selection` payload per click with the
  session ID and excerpt only. Escape delivers nothing. Switching sessions
  while the view is loading discards the pending excerpt.
- With a side-question plugin, verify the quote preview can be removed
  atomically and the first explicitly sent prompt contains only the excerpt
  and the new question. The main conversation and its input remain intact.

# E2E Scenarios: Live Sessions and Remote Control

> Part of the [E2E test plan](../04-e2e-test-plan.md). Live Voice, Live Work, speech, and Remote Agent Control.
> Scenario template, gates, and traceability live in the plan.

## E2E-LIVE-VOICE-gemini-work-schema

- **Preconditions:** Production Gemini adapter with a deterministic transport
  fixture and a bound work profile; no credentials or hardware devices.
- **Steps:** Start the call with a work target, accept a valid setup, unmute and
  send PCM. Reject another setup with close 1007 and a UTF-8 reason. Repeat
  with a transport error followed by close; cancel and close the adapter.
- **Expected:** Gemini sends the supported Schema subset and connects; OpenAI's
  schema and Host argument validation remain strict. Setup rejection settles
  immediately as `LIVE_PROTOCOL_ERROR`, transport errors remain network errors,
  and only one failure is reported. The raw reason reaches only the provider
  log; even the connect rejection crossing IPC contains only the public code.
  Cancellation suppresses terminal noise and close removes socket observers.
- **Specs:** `03-runtime/live-voice.md`, `09-logging-and-observability.md`.
- **Acceptance:** C, E, Security, Quality.
- **Milestone:** Maintenance, issue #1812.
- **Automation:** `live-voice-gemini-adapter.test.mjs`,
  `live-voice-service-lifecycle.test.mjs`, and voice-runtime `live/protocol.test.ts`.
- **Status:** Adapter/service contract-covered; full Electron/Gemini account and
  physical microphone acceptance remain separate and are not certified here.

## E2E-LIVE-VOICE-public-settings-and-reconnect

- **Preconditions:** A built production Renderer and real Electron/Main/Host,
  isolated data/profile/project, developer mode off, a local TLS or loopback
  HTTP Realtime fixture and synthetic microphone. For TLS, trust only the
  fixture CA in the child process; do not disable TLS, sender, sandbox or
  microphone checks.
- **Steps:** Open Live from Composer while disabled and follow Open settings.
  Find Voice through settings search, bind the fixture account, enable Live,
  connect, unmute, receive audio/captions, mute and hang up. Cancel a delayed
  startup, disconnect the provider and explicitly reconnect. Restart with the
  same isolated profile, inspect persisted settings and disable Live.
- **Expected:** Voice is reachable without developer mode. Enabling settings
  does not capture audio; the real built Renderer passes the exact main-frame
  owner check. Only the chosen account is used. Mute stops input, every end
  closes media/socket resources, and failures never trigger an automatic new
  call. Settings survive restart without reconnecting. Legacy Dictation
  settings are unchanged; a voice-only call creates no Agent session.
- **Coverage:** `pnpm test:e2e:live-voice` drives the built app and its concrete
  Realtime GA adapter against local WSS; `pnpm test:e2e:live-voice --
  --plain-http` repeats the call flow against a loopback `ws://` endpoint.
  `live-voice-websocket-endpoint.test.mjs` connects the production transport to
  a local loopback WebSocket and verifies proxy refusal; `live-voice-owner.test.mjs`
  bundles the production owner module and rejects other files/frames. Fixture
  audio is not physical-device or real-provider acceptance. Commands and
  results are recorded in
  `docs/implementation/live-voice-public-readiness.md`.
- **Specs:** [Live Voice](../../03-runtime/live-voice.md).

## E2E-LIVE-VOICE-provider-call-lifecycle

- **Preconditions:** Isolated desktop profile with Live Voice enabled and one
  fixture provider binding. Use a deterministic local protocol fixture; do not
  use a real provider account or paid endpoint for automation.
- **Steps:** Open Voice settings and confirm only Live Voice controls are
  visible; legacy Dictation toggles, microphone selection and transcription
  model controls are absent. Confirm the enabled Composer shows one Live
  preparation entry without a separate Work or old Dictation microphone button.
  Bind/select a fixture account for each supported adapter profile. In Settings
  → Shortcuts, customize the Live Voice toggle and use it to start then end a
  fixture call. Cancel a pending startup
  with the `voiceCancel` binding (default `Escape`) when no popup consumes the
  key; pressing `Escape` during a connected call must not end it. Restore the
  default, then explicitly Start from preparation, cancel during
  permission/startup, connect, mute/unmute, interrupt playback, inspect the
  in-memory transcript, and end. Repeat with Dictation already holding the
  microphone, a changed active binding, a provider credential removal, renderer
  hide/reload, and a rejected playback gesture.
- **Expected:** Live is off by default; persisted Dictation settings remain
  unchanged but are not exposed in the UI; only the selected Provider ID is used;
  secrets do not enter Renderer;
  no Agent, MCP, shell or file action runs; mute gates new input immediately;
  cancellation stops late media; the transcript is not persisted; every end
  path releases media and background-throttling leases or quarantines an
  unconfirmed microphone lease. A new call starts only after explicit user
  action.
- **Specs:** [03-runtime/live-voice.md](../../03-runtime/live-voice.md),
  [03-runtime/20-speech.md](../../03-runtime/20-speech.md),
  [04-ux/09-interaction-patterns.md](../../04-ux/09-interaction-patterns.md).
- **Acceptance:** Adapter setup and event parsing are local fixtures; Main
  lifecycle, owner, lease and settings behavior are covered by targeted tests.
  `apps/desktop/test/live-voice-shortcuts.test.mjs` covers the configurable
  toggle/cancel actions, including that Escape never ends a connected call.
  The full Electron flow and real-provider/device compatibility remain
  unverified until their respective isolated acceptance environments are run.

## E2E-LIVE-VOICE-realtime-plaintext-user-endpoint

- **Preconditions:** Isolated desktop profile with Live Voice enabled and an
  OpenAI-compatible API-key Provider whose base URL is a local plain-HTTP
  Realtime fixture such as `http://127.0.0.1:<port>/v1`. Do not use a real
  provider account.
- **Steps:** Bind the Realtime adapter to that Provider and start a call with
  `networkPolicy.mode` at its default (`relaxed`). End the call, switch the
  mode to `strict` and start again. Repeat in `relaxed` with a system proxy
  that does not bypass the fixture host.
- **Expected:** In `relaxed` mode the call connects over
  `ws://127.0.0.1:<port>/v1/realtime?model=…` and the one-time plaintext
  notice is raised. In `strict` mode, and on a proxied route, the call fails
  before any socket opens with a network-policy error. An `https` base URL
  still connects only over `wss`; Gemini never uses `ws` and Codex SDP stays
  HTTPS-only.
- **Specs:** [Live Voice](../../03-runtime/live-voice.md),
  [ADR 0304](../../../adr/0304-user-supplied-endpoint-trust.md).
- **Acceptance:** `apps/desktop/test/live-voice-websocket-endpoint.test.mjs`
  covers the scheme mapping, the user/third-party split and the refused base
  URL shapes; the network guard's `relaxed`/`strict` verdict is covered by the
  existing public-network tests. The full Electron flow remains unverified
  until its isolated acceptance environment is run.

## E2E-LIVE-VOICE-four-stage-ui

- **Title:** Disabled, preparation, compact call, and deliberate details.
- **Preconditions:** Isolated Electron profile with Live Voice initially
  disabled, deterministic local provider/media fixtures, and local work-session
  fixtures. No real account, microphone, speaker, paid endpoint, or user's
  running Desktop instance is used.
- **Steps:**
  1. Confirm neither Live nor Work Composer icon exists while disabled. Every
     account card shows only its provider picker until that account is bound.
     Enable Live Voice only from Settings → Voice; verify exactly one idle
     voice icon and that the card keeps its Model configuration link on the
     heading line beside the help mark.
  2. Open preparation and expand/collapse work options without starting. Verify
     no prepare request, microphone acquisition, media initialization, provider
     connection, or work dispatch occurs. Make the selected binding unavailable
     while another is ready: show the exact selected identity/reason, disable
     Start, and do not switch providers implicitly.
  3. With a ready binding, explicitly Start and observe Connecting plus Cancel
     in the compact bar, without automatically opening Details. Cancel while
     prepare or media acquisition is pending and deliver the late completion.
     Repeat Start to connect muted, then unmute/mute and inspect status.
  4. Open Details, inspect transcript/provider/work state, and dismiss it with
     Close, outside press, and Escape. Keep the call connected; use the bar to
     resume blocked sound, observe a rejected resume, and recover explicitly.
  5. Navigate between chat, Settings, Plugins, and sessions. The call chrome is
     a docked desktop widget window, so drag it by its own bar, verify the
     position survives that navigation and is clamped back inside the work area,
     and verify the main window draws no call bar. End or disable the
     feature with delayed Main termination and renderer cleanup, in either
     completion order. Keep Ending visible and prevent another Start until both
     settle. Exercise unconfirmed release and verify visible blocked recovery.
  6. Reopen preparation: work access and context consent are unchecked. Merely
     expanding the section or selecting a session never starts a call; Start
     without the work opt-in is voice-only. Opt into work explicitly, select a
     valid local target, and Start; inspect the fixed binding and work results
     in Details. End and reopen preparation, then change/create the target,
     opt out, or cancel and verify context consent resets. Ending Live does not
     stop already accepted work.
  7. Use the configured toggle to start a voice-only call directly and end it.
     During startup, a popup consumes Escape to dismiss itself without
     cancellation; without a consuming popup, the startup-cancel shortcut works.
     Escape never ends a connected call. Repeat visible controls in English and
     Simplified Chinese and check catalog coverage for all shipped locales.
- **Expected:** Four distinct UI states, deliberate startup and work consent,
  exact-binding readiness, default mute, global cleanup visibility, accessible
  controls and focus return, and no changed IPC, persistence or permission
  boundary. Playback and error recovery do not require opening Details.
- **Specs:** [Live Voice](../../03-runtime/live-voice.md),
  [Live Work](../../03-runtime/live-work-session.md),
  [Component spec](../../04-ux/08-component-spec.md#1171-live-voice-preparation-compact-call-bar-and-details),
  [Settings IA](../../04-ux/06-settings-ia.md#voice).
- **Acceptance:** C / E / Security / Quality.
- **Milestone:** Post-MVP experimental interaction maintenance.
- **Coverage:** Targeted controller/presentation regression tests and
  `pnpm test:e2e:live-voice-interaction` cover the mounted production controls,
  controller, store, shortcuts, i18n, cleanup ordering, work consent, and error
  recovery with simulated shell navigation and fake external edges. This does
  not mount full AppShell/settings/plugin routes or exercise a real provider,
  device, permission prompt, or audio output.
- **Status:** Task-candidate fixture passed 48/48 interaction checks. Full
  AppShell, real-provider, and device compatibility remain unverified.

## E2E-LIVE-WORK-session-admission

- **Preconditions:** Isolated Live provider fixture, Desktop/Native Pi/Remote
  session catalog fixtures, and a deterministic fake intent resolver. Provider
  candidates enter through the existing Live adapter callback; do not use a
  real account or paid endpoint.
- **Steps:** Start a call from a Composer with an active Desktop session and
  verify that session is the default target without a work-access checkbox or
  pre-call voice selection. Repeat with Native Pi and Remote Composer sessions.
  Start with no current session and verify the call remains unbound until the
  user lists sessions and chooses one by voice. Reject missing and duplicate
  session identities. With context sharing disabled, submit one work request
  and verify no history read; then test the separate bounded-context consent.
  Switch targets by voice during a call, submit before and after the switch, and
  verify the two operations remain associated with their respective sessions.
  Deliver each receipt, route through the classifier, and inspect backend
  admission and `voiceOrigin`. Exercise backend-specific queue/steer/stop
  capabilities, approval denial, stale turn, offline Remote Host, and a
  terminal event arriving before submit resolves. Query an exact terminal
  result without creating another Host turn. Request project/session lists,
  verify labels and opaque call-scoped references, then test opening and
  creating only through their existing panel actions. With a submission
  waiting on the user, confirm the compact bar keeps a waiting line and
  Details shows the pending ask question with an action that opens that exact
  session; verify another session's pending request stays unattributed. Then
  answer the open asktool question by voice and confirm the session's card
  resolves through the Host input path; retry with a label the question never
  offered, with a partial answer, and with two open questions, and confirm each
  is refused without a write and without being retried.
  Exercise feedback while
  generation, user speech, and playback are active; finish by ending Live after
  Host admission.
- **Expected:** The initial target is the current Composer session when present;
  voice switching affects subsequent requests only. Main validates each target
  against a fresh multi-backend catalog, and ambiguity/unavailability fails
  closed. Context reads occur only after independent consent and remain bounded
  to the current target. Each backend retains its own admission, permission,
  approval, and capability rules; unsupported operations and offline targets
  are reported honestly. Duplicate provider IDs do not dispatch twice,
  terminal state comes from authoritative backend events, result queries project
  only the exact operation summary, and ending Live does not cancel accepted
  work. Selection references expose no raw paths or IDs and remain call-scoped.
  Automatic feedback and task execution remain separate; a renderer signal is
  not evidence that a person heard the result.
- **Coverage:** `apps/desktop/test/live-work-scope.test.mjs` covers the fresh
  Desktop/Native Pi/Remote catalog, source-specific prompt/stop/queue routing,
  offline Remote failure, initial Native/Remote event subscriptions without a
  local AgentHost bridge, project/workspace identity, opaque refs, and
  ambiguous-target rejection. `apps/desktop/test/live-voice-ipc-media.test.mjs`
  covers separate target/context consent and rejects raw operation/session/turn
  IDs. `apps/desktop/test/live-voice-service.test.mjs` covers owner-scoped
  stop/cancel routing by call and operation IDs. `packages/host-runtime/src/live-work/coordinator.test.ts`
  covers receipt ordering, routing, stale steer, replay, call close, target
  switching, exact-turn stop and old-session queue cancellation. `packages/host-runtime/src/live-work/context.test.ts`
  covers bounded context projection. `packages/agent-host/src/agent-host.test.ts`
  covers history-free state, queue insertion, and voice provenance.
  `packages/voice-runtime/src/live/protocol.test.ts` covers provider-specific
  tool declarations and receipts. `packages/host-runtime/src/live-work/result-summary.test.ts`
  covers exact-turn summary projection and honest fallbacks. The
  `LiveWorkFeedbackScheduler` tests cover debounce, speech spacing, silent
  mode, stale downgrade, deduplication, and overflow; desktop service tests
  cover provider/user/local playback gating and separate delivery status.
  `apps/desktop/test/live-work-scope.test.mjs` covers selection reference
  scope/expiry, and `live-work-operations.test.mjs` covers the panel actions.
  `apps/desktop/test/live-work-decision.test.mjs` covers the waiting-decision
  projection, its session scoping, bounded plain-text rendering and the panel
  action that opens the bound session.
  `packages/host-runtime/src/live-work/ask-answer.test.ts` covers the spoken
  answer intent and its routing (resolved, refused, unknown and never resent),
  and `apps/desktop/test/spoken-answer.test.mjs` covers the option-only
  matching, the bounded read-out and the delivery budget.
  `voice-runtime/src/live/playback-monitor.test.ts` covers local audio signal
  detection. This is targeted automated coverage, not the complete
  W2-001—W2-096 matrix or real-provider E2E.
- **Status:** Partial; remaining scenarios and the real-device matrix are
  tracked in `docs/implementation/live-work-evidence.md`.
- **Specs:** [live-work-session](../../03-runtime/live-work-session.md),
  [live-voice](../../03-runtime/live-voice.md).

## E2E-LIVE-WORK-v2.1-reliability

- **Preconditions:** An isolated local Host session, fixture classifier
  completion, and fake runtime/provider I/O. No real account, user project, or
  running Desktop instance is used.
- **Steps:** Capture a null/active target at provider ingress and delay
  classification; race a validated stop against ordinary classification; make
  Host dispatch stay unresolved, then return exact read-only admission
  evidence; deliver terminal before the write acknowledgement; close Live
  during dispatch; change the authorized workspace before AgentHost admission;
  enqueue independent work; delay final assistant persistence; query the task
  result after a stop control operation.
- **Expected:** Stale/null targets never become later turns. A stop barrier
  withdraws earlier writes that have not crossed admission. Explicitly busy
  ordinary submits do not silently enter the queue. Host uncertainty is shown
  as unknown and reconciled without a second write. Terminal evidence cannot
  revive or be overwritten by a late acknowledgement. Workspace mismatch
  creates no turn or queue item. Idle explicit queue entries drain through
  AgentHost; restored held entries remain held. A result query returns only an
  exact task result, not an admission or stop acknowledgement.
- **Coverage:** `packages/host-runtime/src/live-work/coordinator.test.ts`,
  `packages/host-runtime/src/live-work/operation-ledger.test.ts`,
  `packages/agent-host/src/agent-host.test.ts`,
  `apps/desktop/test/live-work-production-composition.test.mjs`, and
  `apps/desktop/test/agent-host-bridge-work-ack.test.mjs`. The production
  composition fixture instantiates the Live Work bridge, AgentHost bridge,
  registered `agentPrompt` handler, and real AgentHost; Host-core persistence,
  concrete provider adapters/transports, and real device journeys remain
  outside that test boundary.
- **Status:** Automated coverage is partial and is recorded per case in
  `docs/implementation/live-work-v21-coverage.md`. Real device acceptance is
  not run.
- **Specs:** [live-work-session](../../03-runtime/live-work-session.md),
  [live-voice](../../03-runtime/live-voice.md).

## Remote Agent Control target scenarios (post-MVP)

The following scenarios require the approved remote harness. They are
documented now so the protocol and security work has an explicit acceptance
target. Do not run them against a local desktop or a production Gateway unless
the request explicitly authorizes that environment. D374 amended every
scenario in this section to the revised contract: `{ epoch, sequence }`
cursors, ephemeral deltas, the Host-owned turn queue, the full local approval
vocabulary, the remote permission ceiling, the Host link relay, and the
browser cookie profile. D375 re-sequenced the milestones: E2E-231 and
E2E-232 are the acceptance targets of the scheduled SSH-tunnel and
integration milestones, while E2E-227 and E2E-228 run when the Gateway and
browser milestones are scheduled.

## E2E-221: RACP initialization negotiates capabilities and policy

- **Preconditions**: A test Agent Host and an authenticated client support
  `RACP-WS` v1. The Host has one visible idle Session and a configured
  `remoteMaxPermissionMode` and `approvalLifetimeMs`.
- **Steps**: 1) Connect without initialization and send a request. 2) Send
  `connection/initialize` with supported bindings and the `turnQueue`,
  `hostEvents`, and `history` capabilities. 3) Send
  `notifications/initialized`. 4) Repeat with an unsupported major version.
  5) Call `host/list` on the direct Host connection.
- **Expected**: Pre-initialization requests are rejected; the valid handshake
  returns the negotiated protocol, connection id, principal roles, limits
  including `maxQueuedTurnsPerSession` and `replayWindowEvents`, the
  advertised capabilities, and the informational `policy` block; the
  unsupported major version returns `PROTOCOL_MISMATCH`; `host/list` returns
  `METHOD_NOT_FOUND` because no Gateway is present.
- **Specs linked**: `03-runtime/19-remote-agent-control-protocol.md` §3 and
  §7.7, `05-security/02-remote-control-security.md` §3
- **Acceptance**: Security, Quality
- **Milestone**: Post-MVP
- **Status**: Draft; remote harness required

## E2E-223: Reconnect replays durable events or resynchronizes by epoch

- **Preconditions**: A turn is producing at least five durable events and a
  long streaming assistant message; the harness can close and reopen the
  client connection and restart the Host.
- **Steps**: 1) Record the last applied cursor. 2) Disconnect in the middle
  of a streaming message. 3) Reconnect and subscribe with `after`. 4) Repeat
  after evicting the cursor from the bounded replay window. 5) Restart the
  Host during an idle period and reconnect with the old cursor. 6) Repeat
  step 3 over `RACP-HTTP` using `Last-Event-ID` in the `epoch:sequence` form.
- **Expected**: A retained cursor replays every later durable event exactly
  once and no delta; the snapshot's `activeItems` carry the text streamed
  before the disconnect; an evicted cursor returns `resync.required` with a
  complete snapshot; a cursor from the previous epoch returns
  `CURSOR_EXPIRED` and a snapshot with a new epoch; a durable gap never causes
  the client to guess or apply out-of-order state; and the SSE path behaves
  identically.
- **Specs linked**: `03-runtime/19-remote-agent-control-protocol.md` §§5.3,
  5.4, 7.2, and 8, `02-architecture/05-remote-agent-control.md` §8
- **Acceptance**: Recovery, Quality
- **Milestone**: Post-MVP
- **Status**: Draft; remote harness required

## E2E-224: Remote approvals carry the local vocabulary and stay host-owned

- **Preconditions**: A Session policy requires a tool approval; the fixture
  Agent submits a Plan and asks one multi-select asktool question in the
  same run; Host policy allows remote session grants; a second Session is
  configured with `permissionMode: "auto"` and the Host ceiling is `ask`.
- **Steps**: 1) Start the turn from a controller. 2) Observe the tool
  approval request. 3) Attempt a decision from a viewer, then with a stale
  revision. 4) Resolve from an authorized approver with `allow-session`.
  5) Attach a third client after the Plan approval is raised and read its
  snapshot. 6) Resolve the Plan with `approve` and no `permissionMode`, then
  with `permissionMode: "accept-edits"`. 7) Answer the input request with one
  multi-select answer and one `null`. 8) Repeat step 4 after expiry.
  9) Start a turn on the `auto` Session from a controller without `approver`.
- **Expected**: The viewer and stale responses fail closed with `FORBIDDEN`
  and `APPROVAL_STALE`; `allow-session` resumes the turn and a later call of
  the same tool in that Session needs no approval; the late client's snapshot
  lists the pending Plan approval; the mode-less approve is rejected and the
  explicit one queues execution in Agent mode with `accept-edits`; the
  desktop's own approval card closes when the remote decision lands; the
  asktool answers reach the Agent as the local `AskToolResolution`; expiry
  returns `APPROVAL_EXPIRED` and never executes the tool; and the `auto`
  Session turn reports `effectivePermissionMode: "ask"` and raises an approval
  while the durable session mode stays `auto`.
- **Specs linked**: `03-runtime/19-remote-agent-control-protocol.md` §§5.5,
  7.3, 7.5, and 9, `05-security/02-remote-control-security.md` §§4 and 7,
  `03-runtime/10-session-state-machine.md`
- **Acceptance**: E (tools & permissions), Security, Recovery
- **Milestone**: Post-MVP
- **Status**: Draft; remote harness required

## E2E-226: Roles, scopes, and revocation are enforced

- **Preconditions**: One tenant, two Hosts, two Sessions, and principals with
  viewer, controller, approver, and owner roles exist. A multi-tenant harness
  profile, when available, adds a second tenant.
- **Steps**: 1) Try every catalog operation, including `session/history`,
  `turn/cancel`, and host-scope `events/subscribe`, with each role.
  2) Substitute a Session, Host, and approval id from the other Host, and
  from the other tenant when the multi-tenant profile is active. 3) Queue a
  turn as a controller, then revoke that principal and retry its existing
  connection.
- **Expected**: The role matrix is enforced, including the `allow-session`
  policy row; foreign identifiers return `FORBIDDEN` or `NOT_FOUND` without
  existence leakage; revocation closes the connection, blocks new mutations,
  and cancels the revoked principal's queued turn; and audit records identify
  the denied principal without recording prompt or secret content. The
  cross-tenant cases are required only under the multi-tenant profile.
- **Specs linked**: `05-security/02-remote-control-security.md` §§3–9 and
  §11, `03-runtime/19-remote-agent-control-protocol.md` §§6 and 13
- **Acceptance**: Security, Quality
- **Milestone**: Post-MVP
- **Status**: Draft; remote harness required

## E2E-227: The Host link relays clients behind inbound firewall/NAT

- **Preconditions**: The Agent Host runs behind a test firewall that rejects
  inbound connections. The Gateway is publicly reachable by two test clients.
- **Steps**: 1) Enroll the Host with a one-time credential. 2) Establish the
  outbound mTLS Host link. 3) Attach both clients and run a turn that raises
  a tool approval. 4) Answer the relayed server request from the client that
  received it, then attempt to answer it again from the other client.
  5) Upload an attachment through the Gateway upload target and reference it
  from a turn. 6) Drop the link and allow it to reconnect. 7) Revoke the Host
  and attempt re-enrollment with the old credential.
- **Expected**: No inbound desktop port is opened; the Gateway routes only to
  the authenticated Host; the approval request is delivered on exactly one
  logical connection and the second answer returns the stored result with
  `alreadyResolved`; attachment bytes cross the link in bounded chunks, the
  Host verifies the hash, and the Gateway's copy is gone after
  `attachment/complete`; local execution continues across the link
  interruption and both clients resume from resumable cursors; reconnect does
  not duplicate the turn; and the revoked credential cannot re-enroll.
- **Specs linked**: `02-architecture/05-remote-agent-control.md` §5.3,
  `03-runtime/19-remote-agent-control-protocol.md` §§10 and 11.4,
  `05-security/02-remote-control-security.md` §§3.2 and 6,
  `06-delivery/07-remote-control-rollout.md` §2
- **Acceptance**: Security, Recovery, Quality
- **Milestone**: Post-MVP
- **Status**: Draft; unscheduled until the Gateway milestone is scheduled (D375)

## E2E-230: Failure recovery does not replay admitted work

- **Preconditions**: A deterministic Host, Gateway, and client can inject
  process, link, and response-loss failures; one turn is running and two are
  queued.
- **Steps**: 1) Drop the response after `turn/start` is admitted. 2) Retry
  with the same idempotency key. 3) Crash the Host during the running turn.
  4) Restart the Host and reconnect from the last cursor. 5) Drop an approval
  response after it is accepted and retry it.
- **Expected**: The first retry returns the original turn; execution occurs
  once; Host recovery marks the interrupted turn according to the local
  recovery policy; the reconnect receives a new epoch and a snapshot whose
  queue is empty, and neither queued turn is started or replayed; no
  completed item is replayed as a new turn; and the retried approval returns
  the stored decision with `alreadyResolved` without executing twice.
- **Specs linked**: `02-architecture/05-remote-agent-control.md` §10,
  `03-runtime/19-remote-agent-control-protocol.md` §§7–8 and 9.3,
  `06-delivery/07-remote-control-rollout.md` §4
- **Acceptance**: Recovery, Security, Quality
- **Milestone**: Post-MVP
- **Status**: Draft; remote harness required

## E2E-REMOTE-MVP: Legacy remote Agent compatibility

- **Preconditions**: Current Desktop and complete same-platform Host bundle,
  isolated data/profile, and a loopback mock model. No production credentials.
- **Steps**: Copy an explicitly selected eligible provider and repeat the copy;
  pair, register a project, create/open an Agent/Ask session and send text. Drop
  the client connection while a real Bash approval is pending, reconnect and
  approve once. Read the resulting transcript/file/diff, reject a path outside
  the project, remove the host and attempt another prompt.
- **Expected**: Import preserves the default and is idempotent. The command and
  turn execute once, in the Host project only; stale routing never falls back
  locally. Snapshot recovery restores pending requests and clears peer-resolved
  cards. Local workspace/model state is unchanged.
- **Compatibility coverage**: Existing remote Agent session routing remains
  covered by `remote-mvp-renderer.test.mjs`; the Settings inventory exposes no
  session-list or new-session controls. New projects follow E2E-REMOTE-HOME.
- **Automation**: `scripts/e2e-remote-mvp.mjs` (packaged Host, real Rust/Agent
  runtime and Desktop main routing, mocked model); `scripts/e2e-remote-mvp-ui.mjs`
  (real components, mocked IPC). Neither is a full SSH/Desktop acceptance result.
- **Status**: Automated narrow-MVP scenario. Linux `sshd`, release download,
  password authentication and full R2 remain separately gated by E2E-231.

## E2E-REMOTE-HOME: Create and continue a remote workspace as a local project

- **Preconditions**: Isolated Desktop profile, connected Host directory fixtures,
  a local provider fixture, and local/remote directories with the same basename.
  No user profile, production host, credentials or paid model calls.
- **Steps**: Open Settings → Remote Hosts and click **New project** on the
  intended host. Confirm the shared Create project dialog has Remote selected
  and that host preselected. Browse through a separate folder dialog,
  cancel/reopen, navigate parent/child and confirm a directory. Enter a custom
  name, create, rename and reopen the project. Start a normal local chat, choose
  a local model and send a request that invokes Read and Bash remotely. Approve
  locally, cancel a command, disconnect/reconnect and retry explicitly.
- **Expected**: Focus and drafts survive picker cancellation. Late host responses
  cannot replace the current host selection. Project metadata and sessions are
  local and stable after reload, including name/memory/instructions and ordinary
  sidebar/archive operations. Model requests and provider secrets never appear
  in remote transport. Only locally admitted workspace tools execute on Host.
  Equal paths on two hosts or on Desktop never collide. Failed calls never
  execute locally or replay automatically. Existing remote histories remain readable.
- **Specs**: `02-architecture/05-remote-agent-control.md`, `04-ux/01-ui-ia.md`,
  ADR `local-agent-remote-workspace-tools`.
- **Acceptance / milestone**: Local Agent remote-workspace execution; additive
  project KV metadata and authenticated workspace-tool endpoints.
- **Automation**: `remote-project-dialog-user-path.test.mjs`,
  `remote-workspace-tools.test.mjs`, host-core remote project/relay tests,
  pi-host workspace-tool tests and Agent runtime remote-workspace tests;
  `PI_HOST_CORE_BINARY=<candidate binary> node scripts/e2e-local-agent-remote-tools.mjs`
  runs a local model fixture through production Desktop relay, WebSocket RACP
  and real Rust Read/Bash execution, asserting zero remote providers, projects
  and sessions. Both local and remote Rust Hosts are real; the model service
  and the fixture's user approval action are controlled test boundaries.
- **Status**: Candidate implementation; real SSH release validation remains the
  separately provisioned E2E-231 scenario.

## E2E-231: The desktop drives a remote Host over an SSH tunnel

- **Preconditions**: A Linux test machine runs `sshd` and holds a project
  the desktop can reach with the user's SSH key. A GitHub Releases fixture
  serves the `pi-host` bundle for that platform at the desktop's version, a
  bundle at another version, and a tampered bundle with a wrong checksum.
  The desktop has one local session open, one user MCP server configured,
  and one installed plugin whose tool requires workspace access.
- **Steps**: 1) Add the remote machine from the desktop and let the uploaded
  bootstrap script download, verify, and start `pi-host` over SSH.
  2) Observe the pairing exchange and the resulting device token. 3) Create a
  session under a remote project through `project/list` and
  `session/create`. 4) Start a turn whose fixture reads, edits, and runs a
  command in the remote project, and approve the command from the desktop
  card. 5) Switch the session to Plan mode and back with `session/configure`
  while idle, then attempt it while a turn runs. 6) Open the files tab and the
  diff tab for the remote session. 7) Advertise relay from the desktop, run a
  turn that calls the desktop MCP tool, then close the desktop during a
  second call. 8) Kill the SSH session mid-turn, restore it, and let the desktop
  reconnect. 9) Inspect the remote tool catalog. 10) Attempt to connect from a
  non-loopback address on the remote machine, then with a reused pairing token.
  11) Point the bootstrap at the tampered bundle, then at the other version,
  and reconnect.
- **Expected**: Files change only on the remote machine and the command runs
  there; the approval card appears in the desktop with the local vocabulary;
  the remote host-core binds loopback only; `session/configure` succeeds while
  idle and returns `CONFLICT` while running; files and diff come from the
  remote session root and a path outside it returns
  `PATH_OUTSIDE_WORKSPACE`; the desktop MCP tool executes on the desktop and
  its result reaches the remote transcript, while the second call fails with
  `TOOL_FAILED` and the turn continues; reconnect resumes by cursor without a
  duplicate. The remote catalog lists the relayed MCP tool but not the
  workspace-requiring plugin tool. Non-loopback peers and reused pairing tokens
  are rejected. Tampered bundles are refused before start; SSH login failures
  are surfaced safely; version mismatch offers a matching-release recovery.
  The local session is untouched throughout.
- **Specs linked**: `02-architecture/05-remote-agent-control.md` §§5.2 and
  6.3, `03-runtime/19-remote-agent-control-protocol.md` §§6.2, 9.4, and
  11.1, `05-security/02-remote-control-security.md` §§3.4, 4.3, 5.1, and 7,
  `06-delivery/07-remote-control-rollout.md` §2
- **Acceptance**: E (tools & permissions), Security, Recovery, Quality
- **Milestone**: Post-MVP (rollout R2)
- **Status**: Draft; remote harness with a Linux SSH target required

## E2E-REMOTE-SSH-OPTIMIZATION: Verified deployment, local Agent and recovery

- **Preconditions**: Isolated Desktop profile and a Linux x64/arm64 SSH target
  with `sshd`, POSIX shell, archive/hash tools and kernel `flock`; no system Node,
  systemd, public listener, production credential or paid model. A controlled
  release fixture serves a matching Host archive and digest.
- **Steps**: Install through SSH with remote download; repeat bootstrap and verify
  immutable installed files are reused. In a separate isolated account, block
  remote release access and verify one bounded Desktop-download/SSH-upload path.
  Corrupt the archive and alter an installed file; verify integrity failures do
  not fall back or replace a working install. Reboot/kill the Host and repeat
  readiness; rotate Host identity and revoke a device token. Create a local
  project bound to the remote workspace, use local model credentials and remote
  `AGENTS.md` with local global instructions, then run Read and permissioned Bash.
  Drop SSH during Write and inspect the remote file before any manual retry.
  Exercise offline project browsing and the Settings connection status labels.
  Repoint the fixture release so the paired Host no longer matches the desktop,
  then select a remote folder and verify the Host is realigned over the same
  verified install, re-paired in place and connected without removing it.
- **Expected**: Bundled Node starts the Host without a system Node or remote
  release access. Reuse validates the external release receipt and installed
  manifest; failed staging leaves the previous `current` intact. Daily readiness
  starts/reuses the same Host without re-pairing, resetting credentials, killing
  another client’s Host or replaying tools. Identity/authentication failures stop
  automatic retry. Local model requests, API keys, sessions and permissions stay
  local; workspace tools/files and root-only repository instructions come from
  the remote canonical root. A lost mutation reply reports
  `REMOTE_MUTATION_OUTCOME_UNKNOWN` and is not replayed or executed locally. A
  Host that falls behind the desktop release is realigned over the same verified
  install and re-paired in place — once per release per host, and again on an
  explicit user reconnect — while a Host that still cannot serve this desktop
  keeps the upgrade message instead of looping or dropping the pairing.
- **Automation**: `remote-host-realign.test.mjs`,
  `remote-host-supervisor.test.mjs`, SSH bootstrap shell,
  packaging, artifact transfer, concurrent readiness/auth lifecycle and UI
  contract suites; `PI_HOST_CORE_BINARY=<candidate binary> node
  scripts/e2e-local-agent-remote-tools.mjs` covers local model/instructions
  through real loopback RACP and Rust Read/Bash, but is not SSH qualification.
- **Acceptance**: Security, Recovery, Quality; release remains gated on the
  real Linux SSH run and a new matching Desktop/Host release. This scenario does
  not claim reverse-relay, interactive-terminal or complete R2 acceptance.
- **Status**: Candidate implementation; Linux SSH and release qualification
  pending.

## E2E-REMOTE-HOST-ssh-password-authentication

- **Preconditions**: Settings → Remote Hosts is available with its Experimental
  badge, independently of developer mode. A Linux test machine runs `sshd` with
  `PasswordAuthentication yes` and `PubkeyAuthentication no`, so the login is
  only reachable with a password; the user's local SSH agent holds no usable key
  for it. A GitHub Releases fixture serves the `pi-host` bundle for that platform
  at the desktop's version. A second machine accepts the user's key only.
- **Steps**: 1) In Settings → Remote Hosts, open the Add form's SSH tab, choose
  a local private-key file in key mode, and confirm its path is displayed. Cancel
  a second file selection and confirm the existing choice remains; select the
  same file again and confirm it can be reselected. Clear the selection once to
  confirm the SSH agent/config fallback is available, then choose the key again.
  2) Switch the authentication mode to password, confirm the identity-file
  picker is replaced by a masked password field, and reveal it once.
  3) Try to submit an empty password. 4) Point the form at the
  password-only machine, enter the password, and bootstrap it.
  5) Quit the desktop, relaunch it, and let the host reconnect.
  6) Change the saved password to a wrong value through a re-pair, then force a
  reconnect. 7) Bootstrap the key-only machine with a password supplied.
  8) Inspect the desktop's process arguments and `remote-hosts.json` while a
  password-authenticated host is connected. 9) Attempt to submit a password
  containing a newline through the IPC channel directly.
- **Expected**: Key mode lets the user choose a local identity file; its path
  is read-only in the form and is passed to the existing `ssh -i` flow. The app
  never reads or uploads the key contents. Cancel preserves the prior choice, the
  same file can be selected again, and Clear returns to SSH agent/config lookup.
  The key-authenticated SSH behavior remains unchanged: `BatchMode=yes` and no
  credential file anywhere. In password mode the picker is replaced by a masked
  password field, the reveal toggle shows and re-hides the value, and an
  empty password keeps the submit disabled. The password-only machine installs
  and pairs. After the relaunch the host reconnects with no prompt, proving the
  saved credential is used. The wrong password yields exactly one failed attempt
  per connect (no helper-driven retry storm) and the host shows as offline rather
  than crashing the app or showing a rejected-login dialog. The Settings toast
  carries ssh's last stderr line (for example `Permission denied`), not a bare
  exit code 255. The key-only machine fails under password mode because that
  mode sets `PubkeyAuthentication=no`; a user with a key picks key mode. No
  `ssh` argument contains the password, no askpass file or directory remains
  after the connect completes, and the on-disk record stores the password only
  as keychain ciphertext — never in cleartext. A password containing a newline
  is refused with `INVALID_ARGUMENT` before any remote command runs.
- **Specs linked**: `05-security/02-remote-control-security.md` §§3.4 and 13
  (gate 21), `02-architecture/05-remote-agent-control.md` §5.2,
  `06-delivery/07-remote-control-rollout.md` §2
- **Acceptance**: Security, D (surfaces), Quality
- **Milestone**: Post-MVP (rollout R2b)
- **Status**: Draft; remote harness with a password-only Linux SSH target
  required. The chooser control is covered by
  `apps/desktop/test/settings-remote-hosts.test.mjs`; the SSH credential seam is
  covered offline by `apps/desktop/test/remote-host-ssh-password.test.mjs`.

## E2E-REMOTE-HOST-settings-compact-inventory

- **Preconditions**: The desktop Settings window can open. No paired remote
  host is required. Developer mode is off in persisted settings. The isolated
  renderer harness can return a successful pair result without network access.
- **Steps**: 1) Open Settings with developer mode off and confirm Remote Hosts
  and its search hits are available. 2) Open the page and confirm the rail and
  title carry the Experimental badge. 3) Confirm the SSH and Pair action row is
  above the inventory and neither dialog is open. Open SSH; verify the dialog is
  named, modal, and focuses its first field. Cancel and confirm focus returns to
  SSH. Open Pair, submit the fixture pairing form, and confirm success closes
  the dialog and clears the draft. Change language and confirm action labels
  update. Reopen Pair, enter a draft, cancel, and confirm the dialog closes and
  the draft clears. Open SSH password mode, enter a fixture password, cancel,
  reopen, and confirm the password is empty. Press Escape and verify the dialog
  closes and focus returns to SSH. 4) Toggle developer mode and confirm the
  destination stays selected and available. 5) On a paired SSH host, open the
  historical sessions browser and verify model-copy and remote-create controls
  are absent. New workspace creation stays on Home.
- **Expected**: Experimental availability is consistent across packaged and
  development builds. Add actions precede inventory; the forms open in the
  shared modal surface, one at a time. Cancel, Escape, backdrop dismissal, and
  successful submission close the dialog and clear drafts; focus returns to the
  initiating action. Existing pairing toasts remain. The inline browser
  preserves existing remote histories; new SSH workspace projects use the
  local model and project controls from Home.
- **Specs linked**: `04-ux/06-settings-ia.md` §1, §3,
  `06-delivery/07-remote-control-rollout.md` §2 R2,
  `02-architecture/05-remote-agent-control.md` §5.2
- **Acceptance**: D (surfaces), Quality
- **Milestone**: Post-MVP (rollout R2b)
- **Status**: Offline coverage in `settings-remote-hosts.test.mjs` and
  `remote-mvp-renderer.test.mjs`; isolated Electron/Chromium interaction coverage
  in `scripts/e2e-remote-mvp-ui.mjs`, including disclosure, success and cancel
  paths. Real SSH acceptance is separate.

## E2E-232: The outbound messaging integration relays events and commands

- **Preconditions**: A Host runs with the integration adapter configured
  against a webhook sink and a long-polling bot fixture, with one linked chat
  and one unlinked chat. No inbound port is open on the Host machine.
- **Steps**: 1) Run a turn to completion. 2) Start a turn that raises a tool
  approval and leave it pending. 3) Send the stop command from the linked
  chat during a running turn. 4) Send the same command from the unlinked
  chat. 5) Make the webhook sink return errors for one minute, then recover.
  6) Inspect every payload delivered.
- **Expected**: The sink and the bot receive redacted summaries of
  `turn.completed` and `approval.requested` with ids and bounded summary
  text only; the linked chat's stop maps to `turn/stop` under the linked
  principal's roles and the turn ends at the next boundary; the unlinked
  chat's command has no effect and is audited; delivery failures are retried
  within the bound and never delay or block the turn; and the Host opens no
  listener.
- **Specs linked**: `02-architecture/05-remote-agent-control.md` §4,
  `06-delivery/07-remote-control-rollout.md` §2 (R3),
  `05-security/02-remote-control-security.md` §10
- **Acceptance**: Security, Quality
- **Milestone**: Post-MVP (rollout R3)
- **Status**: Draft; integration fixture required

## E2E-REMOTE-FILE-MANAGER: Scoped remote plugin reads

Run `node scripts/e2e-remote-file-manager.mjs` to validate the shipped copy in
`apps/desktop/resources/plugins/pi.file-manager`. This is the release acceptance
path: passing against a separate development plugin does not prove the bundled
user path is repaired. The runner records the loaded directory in its output.
An optional `<built-file-manager-directory>` argument selects the companion
plugin's rebuilt `views/` or unpacked official PluginPack artifact for development
validation only. Before accepting #1711, update the bundled release, its upstream
tag/commit and per-file checksums, then rerun the default path on the updated PR
integration candidate.

A development integration may exercise a Desktop hotfix in that actual bundled
directory, with its immutable source commit, local patch and artifact checksums
recorded honestly in `UPSTREAM.md`. A passing hotfix journey does not claim that
the companion upstream release or the maintainer's final acceptance is complete.
`PI_FILE_MANAGER_QA_DIR` may point to an existing plugin `tests/electron`
installation providing Playwright; `PI_ELECTRON_BINARY` selects an existing
compatible Electron runtime. `PI_E2E_ARTIFACTS` optionally preserves screenshots.

The isolated production plugin process and `file://` view use Desktop's actual
SDK broker, durable-binding reader, loopback RACP transport and Host filesystem
service. Only the fixture's project-record lookup and authentication bootstrap
are supplied by the harness. The remote fixture root is registered explicitly
outside the Host folder picker's browse root. Verify nested listings,
text/image bytes, hidden credentials, read-only editor/save/menu controls,
visible disconnect errors and refresh recovery, rejected late previews and
ancestor opens after a project switch, and restored local
editing/Browser/editor detection. No model, user profile or external SSH server
participates. Real SSH transport and native Windows/Linux behavior require
their separate platform acceptance.

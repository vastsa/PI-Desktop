# E2E Scenarios: Plans, Goals, Modes, and Automations

> Part of the [E2E test plan](../04-e2e-test-plan.md). Plan mode, goals, user-defined modes, and scheduled tasks.
> Scenario template, gates, and traceability live in the plan.

## E2E-SCHEDULED-independent-loading-and-route-return

- **Preconditions:** Synthetic tasks; controllable task, latest-run, history and
  project API responses. No provider execution is required.
- **Steps:** Hold latest-run and project reads while resolving task definitions;
  select a task and run, leave and re-enter with refresh held; open Create/Edit;
  fail and retry a history read; switch tasks while a previous history is held;
  invalidate the Host lifecycle before an old read resolves.
- **Expected:** Definitions appear independently. Route return immediately shows
  the last successful in-memory task/outcome/history snapshot and selection.
  Project options are requested only for editing; the form waits for successful
  options and failures expose retry. Pending/failed run reads never say the task
  has not run. Failed refresh retains known history, and late responses cannot
  replace another task's data or repopulate an invalidated snapshot. Run now and
  Delete require known run status and retain authoritative Host admission.
- **Coverage:** `apps/desktop/test/scheduled-workspace-loading.test.mjs` exercises
  the production hook with controlled API promises and poll ticks;
  `scheduled-workspace.test.mjs` checks rendered loading/error states.
  These are renderer regression checks, not a native Electron E2E run.

Also invalidate the Host while Create/Edit options are pending, with the old
request resolving, rejecting or remaining pending. The next normal poll must
replace that read and recover the same editor without Cancel/reopen. A failed
replacement exposes Retry; retry success mounts the editor. Old responses must
not overwrite recovered options. Successful options remain lazy rather than
being fetched on every subsequent poll.

## E2E-SCHEDULED-settings-switch

- **Preconditions:** Candidate Desktop, Host and reused local dependencies;
  isolated profile/data/project and the local scheduled-model fixture.
- **Steps:** With a saved task, open Settings → Behavior, observe the default-on
  Scheduled tasks switch, turn it off, return to the app and search.
  Reload the renderer, verify the saved off state, re-enable and run the task.
- **Expected:** The footer and page-search entry disappear while off; the
  settings row remains searchable. New runs are rejected, task configuration
  and history survive, reload preserves the choice and re-enabling restores
  the same task and normal execution. Host tests also cover due admission,
  stale tools, restart and completion of an already-admitted run while off.
- **Coverage:** `node scripts/e2e-scheduled.mjs --settings-switch-only`,
  `apps/desktop/test/scheduled-settings.test.mjs`, Host scheduled settings tests.
- **Specs:** `04-ux/06-settings-ia.md`, `04-ux/01-ui-ia.md` §3.3.
- **Acceptance:** No data/schema migration; default-on backwards compatibility.
- **Milestone:** Maintenance. **Status:** Automated.

## E2E-SCHEDULED-desktop-automation-lifecycle

- **Additional coverage:** Shared model/reasoning root menu, searchable model submenu,
  keyboard model selection, selecting and reopening `high`, unchanged application
  defaults, and the saved thinking level on the executed session.

- **Preconditions:** Isolated desktop profile, built task candidate, local SSE
  fixture model; no real provider credentials or paid API.
- **Steps:** Open the footer clock; create a daily Morning task at 09:00; select
  another saved project, Auto permission and a non-default configured model; edit its name;
  select a daily time period from four fixed defaults; open the weekday menu,
  select custom days, save and reopen; reject empty days; verify the four defaults,
  arrows, Home/End, Enter, Escape/Tab and outside dismissal; select hourly without time
  fields and verify its first occurrence is one hour away; pause/resume; Run now
  and read the admitted run's transcript inside the task page; select an interval
  cadence, enter 30 minutes and verify the row states that span instead of a
  clock, then switch to a weekly cadence and back to confirm the value survived;
  open the edit form and verify the task column and the task page step aside;
  let one task accumulate more runs than the shared window while another stays
  idle, and verify the idle task still reports its own last outcome; open the
  result conversation from that page and verify its top bar offers the way back
  to the scheduled task; return and confirm the same task and run are still
  selected; observe automatic completion; delete the settled task. In a normal Agent
  conversation, use model tool calls to discover, create, list, update to 15:30
  and delete a task. Verify the custom time appears in the form and survives
  renaming. The model is a local deterministic fixture, not a live provider.
- **Expected:** Project, permission and exact provider/model persist on that task,
  reopen with the same values and reach the sidecar without changing another task.
  The project, permission and model controls remain inside the Instruction field's
  Composer-style bottom toolbar, including at the narrow viewport, with no horizontal overflow.
  Legacy rows without the new fields retain their previous defaults. Configuration
  persists, next time is visible, paused tasks do
  not dispatch, both execution paths reach the real Agent sidecar, the task's own
  history lists each run with its status and duration and Open conversation
  reaches the persisted transcript while the SessionList and session search never
  list it, that conversation's top bar returns to the same task and run, an
  interval task arms from the span the form states and reports it in its row,
  the task form owns the page while it is open, a task that stayed idle while
  another accumulated more runs than the shared window still reports its own
  last outcome, and
  automatic execution does not require a
  renderer prompt. Host tests additionally prove duplicate admission rejection,
  stale/missed occurrence handling, invalid input rejection and recovery.
- **Specs:** 04-ux/01-ui-ia §3.3; 04-ux/08-component-spec §6, §20A;
  03-runtime/04-data-storage §4.11; ADR scheduled-desktop-automations; ADR 0305.
- **Acceptance:** Scheduled task execution and recoverable run history.
- **Milestone:** Post-MVP desktop automations.
- **Status:** Automated in `node scripts/e2e-scheduled.mjs`; run against the
  request candidate per AGENTS.md, with tested head and base recorded.

### Scheduled execution-status wording (English / Simplified Chinese)

- Open Scheduled with a normally ended session whose transcript reports that
  the requested work could not be completed. Verify that the rail, history and
  selected-run header say **Session ended** / **会话已结束**, not unqualified
  task completion. The history hint states that session completion does not
  confirm task success and asks the reader to verify task evidence.
- Running, interrupted and error labels also identify the session. No task
  outcome is inferred, persisted or backfilled by this copy-only correction.
- Copy validation checks both catalog entries and the existing shared label
  mapping. Existing Scheduled component/user-path coverage is unchanged.

## E2E-1174: Return a paired tool denial in Plan/Goal

- Seed earlier tool-call history, then switch an Agent session to Plan or Goal.
  A loopback Responses gateway emits Edit, Write or Task only if that tool is
  declared in the request; an undeclared name would cause a 502.
- Verify all six mode/tool combinations reach the normal tool-result path:
  the next request contains the original call id and a mode-denial error,
  preserves old call/result pairs, and adds no synthetic user correction.
- Assert that no host call occurs and no delegate starts. The tool event is an
  error while the model can continue with a read-only answer.
- A handler reference retained from Agent must refuse execution after Plan/Goal
  is entered; switching back to Agent restores the normal permission path.
- Automation: `mode-tool-access.test.ts` runs real runtime/SDK loops against a
  loopback HTTP/SSE fixture; `runtime.test.ts` covers catalog/mode transitions.
  Existing host permission tests keep Write/Edit denied regardless of grants or
  permission mode. No paid provider or user Desktop profile is used.

## 7A. M6 Plan and shell scenarios

## E2E-105: Plan policy remains host-authoritative

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

## E2E-PLAN-WORKSPACE: Missing workspace does not strand a contract turn

- **Preconditions**: Isolated host, active global workspace, temporary session
  without a persisted project workspace; repeat for Plan and Goal.
- **Steps**: Enter the contract from Agent mode and submit. In the runtime,
  submit from a workspace-less contract session, receive the tool error, deliver
  a final explanation, and repeat on
  the user's next "continue" turn. Use a bound project as the success control.
- **Expected**: Entry succeeds and leaves the session in planning state.
  Submission fails with `PLAN_WORKSPACE_REQUIRED` without an approval or
  artifact. The runtime returns a non-terminating error with workspace binding
  guidance and permits a final assistant response. No execution is authorized.
  Bound-project submission still produces a pending immutable checkpoint.
- **Status**: Automated by `scripts/e2e-plan.mjs` and the runtime Plan transition
  tests with a scripted provider boundary.

## E2E-106: SubmitPlan rejects into editable planning and resubmits a new artifact

- **Preconditions**: A project-bound session starts in Agent with Auto permission,
  then enters Plan with a provider;
  `.pi/plan/` is absent or empty and the workspace permits host artifact
  creation.
- **Steps**: 1) Let the Agent call `SubmitPlan` with fixed title, Markdown, and
  question. 2) Inspect the new `.pi/plan/*.md` file byte-for-byte and the
  `plan_approvals` row. 3) Inspect the card's title and artifact opener; confirm
  the opener uses the bundled file view when it is launchable and the host
  file tab otherwise (D452), and that the question/description,
  validity/deadline, and status are absent with only Approve and Reject
  offered. 4) Verify the main approval button defaults to Auto even if an older
  device-wide preference was Ask. 5) Reject the
  proposal. 6) Confirm durable mode is Plan, live state is editable `planning`,
  the approval gate is cleared, and a later prompt is accepted. 7) Let the
  Agent revise and call `SubmitPlan` once in that new turn with a complete
  snapshot. 8) Approve the second proposal using the main Auto button.
  9) Repeat with Ask and Accept edits Sessions, and an inherit Session whose
  global default is Auto; verify each card follows its own Session even when
  another Session is active. 10) In an Auto Session, explicitly approve with
  Ask from the menu and verify the return to Agent uses Ask.
- **Expected**: Host preserves the exact submitted Markdown bytes in a new
  unique artifact, records its relative path/hash/size with structured
  title/question, and never lets the renderer or sidecar write or replace it.
  The title-derived artifact filename is recognizable from the title, including
  non-ASCII title characters. The card shows the title and opens the artifact in
  the bundled file view, falling back to the host file tab when that view is not
  launchable (D452);
  it does not require inline question/Markdown/hash/size or a validity/deadline
  indicator. The approval default follows the owning Session's effective
  permission, ignoring legacy device-wide approval history. Main-button
  approval preserves Auto across Plan → Agent; an explicit menu choice changes
  the execution permission. Reject sends no mode and preserves it.
  Rejection is terminal for the first row, leaves durable mode Plan, and returns
  live state to editable planning. The later prompt/resubmission creates a
  second complete Markdown snapshot and a different `.pi/plan/*.md` artifact;
  the first artifact bytes remain unchanged. Approving the second proposal with
  the Session's Auto mode still changes the same Agent to Agent and queues execution.
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
  entered CDP or output. The no-key run also covers
  `E2E-106-session-permissions`: eight native main-button/menu/rejection cases
  verify explicit Ask/Accept edits/Auto, inherited global modes, ignored legacy
  device history, durable Plan-to-Agent permission and renderer reload. Run
  `node scripts/e2e-plan-ui.mjs --permissions-only` for this focused gate.
  Each seeded Session owns a distinct probe tool-call identity. No provider is
  configured for these cases; automatic execution reports the expected missing
  provider while approval persistence is verified through the real Host.
  The default no-key run has six required cases; the live case is explicitly
  skipped.

## E2E-107: Plan approval uses one absolute 30-minute expiry

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

## E2E-108: Startup fence interrupts pending Plan work

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

## E2E-109: Approved Plan execution is not replayed after restart

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

## E2E-110: Scheduled Plan is rejected before any work

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

## E2E-117: Agent/Plan/Goal UX and locales contain no Chat controls

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

## E2E-146a: Approved Plan/Goal progress text continues once

- **Preconditions**: A project-bound session has an approved Plan or Goal and a
  deterministic provider fixture. One fixture ends with short forward-looking
  progress text and no tool call; a second ends with a normal final report;
- **Steps**:
  1. Start the approved execution with the progress-only fixture and inspect
     the transcript while the runtime recovers.
  2. Inspect the model request context, lifecycle events, and visible message
     ids after the continuation completes.
  3. Repeat with the normal final-report fixture.
  4. Repeat the progress fixture with a continuation that emits a real tool
     call, then inspect the tool result and final report.
- **Expected**:
  - The progress text remains in one assistant bubble and causes exactly one
    continuation. The provider receives the user/execution context without the
    prior assistant message at the end, and the continuation carries the
    progress nudge.
  - The first attempt's `agent_start`, `turn_start`, `turn_end`, and
    `agent_end` are suppressed; the reused bubble id and one terminal lifecycle
    are visible to the UI. The nudge is removed after the run.
  - A continuation tool call proceeds through the ordinary autonomous loop;
    it does not create a duplicate assistant bubble or lifecycle.
  - A normal final report, including one recovered after silent-turn recovery,
    does not cause an unnecessary progress continuation. Ordinary Agent text
    answers remain unchanged.
- **Specs linked**: `03-runtime/02-agent-runtime.md` §5e/§5e.1/§7,
  `03-runtime/08-error-codes.md` §3.2
- **Acceptance**: C (chat & stream), F (persistence), H (diagnostics), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`runtime.test.ts`, `progress-turn.test.ts`); full
  provider/UI journey Draft

## E2E-147: Scoped search stays inside its budget and the agent narrates

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

## E2E-102j: Historical vision replay uses a bounded aggregate byte budget

- **Preconditions**: A vision-capable model, a session with no compaction boundary
  across the fixture turns, six distinct user image turns whose combined raw
  image size is below 30 MB, and a later text-only user turn. Capture the
  provider request during runtime recreation and edit/resend.
- **Steps**:
  1. Send the six image turns and then a text-only turn.
  2. Reload/recreate the runtime and edit/resend the text-only turn.
  3. Inspect the provider request and the durable transcript.
- **Expected**:
  - All six historical images are replayed as image blocks; being older than
    five image messages does not drop visual context while the aggregate stays
    within budget.
  - The current text row is removed before history hydration and is not
    double-counted against the restored-history budget.
  - Durable turns retain only attachment refs/metadata, never base64. A unit
    case with a deliberately small budget verifies that many images in one
    message are capped and newest attachments win.
- **Specs linked**: `03-runtime/01-ipc-protocol.md` §5.1,
  `03-runtime/02-agent-runtime.md` §5c, `03-runtime/04-data-storage.md`, ADR 0101
- **Acceptance**: C (conversation & stream), F (persistence), Quality
- **Milestone**: M5
- **Status**: Documented; provider/UI journey Draft (run only in a capable environment when this surface changes)

## E2E-121: Goal approval resumes autonomous acceptance-criteria execution

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
  host-core Goal tests); full UI journey Draft (run only in a capable environment when this surface changes)

## E2E-PLAN-005: Plan-mode plugin tools with `planSafeActions` are read-only (D384)

- **Preconditions**: PI-Desktop is built with the bundled Browser
  plugin (`pi.browser`) enabled and a workspace that exposes one
  http(s) URL the planner can reach. The catalog list is the default
  bundled one; no third-party plugin needs to be installed for this
  scenario.
- **Steps**: 1) Create a new session and switch it to Plan mode from
  the mode selector. 2) Send the prompt "Use the browser plugin to
  read `https://example.com`, summarize the page, and tell me what
  to change." 3) Wait for the planner to call
  `plugin_pi_browser_Browser` with `action="navigate"` followed by
  `action="snapshot"`, and to submit a plan with the requested
  summary. 4) Approve the plan and confirm the Agent run completes.
  5) Reject the plan, re-send the same prompt in Plan mode, and
  confirm the planner can still call `navigate` + `snapshot`.
  6) Ask the planner to "click the sign-in button" through the
  browser plugin and confirm the call is rejected with
  `PERMISSION_DENIED` (a Plan call can never click). 7) Inspect the
  active session tool list and confirm it shows the Browser plugin
  with the description suffix `Plan mode: only navigate, snapshot,
  screenshot, console actions`. 8) Switch back to Agent mode and
  confirm the same prompt lets the model call `click` and `fill`
  without the suffix.
- **Expected**: Plan mode can drive the Browser plugin for the four
  declared read-only actions, the description tells the model which
  actions are allowed, and any mutating action is denied with a
  structured `PERMISSION_DENIED` error before the plugin sees the
  call. Agent mode keeps the full plugin surface.
- **Specs linked**: `03-runtime/02-agent-runtime.md`,
  `03-runtime/03-tools-and-permissions.md`, `07-plugins/README.md`,
  ADR 0211
- **Acceptance**: Functional, Quality
- **Milestone**: M6
- **Status**: Partially automated: `test:e2e:plan` covers Plan-mode host
  admission, durable-mode/action-list forwarding, and fixture-boundary
  mutation denial; the full Electron Browser journey remains Draft (run only
  in a capable environment when this surface changes)

## E2E-SCHEDULED-manual-to-hourly

- **Preconditions:** Built host candidate, isolated data directory, no provider.
- **Steps:** Through `tools.execute`, create a paused Manual task, update only
  its id and cadence to Hourly, rename it, restart, and list tasks again.
- **Expected:** Update succeeds without calendar fields; the next occurrence is
  one hour away. Prompt, paused state and saved configuration survive. Rename
  does not reset the interval. RPC tests also cover required Daily/Weekly times
  and retention of an existing custom schedule.
- **Specs:** 04-ux/01-ui-ia §3.3.
- **Acceptance:** C / F — task configuration and persistence.
- **Milestone:** Maintenance.
- **Status:** `node scripts/e2e-scheduled-hourly-update.mjs` exercises the real
  Rust host, permission path, stdio and SQLite; no model inference or desktop UI.

## E2E-SCHEDULED-manual-workspace-binding

- **Preconditions:** Built request candidate; isolated host data and two project
  directories. No provider credentials or paid API.
- **Steps:** Create Manual and Hourly tasks in project A and without a project;
  restart the host, switch to B, Run now, rename through the editor payload,
  and Run now again.
- **Expected:** Each result session and edited task retain the original binding,
  including no-project tasks. Legacy cadence-only tasks keep their previous
  fallback until explicitly configured (covered by host RPC tests).
- **Specs:** 04-ux/01-ui-ia §3.3.
- **Acceptance:** Saved workspace binding across run, edit and restart.
- **Milestone:** Maintenance.
- **Status:** Automated by `node --experimental-strip-types
  scripts/e2e-scheduled-workspace.mjs`, using production Electron dispatch and
  real Rust/stdio/SQLite. Only external inference is replaced with an observer.

## E2E-SCHEDULED-dispatch

- **Scenario:** Independent task dispatch.
- **Expected:** The Electron runner admits independent due tasks without awaiting another task's prompt setup. Local in-flight ownership is keyed by task ID and Host instance until setup settles; Host remains authoritative for enabled, due and overlap checks. A replaced Host's completion cannot clear its successor's local ownership. Stop prevents new polls; admitted work keeps the existing execution/failure lifecycle. Failures remain observable and the 90-second late policy is unchanged.
- **Automation:** `node --experimental-strip-types scripts/e2e-scheduled-dispatch.mjs` uses an isolated real Host and SQLite profile. Inference is not sent to a live provider.
## E2E-SCHEDULED-project-removal

- **Scenario:** Project removal and automations.
- **Expected:** Removing a project pauses its bound scheduled tasks without deleting their definitions, schedule, workspace binding or run history. Session references in history may become null when the project's conversations are removed. Already admitted task runs block removal even before a conversation turn starts. Tasks belonging to other projects and unbound legacy tasks are unaffected. Explicit resume or Run now may recreate a project from the preserved path; automatic polling cannot do so while paused.
- **Automation:** `node --experimental-strip-types scripts/e2e-scheduled-project-removal.mjs` uses an isolated real Host and SQLite profile. Inference is not sent to a live provider.
## E2E-SCHEDULED-legacy-pause

- **Scenario:** Legacy task maintenance.
- **Expected:** Agent tools allow title, prompt and pause updates on legacy automatic tasks without a schedule, including an echoed unchanged cadence. These edits do not arm the task or capture the foreground workspace. Explicit enabling, a cadence change or a supplied schedule still follows schedule validation. Resume requires an explicit valid schedule; Manual-to-Hourly retains its existing default interval behavior.
- **Automation:** `node --experimental-strip-types scripts/e2e-scheduled-legacy-maintenance.mjs` uses an isolated real Host and SQLite profile. Inference is not sent to a live provider.
## E2E-SCHEDULED-calendar-intent

- **Scenario:** Calendar intent.
- **Expected:** The optional config_json.calendarConfigured boolean distinguishes an explicitly configured Daily/Weekly calendar from Hourly's internal schedule placeholder. Without the key, legacy Daily/Weekly schedules are treated as configured; legacy Hourly schedules retain their values but require an explicit schedule when converting to Daily/Weekly. Known calendar intent survives Hourly and restart, including midnight. Clearing or replacing the calendar with a different non-calendar placeholder clears intent. This additive extension needs no table/schema migration; older versions ignore it and cannot enforce the new conversion guard. Metadata-only edits and Manual-to-Hourly remain unchanged.
- **Automation:** `node --experimental-strip-types scripts/e2e-scheduled-calendar-intent.mjs` uses an isolated real Host and SQLite profile. Inference is not sent to a live provider.
## E2E-SCHEDULED-paths

- **Scenario:** Workspace identity.
- **Expected:** Stored workspace bindings use the existing project canonicalization contract on both write and read. On Windows, slash direction, case, trailing separators and extended path prefixes do not hide a task from its own project's conversation. The distinction between missing legacy bindings and explicit null remains unchanged. Foreign-project tools cannot list or mutate bound tasks.
- **Automation:** `node --experimental-strip-types scripts/e2e-scheduled-paths.mjs` uses an isolated real Host and SQLite profile. Inference is not sent to a live provider.
## E2E-SCHEDULED-cancelled-quit-keeps-runner

- **Scenario:** Cancelled quit and automatic runs (issue #2048, D363).
- **Expected:** An explicit quit that the user cancels in the quit confirmation leaves the app running with no `app shutdown` lifecycle entry and no scheduled-runner stop. A task that becomes due afterwards still runs automatically, and its `nextRunAt` advances. A later quit prompts again; Confirm runs the ordered shutdown, the process exits with code 0, and the runtime log records `scheduled runner stopped` exactly once. Only the shutdown handler listens to `before-quit`; services that must survive a cancelled quit stop through `onConfirmedQuit`.
- **Automation:** `pnpm test:e2e:scheduled-quit-cancel` (`scripts/e2e-scheduled-quit-cancel.mjs`) drives the built desktop, preload, real Host SQLite and agent sidecar over CDP in an isolated profile, clicking the in-app confirmation with real pointer input. Only the model is a local SSE fixture; the due instant is set through `configJson.nextRunAt` instead of waiting for the wall clock. Requires `apps/desktop/out` and a host-core debug binary.

## E2E-PLAN-HISTORY: Immutable submissions retain current status in chat

Run `node scripts/e2e-plan-history.mjs` against the committed candidate host.
Use an isolated Electron profile/workspace and the production session IPC,
preload, API normalization, store events, ToolRow, and Markdown renderer.

1. Submit Plan and read a capped history page: expand the full Markdown and
   open its exact artifact path in the owning session's work panel.
2. Approve and deliver a stale pending tool echo: history still says approved.
   Cover approval-before-message and inactive retained-session events.
3. Complete execution, submit/reject a revision, and read both newest/older
   pages: retain both exact bodies and statuses, mark only the older Plan
   superseded, and leave unrelated sessions/Goal untouched.
4. Submit/reject Goal and check localized Chinese status.
5. Continue chat, append a compaction checkpoint, restart host and renderer:
   both versions remain readable; no historical card has approval controls.

No provider credentials or paid model calls are required. The fixture ends at
work-panel file-request routing; artifact bytes are verified from the real
host-created files. The full app's file-preview viewer is covered separately.

## User-defined mode workflow acceptance

Candidate command: `PI_DESKTOP_HOST_BIN=<candidate-host> node scripts/e2e-mode-definitions.mjs`
with `PI_SCRATCH_DIR` set to an isolated test directory. No model API is called.

1. Configure a session with a two-stage definition snapshot. Start a durable
   turn and claim the first contract stage.
2. Request completion without its required artifact; observe a failed gate.
3. Supply the artifact through stage completion; verify its exact disk content
   and the waiting-for-approval state.
4. Settle the first turn, approve with the current revision and claim the next
   stage with approval provenance.
5. Submit the stage's command gate. A changed command must fail with
   `MODE_GATE_MISMATCH` before execution.
6. Execute the exact command through `tools.execute`; consume the Host-recorded
   result and observe finished, no open run, and session mode Agent.

Companion tests: `mode_runs::*` and `rpc::modes_rpc::tests::*` cover migration,
recovery, CAS, budget and permission caps; desktop `mode-definitions-user-path`,
`mode-definitions-renderer` and `mode-runs-main` cover source editing, selection,
run controls and Main dispatch. Runtime `modes/*` covers stage completion and
compaction injection.

### Goal input, replacement and elapsed repairs (offline)

- Run `scripts/e2e-goal-run-repairs.mjs` with `PI_DESKTOP_HOST_BIN` pointing at
  the candidate Host and `PI_SCRATCH_DIR` plus `PI_DESKTOP_AGENTS_DIR` pointing
  at isolated test state. Production Main prompt IPC, coordinator, finalization
  and persistent queue run against real host-core; only the model sidecar
  boundary is controlled. No provider request is made.
- Send a Goal and observe Agent input while its Goal claim remains running.
  Complete its first turn; automatic continuation retains the original run,
  snapshot and Auto permission. Send a second explicit Goal during that turn:
  acceptance is durable before the old Goal stops, old usage/rounds settle
  before queue release, and a distinct new run starts with the second input.
  Stop it, and verify no further continuation. Restored transcript assistant
  rows retain distinct turn ids and contain only the two actual user inputs.
- `scripts/e2e-goal-layout.mjs` renders the production run status bar with
  the built stylesheet in isolated Electron. Check English/Chinese layouts at
  320, 480, 720 and 1120 pixels, long objectives/day durations, metadata order,
  and nonoverlap. Duration uses `d`, `h`, `m`, `s`
  with exactly one ASCII space after each number, including `0 s`, in both
  languages. Resume/Pause/Edit/Remove are icon-only with localized accessible
  names; native clicks still resume/pause, open/cancel editing and arm/cancel
  removal. Stop retains its text and confirmation. Timer lifecycle is unchanged.
  It never attaches to the user's app.
- Rust elapsed tests cover all frozen states, deterministic clock rollback,
  pause/resume, duplicate settlement, offline recovery and populated v29 upgrade.
  RPC permission tests cover Auto, Ask and Accept edits after input reset, plus
  Plan hard denies and separate accounting for a replaced run. Queue tests cover
  restart and idempotency. Renderer user-path tests cover accepted/rejected Goal,
  pending model settings, newer picker choices, live/background turn attribution,
  legacy grouping and fixed Latin duration symbols with localized elapsed labels. Paid live-model checks below
  remain opt-in and are not a prerequisite for this offline repair suite.

### Goal run controls with a live model (opt-in, paid)

Command: `PI_LIVE_BASE_URL=<url> PI_LIVE_MODEL=<model> PI_LIVE_API_KEY=<key>
PI_DESKTOP_HOST_BIN=<candidate-host> node scripts/e2e-goal-live.mjs` with
`PI_SCRATCH_DIR` set (`PI_LIVE_SECRETS_DIR` + `PI_LIVE_SECRET_REF` may replace
the key; only the machine key and that one secret file are copied). It calls a
paid model API and needs the account owner's authorization. Real pieces: an
isolated Host, the production runtime loop and Electron main's run coordinator.

1. A Goal run starts with the builtin definition budget (20 turns), does
   the work, calls `CompleteStage` with the three-heading artifact, finishes,
   and the session returns to Agent.
2. During the first turn, Edit the objective and budget, then Pause: the turn
   receives the closeout notice and ends within 3 more model requests; the run
   stays paused and no turn starts. Resume starts an approval turn with the
   edited objective, which the run meets before it finishes.
3. During a turn, Remove: the turn is not interrupted, finishes in Agent
   without `CompleteStage`, no Host-started turn follows, and no open run is
   left.
## E2E-custom-mode-prompt-admission

Select a simple custom mode with a distinctive prompt and contract policy, send a
message, and refresh planning state. The runtime receives the selected definition
and the session retains its mode. Remove the definition before another send: reject
without persisting a user message or invoking the sidecar; the admission turn is
closed. For a staged run, edit the catalog into a simple mode and then remove it;
subsequent dispatch retains the run snapshot in both cases. Controlled coverage:
`apps/desktop/test/custom-mode-dispatch.test.mjs`. Native Electron/provider
acceptance is separate from these stubbed Host/sidecar boundary checks.
Also create directly in Goal or a staged custom mode without switching modes:
the first send starts a run. `mode-session-create.test.mjs` checks the production
creation registrar validates input and sends its snapshot in one creation RPC.
Host RPC tests cover snapshot/policy persistence, invalid snapshots and rollback
after an injected session-insert failure. Approve a legacy Goal proposal: live
events and pending-proposal restoration show Agent. Inactive polling with no
approval preserves staged Goal/custom modes, including after older Goal history.
Coverage: `mode-planning-approval.test.mjs`, `session_mode_create_tests.rs`.
`scripts/e2e-mode-definitions.mjs` also exercises production prompt IPC and the
coordinator against an isolated real Host, including edit/removal, durable claim
settlement and unavailable-mode cleanup. The sidecar boundary is synthetic; this
does not qualify native Electron interaction or live-provider execution.

Upgrade schema 28/29/30/31 fixtures that retain the builtin-only `sessions.mode`
CHECK, then select a custom mode in an existing session and create a session in a
custom mode. Both paths persist the definition and retain its tool policy; builtin
switches and snapshot-mismatch rejection still work, and reopen retains the custom
selection. Preserve populated rows, child records, indexes, triggers and views;
failed replacement or foreign-key validation rolls back with a pre-upgrade backup.
Coverage: `rpc/session_mode_migration_tests.rs` and
`db/session_mode_migration_tests.rs`. This is isolated real SQLite/Host RPC coverage,
not a claim of installed-client or live-provider acceptance.

## E2E-custom-mode-legacy-goal-upgrade: Retire the old turn snapshot writer

- **Preconditions**: Isolated schema-31 and schema-32 fixtures retain the
  independent Goal `turn_execution_snapshot` trigger and populated execution
  history. Include schema 32 both with and without the old sessions-mode CHECK.
- **Command**: Set `PI_SCRATCH_DIR` and `PI_DESKTOP_HOST_BIN`, then run
  `node scripts/e2e-legacy-goal-migration.mjs` after JS and Host builds. The
  Host binary may also be selected from the extracted installed-layout payload.
- **Steps**: Upgrade, select staged `goal-3` in a saved session, begin and end
  a turn, create another custom-mode session, inspect the backup, and restart.
- **Expected**: Schema reaches 33; custom turns complete without the legacy
  CHECK error; old ledger rows remain unchanged; only the obsolete trigger is
  retired; foreign keys remain valid; the verified schema-32 backup retains the
  original trigger and records and is not replaced on restart. RPC regression
  tests also cover backup refusal, transactional rollback, unchanged sessions
  schema when no rebuild is needed, and unrelated trigger behavior.
- **Specs linked**: [Data storage](../../03-runtime/04-data-storage.md).
- **Acceptance criterion**: C, G, H.
- **Milestone**: Post-MVP compatibility repair.
- **Status**: Automated at the isolated real-Host/RPC boundary; no live provider
  or running user Desktop is used.

## E2E-GOAL-completion-channel: Completion and blockers stop autonomous rounds

- **Environment**: Isolated Host data and `PI_DESKTOP_AGENTS_DIR`, production
  sidecar/proxy, production Main claim/settlement services, deterministic
  loopback-only model endpoint; no real provider or user Desktop instance.
- **Command**: After JS/runtime and Host builds, run
  `node scripts/e2e-goal-completion.mjs` with `PI_SCRATCH_DIR` and
  `PI_DESKTOP_HOST_BIN`. `PI_DESKTOP_SIDECAR_ENTRY` can select the sidecar
  extracted from the installer for payload validation.
- **Steps**: Submit a completed report with the Goal artifact, a legacy
  summary/artifact call, a blocked report with unfinished evidence, and a
  completion-channel failure. Also complete a stage with a real Bash exit gate.
  Repeat settlement and restart the isolated Host for each scenario.
- **Expected**: Success reaches `finished`; blocked remains non-success
  `waiting/blocked` with durable outcomes/reason; infrastructure failure emits
  `MODE_COMPLETE_STAGE_FAILED` and settles `waiting/error`. Each scenario uses
  exactly one model request, returns `continue: false`, releases its claim,
  and schedules no next autonomous round. Gate results traverse the production
  proxy and use Host-recorded execution, not a model verdict. Restart preserves
  terminal/waiting state; duplicate settlement cannot recharge accounting.
- **Companion negatives**: Runtime/Host tests cover invalid/oversized reports,
  original exit gates, stale/cross-session claims, paused/stopped runs and input
  edits. The stdio proxy tests retain denies for start/control/update/resolve/
  settlement and configuration methods. Saved snapshots gain reporting guidance
  without changing frozen objectives or gates.
- **Scope**: Host validates authorization, report structure and state; it does
  not independently prove model-reported acceptance evidence true.

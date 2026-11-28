# E2E Scenarios: Tools, Permissions, and Workspace

> Part of the [E2E test plan](../04-e2e-test-plan.md). Agent tools, permissions, files, projects, worktrees, browser, and computer use.
> Scenario template, gates, and traceability live in the plan.

## E2E-FILE-INDEX-git-deadline

Drive `getWorkspaceFileIndex` and `searchWorkspaceFiles` against real fixture
files. Hold Git's close event beyond its deadline: both calls return the bounded
filesystem listing. Coverage: `fs-index-git-deadline.test.mjs`. Existing index
tests cover Git ignore semantics, Unicode chunk boundaries and deep search.

## E2E-FILE-MANAGER-git-deadline

`file-manager-git-timeout.test.mjs` drives actual bundled `fm.list` and `fm.read`
against real fixture files with a controlled child-process boundary. Advance
the Git deadline while the child never closes: entries and preview complete
without Git metadata. Existing Electron directory-location and mutation
journeys cover successful reads, saves and directory browsing.

## E2E-PROJECT-case-alias-upgrade-and-delete

- Entry: `python scripts/e2e-project-path-case.py <candidate-host>` on native
  Windows or a case-insensitive macOS volume. `--expect-bug` verifies the old
  failure against an unpatched Host.
- Create a temporary profile, real `Alpha` directory, two conversations with
  transcript bytes, and an unrelated project/conversation. Seed the historical
  lowercase project row and move one conversation to it while the Host is stopped.
- Restart: require schema v28 and a v27 backup retaining both original owners,
  one project, both conversations owned by it, and both
  transcripts preserved. Delete by the lowercase spelling: require both owned
  conversations/files removed, no reappearing alias row, and the unrelated
  conversation and physical project directory preserved.
- Repository regressions also cover a directory appearing after its first
  registration, schedule/current-selection retention, opaque remote ids,
  distinct case-sensitive directories, retargeted symlinks, nested import
  transactions and failure rollback. Use synthetic data only; no installed
  user profile, provider request or interactive Electron instance is used.

## E2E-TOOLS-parallel-read-batches: ordered preparation and Host file admission

- Use isolated data/project paths and a local provider; no production profiles.
- Run scripts/e2e-parallel-read-batches.mjs after building shared, agent-runtime
  and the candidate Host. Set PI_DESKTOP_HOST_BIN when reusing a build cache.
  It drives real parent/delegate pi loops through the real Host: independent
  read dispatch, ordered results, prompt isolation, mixed Read/Write dispatch,
  a successful real-tag Edit, differently named hard-link Read/Write in both
  source orders, individual review rollback and simultaneous ask-mode approvals.
  File symbolic links run where the OS grants creation; otherwise record an
  explicit skip and retain hard-link coverage. This is dispatch/content evidence,
  not a production throughput or Electron UI measurement.
- Run scripts/e2e-task-read-batches.mjs for both Task/read model orders. Task
  returns its started notice; the later parent read waits for the writable
  shared-workspace delegate to settle. Task-only fan-out remains available.
- Rust file_batches/file_resources/tool_budget::file_tests cover actual native
  identities, cross-root aliases, unknown/missing targets, structural/register
  fences, independent resources, queue fairness and cancellation. Native RPC
  tests reverse tools.execute arrival and assert actual read contents in both
  hard-link orders, permission-mode denial, changed arguments and ticket replay.
- tools::file_lease_tests gates a real spawn_blocking body, drops the outer
  future and proves a conflicting write cannot acquire until that body finishes.
  Closing/abandoning metadata must not release running work. Snapshot/finalize
  and later rollback participate in the same Host file domain.
- Independent identified writes with validated tickets may use two session
  slots. Per-file native gates must observe both blocking bodies before either
  is released, and retain the cancelled body's lease. Budget regressions cover
  legacy/coordinated admission in both orders, conservative waiter draining,
  reversed source order, global limits and cancellation after reservation.
  Runtime E2E must preserve distinct snapshots and rollback for both writes;
  this is correctness evidence, not a wall-clock throughput claim.
- Runtime/pi integration tests cover parent/delegate registration, preparation
  order, validation/mode failures, Stop and model result order. Protocol adapter
  tests cover sealing, cleanup, remote/legacy fallback and equal provider IDs in
  independent asynchronous executors. host-runtime/file-batch-bridge.test.ts
  verifies the explicit allowlist through a real stdio child.
- Unknown capability/remote workspaces must retain whole-batch sequential writes;
  no local filesystem identity is used for a remote path. Resource and batch
  waits consume no capacity, and uncertain writes are not replayed.
- Specs: tools-and-permissions §0, agent-runtime concurrency, Host RPC file batch
  protocol; ADRs parallel-read-batches and host-file-batch-admission.

## E2E-WORKTREE-isolated-session-lifecycle

- **Preconditions:** Isolated desktop profile and data directory, git 2.29+, a
  git project on a branch with at least one commit, a configured model, and an
  optional `.worktreeinclude` listing one ignored file.
- **Steps:** Create two isolated sessions from the project menu and run a
  file-editing prompt in each at the same time. Run a Bash command that prints
  `PI_PORT` / `PI_WORKTREE_ROOT`. Merge the first session into the project;
  edit the same line in the project and in the second session, then merge the
  second. Resolve the conflict in the second session and merge again, then
  use **Sync from project** in the first session. In one
  isolated session, start two writing subagents in parallel. Finally delete
  an isolated session with unmerged work, and restart the app once while a
  session exists. Open the menu of a non-git project.
- **Expected:** Each session's edits land only in its own worktree; the project
  checkout and `git status` stay clean until a merge, and the ignored include
  file is present in each worktree. The two sessions get distinct ports. The
  first merge fast-forwards the project and a success toast names the branch.
  The conflicting merge lists the files, leaves the project untouched, and
  marks the row `Conflict`; after resolution the badge clears and the merge
  lands. The first session's row shows `↓N`; Sync from project shows the new
  commits, clears the marker, and brings the resolution
  into the first session without touching the project. Writing
  subagents edit in separate worktrees and completed runs merge back into the
  session. Delete warns about unmerged work and removes the worktree folder
  and `pi-desktop/<id>` branch without touching files linked from it. After
  restart the session reopens in its worktree; a manually removed worktree
  shows `Folder missing` and never falls back to the project. In the non-git
  project **New isolated session** is disabled with the reason under it.
- **Windows checks:** a worktree containing a directory junction is deleted
  without following the junction; a deep path beyond 260 characters is
  created and removed; deleting while a file in the worktree is locked fails
  visibly and can be retried.
- **Specs linked:** `03-runtime/03-tools-and-permissions.md` §4e, §10.2;
  `03-runtime/06-host-rpc-protocol.md`; `04-ux/01-ui-ia.md` §3.2; ADR 0329.
- **Coverage:** host-core `session_worktrees` tests (create, merge, conflict,
  removal, link safety, reconcile, delegates), worktree IPC contract tests,
  renderer `worktree-ui` tests, and agent-runtime delegate tests. The Windows
  checks run as host-core tests on a Windows host: junction removal
  (`remove::tests`), the replaced-root link (`lifecycle::tests`), and the deep
  path and locked-file delete through the RPC user path
  (`rpc::worktree_rpc::tests`). `pnpm test:e2e:worktree-live`
  (`scripts/e2e-worktree-live.mjs`) runs the steps above against a real model
  at protocol level, without the renderer.
- **Status:** Partially automated

## E2E-ASKTOOL-compact-card-interaction

- **Preconditions:** No live provider is required; the fixture stubs
  `api.resolveAskTool` and seeds one two-question ask through the real store
  slice.
- **Steps:** Mount the production `AskToolCard`, assert the header Tab order
  (decline, skip, next) with no legacy bottom action row, then walk select →
  next → submit, skip → submit, decline-all, and a custom answer, remounting
  with a fresh request id between flows. Finally mount a question whose body
  holds two markdown blocks and measure their boxes, then answer a question at
  the 300-character limit.
- **Expected:** Every flow resolves through the store's `resolveAsk` with the
  exact answers (skips recorded as `null`), and no render errors are reported.
  The two question blocks stack vertically on a shared left edge that spans
  the card's text column, so a sentence never wraps inside a flex column. The
  full 300-character question remains visible and answerable; runtime validation
  rejects a 301-character question before opening the card.
- **Status:** Automated in `pnpm test:e2e:asktool-card`, which mounts the
  production `AskToolCard` in a real Chromium page, clicks through the header
  actions, and measures the multi-block question layout. Runtime boundary
  validation is covered by `packages/agent-runtime/src/runtime.test.ts`.

## E2E-ASKTOOL-draft-survives-session-switch

- **Preconditions:** No live provider is required; the fixture stubs
  `api.resolveAskTool` and seeds one two-question ask through the real store
  slice.
- **Steps:** Mount the production `AskToolCard`, select the second option on
  question one, advance to question two, unmount the card (the session switch
  the dock performs), and remount it with the same `requestId`. Then click the
  first step indicator to return to question one.
- **Expected:** The remounted card opens on question two with the earlier
  selection still marked, and question one still shows the selected option.
  Resolving or dismissing the ask clears the stored draft.
- **Status:** Automated in `pnpm test:e2e:asktool-card` as the
  `E2E-ASKTOOL-draft-survives-session-switch` flow.

## Workspace Open

## E2E-012: Open a project directory

- **Preconditions**: App running; no project open.
- **Steps**: 1) Open project directory via UI. 2) Select a local folder.
- **Expected**: Project path displayed; tool paths resolve relative to project root.
- **Specs linked**: `03-runtime/15-workspace-ignore-rules.md`
- **Acceptance**: D (open project, show path)
- **Milestone**: M3
- **Status**: Draft

## E2E-012a: Create a named project from multiple folders

- **Preconditions**: App running; no project dialog open; at least two local
  folders are available, including one with a long name or path.
- **Steps**:
  1. Invoke Add project from Settings → Project archive or the sidebar Projects
     heading and inspect the empty dialog.
  2. Add two folders with the folder picker without typing a name. Confirm the
     name field seeds with the first folder's name, both rows render, and the
     first row is marked Primary.
  3. Remove one row, check the count, and add it again.
  4. Inspect the empty and populated states in light and dark themes, including
     a narrow window and reduced-motion settings.
  5. Use Tab and Shift+Tab to traverse the controls. Close with Escape, then
     reopen and close by clicking outside; check focus after each close.
  6. Reopen, enter the name, add the folders, and create the project. Inspect
     the in-flight controls and the resulting active primary workspace and one
     grouped project entry with both roots.
  7. Start a session in the group and ask the agent to read a file using the
     additional root's absolute path; then try an unrelated outside path.
- **Expected**: The dialog traps focus, closes on Escape or outside click while
  idle, and keeps the name and selected folders visible without horizontal
  overflow. The native picker allows multiple directories in one selection.
  Removing a folder updates the count and never removes another row. Create
  needs one folder and no typed name; an empty name field falls back to the
  first folder's name. On creation one
  logical project group receives the entered display name; its primary folder
  becomes the active workspace and every selected folder is retained as a group
  root. The Project archive shows one group row, and its sessions, shared
  instructions, and shared memory use the group identity. Read/Glob/Grep/
  Write/Edit can use an explicitly addressed additional root only after host
  canonical containment; an unrelated outside path still follows the normal
  permission flow. The
  dialog is unavailable while creation is in flight and returns focus to the
  invoking control after close. The surface follows the shell's neutral gray
  theme with a 480px maximum width, 18px tokenized corners, shared dialog
  elevation, and the global compact type ramp. The title uses the dialog-level
  heading size, the name field uses the body/input size, and labels/metadata
  remain on the smaller global steps. The header and action row use the shared
  18px dialog gutter; sections use a 16px gap. It shows one Create project
  title, a filled name field without duplicate placeholder copy, a compact
  local source chip, and a softly filled Add folder action. It does not add
  explanatory memory or multi-selection copy. The workspace section keeps the
  current local folder selection behavior while staying neutral about future
  remote sources. No outer stroke, section rules,
  footer divider, or dashed picker border appears. Spacing provides the section
  hierarchy; long names and paths remain contained, and scrolling content never
  hides the fixed action row. Both themes keep text readable and keyboard focus
  visible; reduced motion suppresses the control transitions. The source chip
  is the extension point for a future remote project source; the current flow
  remains local-only.
- **Specs linked**: `03-runtime/01-ipc-protocol.md` (§9),
  `04-ux/06-settings-ia.md` (Project archive),
  `04-ux/07-ui-design-system.md`,
  `04-ux/08-component-spec.md` (§3.5)
- **Acceptance**: C (project creation UI), D (multi-folder project setup),
  Accessibility, Localization
- **Milestone**: M3
- **Status**: Source-level regression covered; full UI scenario Draft

## E2E-012b: Delete a project root from a multi-folder group

- **Preconditions**: A two-root project group has sessions in both roots; one
  session in the root being deleted can be started and stopped.
- **Steps**:
  1. Start a turn in the primary root, then request deletion of that project
     and confirm the action.
  2. Confirm the running-session conflict and inspect the group and both
     session lists.
  3. Let the turn finish, delete the primary project, and confirm again.
  4. Inspect the remaining group, its sessions, shared instructions and
     memory, and both directories on disk.
- **Expected**: A running session blocks deletion without changing group
  membership or deleting data. After the session is idle, deletion removes the
  selected root, its sessions and project memory, promotes the first remaining
  root when needed, and preserves the remaining root's sessions and group-level
  instructions and memory. The original folders remain on disk.
- **Specs linked**: `03-runtime/06-host-rpc-protocol.md` (Projects),
  `04-ux/08-component-spec.md` (§3.9)
- **Status**: Draft

## E2E-013: Read-only tools work in project

- **Preconditions**: Project directory open.
- **Steps**: 1) Ask agent to read a file in the project. 2) Observe result.
- **Expected**: `Read` returns immediately within project scope. In Agent mode,
  `Glob` and `Grep` are available in the first Agent request without
  `ToolSearch`; Plan keeps its read/search core available from the first
  request. All results remain within project scope.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md`
- **Acceptance**: E (Read/Glob/Grep work), D (tools based on project)
- **Milestone**: M3
- **Status**: Automated (protocol smoke: Read + Glob in sample project)

## Permission Allow / Deny / Cancellation

## E2E-014: Write/Edit/Bash triggers permission card

- **Preconditions**: Agent mode; project open.
- **Steps**: 1) Ask agent to write a file. 2) Observe permission card.
- **Expected**: Permission card appears inline in the originating transcript
  with tool name, workspace, arguments preview, and allow/deny
  options. It creates no backdrop or modal and does not cover another session.
- **Specs linked**: `04-ux/03-permission-ux.md`, `03-runtime/03-tools-and-permissions.md`
- **Acceptance**: E (Write/Edit/Bash trigger confirmation)
- **Milestone**: M3
- **Status**: Draft

## E2E-015: Denied permission blocks execution

- **Preconditions**: Permission card displayed.
- **Steps**: 1) Click deny on permission card. 2) Observe agent response.
- **Expected**: Tool not executed; agent receives denied result; no file changed.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md`
- **Acceptance**: E (denied → not executed)
- **Milestone**: M3
- **Status**: Draft

## E2E-016: Allowed permission executes tool

- **Preconditions**: Permission card displayed.
- **Steps**: 1) Click allow on permission card. 2) Observe agent response and UI.
- **Expected**: Tool executed; result returned to model and displayed in UI; file modified.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md`
- **Acceptance**: E (allowed → result returned)
- **Milestone**: M3
- **Status**: Draft

## E2E-017: Local permission approval has no automatic deadline

- **Preconditions**: Permission card displayed; no user action.
- **Steps**: 1) Leave the permission card unanswered. 2) Confirm it remains
  visible and the tool call remains pending. 3) Choose Deny and observe the
  outcome.
- **Expected**: No countdown or automatic denial appears; the request remains
  pending until the explicit Deny action, and the tool is not executed.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md`
- **Acceptance**: E (timeout → deny)
- **Milestone**: M3
- **Status**: Draft

## E2E-018: Plan denies workspace mutation and plugin tools

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
- **Status**: Documented (M6; E2E execution pending)

## E2E-019: Workspace-outside paths follow permission mode

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

## E2E-019e: Bounded search parameters stay portable across platforms

- **Preconditions**: Agent or Plan mode; project open; the host tool catalog is
  available on macOS, Linux, or Windows.
- **Steps**: 1) In Agent mode, inspect `Glob`/`Grep` in the first request
  without `ToolSearch`; confirm Plan also exposes both from its first request.
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
  required, workspace-relative paths use `/` for platform separators while
  literal backslashes in POSIX filenames remain intact, and oversized results
  remain bounded.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md`,
  `03-runtime/16-tool-result-limits.md`, ADR 0057, ADR 0069
- **Acceptance**: E (bounded cross-platform search)
- **Milestone**: M5
- **Status**: Unit-covered (host-core and agent-runtime); live multi-platform
  protocol capture pending. The workspace-relative path expectation is covered
  on Windows by `relative_display`, which must canonicalize the workspace root
  with the resolver's own spelling (`simple_canonicalize`) — std
  `Path::canonicalize` keeps the `\\?\` prefix there and silently degrades
  every label to an absolute path.

## E2E-019a: Scratch-directory writes stay out of the workspace (D114)

- **Preconditions**: Agent mode; project open; session started.
- **Steps**: 1) Ask the agent to produce a temporary/intermediate file (e.g. a one-off script). 2) Observe where it writes and whether a permission card appears. 3) Check `git status` and the work-panel state. 4) On Windows with Git Bash selected, print `$PI_SCRATCH_DIR` and write a file through that path. 5) Delete the session and check `<data_dir>/scratch/`.
- **Expected**: The file lands under `<data_dir>/scratch/<sessionId>/` without a permission card; project `git status` stays clean; no file or Review artifact tab opens for the scratch write; Git Bash receives a directly usable forward-slash path matching the prompt, while PowerShell and cmd retain native path spelling; deleting the session removes the scratch directory.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md §4b`, `03-runtime/04-data-storage.md`
- **Acceptance**: E (temp files isolated from workspace)
- **Milestone**: M5
- **Status**: Partially automated (host-core unit tests: dual-root resolve, scratch write/read, Windows Git Bash `PI_SCRATCH_DIR` formatting, sweep)

## E2E-019b: Scratch containment matches workspace defenses (D114)

- **Preconditions**: Agent mode; project open.
- **Steps**: 1) Attempt Write with `..` traversal from the scratch root. 2) Attempt Write through a symlink planted inside scratch pointing outside. 3) Attempt the same Write calls in Plan.
- **Expected**: Both escapes return `PATH_OUTSIDE_WORKSPACE`; Plan returns
  `WRITE_DISABLED_IN_PLAN` before any scratch path can make Write available.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md §4b`
- **Acceptance**: E (scratch root cannot be escaped)
- **Milestone**: M5
- **Status**: Automated (host-core unit tests)

## E2E-019c: Permission modes govern high-risk approval (D115/D132)

- **Preconditions**: Agent mode; project open; global default `ask`.
- **Steps**: 1) With a newly inherited session and global default Ask every time, open the composer menu — expect Ask every time to be selected with no global-default/inherit label — then ask the Agent to write a workspace file and expect a permission card. 2) Switch the session chip to Accept edits; repeat — expect no card for Write/Edit but still a card for Bash. 3) Switch to Auto — expect no card for Bash either. 4) Create another inherited session after setting the global default to Accept edits in Settings — expect the composer chip and menu selection to display Accept edits directly and Write/Edit to be auto-allowed. 5) Switch the session to Plan, then Goal, with Auto set — expect Write/Edit/plugin denied but Bash allowed without confirmation.
- **Expected**: Effective mode = session override → global default → ask; Plan and Goal Write/Edit/plugin hard denies outrank every mode while their Bash follows the selected mode; the composer chip and menu always display the effective mode without default/inherit provenance.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md §6`, `03-runtime/04-data-storage.md`, `08-meta/decisions-log.md` (D115/D132)
- **Acceptance**: E (permission modes resolve and enforce host-side)
- **Milestone**: M5
- **Status**: Partially automated (host-core unit tests: evaluate matrix, Plan policy precedence, session grants under ask; renderer source test: effective-only composer options and selection)

## E2E-019d: Bash tool sees the user's login-shell toolchain (D181)

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

## E2E-034: NDJSON log files are written and redacted

- **Preconditions**: Fresh profile; provider configured; one chat turn completed.
- **Steps**: 1) Run a prompt with a tool call. 2) Open `~/.pi-desktop/logs/`. 3) Inspect the categorized files under `app/`, `host/`, and `agent/`.
- **Expected**: NDJSON records exist with `ts/level/channel/category/event/message`; a normal tool call produces one completion or failure record carrying `sessionId`/`toolCallId`, safe tool metadata, and bounded result/duration information; an interrupted tool remains traceable by the same id; no API key, authorization value, raw command output, or local absolute path appears; each category file rotates at 5 MB; lifecycle, permission, tool, provider, plugin, persistence, updater, and error records remain available without creating dedicated timing category files.
- **Specs linked**: `03-runtime/09-logging-and-observability.md`
- **Acceptance**: H (diagnostics)
- **Milestone**: M5
- **Status**: Documented

## E2E-035: Bash tool uses the effective catalog shell

- **Preconditions**: Workspace open; agent mode.
- **Steps**: 1) Select an available catalog shell and run `Bash` (e.g. `echo ok`). 2) Make the persisted selection unavailable and inspect the effective catalog before running the next turn. 3) Run with the previous turn snapshot.
- **Expected**: The unchanged `Bash` protocol call uses the selected catalog entry. A later unavailable persisted choice falls back to the first available platform shell and marks the catalog fallback; the previous turn snapshot is rejected as stale by `COMMAND_SHELL_CHANGED` rather than silently changing shell. No partial execution occurs; E2E-113 covers the stale identity path.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md`, `03-runtime/06-host-rpc-protocol.md`, `03-runtime/08-error-codes.md`, ADR 0054
- **Acceptance**: H (errors expose stable codes)
- **Milestone**: M5
- **Status**: Unit-covered (`tools::shell::tests`); scenario Documented

## E2E-047: Retain, collapse, switch, and close multiple project tabs

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
  every non-action point in A's row toggles only A, project activation is owned
  by the directory row rather than its overflow menu, and project actions appear on
  hover/focus without shifting labels, the project title hover/focus path shows
  A's full absolute path in a content-sized tooltip (long paths wrap within a
  420px maximum), Open folder is a project-menu action only and opens A
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

## E2E-048: Pin, archive, restore, and sort project/conversation rows

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

## E2E-048b: Edit a logical project name and folder roots

- **Preconditions**: One retained logical project is visible in the sidebar and
  in Settings → Project archive; it has a primary folder, one additional folder
  promoted to primary during the scenario, and one other additional folder
  without chats.
- **Steps**: 1) Open the project's overflow menu in the sidebar and choose
  Edit project. 2) Change the name, use the extra folder's Set as Primary
  action, and confirm that row moves to the top with the Primary tag while the
  former primary becomes an ordinary row. 3) Remove the other additional folder
  and add it again with the native folder picker. 4) Confirm the Primary row
  cannot be removed. 5) Save and inspect the sidebar row, Project archive
  roots, and active workspace. 6) Restart the app and inspect the group again.
- **Background-update regression**: Open Edit project from Settings, change the
  name, promote another folder to primary, and remove the additional folder,
  then complete a background task before saving. Every draft edit must remain
  visible and save together. The isolated rendered test is
  `node scripts/e2e-project-edit.mjs`; it uses real page/store wiring with a
  controlled host IPC boundary and does not prove disk persistence.
- **Expected**: Both project menus offer Edit project. The editor keeps focus
  contained, trims the name, limits it to 80 Unicode characters, keeps the
  Primary folder as the first row, and updates the root count without removing
  another row. Promoting a member folder makes it the first row and the stored
  primary root, so the project opens there afterwards; a folder outside the
  saved roots is never accepted as primary, and a remote project keeps its
  host-owned binding unchanged. Saving persists one logical group with the
  adjusted roots; the name and the promoted primary folder survive restart,
  while the group's sessions, transcripts, and on-disk folders remain
  unchanged.
- **Specs linked**: `04-ux/01-ui-ia.md`, `04-ux/08-component-spec.md`,
  `04-ux/09-interaction-patterns.md`
- **Acceptance**: D (workspace identity), F (local presentation persistence)
- **Milestone**: M5
- **Status**: Unit-covered (`project-edit.test.mjs`,
  `sidebar-preferences.test.mjs`); rendered scenario Draft, with primary
  promotion covered by `node scripts/e2e-project-edit.mjs`

## E2E-PROJECT-relocate-single-root-with-existing-sessions

- **Preconditions**: A legacy or stored single-root local project has an idle
  saved chat, a scheduled task, and project memory. Its directory can be
  renamed outside the app. A second independent project can occupy the
  replacement path for the conflict variant.
- **Steps**: 1) Rename the only project directory outside the app. 2) Open Edit
  project, add the replacement, promote it to Primary, remove the stale row,
  and save once. 3) Reopen the original chat and run a workspace-dependent
  Read or Bash call. 4) Inspect project memory, the scheduled task, the project
  list, and the binding after restart. 5) Repeat with an empty shadow project
  previously opened at the replacement path. 6) Repeat with a non-empty
  independent target project and verify that saving is rejected. 7) Repeat the
  two-step repair: save the replacement next to the stale row first, then save
  again with only the replacement. 8) Repeat step 2 while the old folder still
  exists (an ordinary swap to an unrelated folder).
- **Expected**: The original project id and stored group id survive, its path
  becomes the canonical replacement, and the existing chat, scheduled task, and
  path-scoped memory remain available without recreating the session. The old
  workspace call succeeds at the replacement path. An empty shadow row is
  absorbed, leaving one project. A target with its own chats, tasks, or memory
  blocks the operation with both projects and the original group unchanged.
  The two-step repair ends in the same relocated state; if the replacement
  already owns chats, tasks, or memory, the stale root detaches unchanged
  instead. Relocation applies only when the old folder no longer exists: when
  it still exists, its project keeps its chats, tasks, and memory and remains
  a standalone project. Multi-root detachment still preserves a removed
  existing root's chats as a standalone project; no automatic directory-move
  detection or implicit merge of non-empty projects is introduced.
- **Specs linked**: `03-runtime/04-data-storage.md`,
  `03-runtime/06-host-rpc-protocol.md` (Projects),
  `04-ux/08-component-spec.md` (project editor).
- **Acceptance**: C (project and chat interaction), D (workspace identity),
  F (persistence), Quality.
- **Milestone**: M5
- **Status**: Host integration-covered by the `single_root_replacement_*`,
  `legacy_single_root_replacement_keeps_sessions_when_the_old_folder_still_exists`,
  `two_step_stale_root_repair_*`, and
  `removing_an_existing_root_with_chats_still_detaches_it` regressions and the
  `project_group_update_rpc_relocates_the_active_single_root_workspace`,
  `project_group_update_rpc_follows_a_two_step_relocation`, and
  `project_group_update_rpc_keeps_workspace_when_the_old_folder_exists` RPC
  regressions; full UI scenario Draft

## E2E-048c: Detach a project folder with chats and delete it

- **Preconditions**: One retained logical project has a primary folder and an
  additional folder with at least one saved chat. All chats are idle.
- **Steps**: 1) Open Edit project and remove the additional folder. 2) Save and
  inspect the remaining group and the standalone project row for the detached
  folder. 3) Open its chat and confirm the transcript is intact. 4) Choose
  Delete for the detached project and explicitly confirm in the dialog. 5)
  Inspect the remaining group, project list, chat list, and folder on disk.
- **Expected**: Removing the folder from the group preserves its project row,
  chats, and transcripts, and exposes it as a standalone project. Future chats
  use the detached project's path-scoped context; shared instructions and
  memory remain with the original group. The confirmed delete then removes that
  project's sessions and transcripts while keeping its folder on disk; the
  original group remains with its primary folder.
- **Specs linked**: `03-runtime/04-data-storage.md`,
  `04-ux/08-component-spec.md`, `04-ux/09-interaction-patterns.md`, ADR 0249,
  ADR 0251.
- **Acceptance**: C (project and chat interaction), F (persistence), Quality.
- **Milestone**: M5
- **Status**: Host RPC integration-covered; full UI scenario Draft

## E2E-048A: Project session lists fold after the ten most recent rows

- **Preconditions**: One retained project contains more than ten durable
  sessions with distinct updated timestamps; the sidebar uses the default
  Recently updated sort; another retained project has ten or fewer sessions.
- **Steps**: 1) Inspect the large project's session rows and count them. Check
  rows with recent and older replies. Hover a row, then focus one with the
  keyboard. 2) Select the **Load N more…** control. 3) Switch the sort to Name
  and inspect the same group before expanding. 4) Restart the app and inspect
  the group again.
- **Expected**: The group shows exactly ten session rows by default plus a
  **Load N more…** control (N = remaining session count); there are no time-group
  headers. Every row places the title before a divider and the localized last
  reply date. Replies within seven calendar days show an exact relative day
  (including 0–7 days); older replies show a concrete localized date. Hovering
  or focusing a row hides its date and reveals the session action. The ten rows
  are the first rows in the active sort order, so pinned rows are never pushed
  behind unpinned rows and a Name sort folds everything after the first ten
  alphabetically; selecting Load more expands the flat list and the control
  disappears. Expansion is per group and resets on restart (not persisted); the
  project with ten or fewer sessions shows no fold control.
- **Specs linked**: `04-ux/01-ui-ia.md`, `04-ux/09-interaction-patterns.md`
- **Acceptance**: C (session organization)
- **Milestone**: M5
- **Status**: Scenario Documented

## E2E-049: Background sessions keep their originating workspace

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

## E2E-058: Built-in interactive terminal is absent

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
- **Expected**: The work panel offers the Review launcher row plus Browser and
  in-scope plugin views; Review opens on explicit user action and file resources
  are transcript-opened; no PTY is created and no terminal tab can be opened.
  Agent Bash remains non-interactive and fully visible in the transcript.
  Interactive shell work is performed by the external terminal. Desktop
  packaging has no PTY/xterm dependency, terminal-specific
  IPC, or native terminal payload, while generic lifecycle `terminal` values
  continue to work.
- **Specs linked**: `02-architecture/02-tech-stack.md`,
  `03-runtime/01-ipc-protocol.md` §13a, `04-ux/08-component-spec.md` §5,
  ADR 0108
- **Acceptance**: D (workspace), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`work-panel.test.mjs`, `packaging-footprint.test.mjs`);
  full UI scenario Draft

## E2E-059: Embedded browser preview isolation and overlays

- **Preconditions**: A local dev server is running; a URL or BrowserPreview artifact exists; HTML fixtures exist both inside and outside the workspace.
- **Steps**: 1) Activate the artifact, enter `localhost:<port>` and
  `localhost:<port>/index.html` without a scheme, and submit each. Enter a
  dotted host with a port (for example, `example.com:8080`), then verify an
  explicit HTTP(S) URL and a rejected `javascript:` URL.
  2) Navigate site links; use back/forward/reload/stop. 3) Trigger a
  `window.open` popup and a permission-requesting page (e.g. notification
  prompt). 4) Open global search, then rename a session from the left sidebar;
  close it and open Settings. Return to chat
  and trigger an inline tool permission card. 5) Switch to another panel tab
  and back; close the panel. 6) Use open-external. 7) From both an existing page
  and a blank Browser tab, enter an existing HTML file inside the workspace by
  platform-appropriate `file:` URL and absolute path. Then enter an existing
  file outside the workspace by its platform-appropriate URL and absolute path
  (for example, `file:///tmp/demo.html` and `/tmp/demo.html` on Unix, or
  `file:///D:/demo.html` and `D:\demo.html` on Windows). From the loaded
  local HTML, follow a link to another existing file outside the workspace.
  From an HTTP page, try the same outside file link and enter a missing local
  file path.
- **Expected**: Scheme-less input normalizes to http; nav state (URL bar,
  back/forward enablement, load spinner) mirrors the page. Popups open in
  the default browser (never in-app) only when the URL parses as http(s) or
  mailto; popups using `file:`, `javascript:`, and custom schemes are denied.
  Permission requests are denied; top-level navigation allows HTTP(S),
  in-workspace file links, and existing local file links from a local file
  page. HTTP pages cannot navigate to files outside the workspace. Missing
  files, directories, remote file authorities, and other schemes are blocked.
  The preview hides for the whole lifetime of the rename
  dialog and every other blocking overlay, and while
  unmounted, reappearing with correct bounds afterwards. An inline permission
  card does not hide or remount the preview; resize/drag keeps the native view
  visible and aligned with the placeholder rect without a black flash. Opening
  the work-panel context dropdown moves beside the native view; the view keeps
  its full surface rect and the plugin body does not shift down.
  Open-external launches an http(s) page in the default browser and any loaded
  local file via `openPath`. The view uses an isolated persist partition
  (no session bleed from the app shell). Both inside and outside forms load;
  the HTTP page's outside link and missing path do not reach the guest load.
  The submitted address remains visible on failure, with localized copy that
  only existing local files can open.
- **Specs linked**: `03-runtime/01-ipc-protocol.md` §13a, `04-ux/08-component-spec.md`, `05-security/01-security.md`, ADR 0019, ADR 0168, ADR 0328
- **Acceptance**: Quality, Security
- **Milestone**: M5
- **Status**: Partial automation: `scripts/e2e-browser-local-file-access.mjs` covers native local-file navigation; the address-bar and overlay workflow remains manual.

## E2E-BROWSER-capture-resize: Capture preserves live placement and restores the latest viewport

- **Preconditions**: Isolated Electron profile and a local responsive page
  taller than the visible browser viewport. No provider account is needed.
- **Steps**: Start a full-page screenshot for pages taller than 2048px and
  verify proportional scaling to at most 1280×2048 output pixels. Keep one
  capture pending while resizing the browser hole twice. Repeat with raw
  `Page.captureScreenshot`, which retains caller-supplied capture settings.
  While a capture is pending, maximize, restore, enter fullscreen, and leave
  fullscreen so the panel moves or changes size. Also queue overlapping
  captures, switch resource tabs, hide and restore a captured page, fail a
  capture, close a tab with a queued capture, and recreate a destroyed guest.
- **Expected**: Full-page Browser captures are proportionally bounded to
  1280×2048; viewport captures are unchanged. During capture, the native guest
  follows the panel's current position and remains clipped within its bounds;
  it never covers the conversation. Its capture-time viewport stays stable
  until completion, then `innerWidth`/`innerHeight` match the latest requested
  bounds. Captures on one page serialize without blocking a sibling page.
  Failed capture releases resize handling. Hiding or closing a page cannot
  expose it or redirect its queued capture to another page. A destroyed guest
  leaves no orphan native view when it is recreated or disposed. No screenshot
  is repeated to repair layout.
- **Image failure recovery**: If a full-page image cannot be normalized, the tool
  result keeps its screenshot path/text and replaces the image with an omission
  message; the failed image is absent from later model requests.
- **Timeout recovery**: When either screenshot API does not complete within
  30 seconds, it fails with `TIMEOUT`, detaches the stalled CDP session, and
  releases the page queue; the next capture reattaches and can run.
- **Status**: Native Electron capture/resize and pending window-transition
  placement path automated by
  `node scripts/e2e-browser-capture-resize.mjs` (artifacts retained). The
  production Host/Pane/CDP service paths for failure, queueing, tab closure,
  guest recreation, and relocated-panel clipping are covered by
  `apps/desktop/test/browser-capture-resize.test.mjs`.

## E2E-BROWSER-session-preview-race: Session switching does not expose a stale preview

- **Preconditions**: Two sessions have distinct HTML previews; their Browser
  panel contexts are retained independently. Directory lookups and document
  loads can be delayed independently by the fixture.
- **Steps**: Preview A; produce B's preview in the background; collapse A's
  panel and open B; delay B's directory lookup and load, then return to A.
  Switch rapidly B → C and finish the older B lookup last. Repeat with an
  already-started old load, an empty session, a failed load, and disposal.
- **Expected**: Background B does not navigate A. On switching, no A document
  appears in B's panel, even after bounds/visibility updates. Only the latest
  navigation can reveal the guest; the late B lookup cannot replace C.
  Returning to A restores A, while an empty session remains empty. Closing or
  disposing cannot be undone by a delayed completion. Same-session navigation
  keeps its current page visible. Invalid, failed, or timed-out loads do not
  report the previous document as the destination being ready. A switch that
  exceeds the 15-second main-frame wait stays hidden with an error until retried.
  Slow images/subframes do not delay revealing a committed current document.
  Start navigation during an unfinished page load: the old ERR_ABORTED event
  must not prevent the new address, title, and loading state from updating.
- **Specs linked**: `04-ux/08-component-spec.md` §5.3; ADR 0028, ADR 0170.
- **Status**: Automated service-path coverage in `browser-host-session.test.mjs`
  and `browser-pane-navigation.test.mjs`: production BrowserHost/BrowserPane,
  controlled native-browser/Host boundaries, and deterministic timers. Native
  Electron compositing and the reporter's live sessions are not covered.

## E2E-BROWSER-responsive-resource-tabs

- **Preconditions**: Browser enabled; isolated profile; local HTML with a
  17-second image, a delayed main response, and ordinary/new-window links.
- **Steps**: Submit the slow-image URL once; observe loading feedback and page
  display before the image finishes. Open two chat links and a website
  new-window link; switch tabs, navigate within one, then switch away and back.
  Repeat with a delayed main response, Stop, failed navigation, and a retry.
  Set Link open destination to External and repeat the new-window link.
- **Expected**: The current document displays after main-frame commit; slow
  assets do not strand the empty state. New links preserve earlier resource
  tabs. Tab switching retains forms, scroll positions, JS state and independent history
  without another page request. Each tab keeps its last address; same-tab navigation updates only its
  originating tab. Failure/stop leave usable address controls. External mode
  does not create a work-panel tab. Session switches and invalid schemes retain
  their security and visibility gates.
- **Additional paths**: Invoke BrowserPreview through ToolSearch/BrowserPreview
  while a tab has unsent form input: only a new host-owned page navigates, before
  its renderer tab mounts. Navigate for an inactive session and verify immediate
  execution in its connected page without changing the visible one. Open a blank
  tab and inspect its empty address and state. Close a background tab and verify its WebContents is
  destroyed without affecting its sibling; deleting a session and plugin/window
  disposal release the appropriate retained pages.
- **Status**: Targeted isolated Electron validation; no new repository test suite.

## E2E-BROWSER-in-page-navigation: Browser chrome follows same-document navigation

- **Preconditions**: Browser plugin enabled; a local page has a fragment link
  and a History API route control.
- **Steps**: Open the page; click the fragment link; change the route with
  `history.pushState`; use Back, Forward, and Reload. Switch to another session
  and verify late events from the old page cannot update the new preview.
- **Expected**: The address matches the main document URL and history buttons
  reflect its history. Loading settles back to Reload. Subframe, replaced-frame,
  and invalidated-session events cannot change the toolbar.
- **Coverage**: `browser-pane-navigation.test.mjs` for published state and event
  isolation; native Electron click-through for actual same-document events.
- **Specs linked**: `04-ux/08-component-spec.md` §5.3.

## E2E-BROWSER-background-lifecycle: Side-panel presentation does not own page execution

- **Preconditions**: Dedicated worktree, reused Electron/toolchain, isolated
  profile and localhost A/B/C pages. No real account or paid provider requests.
- **Steps**: Snapshot A, switch to B, fill and click A through production CDP,
  then start a new hidden screenshot. Detach presentation, reload the renderer,
  repeat A's snapshot/screenshot and restore its tab. Open a first C preview
  before UI mounting. Close C and try unknown/closed targets. Exercise every
  Browser API through real concurrent plugin invocations with spoofed argument
  identities. Restore missing renderer tabs while the panel is collapsed.
- **Expected**: A's actions, pixels and screenshot path belong to A; B is
  unchanged and remains the only visible guest. No background action reveals
  a page. Renderer reload retains native identity and inputs. C executes before
  mounting. Unknown/closed targets fail without fallback. Restored tabs are
  scoped, duplicate-free and do not reopen or replace a user's selected resource.
  Hidden backing hosts remain invisible and release with the last parked page.
- **Automation**: `node scripts/e2e-browser-background.mjs`,
  `browser-background-session.test.mjs`, `browser-tab-restore.test.mjs`,
  `browser-capture-resize.test.mjs`, and `plugin-tool-invocations.test.mjs`.
  The isolated Desktop trial also uses real Composer, sidecar, plugin and Host
  wiring with a localhost SSE model; no real provider is contacted.
- **Specs**: `04-ux/08-component-spec.md`, `07-plugins/03-plugin-api.md`,
  `05-security/01-security.md`, [background lifecycle ADR](../../../adr/browser-background-lifecycle.md).
- **Status**: Automated native Chromium/service paths; isolated Desktop trial passed.

## E2E-060: Files tab browsing stays inside the workspace

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

## E2E-095: Terminal failures expose recovery without a success card

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

## E2E-073a: Developer mode gates the developer-tools console

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

## E2E-083: Long streaming turns keep shell interaction responsive

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
  - Smooth text reveal on a simulated 120 Hz display commits no faster than
    60 Hz, and its animation frame loop stops after it catches up.
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
  - Within that same active turn, unchanged non-delegation activity groups do
    not render again just because text updates rebuild turn-wide delegation
    maps. Tool content changes still render; later TaskWait results update
    the original Task group's terminal status and completion duration.
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
- **Status**: Unit-covered (`interaction-performance.test.mjs`); automated
  React/Chromium render regression via `pnpm test:e2e:transcript` (no provider
  credentials; requires installed Electron and a graphical session, or Xvfb on
  Linux). It mounts production transcript components, counts ActivityGroup
  renders across 20 text updates with 100 completed groups, checks changed tool
  content, checks cross-part Task terminal status/timing updates, and exercises
  the production smooth-text hook against deterministic 120 Hz animation frames.
  The page links the app's built stylesheet, which the runtime-status scenario
  below measures real geometry against; full provider streaming and shell
  responsiveness remain Draft.

## E2E-263: Native interaction stays live during large transcript and tool-output rendering

- **Preconditions**: Isolated visible Electron window with the production
  `Markdown` and `ToolDetailBlocks` renderers and built app stylesheet. A
  separate local Node fixture emits ordered synthetic deltas; no provider, real
  Host, production session, or user data is used.
- **Steps**: Mount a 680 Ki-code-unit tool result, then stream a 90 Ki-code-unit
  unbroken message plus a final marker from the child process. Once the rendered
  message exceeds the streaming-tail threshold, use Electron
  `webContents.sendInputEvent` to click, move between tool-output pages, type
  into the draft, switch to another session and back, collapse and expand the
  transcript, and scroll while deltas continue. Finish the stream and compare
  every received source code unit, sequence number, final marker, and rendered
  source length.
- **Expected**: Every native action is acknowledged while streaming remains
  active, each completes within 250 ms, and the action P95 is at most 100 ms on
  the recorded environment. The independent producer advances all 180 sequence
  numbers in order; switching sessions does not move or lose the background
  stream, and the finished content retains the exact received source. The large
  tool result exposes page controls, renders one page at a time (at most 32 Ki
  code units plus one code unit where a surrogate pair crosses the boundary),
  and retains its final page marker.
- **Specs linked**: `04-ux/08-component-spec.md` §8.7, §9.6.
- **Status**: Automated by `pnpm test:e2e:renderer-responsiveness`. The parent
  Electron process drives native input under an external 25-second deadline;
  the renderer cannot self-report its own timeout. The fixture is deterministic
  and offline, not an incident replay or a claim about production-session root
  cause.

## E2E-AGENTS-001: Project instruction chain configures an agent session

- **Preconditions**: A project contains root `AGENTS.md`, nested
  `packages/api/AGENTS.md`, and a provider is configured.
- **Steps**:
  1. Start an Agent-mode conversation and submit a task covered by the root
     instruction.
  2. Let the agent read or edit `packages/api/handler.ts`.
  3. Have the agent read an attachment outside the project root.
  4. Add `packages/api/AGENTS.override.md`, then have the agent access another
     file in that directory.
  5. Edit the root instruction while the session is idle, then submit a
     follow-up task.
- **Expected**: The initial runtime receives the root chain. Before the file
  tool executes, the nested instruction is appended after its root source and
  therefore takes precedence. In one directory, `AGENTS.override.md` wins over
  `AGENTS.md`; `CLAUDE.md` and `.claude/CLAUDE.md` are fallback names. The idle
  follow-up uses changed root content rather than reusing the prior runtime.
  Empty, unreadable, oversized, and out-of-root instruction files do not block
  the turn; the global file and the project chain each have an independent
  32 KiB UTF-8 budget, an oversized global file does not remove project
  entries, and a truncated file ends with a notice naming its source and the
  loaded and total byte counts. A file tool whose target
  is outside the project root, or targets the root itself, keeps the root chain
  rather than clearing the project instructions; instruction files are still
  read only from inside the root. A fixture-backed sidecar run verifies that a
  nested read applies nested rules and a following attachment read restores the
  root rules without loading an outside `AGENTS.md`. If path-specific resolution exceeds its
  two-second deadline or the host is unavailable, the
  file tool continues with the base chain and does not retain a sibling
  directory's rules. Repeated file tools in the same directory during one
  prompt reuse one path-resolution claim; the next prompt resolves again so
  changed instruction files are observed. The resolver uses the session-bound
  project root passed at runtime launch and does not issue a per-file
  `session.get` RPC.
- **Specs linked**: `03-runtime/02-agent-runtime.md`
- **Acceptance**: C (chat/stream), F (persistence)
- **Milestone**: M5
- **Status**: Resolver and runtime behavior are automated in
  `project-instructions.test.ts` and `runtime.test.ts`; the fixture-backed
  sidecar scenario runs through `pnpm test:e2e:hosted-search`. The broader full
  provider/UI journey remains Draft.

## E2E-093: Mutating tools serialize and recover from stale edit context

- **Preconditions**: A project-bound Agent session has a writable workspace;
  the provider fixture can emit two same-session `Write`/`Edit` calls in one
  tool batch; a second edit can be given a stale `tag`; a Bash command can
  return a non-zero exit code with diagnostics.
- **Steps**:
  1. Start a task that emits two mutations for the same session while also
     emitting independent read/search calls.
  2. Inspect the key tool result and transcript while the first mutation runs.
  3. Force the second `Edit` to carry a `tag` that no longer hashes the file,
     with anchors that recovery cannot remap, then allow the agent to re-read
     the file and retry from the current contents.
  4. Run a Bash command that exits non-zero and inspect its tool result and
     inline state.
  5. Repeat with an `ops` payload whose ranges overlap.
  6. If the task uses a dedicated worktree outside the advertised workspace,
     verify its guarded Bash edit and resulting `git diff`.
- **Expected**:
  - Read/search calls may overlap. A session may execute two independent
    identified local writes with validated batch tickets; conservative writes
    remain exclusive within the session. Queued mutations consume no global
    mutation capacity while waiting; total running writes stay bounded by two.
  - The stale-tag edit fails without changing the file and returns
    `EDIT_TAG_MISMATCH` carrying the live tag and current content at the
    anchors; the overlapping-range payload fails with `EDIT_RANGE_INVALID`
    before any write.
  - The non-zero Bash command is marked failed while retaining its exit code,
    stdout, and stderr for the agent and diagnostics.
  - The retry performs one fresh read and operates on the current file; once
    that path has spent its recovery graces, the third counted same-path failure
    — or a third failed shell patch command — returns a terminating tool result
    plus a visible `MUTATION_RETRY_BUDGET_EXHAUSTED` row, stops the mutation
    workflow, and does not repeatedly modify an old patch artifact or its hunk
    headers.
  - The final file contains exactly the intended change, and diff/review data
    contains no partial or interleaved mutation.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md`,
  `03-runtime/06-host-rpc-protocol.md`, `03-runtime/08-error-codes.md`
- **Acceptance**: E (tools & permissions), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`tool_budget.rs`, `tools/mod.rs`,
  `agent-runtime/runtime.test.ts`); full provider/UI journey Draft

## E2E-112: Selectable shell catalog persists the default

- **Preconditions**: Host has an available platform catalog entry, a fixture can
  make a persisted choice unavailable, and a project-bound Agent session is
  idle. The Windows lane exercises the multi-choice ordering.
- **Steps**: 1) Inspect the catalog for the platform-valid IDs
  `windows-powershell`, `windows-pwsh`, `cmd`, `git-bash`, and `bash`. 2) Verify settings
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

## E2E-113: Stale shell identity fails closed

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

## E2E-114: Bash streams stdout and stderr independently

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

## E2E-115: Bash timeout uses 60 seconds and a bounded override

- **Preconditions**: A selected shell can run a command longer than 60 seconds;
  host clock is observable.
- **Steps**: 1) Run without a timeout override. 2) Observe the 60-second
  deadline. 3) Run with an in-range override including values above 300
  seconds. 4) Submit zero, negative, and over-21,600-second overrides.
- **Expected**: Missing timeout uses exactly 60 seconds and returns
  `TOOL_TIMEOUT` after process-tree shutdown; the error names the effective
  `timeoutMs` budget and suggests raising it or splitting the command. In-range
  values work within 1–21,600 seconds; out-of-range values fail validation and
  never spawn.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md`,
  `03-runtime/06-host-rpc-protocol.md`, `03-runtime/08-error-codes.md`,
  `03-runtime/16-tool-result-limits.md`, `05-security/01-security.md`, ADR 0054,
  ADR 0167
- **Acceptance**: E (tools), H (diagnostics), Security
- **Milestone**: M6
- **Status**: Automated (passed 2026-08-04): long-timeout `test:e2e:plan`
  measured the no-override timeout at 60,024 ms and verified in-range plus
  invalid bounds without delayed marker writes

## E2E-116: Bash abort shuts down the complete process tree

- **Preconditions**: A Bash command starts a child and grandchild that emit
  delayed output; the originating session is running.
- **Steps**: 1) Start the command. 2) Abort the active turn. 3) Inspect process
  descendants, output events, audit, and turn state after the shutdown grace.
- **Expected**: The process group/job tree is terminated, no descendant remains,
  no later output arrives, the turn returns `TURN_ABORTED`, and the workspace is
  not rolled back automatically. On Windows, the hidden runner requests
  `CREATE_BREAKAWAY_FROM_JOB` only when the job that contains the host grants
  `JOB_OBJECT_LIMIT_BREAKAWAY_OK`, then enters its own kill-on-close job. A host
  job that withholds breakaway leaves the runner in a nested job instead of
  failing the tool closed; termination is still scoped to that job, so the
  Desktop tree never becomes the termination scope.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md`,
  `03-runtime/07-process-model.md`, `03-runtime/08-error-codes.md`,
  `03-runtime/16-tool-result-limits.md`, `05-security/01-security.md`, ADR 0054
- **Acceptance**: C (abort), E (tools), H (diagnostics), Security
- **Milestone**: M6
- **Status**: Automated (passed 2026-08-04): `test:e2e:plan` aborts a real
  descendant process tree and verifies no late marker/output; host-core tests
  verify cancellation registry cleanup

## E2E-265: Background Bash tasks outlive their turn

- **Preconditions**: A project session whose catalog shell supports background
  execution, and a port the test server may bind.
- **Steps**: 1) Ask the agent to start a long-lived process with
  `runInBackground` (a local web server) and watch the running-tasks bar above
  the composer. 2) Abort the turn, send a second prompt in the same session,
  then reload the renderer. 3) Expand the row's `Output`. 4) Press `Stop`.
  5) Start ten tasks with 100,000 lines of 100 characters on both streams,
  then inspect their final output. 6) Show Todo and Ask alongside the task list
  at wide and narrow widths, scroll to the tenth task, and switch output previews
  while an earlier read is pending. 7) Fail a Stop request and retry it.
  8) Start two more tasks and quit the app during output capture.
  9) Start a quiet task with a long, multiline command. Expand its row at
  a narrow width and select the command through its final line.
- **Expected**: The tool result carries `backgroundTaskId` and resolves without
  waiting for the command; the bar lists the task as running with a growing
  elapsed time and shows its streamed output; the process stays alive across the
  abort, across the 60-second Bash timeout, and across a renderer reload.
  `Stop` settles the row to `Stopped` and kills the process tree; quitting the
  app leaves no orphan process behind. The ten-task list scrolls within its
  height cap without displacing Todo, Ask, or input. Only the selected log is
  fetched and refreshed; old responses cannot erase it. Each stream remains
  bounded to 256KiB and retains its final marker after exit. A Stop failure is
  visible without an unhandled rejection and the control remains retryable.
  The task header stays on one line. The expanded row shows the complete
  command above the output, preserving whitespace and wrapping to fit even
  before the task produces any output.
  An ended task's row leaves the bar as soon as its end state arrives — only
  the row whose output preview is open stays (the auto tab rule never switches
  the panel away from an open read), and the pin ends when its preview leaves
  the screen — collapse, or a switch to Todo — unless the task still runs: a
  running task's preview survives the switch, while a task that ends while
  hidden takes its row with it — and the tab badge falls with
  the running count, so finished commands do not accumulate above the
  composer (#2632, #2634).
- **Specs linked**: `03-runtime/03-tools-and-permissions.md` (§5),
  `03-runtime/06-host-rpc-protocol.md` (§4)
- **Acceptance criterion**: C, E, F
- **Milestone**: M6+
- **Status**: Partially automated (host-core `background_tasks::tests` and the
  renderer contract test `apps/desktop/test/background-tasks.test.mjs`;
  `node scripts/e2e-background-tasks-host.mjs` runs the real Host/process/pipe
  stress path without providers, and `node scripts/e2e-background-tasks.mjs`
  exercises production React components in isolated Electron at 1280px, 700px,
  and 390px widths. Host tests cover exit-before-drain and shutdown under output
  lock contention. The full agent-to-Desktop journey and an 83-minute paced
  100,000-line soak remain manual; the automated volume test is accelerated.
  Renderer visibility (live rows, close action, pinned output preview) is
  covered by `apps/desktop/test/background-tasks-bar-visibility.test.mjs`; the
  multi-second hand-off itself is not timed in Electron.)

## E2E-REVIEW-append-state: Rolling back a historical tool card does not rewrite its session

- **Preconditions**: An isolated real Host process, a temporary workspace with
  a file changed by `Write`, and a transcript with 16 MiB of synthetic retained
  tool output after the review-owning message. Use `--large` for 384 MiB.
- **Steps**: Run `review.rollback`, compare the transcript prefix hash and
  appended bytes, read the review with a one-message `messageAround` window,
  read the tail, restart the Host, and retry the same rollback.
- **Expected**: Workspace bytes are restored. The original transcript prefix
  is unchanged and fewer than 256 bytes are appended. The selected card reads
  `rolledBack` before and after restart, its original position and the last
  message remain correct, and message count is unchanged. Retrying returns
  `alreadyRolledBack` without appending another state record.
- **Specs linked**: `03-runtime/04-data-storage.md` §2.0; ADR
  [append-only-review-state](../../../adr/append-only-review-state.md).
- **Acceptance**: C (conversation), F (persistence), Quality.
- **Milestone**: M6.
- **Status**: Automated by `pnpm test:e2e:review-state`; set
  `PI_DESKTOP_HOST_BIN` to the candidate Host binary. No provider or user data
  is used. `transcripts::review_state_tests` additionally covers duplicate IDs,
  snapshot isolation, disk cache reuse, intentional rewrites and torn appends.
  `equal_length_state_appends_replay_in_file_order_across_cached_reads` pins
  file-order precedence for equal-sized state appends through warm and cold
  layouts. `truncate_from_folds_review_state_into_the_retained_prefix` verifies
  that a later truncate removes the state log while retaining the effective
  state in the surviving canonical tool message.
  This validates the review-state trigger in #1836; it does not assert Windows
  UI timing or eliminate full rewrites for deliberate history replacement.

## E2E-145: Tool results read as structured blocks, never JSON

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
  - A Read row's collapsed chip shows the returned window as
    `{lineCount},L{offset+1}-L{offset+lineCount}` (for example,
    `50,L16-L65`), never `fileBytes`; a Read result without valid window
    metadata has no size chip. Write continues to show its byte-size chip.
  - Each Glob/Grep path-list row is start-aligned with natural character
    spacing; glyphs are not distributed across the block width.
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

## E2E-102: Composer file and image paste keeps structured attachment metadata

- **Preconditions**: The app is running with an Agent session in a project and
  a home composer available. The OS clipboard contains a text snippet no
  longer than the configured large-paste threshold, one or more local files
  (including a filename with whitespace), and an image in separate paste
  attempts. Record the app data directory and the session id.
- **Steps**:
  1. Paste text-only within the configured threshold and confirm editable text.
     Copy a Word selection with text plus a generated image representation;
     confirm text wins, including multiline/CRLF, blank/trailing lines, literal
     `<>&` and quotes, replacing selections across line breaks/attachment chips,
     caret position, and native undo/redo.
     Repeat above the threshold and confirm a TXT chip rather than an image.
     Paste a real native image file with accompanying filename text and confirm
     it remains an image attachment.
  2. Paste one local file, then paste multiple files including a spaced name.
  3. Paste an image from the OS screenshot/clipboard provider.
  4. Inspect the draft before sending: confirm each materialized item is a
     removable leaf-name chip and no scratch absolute path occupies the
     textarea. Hover/focus chips to inspect their full paths, remove one, then
     send the prompt and inspect the session message's attachment metadata.
    Before sending, verify each image is a compact inline chip in the draft and
    that hovering it reveals its preview card. Replacing all text removes the
    inline image chips while undo restores them; image-only drafts must survive
    session switching and retain submission metadata.
    Mount the complete Composer: click Send for image-only input, verify
    attachment delivery and successful clearing, and immediately reject a
    text-plus-image send to verify full draft restoration. In a narrow pane,
    prefill 20 images, confirm 20 inline chips inside the composer, and remove
    one without losing the others.
    Send a prompt that puts text, an image, then more text in that order:
    confirm the sent message renders the image chip at that position instead of
    after the body, and that an image the draft did not name inline still
    follows the text. The provider-facing prompt keeps the same order; the
    runtime placement tests assert those content blocks.
    Inspect the chip and open it with click, Enter, and
     Space. Confirm a centered modal preview opens, the work panel stays
     unchanged, and the draft is neither edited nor sent. Check small images
     stay at natural size, wide images fit without distortion, zoom/reset and
     download target the selected original, and multiple images support button
     and arrow-key navigation with zoom reset. Drag at fit size and after zoom,
     including releasing outside the image; check cancellation and ordinary wheel
     panning. Fit and image navigation must reset position; dragging must not
     dismiss the preview or leave capture active after close/session changes. Close with Escape, the close
     button, and blank space; verify focus/caret restoration and modal focus
     containment. Native plugin surfaces must hide while the preview is open.
     Repeat without a project. Remove an attachment; it must neither preview
     nor send. Switch session/project or remove the selected attachment during
     a delayed read; the old preview must close and late results must not
     overwrite a newer image. Missing/undecodable images show retry and keep
     the draft. Text chips must still expand as editable text.
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
  - Image preview preserves the draft and attachment metadata, uses
    `fs/readImageDataUrl` with bounded reads and path containment, and works
    without a workspace for allowed scratch files. Preview preserves the draft
    attachment format and leaves work-panel tabs unchanged. Closing/unmounting
    releases modal/native-view blocking.
  - Deleting the session removes the pasted files with the rest of scratch.
  - Deleting text immediately before an inline file chip must not insert a
    blank line or move the chip to the next line; native undo/redo stay intact.
- **Specs linked**: `04-ux/08-component-spec.md` §11.7–11.8,
  `03-runtime/01-ipc-protocol.md` §13c,
  `03-runtime/03-tools-and-permissions.md` §4b,
  `03-runtime/04-data-storage.md`, `08-meta/decisions-log.md` (D197, D209,
  D243, D392), ADR 0059, ADR 0070, ADR 0101, ADR 0218
- **Acceptance**: C (conversation & stream), E (tools & permissions),
  F (persistence), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`composer-paste-files.test.mjs`,
  `composer-clipboard.test.mjs`, `composer-native-deletion.test.mjs`);
  `prompt-inline-attachments.test.mjs` covers where an inline image's `@path`
  is recorded and that a replayed fallback copy still travels,
  `session-message-presentation.test.mjs` renders the row order, and
  `packages/agent-runtime/src/runtime.test.ts` asserts the prompt content
  blocks. `pnpm test:e2e:composer-paste` mounts the real
  ComposerInput, draft/paste hooks, file viewer, production CSS and sandboxed
  preload. It dispatches Chromium ClipboardEvents with synthetic mixed data
  and native File objects, exercises the real scratch writer and contained
  file reader, compares saved bytes and decodes the preview image. Requires
  a desktop build, installed Electron and a graphical session (Xvfb on Linux).
  It does not modify the OS clipboard or automate Word; Word/platform journeys
  and full provider dispatch remain manual. Run against the refreshed request
  candidate and record its revision; PR integration validation follows the
  authoritative `AGENTS.md` workflow without merging into local main first.

## E2E-102h: Composer picker imports files into session scratch

- **Preconditions**: The app is running with a home or Agent composer and a
  durable session. The native picker can select a text file and an image outside
  the active workspace.
- **Steps**: 1) Click the Composer `+` button twice in quick succession;
  confirm that only one native file picker opens, directly without an
  intermediate type-choice menu. 2) Select both
  fixtures. 3) Inspect the draft chips and send a prompt asking the agent to
  read the text fixture and identify the image marker. 4) Inspect the renderer
  request, session transcript, and the session scratch directory.
- **Expected**: While the native picker or its renderer import is in flight,
  repeated `+` clicks are ignored. While the native picker is open, the main
  process rejects duplicate picker requests instead of opening another dialog.
  The native picker returns a short-lived one-shot token, never a
  source absolute path, and the selections are copied into
  `<data_dir>/scratch/<sessionId>/pasted/` before they enter the draft. The app
  classifies each selected item from its MIME/extension metadata, so the same
  picker handles both regular files and images. Chips show sanitized leaf names
  while prompt attachments reference only the copied paths; the workspace is
  unchanged. The agent can call `Read` on the text fixture, and a
  vision-capable model receives the image as an image block. Durable messages
  retain metadata and refs only, never the source absolute path or binary bytes.
  The file picker does not offer directory selection; missing files,
  expired/replayed tokens, and oversized files return a visible IPC error and
  write nothing.
- **Specs linked**: `03-runtime/01-ipc-protocol.md` §13c,
  `03-runtime/04-data-storage.md`, `04-ux/08-component-spec.md` §11.7–11.8,
  ADR 0059, ADR 0101, ADR 0218
- **Acceptance**: B (model config), C (conversation & stream), E (tools &
  permissions), F (persistence), Security, Quality
- **Milestone**: M5
- **Status**: Unit-covered (`apps/desktop/test/composer-paste-files.test.mjs`);
  provider/UI journey Draft (run only in a capable environment when this surface changes)

## E2E-102i: Composer accepts native file and folder drops

- **Preconditions**: The app is running with an Agent session and a visible
  Composer. The OS file manager exposes one regular file, one folder, and a
  mixed multi-selection; place the caret in the middle of a non-empty draft.
- **Steps**: 1) Drag the regular file over the Composer and observe the target
  outline, then drop it. 2) Drag the folder into the same draft. 3) Repeat with
  a mixed file/folder selection while the caret is between existing text. 4)
  Inspect the draft, remove the file chip, and send the prompt. 5) Inspect the
  saved scratch file and the persisted user message.
- **Expected**: File-system drag-over prevents the browser default and marks
  the whole Composer shell without layout movement. Regular files are saved
  through the existing bounded session-scratch bridge and appear as removable
  leaf-name chips; folders are not read, copied, or traversed, and their full
  native paths appear at the caret as `@<path>/` literal directory references.
  Mixed drops preserve OS order, retain surrounding text, and restore the
  caret after asynchronous file saving. Sending keeps the file's existing
  attachment metadata/path behavior and the folder path as prompt text; no
  workspace files are created.
- **Specs linked**: `04-ux/08-component-spec.md` §11.5–11.8,
  `04-ux/09-interaction-patterns.md` §8.2/§8a.2,
  `03-runtime/01-ipc-protocol.md` §13c, ADR 0059, ADR 0070, ADR 0222
- **Acceptance**: C (conversation & stream), F (persistence), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`apps/desktop/test/composer-drag-drop.test.mjs`);
  full desktop gesture journey Draft (run only in a capable environment when this surface changes)

## E2E-102a: Composer file reference results show leaf names with full relative paths

- **Preconditions**: The app is running with an Agent session in a workspace
  containing nested files, duplicate leaf names in different directories, and
  a directory whose name contains whitespace.
- **Steps**: 1) Type `@` and filter to the nested and duplicate entries. 2)
  Inspect the visible rows, then hover for full-path tooltips and inspect their
  accessible names. 3) Accept a file with Enter and confirm a leaf-name chip
  remains in the draft at the caret while the `@` token and full path stay
  hidden. Accept a second file with Tab or click. Accept a directory result
  and continue to a child file. 4) Send the completed references and inspect
  the persisted user message.
- **Expected**:
  - Each result persistently renders its leaf name followed by the entry's
    complete workspace-relative path in a de-emphasized span; directories
    retain a trailing `/` on the leaf name, the span carries the raw
    `entry.path`, and it ellipsizes before the leaf name can while the row
    never overflows the menu.
  - The tooltip and accessible name retain the complete relative path so
    duplicate leaf names remain distinguishable.
  - In a Git workspace containing accented, CJK, and emoji file names,
    indexing and filtering retain each name exactly, including when Git's
    stdout chunks split a UTF-8 character. Accepting the result names the
    existing file, without replacement characters in its path.
  - Enter/Tab/click on a file replaces the `@` token with an inline chip that
    stays in the draft; that key does not send. File acceptance retains the
    original complete `entry.path` behind the chip; directory acceptance
    retains literal path continuation. At dispatch the sent and persisted
    prompt contains each complete path with existing whitespace quoting, and
    the agent can read both selected files normally.
- **Specs linked**: `04-ux/08-component-spec.md` §11.8,
  `04-ux/09-interaction-patterns.md` §8a, `03-runtime/01-ipc-protocol.md` §13c,
  `08-meta/decisions-log.md` (D124, D209, D362, D660), ADR 0024, ADR 0070
- **Acceptance**: C (conversation & stream), Quality
- **Milestone**: M5
- **Status**: Unit-covered
  (`apps/desktop/test/composer-file-reference-display.test.mjs` and
  `packages/host-runtime/src/fs-index-encoding.test.ts`); Unicode filtering and
  file acceptance run in `composer-deep-file-search-user-path.test.mjs`; file-mode row
  layout covered by `scripts/e2e-composer-autocomplete.mjs`; full UI journey
  Draft (run only in a capable environment when this surface changes)

## E2E-102b: Unanswered Stop restores compact file-reference drafts

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
  full UI journey Draft (run only in a capable environment when this surface changes)

## E2E-102g: Large text paste becomes an inline session-scratch reference

- **Preconditions**: The app is running with an Agent session in a project and
  a home composer available. The large paste threshold is first left at its
  default, then changed to a small test value. Record the app data directory,
  session id, and a multiline Unicode text fixture.
- **Steps**:
  1. Open Settings → Conversation → Input & links and confirm the large paste threshold is
     600. Set it to a deterministic lower value, save it, then return to the
     composer.
  2. Paste text exactly at the threshold and confirm native textarea behavior;
     paste text one character above it at the beginning, middle, and end of
     drafts, including multiline and Unicode content.
  3. Inspect the draft after each oversized paste: confirm the exact prefix and
     suffix remain, a generated `pasted-text-*.txt` chip appears at the original
     selection, the editor does not contain the scratch absolute path, and the
     composer reports its busy/error state correctly during the transfer.
  4. Click the generated TXT chip and repeat with keyboard focus plus Enter and
     Space. Confirm the exact UTF-8 contents replace the chip at its position,
     the text is editable, the caret lands after it, and subsequent send uses
     the edited text. While a read is pending, switch drafts or remove the chip
     and confirm a stale response does not change the current draft.
  5. Inspect the session `scratch/<sessionId>/pasted/` file bytes, send a mixed
     draft that still contains a chip, and inspect the renderer request,
     persisted user message, and agent-readable path. Switch projects and
     sessions before sending a cached draft, then remove the chip and confirm it
     is no longer dispatched.
  6. Delete the owning session and confirm its temporary paste files are
     removed.
- **Expected**:
  - The threshold is persisted as an AI default, defaults to 600 on older
    settings, and accepts only integer values from 1 through 1,000,000.
  - Text at or below the threshold remains native. Text above it is saved
    byte-for-byte as UTF-8 `text/plain` under the owning session's scratch
    `pasted/` directory, without changing the project or creating an artifact.
  - The sentinel-backed TXT chip is inserted at the exact paste selection,
    including in the middle of a multiline draft. Clicking or pressing Enter /
    Space expands it to editable exact text and removes its reference; edits
    made afterward are what dispatch sends. A failed, binary, image, or
    oversized read leaves the chip and mapping intact.
  - Any remaining chip is resolved to its canonical path in place exactly once;
    it is neither appended as a basename nor duplicated as an attachment.
    Removing the chip removes that mapping.
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
  (run only in a capable environment when this surface changes)

## E2E-153: The vendored file manager replaces the built-in Files tool

- **Preconditions**: A packaged build (so `resources/plugins` is copied outside
  the asar) and a project with nested directories, a `node_modules`, a `.env`,
  a binary file, an image, a CSV, and a Markdown file. The project is a group
  whose second folder is registered as another root (ADR 0249).
- **Steps**:
  1. Open the Plugins page. Confirm **File Manager** is listed as a bundled
     plugin, enabled, showing a work-panel-views capability, and that it offers
     no Uninstall action.
  2. Reveal the work panel and click `+` to create a New launcher tab. Confirm
     its rows include Review and the plugin-contributed File Manager and Browser
     views. Trigger an agent edit and confirm the panel does not open itself:
     Review appears under Open resources only after the user selects its row.
  3. Open the File Manager view. Confirm the tree lists the project, expands
     directories lazily, and omits `node_modules`, `.git`, and `.env`. Switch
     the view's top-left folder control to the project's second folder and
     confirm the tree follows it while the app's visible workspace does not,
     then switch back to the project's primary folder.
  4. Right-click an HTML file and confirm **Open in built-in Browser** appears
     under Open With. Select it and verify a new Browser resource tab opens the
     file in the active local session while the File Manager tab remains open.
     Right-click a non-HTML file and confirm that item is absent. Confirm
     **Open with default app** and **Show in folder** remain available for files
     and work. For directories, confirm the built-in Browser and Show in folder
     actions are absent, the default-app action is disabled, and editor choices
     remain available.
  5. Open a text file, edit it, and save. Confirm the file on disk changed and
     the editor keeps the saved content. In dark appearance, press `Ctrl/Cmd+F`
     and confirm the find text, replace text, and action labels remain readable
     against their themed fields and buttons; repeat after switching to light
     appearance. Change the same file outside the app, edit and save again, and
     confirm the conflict is reported instead of the external change being
     overwritten. Click the binary file and confirm it reports as unsupported
     rather than printing replacement characters; open the image, the CSV, and
     the Markdown file and confirm each gets its own viewer. Switch the app to
     Simplified Chinese and confirm the tree, viewer, and context menu are
     localized. Switch projects and confirm the tree updates without waiting on
     a poll.
  6. Click a project file path in the conversation. Confirm it opens in this
     view on that file — a chat click now prefers the file view over the host
     `file:` tab.
  7. Click a conversation reference to `src/example.ts:42`. Confirm the host
     `file:` tab opens at line 42 even though the File Manager plugin is enabled.
  8. Disable the File Manager plugin. Confirm the view disappears from the menu
     and the panel. Click a project file path in the conversation; the host
     should enable the bundled plugin and open that file in its view.
  9. Restart the app. Confirm the enabled state and the tree return, and that
     the registry did not gain a duplicate row.
- **Expected**: A panel surface runs entirely on the public plugin contribution
  channel, is user-disableable, cannot be uninstalled, and survives restart. Its
  host-mediated actions obey the declared `fs.read` scope, and its own reads and
  writes stay inside the jail of the one project folder it is browsing
  (ADR 0241, ADR 0263). Plain project-file links open in the bundled view,
  bringing it up on demand after a direct click when its scope and permission
  allow it; a positioned `path:line` reference opens the host file tab and
  scrolls the requested line even while the plugin view is available.
- **Specs linked**: `07-plugins/03-plugin-api.md` §3,
  `07-plugins/13-plugin-permissions-matrix.md` §2,
  `04-ux/08-component-spec.md` §5, ADR 0104, ADR 0109, ADR 0111,
  ADR 0169, ADR 0241, ADR 0249, ADR 0263, ADR 0330
- **Acceptance**: G (plugins), D (workspace), Security, Quality
- **Milestone**: M6+
- **Status**: `pnpm test:e2e:file-manager-theme` loads the shipped plugin view
  in Electron, opens a text file through a fixture public bridge, invokes
  `Ctrl/Cmd+F`, and checks the rendered find/replace fields and actions in dark
  and light appearances. `apps/desktop/test/bundled-plugins.test.mjs` also
  covers the manifest contract, public-bridge-only page, vendored checksums,
  and themed CodeMirror controls. `apps/desktop/test/plugin-fs-scope.test.mjs`
  covers `fs.openDefault`, `fs.openInBrowser`, and `fs.reveal` guards;
  `apps/desktop/test/browser-preview-tool.test.mjs` covers Browser resource-tab
  event routing; `apps/desktop/test/plugin-work-panel-views.test.mjs` covers
  docked-view event broadcast; and host-core covers
  `bundled_plugins_refresh_from_disk_but_keep_user_state`. The remaining
  packaged journey is Draft (run only in a capable environment when this
  surface changes).

## E2E-PROJECT-delete-removes-project-and-owned-sessions

- **Preconditions**: three durable projects A, B, and C, each with at least one
  session that has a transcript; A archived and retained as a sidebar tab; B the
  active workspace; C a root of a stored two-folder project group.
- **Steps**: open Settings → Project archive, choose Delete project for A, and
  verify the confirmation dialog appears before anything is removed. Press X
  and verify A remains. Reopen the dialog and explicitly confirm. From the
  sidebar project menu, repeat for active project B: choose Delete project,
  cancel, verify B remains, then reopen and confirm. Then attempt the same
  action for C, a path the host no longer knows, and a fourth project D while
  one of D's tasks is still running.
- **Expected**: choosing Delete immediately opens the dialog for idle projects
  on both surfaces. X, Cancel, Escape, and backdrop clicks dismiss it without
  removing the project, sessions, or transcripts. The dialog names the project,
  states that its sessions and transcripts are removed permanently, and says
  the folder on disk is untouched. After explicit confirmation, the durable
  project row, owned sessions, transcripts, scratch and review files, and
  project memory are gone. The project disappears from Settings → Project
  archive and the sidebar immediately and after reload, with no retained tab,
  recent-project entry, session-derived row, or stale pin/archive/order
  preference. Other projects' sessions and transcripts are untouched. If the
  deleted project was active, the workspace falls back to another open project
  or Temporary, and the next launch does not reopen its path. A project whose
  folder was moved or deleted on disk is still removable. Deleting C is refused
  with a message and leaves the group unchanged; an unknown host path is removed
  from the archive and sidebar without a missing-project error. Deleting D
  while its task runs opens the same dialog with the running sessions named and
  a stop-and-delete confirm label; cancelling leaves it and its task untouched,
  while confirming stops exactly those turns before deleting D (see
  E2E-PROJECT-delete-running-sessions-are-named-and-stopped).
- **Specs linked**: `03-runtime/06-host-rpc-protocol.md` §Projects,
  `03-runtime/04-data-storage.md`, `04-ux/08-component-spec.md` §3.9, ADR 0251
- **Acceptance criterion**: D (workspace), F (persistence), Quality
- **Milestone**: M6+
- **Status**: Partially automated — `pnpm test:e2e` covers the host contract
  (project row, owned sessions, on-disk transcripts and scratch, project
  memory, isolation from other projects, the running-task refusal, the
  group-root refusal, and the idempotent unknown path), and
  `pnpm test:e2e:boot` round-trips `pi-desktop/project/remove` through the
  sandboxed preload; the Settings archive → dialog → sidebar journey remains
  Draft

## E2E-PROJECT-delete-running-sessions-are-named-and-stopped

- **Preconditions**: a durable project D with one session whose turn is still
  streaming, reachable both from the sidebar project menu and from Settings →
  Project archive.
- **Steps**: from each surface, open D's row menu and choose Delete project
  without stopping the turn. Expect the confirmation dialog with a
  running-session line and a stop-and-delete confirm label; press Cancel and
  expect nothing to change. Open the dialog again and confirm.
- **Expected**: the menu never replaces the dialog with a bare warning, so the
  action stays reachable while a task runs. The dialog keeps naming the
  project, its session count, and the untouched folder; while a turn is live it
  also names how many sessions are still running, its confirm button reads as
  stopping them, and that line joins the dialog's `aria-describedby` only while
  it is rendered. Cancelling deletes nothing and leaves the turn streaming.
  Confirming stops exactly the listed sessions and only then removes the
  project, its sessions, their transcripts, and its durable memory, leaving the
  folder on disk. A turn that starts between the dialog opening and the
  confirmation is still refused by the host, and the dialog reports that
  refusal with `project.deleteRunningBlocked` while removing nothing.
- **Specs linked**: `03-runtime/06-host-rpc-protocol.md` §Projects,
  `04-ux/08-component-spec.md` §3.9, ADR 0251, D421, D431
- **Acceptance criterion**: D (workspace), Quality
- **Milestone**: M6+
- **Status**: Partially automated — `apps/desktop/test/project-delete.test.mjs`
  checks that both menu handlers always open the confirmation dialog without
  deleting, and that X/Cancel only dismiss while the confirm handler owns the
  delete call; the rendered Settings/sidebar journey remains Draft

## E2E-123: asktool renders rich options, reminds the user, and returns answers

- **Preconditions**: Agent, Plan, or Goal mode; a configured provider; a
  session with an active transcript.
- **Steps**: 1) Ask the agent to call `asktool` with a single-select question,
  a multi-select question, and question/option text with Markdown emphasis,
  inline code, and a short list. 2) Confirm each card renders the formatting
  while keeping choices keyboard/selectable. 3) Answer the first question,
  click Next, and select two answers on the multi-select question. 4) Skip the final
  question without entering text. 5) Expand the completed tool row and inspect
  its question-and-answer summary, then inspect the next model response.
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
  action row. A long question prompt is bounded the same way: the question body
  scrolls inside the card (`min(208px, 24dvh)`, with a `24vh` fallback) and the
  header actions stay outside that scroller. The question body is keyboard
  focusable with a visible focus ring. Next, Skip, and the step indicators open
  each question at the top of that body. The tool output is
  ordered as `question：answer`, uses `、` between multiple answers and `\n---\n`
  between questions, and
  keeps `question：` for the skipped question. Markdown renders as rich text
  without activating embedded links or loading images. Selecting a formatted
  option returns its original Markdown source label. Decline all produces empty placeholders for every
  question and still completes the tool call. The completed row shows the
  ordered questions and answers, keeps multi-select labels separate, marks
  skipped questions with localized copy, and does not expose the structured
  JSON details. Its model-facing result stays unchanged. A pending ask shows a stable
  localized title and the first question in its toast; generated session-title
  text never replaces that title. Background sessions retain the existing
  native notification policy. Exactly one soft chime plays for the ask; the
  toast and native banner do not double it. With a right-docked work panel,
  the toast stays horizontally centered within the main-content safe area and
  never intersects the panel tab strip, browser navigation controls, or URL
  field. It follows both safe-area resize and same-width horizontal shifts.
  Clicking the question toast (including from New task or Settings) opens its
  originating conversation and project, shows the pending card, and permits
  submitting an answer for that request. Enter and Space activate the focused
  message button. Dismiss and text selection do not navigate. Identical prompt
  text from two sessions preserves two independent navigation targets; ordinary
  info toasts stay non-interactive. A history-read failure produces a visible
  error and leaves both the original reminder and question pending. Retrying
  from that same reminder after the read recovers opens the correct chat and
  dismisses the reminder only after navigation succeeds.
- **Specs linked**: `03-runtime/17-asktool-questions.md`,
  `04-ux/11-asktool-question-card.md`, ADR 0077
- **Acceptance**: E (interactive tool output), C (inline card)
- **Milestone**: M5
- **Automated coverage**: `pnpm test:e2e:asktool-card` mounts the production
  component in Electron and covers long-prompt scrolling, keyboard reachability,
  visible header actions, and scroll reset on Next.
  `pnpm test:e2e:question-notification` exercises real renderer event handling,
  safe-area geometry under resize and horizontal shift, toast creation,
  session/project navigation, and answer submission in isolated Electron with
  only the IPC boundary stubbed, plus native keyboard input.
- **Status**: Partially automated (component paths and long-prompt behavior are
  covered; full application journey pending)

- **Request transition regression**: Keep a one-question request pending in chat
  B. In chat A, advance a two-question request to question two, then select B.
  B must show its first question with fresh answer state and a usable composer,
  without rendering the application error screen. Also queue two requests in
  one session: submit the first, answer the second differently, and verify both
  resolutions contain their own request IDs and selected values.

## E2E-135: A drifted file recovers when remapping is provable and fails when it is not

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

## E2E-156: Edit tool succeeds on files with CRLF line endings

- **Preconditions**: A workspace containing a file with Windows-style CRLF
  (`\r\n`) line endings.
- **Steps**:
  1. Use Read to display the file content and record the whole-file `tag`.
  2. Issue an Edit with that `tag` and a `PUT N.=N:` whose body uses LF-only
     endings (as the model always produces from Read output).
  3. Inspect the file on disk after the edit.
- **Expected**: The Edit succeeds and returns a new `tag`. The written file
  preserves CRLF line endings throughout — both in modified and unmodified
  lines. No `MUTATION_RETRY_BUDGET_EXHAUSTED` error occurs.
- **Specs linked**: `03-runtime/18-line-anchored-edit-contract.md` §3.1,
  `03-runtime/03-tools-and-permissions.md`
- **Acceptance**: E (tools & permissions)
- **Milestone**: M5
- **Status**: Documented

## E2E-142: Background delegation converges through TaskWait and honors permission scopes

- **Preconditions**: A project-bound Agent session whose permission mode can be
  switched between `ask`, `accept-edits`, and `auto`, with a provider whose
  stream can be driven; the five builtin subagents (`explorer`,
  `code-reviewer`, `test-runner`, `fixer`, `ui-designer`) and a global
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
  11. Inject synchronous `SubagentRun` initialization failure; confirm the
      `Task` result is an error and `TaskList` has no permanently running row.
  12. In a runtime fixture, make settled-row publication throw and confirm the
      parent's idle auto-resume still returns the report. Stop a parent blocked
      in auto-resume while a child ignores abort; confirm the parent ends and
      reports idle without a timeout loop.
- **Expected**: `Task` returns immediately with a `delegationId` and the parent
  keeps working; `TaskWait` converges with per-delegation reports and statuses;
  every terminal child state wakes the parent even if transcript publication
  fails. A synchronous child initialization failure returns a tool error and
  leaves no `running` delegation. User Stop/Dispose abort the parent wait as
  well as delegates, and cancelled sessions do not remain `AGENT_BUSY` solely
  because a child is still settling. `TaskList`/`TaskStop` drive the lifecycle;
  a `TaskStop` result and a finished turn never leave a live “Subagent working”
  card; builtin `fixer` inherits the selected session permission mode, so
  `auto` also covers explicit external paths without a duplicate authorization
  prompt while `ask` and `accept-edits` retain their approval boundaries; a
  global definition's declared scope is dropped; the per-session running cap
  of 10 is enforced; no delegate outlives its turn; reloaded transcripts keep
  their delegation topology.
- **Specs linked**: `03-runtime/02-agent-runtime.md` §5f/§5f.1/§7.1,
  `03-runtime/03-tools-and-permissions.md` §10.2,
  `08-meta/decisions-log.md` (D242 amends D231), ADR 0089 and ADR 0100
- **Acceptance**: C (conversation), E (tools & permissions), F (persistence),
  Security, Quality
- **Milestone**: M6+
- **Status**: Unit coverage includes synchronous initialization failure,
  completion-publication failure, and Stop during parent auto-resume in
  `packages/agent-runtime/src/runtime.test.ts`; desktop journey pending

## E2E-162 / E2E-173: Delegate workflow scrolling

- **Status**: Superseded by the single-scroll live process behavior in E2E-198.

## E2E-158: Temporary sessions use isolated scratch workspaces

- **Preconditions**: PI-Desktop has a project open, a temporary session can be
  created, and the host data directory is known. The temporary session starts
  with an empty transcript.
- **Steps**:
  1. Create or select a temporary session while the project remains recently
     active, then inspect the empty-home hero.
     2. Confirm the hero uses the temporary-session copy and has no project
     underline or project switcher; confirm a project session and no active
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
  temporary hero is localized and has no project switcher; the project hero and
  the no-project generic hero are unchanged by the temporary session. Plan/Goal
  retain their project-root boundary.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md` §4/§4b,
  `03-runtime/10-session-state-machine.md`, `04-ux/01-ui-ia.md`,
  `04-ux/02-i18n-english-first.md`, ADR 0124
- **Acceptance**: C (conversation), D (workspace), E (tools & permissions),
  F (persistence), Security, Quality
- **Milestone**: M6+
- **Status**: Unit-covered (`crates/host-core/src/rpc/mod.rs`,
  `temporary-session-workspace.test.mjs`); rendered desktop journey pending

## E2E-165: A2A and Peer tools are withdrawn

- **Preconditions**: Agent mode; protocol v11 host. A user subagent definition
  lists `A2A` (or `Peer`) among its tools. Two Agent-mode sessions are open.
- **Steps**: 1) Handshake and inspect host capabilities. 2) Inspect the parent
  Agent tool list and `ToolSearch` results. 3) Load the definition that names
  `A2A`/`Peer`. 4) Start two concurrent working-tool delegates. 5) Ask whether
  one conversation can see the other.
- **Expected**: Handshake succeeds at protocol v11 and does not advertise
  `"a2a"`. `A2A` and `Peer` are absent from the parent catalog, deferred tools,
  and `ToolSearch`. The unknown tool names are dropped with a parse warning;
  remaining working tools still spawn. Concurrent delegates report only through
  `Task*` — there is no sibling or parent-to-parent channel. `a2a.*` RPC
  methods return method-not-found. Schema v14 databases have no `a2a_*`
  tables.
- **Specs linked**: `03-runtime/02-agent-runtime.md` §5f.2,
  `03-runtime/03-tools-and-permissions.md` §10.2,
  `03-runtime/06-host-rpc-protocol.md` §3–§4,
  `08-meta/decisions-log.md` (D326), ADR 0165
- **Acceptance**: E (tools & permissions) + C (chat/stream) + Security
- **Milestone**: M5
- **Status**: Draft

E2E-165b, E2E-165c, and E2E-165d (A2A push, cross-session A2A, parent A2A)
are withdrawn with ADR 0165.

## E2E-179: Parent tools after a Task fan-out stay outside the delegation card

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
  journey pending (run only in a capable environment when this surface changes)
## E2E-180: Sent file references stay chips and open on click

- **Preconditions**: An Agent session in a workspace that contains a nested
  source file, an HTML file, and a file whose name contains whitespace, and a
  project group whose second folder holds a source file of its own. The
  composer can also paste an OS file into session scratch. The bundled File
  Manager plugin is loaded.
- **Steps**: 1) Attach a workspace source file, a workspace HTML file, a
  whitespace-named file, and a pasted scratch file via composer chips, then
  send. 2) Inspect the user bubble. 3) Click the HTML chip, then the workspace
  source chip, then the scratch chip. 4) Attach the file that lives in the
  project's second folder and click its chip.
- **Expected**:
  - Each sent reference renders as a compact leaf-name chip (icon + name),
    not as a full `@path`. The tooltip and accessible name keep the
    canonical path. Quoted and scratch-absolute paths are included.
  - A chip plus a short prompt keeps the user plate content-sized; it does
    not stretch to the `min(82%, 600px)` ceiling.
  - Clicking an unpositioned project or scratch HTML chip opens the work-panel
    browser on that file.
  - Clicking the workspace source chip opens it in the File Manager work-panel
    view on that file; the host `file:` tab and the OS default application are
    no longer what a chip click opens.
  - Clicking the scratch chip opens the host `file:` tab on that file's
    absolute path, because it lives outside the File Manager's project root.
  - Clicking the chip of the file in the project's second folder opens it in
    the File Manager view on that file: completion searches the whole project
    group, primary folder first, and a sibling-folder file is addressed by
    absolute path because a relative path always means the primary folder
    (ADR 0263).
  - The persisted user message still contains the canonical `@path` text for
    the agent.
- **Specs linked**: `04-ux/08-component-spec.md` §8.3 / §11.8,
  `04-ux/09-interaction-patterns.md` §8a.2, `03-runtime/01-ipc-protocol.md`,
  ADR 0163, ADR 0241, ADR 0262, ADR 0263, `08-meta/decisions-log.md` (D320)
- **Acceptance**: C (conversation & stream), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`chat-links.test.mjs`, `transcript-file-chips.test.mjs`,
  `fs-panel-guard.test.mjs`, `transcript-style.test.mjs`); full UI journey Draft (run only in a capable environment when this surface changes)

## E2E-182: Relative file paths in chat and markdown preview open

- **Preconditions**: An Agent session in a workspace that contains
  `apps/desktop/src/App.tsx`, `docs/adr/0163-transcript-file-reference-chips.md`,
  `docs/spec/00-baseline.md`, `核查报告.md`, and a Unicode-named file such as
  `报告.pdf`.
- **Steps**: 1) Open an existing session whose transcript already contains
  assistant markdown. 2) Prompt a turn whose assistant reply mentions
  `apps/desktop/src/App.tsx` as a bare path, as inline code, a Unicode path such
  as `报告.pdf`, and as a markdown link; also include
  `[核查报告.md](核查报告.md)`. 3) Click each. 4) Open the ADR markdown file
  in the work-panel files viewer and click a `../spec/00-baseline.md` link.
  5) Include an absolute path under the workspace, an outside absolute path,
  and a `~/` path in chat; confirm only the under-root path becomes a target.
  6) Send a user message `使用llama.cpp，给我迁移步骤，只读。`, then a user
  message that names the real `apps/desktop/src/App.tsx` as a bare path and as
  `@apps/desktop/src/App.tsx`. 7) Add a workspace directory link to an
  outside `page.md`, a second in-root `page.md`, and a link to an in-root file;
  check the exact linked path and a shorthand `page.md`. Repeat with a session
  scratch directory link, and check a dangling link.
- **Expected**:
  - Opening the session paints the transcript without throwing.
  - Each chat path opens `apps/desktop/src/App.tsx` in the File Manager
    work-panel view — the file view a chat click prefers — not a host `file:`
    tab.
  - Clicking `[核查报告.md](核查报告.md)` in the assistant reply opens that
    project Markdown file in the File Manager work-panel view.
  - Unicode filenames and multi-segment paths inside the workspace become
    targets, while an outside absolute path and a `~/` path stay plain text.
  - An absolute path under the workspace resolves to its workspace-relative
    target.
  - The markdown-file `../` link opens `docs/spec/00-baseline.md`, not a
    workspace-root `spec/00-baseline.md`.
  - A `../../../outside.ts` link from `docs/adr` stays inert.
  - The user sentence containing `使用llama.cpp` stays exact original text, not
    a file chip, when that path does not exist.
  - A user-message bare path becomes a chip only after `fs/resolveRef` confirms
    a real file; an explicit `@path` chips immediately.
  - Escaping and dangling exact links do not become file targets or redirect to
    the same-name in-root file. A shorthand selects the first currently valid
    in-root file, while an in-root link still opens its target. Scratch links
    follow the same containment rule.
- **Specs linked**: `04-ux/08-component-spec.md` §8.3,
  `08-meta/decisions-log.md` (D322)
- **Acceptance**: C (conversation & stream), D (workspace), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`chat-links.test.mjs`,
  `verified-chat-files.test.mjs`, `transcript-file-chips.test.mjs`,
  `markdown-prose-style.test.mjs`); full UI journey Draft (run only in a capable environment when this surface changes)

## E2E-234: Workspace security denylist and ignore layers

- **Preconditions**: A project containing `.env`, `.env.example`,
  `server.pem`, `.npmrc`, `keys/id_rsa`, `notes.txt`,
  `node_modules/pkg/index.js`, `generated/out.txt`, `debug.log`, and a root
  `.pi-desktopignore` with `generated/`. Every file contains the word `needle`.
  The session is Agent in `auto` permission mode.
- **Steps**: 1) Ask for `Read` of `.env`, then of `.env.example`. 2) Ask for
  `Write` to `keys/id_rsa`. 3) Run an unscoped `Grep` and `Glob` for `needle`.
  4) Run `Grep` with `path: node_modules/pkg` and with `path: generated`.
  5) Repeat step 1 with a system `rg` installed and with
  `PI_DESKTOP_DISABLE_RG=1`.
- **Expected**: Steps 1 and 2 fail with `WORKSPACE_PATH_DENIED`, the
  `.env.example` read succeeds, and no `keys/id_rsa` file is created. The
  unscoped search lists `notes.txt` and `.env.example` only: `.env`,
  `server.pem`, `.npmrc`, `node_modules`, `generated`, and `debug.log` are
  absent. The explicit-path searches return one hit each. The in-process
  walker and the `rg` fast path produce the same file set.
- **Specs linked**: `03-runtime/15-workspace-ignore-rules.md`,
  `03-runtime/08-error-codes.md` §3.3, D032
- **Acceptance**: B (workspace tools), Security
- **Milestone**: M3+
- **Status**: unit-covered by `crates/host-core/src/tools/mod.rs`
  (`security_denylist_blocks_read_write_edit_and_hides_search_results`,
  `default_ignores_and_workspace_ignore_file_hide_unscoped_walks_only`) and
  `tools/ignore_rules.rs`; the Electron journey is documented and deferred by
  the no-local-E2E policy

## E2E-235: Dangling symlinks cannot write outside the workspace

- **Preconditions**: A project containing `dangling -> /tmp/outside/planted.txt`
  where the target does not exist, and `inner -> ./not-yet.txt`. Agent mode,
  `auto` permission.
- **Steps**: 1) Ask for `Write` to `dangling`. 2) Ask for `Write` to
  `dangling-dir/new.txt` where `dangling-dir -> /tmp/outside/dir`. 3) Ask for
  `Write` to `inner`.
- **Expected**: Steps 1 and 2 fail with `PATH_OUTSIDE_WORKSPACE` and nothing
  appears under `/tmp/outside`. Step 3 creates `not-yet.txt` inside the
  project. A symlink loop fails with a canonicalize error rather than hanging.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md`,
  `03-runtime/15-workspace-ignore-rules.md` §3
- **Acceptance**: B, Security
- **Milestone**: M3+
- **Status**: unit-covered by `crates/host-core/src/workspace.rs`
  (`blocks_dangling_symlink_escape`,
  `dangling_symlink_inside_workspace_resolves_to_its_target`,
  `dangling_symlink_loop_is_rejected`)

## E2E-238: Tool requests for an unknown session do not fall back

- **Preconditions**: host-core running; a JSON-RPC probe attached to its
  stdio.
- **Steps**: 1) Send `tools.execute` with `sessionId: "missing"` and a `Read`
  of `README.md`. 2) Send `plans.enter` with the same id.
- **Expected**: Both fail with `SESSION_NOT_FOUND` (numeric `1007` and
  `PLAN_SESSION_NOT_FOUND` respectively); no file under the last-opened
  workspace is read.
- **Specs linked**: `03-runtime/06-host-rpc-protocol.md` §7,
  `03-runtime/08-error-codes.md` §3.1
- **Acceptance**: B, Security
- **Milestone**: M3+
- **Status**: unit-covered by `crates/host-core/src/rpc/mod.rs`
  (`temporary_session_uses_its_own_scratch_workspace`)

## E2E-228: Shipped bindings and browser profiles preserve semantic behavior

- **Preconditions**: The same deterministic command/event fixture is
  available through `RACP-WS` and `RACP-HTTP`, and through `RACP-GRPC` only
  if that reserved binding has shipped. A browser harness can hold a Gateway
  session cookie.
- **Steps**: 1) Run the fixture through each shipped binding on the header
  profile. 2) Disconnect during the event stream. 3) Retry a mutation with
  the same idempotency key. 4) Compare normalized responses, errors, durable
  sequences, and final snapshots. 5) From the browser harness, open the
  WebSocket and the SSE stream on the cookie profile with an allowed Origin,
  then with a disallowed Origin, then with a token in the URL, then send a
  mutation without a CSRF token.
- **Expected**: All shipped bindings accept and reject the same operations,
  preserve durable event order and terminal state, return the same semantic
  error codes, and produce one mutation result despite retries; the cookie
  profile succeeds only with an allowed Origin; the disallowed Origin, the
  URL token, and the CSRF-less mutation are rejected.
- **Specs linked**: `03-runtime/19-remote-agent-control-protocol.md` §§11
  and 14, `05-security/02-remote-control-security.md` §§3.1 and 5,
  `06-delivery/07-remote-control-rollout.md` §§3–4
- **Acceptance**: Quality, Recovery, Security
- **Milestone**: Post-MVP
- **Status**: Draft; the browser-profile steps are unscheduled until the browser milestone is scheduled (D375); the parity steps run when a second binding ships

## E2E-229: Attachment and workspace boundaries are enforced remotely

- **Preconditions**: A Session has a project root and private scratch root. A
  controller can upload one valid fixture and one invalid fixture, directly
  and through a Gateway relay.
- **Steps**: 1) Upload bytes with a correct hash and reference the attachment
  from a turn. 2) Repeat with a wrong hash, oversized body, local absolute
  path, `file://` URL, and an expired upload target. 3) Repeat step 2 through
  the Gateway relay. 4) Attempt a tool path outside the Session root.
  5) Call `project/list` and `session/create` without a path.
- **Expected**: Only the verified attachment is accepted; invalid uploads
  fail before turn admission on both paths; no local client path reaches the
  Host; `project/list` returns labels and ids without absolute paths;
  `session/create` binds the project by id; and the existing
  `PATH_OUTSIDE_WORKSPACE` boundary remains authoritative.
- **Specs linked**: `03-runtime/19-remote-agent-control-protocol.md` §§5.7,
  7.7, and 10, `05-security/02-remote-control-security.md` §6,
  `03-runtime/03-tools-and-permissions.md`
- **Acceptance**: E (tools & permissions), Security
- **Milestone**: Post-MVP
- **Status**: Draft; remote harness required

## E2E-258: Create project dialog can start from a git repository

- **Preconditions**: The Create project dialog opens from the Projects heading
  (no existing project is required); `git` is installed.
- **Steps**:
  1. Open the Create project dialog and click Add folder twice quickly; confirm
     that only one native folder picker opens, then cancel it.
  2. Switch the source selector to Git repository.
  3. Paste `https://github.com/octocat/Hello-World.git` and confirm the project
     name field is seeded with `Hello-World`, then type a custom name.
  4. Choose a clone destination folder and confirm the destination row shows it.
  5. Confirm Create and inspect the workspace, sidebar, and project archive.
  6. Reopen the dialog, switch to Git repository, and paste a private or
     malformed remote.
- **Expected**: Repeated folder-picker clicks are ignored while the native
  picker is open. The dialog swaps the folder list for a repository URL field plus
  a clone destination row and keeps one project name field. Source options and
  fields are filled tiles without strokes; keyboard focus uses the shared
  accent-tinted ring. Create stays
  disabled until the URL parses and a folder is chosen; a name left empty falls
  back to the parsed repository name. Confirming runs
  `git clone` into the chosen folder with the renderer still owning project
  creation: the checkout becomes the primary root and the entered name names the
  group. Private, loopback, link-local, credential-bearing, and malformed
  remotes leave Create disabled (ADR 0247) and no folder is written.
- **Specs linked**: `03-runtime/01-ipc-protocol.md` §9, `04-ux/08-component-spec.md`,
  ADR 0273, ADR 0233, ADR 0247
- **Acceptance**: Quality (project entry), D (workspace)
- **Milestone**: M5
- **Status**: Unit-covered (`apps/desktop/test/project-create-dialog.test.mjs`,
  `apps/desktop/test/git-clone.test.mjs`); full UI scenario Draft (run only in a
  capable environment when this surface changes)

## E2E-261: Creating from a closed project folder reopens its group

- **Preconditions**: A durable project group exists for a local folder and is
  closed from the sidebar; its directory remains available.
- **Steps**: Open Create project, select only that folder, and click Create.
- **Expected**: The existing group reopens at its primary root, appears in the
  sidebar, and the dialog closes. Its existing name, roots, chats, instructions,
  and memory remain intact; no duplicate project group is created.
- **Specs linked**: `04-ux/08-component-spec.md`, ADR 0249.
- **Acceptance**: The production creation action resolves the host group before
  attempting creation and activates the existing primary path.
- **Milestone**: M5 (project organization maintenance).
- **Status**: Unit/source-contract covered (`apps/desktop/test/project-create-dialog.test.mjs`);
  full UI scenario remains Draft.
## E2E-DIALOG-native-selection-across-boundaries

- **Preconditions:** Built renderer, isolated Electron profile, real production
  React dialogs/hover card and stylesheet; only preload IPC is stubbed. Reveal
  and dismissal delays use a controlled clock, not arbitrary sleeps.
- **Steps:** Drag from release-note/table text onto the backdrop and copy the
  selected text with Chromium's native Copy command; repeat content-to-backdrop
  and reverse drags in project instructions and provider setup. Open provider
  Advanced, drag across its boundary, then deliberately click its backdrop.
  Cancel a backdrop press or blur the window before release, then try a fresh
  outside click. Save project
  instructions while trying outside click/Escape, then use the close button.
  Hover a session row, drag card text outside, advance past the grace period
  while held and after release, Copy, revisit/leave the row, clear selection,
  and repeat ordinary leave, cancellation, Escape and outside press.
- **Expected:** Cross-boundary drags preserve the modal and native selection;
  deliberate backdrop clicks still dismiss. Cancelled/blurred presses never
  dismiss; the next fresh click works. Nested clicks close only Advanced and
  saving protections remain effective. The hover card survives dragging and
  remains copyable while its text selection exists; row timers cannot override
  retention. Clearing selection or ending an unselected/cancelled drag resumes
  ordinary 160ms dismissal. Escape/outside press still dismiss selected cards.
- **Specs:** `04-ux/09-interaction-patterns.md` sections 1.10 and 9.1b;
  `04-ux/07-ui-design-system.md` section 11.4.
- **Automation:** `pnpm test:e2e:overlay-selection`; production Chromium mouse
  and keyboard input with deterministic host replies. On macOS the fixture uses
  Chromium's native copy command because Electron's synthetic Command+C input
  does not invoke the system clipboard. No running user app or real provider is
  used.
- **Status:** Automated on Windows and macOS; Linux native evidence pending.

## E2E-DIALOG-long-text-boundaries

- **Preconditions:** Built renderer assets and an isolated Electron component
  fixture; production components, store, translations and stylesheet are used.
  Only the preload IPC boundary is replaced with deterministic host replies.
- **Steps:** Open an extension input prompt with a long Windows source path;
  type, submit, reopen and dismiss. Repeat long title/message/option prompts in
  light/dark themes and Chinese at 520×480. Inspect long project/plugin names in
  rename, instructions, memory, delete, install, settings, permission-review and
  OAuth dialogs; exercise dismissal controls.
- **Expected:** Full source paths and other long text wrap without clipping; horizontal
  overflow is absent, and the 420px prompt width is unchanged. Tall prompts
  scroll inside the viewport. Close, Escape, typing and radio submission work.
- **Specs:** `04-ux/08-component-spec.md`, Dialog long-text containment.
- **Acceptance:** Bounded text and reachable modal controls.
- **Milestone:** Post-MVP maintenance.
- **Automation:** `pnpm test:e2e:dialog-overflow`; source/contract dialog suites
  supplement, but do not replace, real Chromium geometry and pointer checks.
- **Status:** Implemented. Native Windows evidence; macOS/Linux not qualified.

## E2E-FIXED-TOOL-DECLARATIONS: Stable Flash schemas with independent activation

- Fixture: production AgentSidecar and isolated Host, official Pi Flash binding,
  and a child-process fetch boundary redirected to local HTTP/SSE. Credentials
  are dummy values and synthetic tools have no external side effects.
- Prompt, search Alpha, execute Alpha, search Beta and execute Beta. HTTP payload
  tests assert identical ordered `tools` and unchanged prior message prefixes.
  Directly calling a declared but inactive tool must fail before the Host.
- Restart both processes, then compact and restart again: Alpha stays activated,
  Beta remains inactive despite its declaration. Activate Beta, then remove it
  from the catalog and verify it cannot execute. New schema/route epochs must
  not restore old grants. Host rejection and Plan guards remain effective.
- Runtime contracts additionally cover legacy migration, interrupted activation,
  malformed metadata, temporary prompt replacement, deterministic catalog order,
  the 128-tool boundary and insufficient-context fallback.
- Automated: `node scripts/e2e-fixed-tool-declarations.mjs` with built
  shared/host-runtime/agent-runtime and `PI_DESKTOP_HOST_BIN` set to the candidate
  Host binary; `fixed-tool-runtime.test.ts` and `fixed-tool-declarations.test.ts`
  cover HTTP payload and policy contracts. Electron UI/outbox is outside this
  fixture's scope.
- Separately authorized official Flash experiments compare several independent
  on-demand/fixed sessions with the same synthetic catalog and call sequence.
  Record cold requests, both activations, follow-up cache hits/misses and
  cumulative input cost. Report the larger first request and possible short-chat
  cost increase, alongside any longer-conversation benefit. Offline test success
  alone is not evidence of provider cache behavior.

- Overflow/system-update integration: recover a provider context overflow with
  a system delta after the failed assistant message. Keep that delta, remove the
  failed assistant before compaction, and reuse one visible assistant message
  through successful recovery. Terminal failure and Stop retain their existing
  closure behavior. Covered by the parameterized runtime overflow user-path test.

## E2E-262: Transcript positioned file references open and scroll the host file viewer

- **Preconditions:** Isolated Electron/Chromium, an active workspace and session,
  the bundled file-manager view available, and deterministic filesystem IPC
  fixtures.
- **Steps:** Render a real transcript `path:line-range` reference followed by
  sentence punctuation; click its verified file chip and wait for the host file
  viewer to load. Unit coverage also exercises `path:line:column` and GitHub
  `path#Lline[-Lend]` references.
- **Expected:** Despite the bundled file-manager view being available, the
  positioned reference opens in the host's read-only file tab. The file request
  retains the range's starting line, and the viewer scrolls that line into the
  visible center area. The path and file contents remain the same as the
  reference target.
- **Specs:** `04-ux/08` §11.8; ADR 0262.
- **Status:** `node scripts/e2e-file-ref-line-scroll.mjs` mounts production
  `LinkifiedText` and `FilesTab` in isolated Electron with filesystem IPC
  fixtures; no real project files or provider are used.

## E2E-263: Collapsing a project resets its loaded session history

- **Preconditions:** One retained project has at least twelve unpinned sessions,
  and its group can be expanded in the sidebar.
- **Steps:** 1. Expand the project and confirm the latest ten sessions plus a
  Load more control are visible. 2. Click Load more and confirm all twelve
  sessions appear. 3. Collapse the project, then expand it again. 4. Inspect the
  visible sessions and the Load more count.
- **Expected:** Reopening the project shows only the latest ten unpinned
  sessions, and Load more reports the two hidden sessions. The collapse clears
  only that project's loaded-more state; session selection and other project
  groups remain unchanged.
- **Specs:** `04-ux/08-component-spec.md` §3.9;
  `04-ux/09-interaction-patterns.md` §1.6.
- **Acceptance:** C / D / Quality.
- **Milestone:** Post-MVP maintenance.
- **Coverage:** `scripts/e2e/sidebar-row-states.mjs` exercises the full user path
  with a host-seeded project and real CDP pointer clicks. The unit test
  `sidebar-project-sessions.test.mjs` covers the initial page, Load more,
  collapse reset, and project isolation. `app-store-sidebar.test.mjs` checks
  that sidebar collapse and Load more use those transitions.

## BOM-marked UTF-16 text tools

- Create a UTF-16LE PowerShell build log with a BOM and CRLF, then ask the agent
  to Read it. The tool and the next model request contain readable log lines.
- Edit a displayed line. The original BOM, endian and CRLF bytes are preserved.
- Repeat with UTF-16BE Chinese text. Ordinary binary files remain rejected.
- Automated coverage: `read_powershell_utf16le_log`,
  `read_and_edit_utf16be_chinese_text`, and the existing binary/CRLF tool tests.

## Edit parse diagnostics name corrective operations

- Submit an empty `PUT`, a unified-diff hunk, a Markdown heading, a colon-
  terminated `CUT`, an orphan body row, and an invalid `PUT` locator against a
  read file. Follow them with a valid range `PUT` as a control.
- Expected: every malformed payload fails before writing with
  `EDIT_PARSE_FAILED`; the result names a concrete replacement `PUT`, `CUT`, or
  gap-insert form. A unified-diff hunk is identified explicitly, and foreign
  patch/Markdown wrappers are never silently stripped. The valid control edit
  succeeds. The tool description says to delete with `CUT`, not an empty `PUT`,
  and not to paste unified-diff or Markdown wrappers into `ops`.
- Automated coverage: `cargo test -p host-core
  tools::hashline::parse::tests` and `cargo test -p host-core
  tool_defs_advertise_the_scoping_parameters`; no real provider is used.

## Delegate mutation recovery isolation

- Start two Task delegates editing the same file. Delegate A produces text and
  fails three Edits; B fails twice and then completes. A is failed with
  `MUTATION_RETRY_BUDGET_EXHAUSTED`, B completes, and the parent has no mutation
  error. Resume A with a corrected task and verify successful completion.
- Run the same flow with failing shell patch commands. Repeat with one delegate
  to prove that text preceding exhaustion does not become a completed report.
- While a delegate continues, a new parent prompt resets only the parent's
  recovery counters. Both default and explicit delegate permissions retain the
  same isolation.
- Automated provider-boundary flow: `node scripts/e2e-subagent-edit-isolation.mjs`
  with optional `--single` and `--patch`; runtime tests cover parent restart.

## Mutation recovery file aliases

- Retry a failing Edit using relative, absolute, `.`/`..`, directory-link and
  Windows case-alias spellings of the same existing file. The third counted
  failure terminates; changing spelling does not grant another recoverable-code
  grace. Distinct files retain independent budgets.
- Successfully Edit or Write through an alias and retry: the count and grace
  reset. Removing the file through a linked path clears its pre-mutation identity.
- Repeat relative/absolute aliases in a temporary session: its scratch root is
  the relative base. Probe the directory's actual case sensitivity: distinct
  case-sensitive files remain separate, while case aliases share an identity.
- Automated filesystem/runtime boundary coverage: `runtime.test.ts` and
  `mutation-recovery.test.ts`; no UI, production profile or real provider is used.

## E2E-266: Project headers show running activity while collapsed

- **Preconditions**: At least two local project groups with sessions, one of
  them with a running turn (and optionally a session waiting for a
  permission prompt), plus a connected remote host group with a running
  session. Settings → Appearance → Sidebar switches are at their defaults.
- **Steps**:
  1. Start a turn in one project and collapse that project group.
  2. Inspect the collapsed header, then expand it again.
  3. Start a second concurrent turn in a different project and a turn in the
     remote host's project.
  4. Open Settings → Appearance → Sidebar and turn off **Show running activity
     on projects**, then re-check the sidebar.
  5. Turn the master switch back on and turn on **Activity rail**.
  6. Turn off **Count badge** only and re-check; turn it back on.
  7. Turn off **Activity rail** only and re-check; turn it back on.
  8. Enable the OS "reduce motion" setting and re-check the rail.
- **Expected**: A project with live work marks its header — the collapsed
  header shows only the count badge by default; the activity rail is off.
  Running and permission-waiting counts are separate figures and never merge
  into one number. The remote host group shows the same default. Turning on the
  activity rail displays it alongside the badge, while the counts stay in the
  badge alone; with the badge switched off the rail takes them over, so no
  group ever shows the same figure twice. The master switch removes
  both affordances at once and leaves the two sub-switches disabled while
  retaining their stored value, so
  re-enabling the master restores the previous choice. Each sub-switch hides
  only its own affordance. Under reduced motion both affordances stay visible
  with their animation removed. Settings persist across a renderer reload.
- **Specs linked**: `04-ux/01-ui-ia.md` §3.2, `04-ux/06-settings-ia.md`
  (General → Sidebar card).
- **Acceptance**: The "is anything running under here?" answer is available
  from a collapsed project group, and each affordance can be switched off
  independently through a persisted setting.
- **Status**: Draft. Existing unit coverage in
  `apps/desktop/test/sidebar-project-runs.test.mjs` covers count
  classification, master/sub-switch gating, both render call sites, and
  theme-token and reduced-motion guarantees. It does not exercise settings
  API default normalization or the full interaction; those remain manual
  validation in a capable environment.

## Computer use (ADR 0342, ADR 0344)

Native-control scenarios remain landing gates for
[03-runtime/computer-use](../../03-runtime/computer-use.md). The host half now has
device evidence on macOS through
`PI_DESKTOP_COMPUTER_USE_DEVICE=1 node scripts/e2e-computer-use-device.mjs`
(opt-in: it reads the operator's screen, and with `--act-app` types into one of
their windows). The Electron half — the automatic mint through the tool, the
indicator, Stop aborting the turn, the drawn cursor, and the loop against a real
model — is still `NOT RUN`, and so is anything needing Screen Recording. The
permission-request UI below has isolated fixture automation.

## E2E-COMPUTER-USE-request-accessibility-from-settings

- **Layout regression**: Open Settings → Behavior. Computer use is the final card,
  after Permissions and Defaults, without card/row explanations or a static
  scope note. Its switch, platform/permission status, enabled model/capture
  controls, missing-model hint, and permission error/retry path remain present.
  `apps/desktop/test/computer-use-settings-surface.test.mjs` covers order and
  compact rendering with the feature both disabled and enabled.

- **Preconditions**: Isolated Electron fixture profile; OS calls mocked at IPC
  and Electron boundaries; computer use disabled; no provider or real OS prompt.
- **Steps**: Open Settings with missing Accessibility; focus and click its status
  button twice. Complete the request while permission remains missing. Grant it
  externally and return focus. Exercise denied permission, a failed request and
  retry, a stale capabilities read, focus during a pending request, unsupported
  platform, and unmount during a request.
- **Expected**: Opening Settings or toggling the feature never requests OS
  permission. Explicit click alone requests the app's own TCC trust in main;
  while pending, the button is busy/disabled and duplicate clicks are ignored.
  Missing app trust opens only the fixed macOS Accessibility pane and explains
  that the user must enable it. Errors are visible and retryable. Focus and
  visibility refreshes never prompt. Controlled one-second polling after a
  request detects authorization without a focus event, stops on authorization
  or unmount, and expires after 60 ticks. Stale reads cannot replace newer state.
  An app-level grant updates the badge even when the Rust child still reports
  denied: show a backend-permission diagnostic instead of another request.
  Backend recovery clears the diagnostic without granting any authority from UI.
  Granted/unsupported states are labels. Non-main senders are rejected before OS
  calls; opening failure propagates; no grant, capture, or input is dispatched.
- **Automation**: `node --test apps/desktop/test/computer-use-permission-user-path.test.mjs
  apps/desktop/test/computer-use-permission-ipc.test.mjs`; shared capability
  selection tests and host-core unsupported-backend tests cover platform gating.
- **Specs**: [Computer Use](../../03-runtime/computer-use.md), Settings and UX surface.
- **Status**: Fixture automation PASS; actual macOS TCC prompt/switch NOT RUN.
  Native OS approval remains a manual system decision.

## E2E-COMPUTER-USE-desktop-grant-is-automatic-and-stoppable

- **Preconditions**: Isolated desktop profile, computer use enabled with a model
  bound, OS permissions granted on the platform under test, two fixture target
  applications, one PI-Desktop window in front, no provider account needed.
- **Steps**: Ask the agent to operate an application with no grant in existence.
  Watch the indicator, run `inspect` and one `act`. Press Stop mid-task and have
  the agent immediately call `Computer` again. Wait out the cooldown and call
  again. Ask from a second session while the first grant is active. Let a grant
  idle past its expiry, and exhaust an action budget. Restart the app.
- **Expected**: No picker appears and the user is never asked which window: the
  first call mints a desktop grant bound to the frontmost window that is not
  PI-Desktop's, with no OS prompt and no capture under `a11y-only`. The
  indicator names that window, shows budget and capture mode, follows every
  rebind, and stays visible while the app is backgrounded. Stop revokes the
  grant, aborts the owning turn, and the immediate re-call fails
  `COMPUTER_STOPPED_BY_USER` without touching the screen; after the cooldown a
  new grant is minted normally. The second session is refused
  `COMPUTER_GRANT_IN_USE`. Idle expiry and budget exhaustion close the grant
  with their own codes, and no grant survives the restart.
- **Specs**: [Computer Use](../../03-runtime/computer-use.md),
  [03-tools-and-permissions](../../03-runtime/03-tools-and-permissions.md).
- **Automation**: `computer::tests::a_desktop_grant_binds_the_frontmost_usable_window`,
  `a_desktop_grant_refuses_when_every_window_is_refused`,
  `a_user_stop_blocks_the_agents_next_mint_but_not_the_users`,
  `only_one_grant_is_active_per_instance`,
  `another_session_cannot_use_the_active_grant`,
  `an_idle_grant_expires_and_stays_expired`, and
  `the_budget_closes_the_grant_and_refuses_the_next_action` in host-core;
  `apps/desktop/test/computer-use-service.test.mjs` covers the automatic mint,
  the Stop refusal, and the wrong-session refusal the agent would hit. Device:
  `scripts/e2e-computer-use-device.mjs`.
- **Status**: PARTIAL — the device probe confirmed the automatic desktop grant
  binding the frontmost usable window (with our own window refused in front of
  it), the settings defaults reaching the grant, the real tree, and the Stop
  cooldown on macOS 15 with Stage Manager active. The indicator, Stop aborting
  the owning turn, budget and idle closure in a running app, and the restart
  case are NOT RUN.

## E2E-COMPUTER-USE-window-switching-stays-inside-the-refusals

- **Preconditions**: Isolated desktop profile with an active desktop grant, two
  fixture applications, a PI-Desktop window, a window from the built-in
  credential denylist, and one fixture window that can be closed on demand.
- **Steps**: Have the agent read the window list, switch to the second fixture
  application, inspect it, and act. Attempt a switch to the PI-Desktop window,
  to the denylisted window, and to an id that no longer exists. Act using a
  `uid` read before the switch. Close the bound window mid-task and act.
- **Expected**: The observation lists the windows the host enumerated with
  refusals attached, and no renderer surface enumerates anything. A permitted
  switch rebinds the grant, moves the revision, re-frames the drawn cursor, and
  spends a step but no action budget. The refused switches fail
  `COMPUTER_SELF_TARGET_REFUSED`, `COMPUTER_TARGET_DENYLISTED`, and
  `COMPUTER_SCOPE_VIOLATION`, leave the bound window unchanged, and are reported
  to the model as steps rather than ending the run. A pre-switch `uid` fails
  `COMPUTER_STALE_REVISION`. The closed window rebinds to the frontmost usable
  window while the in-flight action is refused, and the audit log shows one
  `computer.grant.rebound` per move with application identity only.
- **Specs**: [Computer Use](../../03-runtime/computer-use.md),
  [05-security/01-security](../../05-security/01-security.md) §13.
- **Automation**: `computer::tests::binding_another_window_moves_the_revision`,
  `a_rebind_re_applies_every_refusal`, `a_window_grant_refuses_a_rebind`, and
  `a_desktop_grant_whose_window_closes_rebinds_and_refuses_the_action` in
  host-core; `packages/computer-use` loop tests cover the switch step, the
  refused-switch recovery, and the terminal-grant case;
  `apps/desktop/test/computer-use-service.test.mjs` pins the host call shape.
  Device: `scripts/e2e-computer-use-device.mjs`.
- **Status**: PARTIAL — on device, switching between six real applications
  worked, the revision moved on every bind, a pre-switch revision was refused,
  and the self-target, denylist and unknown-window binds were refused by code.
  Two defects were found and fixed there: the accessibility window could not be
  matched to the window-server window under Stage Manager (now joined by window
  id, D683), and a failed read left the grant on the unreadable window. The
  closed-window fallback, the cursor re-frame, and the audit read-back are
  NOT RUN.

## E2E-COMPUTER-USE-self-target-and-secure-input-refused

- **Preconditions**: Isolated desktop profile with an active grant, a PI-Desktop
  window with a pending approval card, and a fixture window containing a
  password field.
- **Steps**: Attempt to inspect, capture, and act on a PI-Desktop window,
  including its approval card and the Live Voice widget, under every permission
  mode including `auto` and under an `autonomous-in-scope` grant. Focus the
  password field and attempt `inspect`, `screenshot`, and `set_value`. Attempt a
  target on the built-in credential denylist and try to remove that entry.
- **Expected**: Every self-target attempt fails `COMPUTER_SELF_TARGET_REFUSED`;
  no synthetic event reaches any PI-Desktop window and no approval card is
  dismissed. Secure input refuses capture and synthesis with
  `COMPUTER_SECURE_INPUT_REFUSED`, and no field content appears in a snapshot,
  image, tool result, or log. The built-in denylist entry cannot be removed.
- **Specs**: [Computer Use](../../03-runtime/computer-use.md),
  [05-security/01-security](../../05-security/01-security.md) §13.
- **Automation**: `computer::tests::our_own_windows_are_never_targetable`,
  `a_renamed_self_process_is_still_refused`,
  `built_in_credential_surfaces_cannot_be_allowlisted`, and
  `secure_input_refuses_both_inspection_and_action` in host-core. Device:
  `scripts/e2e-computer-use-device.mjs`.
- **Status**: PARTIAL — on device, a PI-Desktop window sat in front of every
  other window and was refused `COMPUTER_SELF_TARGET_REFUSED` both as the
  automatic grant's choice and as an explicit bind, and a denylisted window was
  refused `COMPUTER_TARGET_DENYLISTED`. The approval card specifically, and the
  secure-input and password-field refusals, are NOT RUN.

## E2E-COMPUTER-USE-stale-basis-and-revision-fail-closed

- **Preconditions**: Isolated desktop profile, an `a11y-and-pixels` grant, and a
  fixture window that can be moved, resized, and re-stacked on demand.
- **Steps**: Capture a `screenshot`, move the target, then act on the stale
  basis. Resize the target between `inspect` and `act` on a `uid`. Act with a
  coordinate outside the measured bounds. Act with a basis minted for a
  different grant. Act under an `a11y-only` grant with coordinates.
- **Expected**: `COMPUTER_STALE_BASIS`, `COMPUTER_STALE_REVISION`,
  `COMPUTER_SCOPE_VIOLATION`, and `COMPUTER_CAPTURE_UNAVAILABLE` respectively;
  no event is dispatched in any of them, nothing is clamped silently, and the
  target application observes no input.
- **Specs**: [Computer Use](../../03-runtime/computer-use.md),
  [08-error-codes](../../03-runtime/08-error-codes.md) §3.10.
- **Automation**: `computer::tests::a_moved_window_bumps_the_revision_and_invalidates_a_basis`,
  `a_resized_window_with_the_same_revision_still_refuses_a_stale_basis`,
  `coordinates_outside_the_measured_window_are_refused_not_clamped`, and
  `a_coordinate_action_without_a_basis_is_refused` in host-core.
- **Status**: NOT RUN — needs a real window that moves mid-step.

## E2E-COMPUTER-USE-voice-request-adds-no-authority-of-its-own

- **Preconditions**: Isolated desktop profile, a Live Voice fixture adapter with
  a bound work session, no real provider account or microphone. One run with
  computer use disabled, one with it enabled.
- **Steps**: Deliver a spoken request that asks the agent to operate an
  application, with the feature disabled and then enabled. Repeat with the
  session in Plan and in Goal. Press Stop during a spoken run and repeat the
  spoken request immediately.
- **Expected**: With the feature disabled the request fails
  `COMPUTER_DISABLED`; voice cannot enable it, and nothing is captured or
  synthesized. With it enabled the request runs as an ordinary Agent turn under
  the session's policy and the same automatic desktop grant the typed path gets
  (ADR 0344) — voice adds no authority and skips no refusal — with progress
  spoken through the existing work-feedback channel. Plan and Goal deny the tool
  before permission evaluation. A spoken retry inside the Stop cooldown fails
  `COMPUTER_STOPPED_BY_USER`.
- **Specs**: [Computer Use](../../03-runtime/computer-use.md),
  [live-voice](../../03-runtime/live-voice.md),
  [live-work-session](../../03-runtime/live-work-session.md).
- **Automation**: none. The spoken path is stage 3 and is deliberately not
  wired, so there is nothing to drive yet.
- **Status**: NOT RUN — stage 3.

## E2E-COMPUTER-USE-platform-support-is-explicit

- **Preconditions**: One run per supported platform plus a Wayland session and a
  platform with the OS permission denied.
- **Steps**: Enable the feature and open the doctor view on each platform. Have
  the agent call `Computer` so a grant is minted, and act. On Windows, bind a
  window owned by a higher-integrity process. On Wayland, attempt input and then
  capture. On a platform with Screen
  Recording or Accessibility denied, attempt inspection and capture.
- **Expected**: The doctor view distinguishes "not requested", "denied", and
  "unsupported on this platform". Input on Wayland fails
  `COMPUTER_PLATFORM_UNSUPPORTED` while portal capture still works; an elevated
  Windows target fails `COMPUTER_TARGET_ELEVATED` rather than dropping events; a
  denied OS permission fails `COMPUTER_OS_PERMISSION_MISSING`. No path hangs and
  none reports success without acting.
- **Specs**: [Computer Use](../../03-runtime/computer-use.md).
- **Automation**: `computer::tests::an_unsupported_platform_refuses_every_operation`
  in host-core covers the fallback backend every unported platform uses.
- **Status**: NOT RUN — needs one run per platform, including Wayland.

## E2E-TOOLS-session-background-jobs

- Split follow-up regression: cancel TaskStop during capability discovery (zero stop requests) and after dispatch (one stop request); late RPC failure stays observed.

- Split follow-up regression: command previews retain a UTF-8 prefix with an independent truncation flag; old snapshots omit the flag and output still retains final errors.

- Entry: build shared/agent-runtime/host-runtime and Host, then run
  `PI_DESKTOP_HOST_BIN=<candidate-host> node scripts/e2e-session-background-jobs.mjs`.
- Environment: isolated Host data and workspace, production runtime and pi tool
  loop, deterministic localhost HTTP provider. No external model account.
- Sequence: start a background test, list it, wait for failure and Unicode
  output tails; start a service, time out waiting, call default stop, then
  explicitly stop and wait for the same job using plain `{job}` selectors.
  Then re-read the failed job with empty `delegationIds`, `mode: all`, and
  `minCompleted: 1`; start a second service, time out with `mode: any` and the
  same defaults, stop with empty `delegationIds`, and confirm it is stopped.
  Both plain and model-generated redundant forms retain independent coverage.
- Expected: correct exit code and both final tails, per-stream UTF-8 limits,
  cross-session list/read/stop isolation, timeout and default stop preserve Bash,
  explicit stop reaches terminal state, repeated reads and desktop output agree.
  Plan-mode access is rejected.
- Runtime tests cover new input/parent abort during a pending Host wait, late
  Host rejection, old Host/remote capability behavior, conflicting/malformed
  delegation selectors, harmless Bash defaults and conflicting/malformed Bash
  selector rejection, existing delegation controls and registration without a
  subagent catalog. Plain-job timeout/abort cases remain intact; additional
  cases exercise both `all` and `any` defaults through those same lifecycles.
- Host tests cover pre-settled observation, repeatable output, Unicode clipping,
  ownership lookup, idempotent stop and stop acknowledgement before termination.
  On macOS, after a successful group stop and child exit, check that a cleanup
  denial followed by a missing group settles as stopped; a persistent denial
  or still-present group must retain the cleanup failure.
  Existing Windows child/grandchild cleanup tests remain required; record native
  failures separately from protocol success.
- Exercise a late stop with an already reaped child before the supervisor drains the pipes. Verify the original exit outcome, final output and stable elapsed time across reads. Stall capability discovery or the first Host observation to exercise the overall wait deadline. The Electron transcript fixture renders a pending Bash stop and a mixed job list.

## E2E-ISSUE-2162

Closing the connected Browser tab clears its connection. Subsequent session-only tools use that session's selected replacement page. Explicit closed targets fail; navigation never revives an invisible old tab. Verify close/reopen/snapshot/fill/click/navigate and final closure with `browser-background-session.test.mjs` and `BROWSER_CLOSE_CONNECTION_ONLY=1 node scripts/e2e-browser-background.mjs`.

## E2E-ISSUE-2173: Redundant delegation job selectors

- Entry: build shared/agent-runtime/host-runtime and Host, then run
  `PI_DESKTOP_HOST_BIN=<candidate-host> node scripts/e2e-task-job-selectors.mjs`.
- Preconditions: isolated Host data/workspace and a deterministic localhost
  provider; production parent and delegate loops, with no external model account.
- Steps: start a delegate; wait with both its job reference and matching
  delegationIds; re-read with empty delegationIds and single-job mode/minCompleted;
  start another delegate, hold its provider response, stop it with both selectors,
  and confirm its stopped state through TaskWait.
- Expected: reports remain readable, redundant selectors do not cause errors,
  single-job mode/minCompleted are ignored, and cancellation settles the target.
  Unit tests also reject conflicting/malformed IDs and nonempty or malformed
  Bash selectors; harmless empty/default Bash options remain accepted.
- Specs: `03-runtime/02-agent-runtime.md`, Session job controls.
- Acceptance: wait, report re-read and running-delegate cancellation complete
  through the real tool loop. Milestone: maintenance. Status: automated.

## E2E-NATIVE-workspace-file-routing

Run `node scripts/e2e-native-workspace-files.mjs`: isolated Electron Main,
production workspace IPC, synthetic sidecar session metadata and real fixture
files. Select an unrelated Desktop workspace; list, read and resolve a native
file, then reject a missing native session. The test asserts no native session
or scratch RPC reaches Desktop storage. `native-workspace-files.test.mjs`
additionally rejects replaced sidecars. No provider execution or native user
session data is used.

## E2E-CODEMODE-sandboxed-nested-calls

- Entry: `pnpm --filter @pi-desktop/agent-runtime test -- src/codemode scripts/codemode-bundle.test.mjs`
  and `node --test apps/desktop/test/codemode-settings-user-path.test.mjs
  apps/desktop/test/jev-session-launch.test.mjs`.
- Preconditions: deterministic localhost Responses fixture and a fake Host; no
  external model account. The packaged probe runs from a temporary directory
  with no reachable node_modules.
- Steps: with the setting off, confirm `codemode` is not declared. Turn it on;
  run a script that reads a file, calls a never-activated on-demand tool, lists
  models and requests a sub-model completion. Activate a plugin tool with
  ToolSearch and call it from a script while Host denies Bash. Stop a script
  whose nested Bash call is held by Host. Replay a transcript that contains a
  nested row. Toggle the Settings switch.
- Expected: nested Host calls carry `<callId>/<n>` and `nestedParentToolCallId`
  only; the inactive tool is absent from the sandbox; Host denial rejects inside
  the script; Stop sends `tools.abort` for the nested call; only the script
  result reaches the next request; model metadata carries no credential or
  header; each physical request emits distinct identified usage; nested rows
  are not replayed; the packaged worker and WASM run outside node_modules and a
  missing asset fails the script; the switch is off by default and persists
  `codemodeEnabled`, and Electron main forwards it only in Agent mode.
- Specs: `03-runtime/03-tools-and-permissions.md` §2.2, `04-ux/06-settings-ia.md`.
- Acceptance: C / E / Security / Quality. Milestone: M6+. Status: automated.

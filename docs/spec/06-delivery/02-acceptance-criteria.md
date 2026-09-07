# 02. Acceptance Criteria

> Language: English (per ADR 0009).
> Sign-off state: M1–M4 accepted 2026-07-25 per `docs/project/BOARD.md`
> validation snapshot; M5 items tracked in [milestones](01-mvp-milestones.md).
> Evidence keys: `auto:<script>` = automated check, `manual:M<n>` = verified
> during that milestone's exit review, `open` = not yet verified.

## 1. MVP acceptance statement

MVP passes when:

> On macOS, a user can configure a model, open a project, complete one
> permission-gated task that uses tools, and restore the session after an
> app restart.

## 2. Functional acceptance

### A. App startup
- [x] App launches and shows the main window — auto:`test:e2e:boot`
- [x] Main↔renderer bridge works — auto:`test:e2e:boot` (sandboxed preload + IPC round-trip)
- [x] App version info is exposed — auto:`test:e2e:boot` (version + host protocol)
- [x] First-run inline checklist appears on a fresh profile — manual:M2

### B. Model configuration
- [x] A provider can be added — auto:`test:e2e` (provider CRUD)
- [x] An API key can be saved — auto:`test:e2e` (secret set/get via host)
- [x] Key survives restart (no re-entry needed) — manual:M2 (safeStorage-backed store)
- [x] Clear blocking message when no model is configured — manual:M2 (`MODEL_NOT_CONFIGURED`)

### C. Sessions and streaming chat
- [x] New session can be created — auto:`test:e2e`
- [x] Message can be sent — auto:`test:e2e` (live model, when key provided)
- [x] Assistant output streams token-by-token — auto:`test:e2e` / `e2e-agent-live`
- [x] Generation can be aborted — manual:M2 (abort → partial output preserved)
- [x] Switching between history sessions works — manual:M2
- [x] An idle session can be forked into an independent conversation —
  auto:host-core + desktop contract tests

### D. Workspace
- [x] A project directory can be selected — manual:M3
- [x] UI shows the current project — manual:M3
- [x] Tool paths resolve against the project root — auto:host-core tests (`workspace::tests`)

### E. Tools and permissions
- [x] Plan and Goal deny Write/Edit/plugin tools under every permission mode —
  auto:`test:e2e:plan` E2E-105 + host-core permission tests
- [x] Plan and Goal Bash prompt under Ask/Accept edits and run without confirmation
  under explicit Auto — auto:`test:e2e:plan` E2E-105 + host-core permission tests
- [x] Agent mode uses permission policy for Write/Edit/Bash — manual:M3
- [x] Permission timeout (120s) becomes deny — manual:M3 (D005)
- [x] Read/Glob/Grep work inside the project — auto:`test:e2e` (glob tool)
- [x] Write/Edit/Bash trigger an inline, session-scoped confirmation card — manual:M3
- [x] Background events and permission requests never activate or cover another
  session — unit:desktop permission contracts; full UI manual:M5
- [x] Deny prevents execution — manual:M3
- [x] Allow returns the result to model and UI — manual:M3
- [x] Paths outside the workspace are permission-gated — auto:host-core tests
  (outside-path prompt/deny/allow and Auto execution)

### M6. Plan checkpoint and shell execution
- [x] One pi Agent owns Agent, planning, approval, and post-approval execution —
  auto:agent-runtime + `test:e2e:plan`/`test:e2e:plan-ui`
- [x] Goal reuses the same host-owned approval pipeline, writes a distinct
  `.pi/goal/*.md` artifact, and resumes in Agent mode to verify acceptance
  criteria — auto:agent-runtime + desktop/runtime contract coverage
- [x] `EnterPlanMode` and UI/session Plan selection converge on the same state —
  auto:host-core CAS tests + `test:e2e:plan-ui`
- [x] `SubmitPlan(title, markdown, question)` preserves exact Markdown bytes in
  a unique `.pi/plan/*.md` artifact, keeps title/question structured in
  `plan_approvals`, and records path/hash/size — auto:`test:e2e:plan` E2E-106
- [x] Approval offers only Approve/Reject; Approve requires an explicit
  permission mode with Ask selected by default — auto:`test:e2e:plan-ui`
  E2E-106/E2E-117
- [x] The approval deadline is an absolute 30 minutes and stale responses fail
  closed — auto:`test:e2e:plan` E2E-107 + host-core late-expiry test
- [x] Renderer retains the latest Plan/Goal proposal/execution snapshot only for the
  current renderer lifetime; `plans.pending` rehydrates only pending rows and
  original deadlines after renderer reload, terminal cards are not rehydrated
  after renderer reload, and Host restart restores no stale action —
  auto:`test:e2e:plan-ui` same-Host PID/negative reload assertions +
  `test:e2e:plan` E2E-108/E2E-109
- [x] Schema v7 first reaches v8 and then uses the guarded v8→v11 path; the
  v8→v11 migration is one atomic transaction with a WAL checkpoint and exact
  readable `pi.sqlite.v8.bak` before destructive work, while schema v9 and v10
  receive readable backups. Malformed app settings/scheduled config, invalid
  top-level operating modes, and unknown or wrong-platform default shells fail
  closed with schema v8 authoritative; platform-valid shells remain migratable
  when temporarily unavailable. Sessions, transcripts, nested extension modes,
  and `plan_approvals` artifact/execution fields survive — auto:host-core
  migration tests (139/139; 15 focused DB tests)
- [x] Pending, queued, and running Plan/Goal work is interrupted on host restart with
  no replay; an already-approved interrupted execution leaves the session Agent —
  auto:`test:e2e:plan` E2E-108/E2E-109
- [x] Scheduled/unattended Plan/Goal runs fail before the provider request —
  auto:`test:e2e:plan` E2E-110
- [x] Plan/Goal plugin tools remain denied despite low risk, grants, or Auto —
  auto:`test:e2e:plan` E2E-105 + host-core policy tests
- [x] Shell catalog selection persists a platform-valid ID, falls back to the
  first available platform shell when a later lookup is unavailable, rejects a
  stale turn ID/dialect, streams stdout/stderr, enforces the 60s default
  timeout, and kills process trees on abort — auto:`test:e2e:plan`
  E2E-112–E2E-116 + host-core fallback test

### M6+ Current product increment
- [x] Extensions keeps only Installed and Marketplace tabs; Settings > Agent
  provides independent Skills, MCP, and global-only Subagents pages with fixed
  columns, local enablement, project selection, and source scanning —
  unit/source contracts plus E2E-100–E2E-103
- [x] Session import, scheduled task records, composer file references and
  clipboard files, global plugin launcher, and next-turn configuration are
  represented by the current E2E catalog — E2E-036, E2E-059, E2E-102,
  E2E-102a, E2E-103, E2E-120

### F. Persistence
- [x] Sessions survive restart — manual:M2 (SQLite via host-core)
- [x] Message history is restored — manual:M2
- [x] Session deletion takes effect — auto:`test:e2e`
- [x] Forked source/child histories persist and diverge independently —
  auto:host-core tests

### G. Plugin system (local minimum)
- [x] Plugin loads from a local directory — auto:`test:e2e` (dev load)
- [x] Plugin command appears in the palette and executes — manual:M4
- [ ] Plugin can open a panel (if declared) — open (ui.openPanel is a toast stub; PluginPanelHost tracked post-MVP)
- [x] Plugin can register and serve at least one agent tool — auto:`test:e2e` (E2E-024 dispatch roundtrip)
- [x] Disabling removes commands and tools — auto:`test:e2e` (plugin disable)
- [x] A plugin exception does not crash the app — manual:M4

### H. Diagnostics
- [x] Errors expose stable codes — auto:`test:e2e` (fatal-path assertions)
- [x] Logs folder can be opened from the app — manual:M5 (Open logs action)
- [x] Secrets never appear in logs on normal flows — auto:`test:e2e` (no-secret-leak)

## 3. Security acceptance

- [x] Renderer has no Node integration (sandboxed, contextIsolation) — auto:`test:e2e:boot`
- [x] Non-whitelisted IPC channels cannot be invoked — manual:M1 (preload whitelist assertion)
- [x] Secrets are never written to plain logs — auto:`test:e2e` + Logger/audit redaction
- [x] High-risk tools require confirmation by default — manual:M3
- [ ] Plugin without a granted permission cannot call the API — open (enforcement matrix lands with plugin runtime isolation, see 07-plugins/13)
- [x] Plugins cannot read provider API keys — manual:M4 (no secrets surface in plugin host services)

## 4. Quality acceptance

- [x] No crash on the main path — auto:`test:e2e:boot` + `test:e2e:supervision`
- [x] Errors show a readable message — manual:M2 (AppError message surfaced)
- [x] Long output does not freeze the UI — manual:M3 (per-tool budgets; search 128KB / 4000 lines)
- [x] Key operations show loading/running state — manual:M2
- [x] Release package has no duplicate renderer/runtime dependency trees —
  auto:desktop package contract + native macOS arm64/Intel x64 package audit:E2E-092
- [ ] Packaged startup and local renderer/runtime capabilities remain available
  offline on every native target — draft:E2E-092

## 5. Acceptance demo script

1. Launch PI-Desktop
2. Configure a working model
3. Open a local sample project
4. Ask: explain the project structure
5. Ask: modify a harmless file and add a comment
6. Approve on the permission card
7. Abort one generation mid-stream
8. Restart the app, confirm the session is still there
9. Load the sample plugin, run one plugin command
10. Disable the plugin and confirm the command disappears

All steps passing = MVP functional acceptance.

## 6. Failure handling

- Blocking: any failure in A/B/C/E/F/G or Security means MVP cannot be
  declared complete.
- Non-blocking: UI details, copy, off-main-path bugs go to known issues.

# 04. E2E Test Plan

## 1. Goals

- Document every user-visible and protocol-visible behavior that MVP must verify.
- Provide a scenario catalog that maps to acceptance criteria (A–H) and milestones (M1–M6).
- Serve as the traceability backbone: scenario ID ↔ acceptance criterion ↔ spec.
- Define the required E2E gate for code-bearing task candidates containing the
  latest `origin/main`, before the pull request; do not merge into local `main`.
- Keep validation evidence tied to the commit the gate ran on, plus any later
  commit that changes the landed executable content.

## Scenario catalogs

Scenarios are grouped by product domain. Add a new scenario to the file
that owns its domain; keep its ID unique across all files.

| Domain | Catalog |
|---|---|
| Release, Platform, and Storage | [`e2e/release-and-platform.md`](e2e/release-and-platform.md) |
| Providers and Models | [`e2e/providers-and-models.md`](e2e/providers-and-models.md) |
| Conversation and Sessions | [`e2e/conversation.md`](e2e/conversation.md) |
| Tools, Permissions, and Workspace | [`e2e/tools-and-workspace.md`](e2e/tools-and-workspace.md) |
| Plugins and Extensions | [`e2e/plugins-and-extensions.md`](e2e/plugins-and-extensions.md) |
| Plans, Goals, Modes, and Automations | [`e2e/plans-goals-automation.md`](e2e/plans-goals-automation.md) |
| UI Shell | [`e2e/ui-shell.md`](e2e/ui-shell.md) |
| Live Sessions and Remote Control | [`e2e/live-and-remote.md`](e2e/live-and-remote.md) |

---

## 2. Non-goals

- Full UI-driven automated coverage; protocol and source-contract automation is
  active while the broader desktop suite remains planned.
- General performance / stress testing (post-MVP); bounded regression checks
  for desktop responsiveness are covered by the relevant functional scenarios.
- Native Windows/Linux release qualification (published artifacts exist; native
  qualification gaps remain documented).
- Hostile-plugin sandbox scenarios. Publisher provenance and the marketplace
  download boundary are now in scope (E2E-024R through E2E-024V); basic
  browse/install/update flows were already part of the catalog.
- Remote Gateway / browser control remains out of scope (ADR 0004 / baseline
  #20); the bounded local loopback MCP control plane is covered by E2E-220.

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

**Strategy**: document all E2E scenarios; add or update unit/integration tests
alongside code when change risk makes them necessary; use selective, high-value
E2E suites for every code-bearing pull request. Lower-level tests localize
correctness, while E2E validates cross-process runtime behavior; passing lower
levels does not waive the relevant E2E gate.

---

## 4. Tooling Intent

| Tool | Purpose | Status |
|---|---|---|
| **Vitest** | Unit + integration (TS side) | Active (`pnpm test`, shared package) |
| **Rust #[test]** | Host-core unit tests | Active (`cargo test -p host-core`) |
| **Protocol smoke** | Host RPC + tools + plugins headless | Active (`test:e2e`, 22 checks) |
| **Electron probes** | Boot bridge, session-list responsiveness, and crash supervision | Active (`test:e2e:boot`, `test:e2e:supervision`) |
| **Playwright** | Full UI-driven journeys | Planned (post-M5) |

> Decision: protocol smoke and Electron probes are active validation assets;
> broader desktop journeys remain scenario-specific and must be recorded as
> environment-limited when their required platform is unavailable.

---

## 5. Environment Requirements

| Requirement | Detail |
|---|---|
| Platform | macOS arm64 and Intel x64, Windows x64, and Linux x64 and arm64 release targets (D126/D285, D638 / ADR 0318) |
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

## E2E Main Integration Validation

Every code-bearing change must pass the E2E suites relevant to its regression
surface on a candidate that already contains the latest `origin/main`, before
the request branch is pushed and the pull request is opened. Code-bearing
changes include Renderer, Electron Main, Preload, Agent Runtime, Rust
host-core, sessions, transcripts, plans, plugins, MCP, permissions,
provider/model runtime, persistence, process lifecycle, packaging/runtime
startup, and build or CI behavior that affects application execution.
Documentation-only changes are exempt when they do not alter executable
behavior.

Run the selected suites from the request worktree after `pnpm check:pr-base`
passes. An E2E run on a branch that is behind `origin/main` is exploratory and
does not satisfy this gate. Do not merge the task into local `main` to create
the candidate.

### E2E environment reuse

Task-candidate E2E runs from the request worktree after the candidate is
prepared, but uses the host development environment already provisioned in the
primary checkout. Reuse the compatible Node/pnpm toolchain, `node_modules`,
Electron, Rust/Cargo targets, package-manager stores, build caches, and ignored
configuration by reference or link when needed.

Do not run `pnpm install`, `npm install`, or create a second dependency/runtime
environment solely for E2E. Isolate only mutable test state: temporary
profiles, data directories, sockets, ports, logs, and artifacts. Install or
rebuild dependencies only when the host environment is missing or incompatible
and record the reason. Clean CI and release runners may install from lockfiles.

From a fresh request worktree, run `node scripts/reuse-worktree-deps.mjs` with
the same Node version/ABI as the primary installation. It links installed
third-party packages and points `@pi-desktop/*` at this worktree; build those
workspace packages here. If the primary installation is stale, pass the path of
another checkout of this repository with matching installed dependencies and
keep it until the consuming worktree is removed. If none matches, use an
isolated install. Never install, prune, or rebuild through shared links.
The helper copies mutable `.bin` shims locally. Before `pnpm run` or `pnpm exec`,
set `pnpm_config_verify_deps_before_run=false` in the command environment to
prevent pnpm from automatically installing into the linked layout (PowerShell:
`$env:pnpm_config_verify_deps_before_run='false'`).

Use the root `package.json` as the source of truth for executable commands.
The minimum selection is:

- Cross-cutting runtime, host, or IPC: `pnpm test:e2e`.
- Electron startup, preload, or window lifecycle: `pnpm test:e2e` and
  `pnpm test:e2e:boot`. For packaged-startup regressions, also run
  `node scripts/e2e-electron-boot.mjs <packaged-executable>` against the
  installed-layout artifact with an isolated profile.
- Session-list refresh or model capability lookup: `pnpm test:e2e` and
  `pnpm test:e2e:boot`, including the synthetic large-list responsiveness check.
- Settings/composer/plugin search theme surfaces: `pnpm build:js` followed by
  `pnpm test:e2e:theme-surfaces`.
- Composer clipboard representation and text insertion: `pnpm test:e2e:composer-paste`.
- Composer slash-menu name/description layout: `pnpm build:js` followed by
  `pnpm test:e2e:composer-autocomplete`.
- Transcript render boundaries and cross-part delegation display: `pnpm test:e2e:transcript`.
- Plan host/runtime behavior: `pnpm test:e2e` and `pnpm test:e2e:plan`.
- Plan UI behavior: `pnpm test:e2e:plan` and `pnpm test:e2e:plan-ui`.
- Host supervision, crash recovery, or restart behavior: `pnpm test:e2e` and
  `pnpm test:e2e:supervision`.
- Subagent lifecycle: `pnpm test:e2e` and `pnpm test:e2e:subagents`.
- Imported-extension dependency installation or registry-boundary changes: `pnpm test:e2e:plugin-import-deps`.
- Trusted extension or plugin-extension changes: `pnpm test:e2e:trusted-extensions`.
- Session collaboration / Session Orchestrator: `pnpm test:e2e:collaboration`.
- Completion-notice silence or the silent-turn contract (D193 / D446): `pnpm test:e2e:session-completion`.
- Changes spanning multiple surfaces use the union of the applicable suites.

`pnpm test:e2e` is the default cross-system smoke suite for host RPC, IPC,
agent execution, plugins, persistence integration, and shared runtime
contracts. A required suite that cannot run because of a missing display,
platform, credential, hardware resource, or other environment capability must
be recorded as `NOT RUN` with its reason, alternative validation, and remaining
risk. The pull request may still be opened with that record so the change can
be validated in a capable environment, but the gate is not satisfied and
delivery remains incomplete until the suite passes against the integrated
`main` that carries the change.

Required results must apply to the executable commit the gate ran on, and any
later commit that changes the landed executable content requires a rerun of
the affected suites (landing fixes, conflict resolution, or commits added
during review). Otherwise the recorded result stands. Report each command,
result, tested commit, and any relevant environment limitation; never claim an
unexecuted suite passed.

## E2E Failure Policy

A failed required E2E blocks the branch push, the pull request, and declaring
the integrated delivery complete until the failure is classified as an
implementation regression, test regression, environment failure, or known
flaky infrastructure. Fix the product or test defect and rerun the affected
suite against the integrated `main`. Do not delete scenarios, weaken
assertions, or add retries that hide a deterministic failure. When a scenario
is not automated on the required platform, keep its status documented and
identify the platform validation still needed.

## 8. Traceability Matrix

| Acceptance | Scenarios |
|---|---|
| C / E / Security / Quality — Gemini work setup | E2E-LIVE-VOICE-gemini-work-schema |
| C / Quality — Continue after malformed tool output | E2E-RUNTIME-malformed-tool-call-continue-recovery |
| B / Security / Quality — Optional provider client certificate requests | E2E-PROVIDER-optional-client-certificate |
| C / E / F / Quality / Security — Session Todo checklist | E2E-CHAT-session-todo-checklist |
| C / E / Security / Quality — Live Voice four-stage interaction | E2E-LIVE-VOICE-four-stage-ui |
| C / F — Hourly task updates | E2E-SCHEDULED-manual-to-hourly |
| C / F / Quality — Saved project isolation | E2E-SCHEDULED-manual-workspace-binding |
| C / F / Quality — Desktop automations | E2E-SCHEDULED-desktop-automation-lifecycle |
| F / Security / Quality — Portable configuration sync | E2E-CONFIG-SYNC-s3-portable-configuration |
| A / C — Unicode stdio framing | E2E-RPC-unicode-separators |
| C / G / Quality — Plugins navigation | E2E-NAV-plugins-button-goes-back |
| C / D / Quality — Sidebar row states | E2E-LAYOUT-sidebar-row-states |
| C / D / Quality — Sidebar lists at high zoom | E2E-LAYOUT-sidebar-height |
| E / Quality — Browser screenshot timeout recovery | E2E-BROWSER-capture-resize |
| A / C / Quality — Sidebar material and settings return | E2E-LAYOUT-sidebar-settings |
| C / Quality — Destination loading and focus | E2E-087b |
| A / H / Quality — Renderer process crash recovery | E2E-RUNTIME-renderer-crash-recovery |
| C / F / Quality — Project folder with chats detaches and deletes safely | E2E-048c |
| B / F / Security — Provider copy | E2E-PROVIDER-copy-config-without-credentials |
| C / Quality — Self-hosted endpoint receives the session id | E2E-PROVIDER-custom-endpoint-session-identity |
| B / F / Quality — Selected model order | E2E-MODEL-selected-order-persists |
| E / F / Quality — MCP server timeout override | E2E-261 |
| A — App startup | E2E-001, E2E-002, E2E-003, E2E-004, E2E-067, E2E-076, E2E-079, E2E-092, E2E-097, E2E-143, E2E-150, E2E-168, E2E-204 |
| A / C / F / Quality — Tray session navigation | E2E-TRAY-bounded-session-navigation |
| B — Model config | E2E-005, E2E-PROVIDER-custom-endpoint-no-api-key, E2E-PROVIDER-unsigned-thinking-replay, E2E-006, E2E-007, E2E-038, E2E-050, E2E-052, E2E-055, E2E-066, E2E-080, E2E-082, E2E-102c, E2E-102d, E2E-102e, E2E-151, E2E-154, E2E-163, E2E-166, E2E-172, E2E-174, E2E-197, E2E-005G, E2E-005J, E2E-199, E2E-201, E2E-202, E2E-203, E2E-205, E2E-206, E2E-209, E2E-PLUGIN-provider-catalog-add-service |
| C — Conversation & stream | E2E-CHAT-long-history-stream-keeps-responsive, E2E-CHAT-running-status-survives-output-pauses, E2E-008, E2E-008d, E2E-008e, E2E-008a, E2E-009, E2E-010, E2E-011, E2E-011a, E2E-011b, E2E-011d, E2E-011e, E2E-011g, E2E-031, E2E-040, E2E-047, E2E-048, E2E-048A, E2E-049, E2E-052, E2E-053, E2E-054, E2E-055, E2E-059, E2E-059a, E2E-060c, E2E-060d, E2E-061, E2E-061a, E2E-062, E2E-064, E2E-065, E2E-068, E2E-071, E2E-073, E2E-074, E2E-075, E2E-081, E2E-083, E2E-084, E2E-086, E2E-087, E2E-088, E2E-088b, E2E-089, E2E-090, E2E-COMPOSER-narrow-controls, E2E-094, E2E-095, E2E-096, E2E-097, E2E-098, E2E-099, E2E-102, E2E-102a, E2E-102b, E2E-102c, E2E-102d, E2E-102g, E2E-106, E2E-109, E2E-111, E2E-114, E2E-116, E2E-117, E2E-118, E2E-119, E2E-120, E2E-121, E2E-218, E2E-259, E2E-219, E2E-AGENTS-001, E2E-142, E2E-144, E2E-145, E2E-146, E2E-146a, E2E-147, E2E-151, E2E-154, E2E-155, E2E-158, E2E-159, E2E-161, E2E-162, E2E-166, E2E-172, E2E-173, E2E-174, E2E-177, E2E-178, E2E-179, E2E-180, E2E-182, E2E-183, E2E-187, E2E-198, E2E-199, E2E-202, E2E-203, E2E-207, E2E-208, E2E-CHAT-content-width-handles, E2E-250, E2E-102i, E2E-PLUGIN-session-orchestrator-real-workers, E2E-SUBAGENT-settlement-updates-before-parent-poll, E2E-SUBAGENT-resume-a-settled-delegation |
| C — Conversation & stream (composer drafts) | E2E-011c, E2E-011c-1, E2E-011c-2 |
| D — Workspace | E2E-012, E2E-013, E2E-022B, E2E-024I, E2E-047, E2E-049, E2E-057, E2E-058, E2E-060, E2E-068, E2E-075, E2E-078, E2E-153, E2E-158, E2E-182, E2E-187, E2E-252 |
| C / D / Quality — Project session history resets after collapse | E2E-263 |
| D — Workspace (project ordering) | E2E-253 |
| E — Tools & permissions | E2E-008a, E2E-014, E2E-015, E2E-016, E2E-017, E2E-018, E2E-019, E2E-024I, E2E-024K, E2E-040, E2E-049, E2E-074, E2E-093, E2E-097, E2E-099, E2E-100, E2E-101, E2E-102, E2E-102d, E2E-102e, E2E-102g, E2E-103, E2E-105, E2E-106, E2E-107, E2E-111, E2E-112, E2E-113, E2E-114, E2E-115, E2E-116, E2E-119, E2E-121, E2E-122, E2E-142, E2E-145, E2E-147, E2E-155, E2E-158, E2E-166, E2E-181, E2E-PLUGIN-imported-pi-package-skills |
| F — Persistence | E2E-020, E2E-021, E2E-021a, E2E-038, E2E-SETTINGS-inline-capability-imports, E2E-040, E2E-042, E2E-047, E2E-048, E2E-051, E2E-054, E2E-056, E2E-061, E2E-062, E2E-064, E2E-066, E2E-068, E2E-071, E2E-072, E2E-073, E2E-082, E2E-084, E2E-096, E2E-098, E2E-102, E2E-102b, E2E-102c, E2E-102d, E2E-102g, E2E-102i, E2E-103, E2E-AGENTS-001, E2E-061a, E2E-073a, E2E-104, E2E-106, E2E-107, E2E-108, E2E-109, E2E-110, E2E-112, E2E-118, E2E-119, E2E-120, E2E-121, E2E-123, E2E-142, E2E-146, E2E-146a, E2E-148, E2E-151, E2E-158, E2E-160, E2E-168, E2E-171, E2E-177, E2E-178, E2E-183, E2E-186, E2E-005J, E2E-PROVIDER-custom-endpoint-no-api-key, E2E-PLUGIN-session-orchestrator-real-workers, E2E-PLUGIN-provider-catalog-add-service, E2E-SESSION-outbox-unclassifiable-failure-does-not-stall-the-queue |
| F — Persistence (project ordering) | E2E-251 |
| G / Update — Bundled Official Enhancements defaults | E2E-PLUGIN-bundled-enhancements-defaults |
| G / Security — Fetch redirect policy | E2E-PLUGIN-fetch-redirect-policy |
| G — Plugins | E2E-022, E2E-022A, E2E-022B, E2E-022C, E2E-023, E2E-024, E2E-024B, E2E-024C, E2E-024D, E2E-024AA, E2E-024E, E2E-024W, E2E-024F, E2E-024G, E2E-024H, E2E-024I, E2E-024J, E2E-024K, E2E-024L, E2E-024M, E2E-024N, E2E-024O, E2E-024P, E2E-025, E2E-026, E2E-105, E2E-117, E2E-120, E2E-122, E2E-123, E2E-024Q, E2E-148, E2E-152, E2E-153, E2E-PLUGIN-imported-pi-package-skills, E2E-PLUGIN-imported-pi-package-wrapper, E2E-PLUGIN-import-extension-installs-dependencies, E2E-PLUGIN-import-extension-reports-missing-dependency, E2E-PLUGIN-global-shortcut-owns-only-its-own-command, E2E-PLUGIN-permission-gate-for-real-time-capabilities, E2E-PLUGIN-background-audio-and-realtime-connection, E2E-PLUGIN-fs-root-follows-the-calling-session, E2E-PLUGIN-provider-catalog-add-service, E2E-PLUGIN-reviews-public-reads |
| H — Diagnostics | E2E-027, E2E-031, E2E-034, E2E-042, E2E-096, E2E-098, E2E-104, E2E-107, E2E-108, E2E-109, E2E-110, E2E-113, E2E-115, E2E-116, E2E-118, E2E-121, E2E-146, E2E-146a, E2E-155, E2E-159, E2E-176, E2E-194, E2E-195 |
| Security | E2E-SETTINGS-inline-capability-imports, E2E-028, E2E-029, E2E-030, E2E-024J, E2E-024K, E2E-024M, E2E-049, E2E-068, E2E-086, E2E-102c, E2E-102d, E2E-102e, E2E-105, E2E-106, E2E-107, E2E-108, E2E-109, E2E-110, E2E-112, E2E-113, E2E-115, E2E-116, E2E-117, E2E-119, E2E-121, E2E-122, E2E-123, E2E-142, E2E-148, E2E-151, E2E-153, E2E-158, E2E-187, E2E-196c, E2E-196b, E2E-196, E2E-PROVIDER-custom-endpoint-no-api-key, E2E-PLUGIN-fs-root-follows-the-calling-session, E2E-PLUGIN-provider-catalog-add-service, E2E-PLUGIN-reviews-public-reads |
| Quality | E2E-SETTINGS-inline-capability-imports, E2E-CHAT-long-history-stream-keeps-responsive, E2E-CHAT-running-status-survives-output-pauses, E2E-032, E2E-033, E2E-039, E2E-043, E2E-044, E2E-045, E2E-046, E2E-047, E2E-048, E2E-048A, E2E-049, E2E-050, E2E-053, E2E-055, E2E-056, E2E-057, E2E-058, E2E-059, E2E-060, E2E-061, E2E-062, E2E-063, E2E-064, E2E-065, E2E-066, E2E-067, E2E-068, E2E-069, E2E-070, E2E-071, E2E-072, E2E-073, E2E-074, E2E-075, E2E-076, E2E-077, E2E-078, E2E-079, E2E-080, E2E-081, E2E-082, E2E-083, E2E-084, E2E-085, E2E-086, E2E-092, E2E-093, E2E-094, E2E-095, E2E-096, E2E-097, E2E-098, E2E-099, E2E-100, E2E-101, E2E-102, E2E-102a, E2E-102b, E2E-102c, E2E-102d, E2E-102e, E2E-103, E2E-AGENTS-001, E2E-021a, E2E-024N, E2E-059a, E2E-060b, E2E-060c, E2E-061a, E2E-073a, E2E-111, E2E-114, E2E-117, E2E-118, E2E-119, E2E-120, E2E-122, E2E-123, E2E-142, E2E-143, E2E-144, E2E-145, E2E-146, E2E-147, E2E-148, E2E-150, E2E-151, E2E-153, E2E-155, E2E-158, E2E-159, E2E-160, E2E-161, E2E-162, E2E-163, E2E-168, E2E-172, E2E-173, E2E-174, E2E-011g, E2E-176, E2E-177, E2E-178, E2E-179, E2E-180, E2E-181, E2E-182, E2E-183, E2E-186, E2E-187, E2E-194, E2E-195, E2E-196a, E2E-196b, E2E-196c, E2E-198, E2E-199, E2E-200, E2E-196, E2E-201, E2E-204, E2E-202, E2E-203, E2E-205, E2E-206, E2E-207, E2E-208, E2E-209, E2E-210, E2E-UPDATE-preference-and-once-only-reminder, E2E-218, E2E-259, E2E-219, E2E-250, E2E-252, E2E-102i, E2E-SUBAGENT-settlement-updates-before-parent-poll, E2E-PLUGIN-imported-pi-package-skills, E2E-PLUGIN-fs-root-follows-the-calling-session, E2E-SUBAGENT-resume-a-settled-delegation, E2E-PLUGIN-provider-catalog-add-service |
| Quality (sidebar menu placement) | E2E-021c |
| Quality (Recent project label width) | E2E-SIDEBAR-recent-project-label-width |
| Quality (project ordering) | E2E-253 |
| Quality (work-panel tab close visibility) | E2E-WORK-PANEL-active-tab-close-visibility |
| Quality (turn changed-files disclosure) | E2E-CHAT-turn-changed-files-summary |
| C / E / G / Quality — Pi kernel upgrade | E2E-PI-130-kernel-upgrade |
| C / E / G / Quality — Pi kernel upgrade | E2E-PI-140-kernel-upgrade |
| C — Conversation & stream (IME slash alias) | E2E-255 |
| E — Tools & permissions (Skill residency) | E2E-254 |
| Quality (Skill residency and IME slash alias) | E2E-254, E2E-255 |
| C / E / F / Quality — Built-in skill activation | E2E-SKILL-builtin-activation |
| Quality — Market catalog retry recovery | E2E-MARKET-CATALOG-RETRY |
| C — Conversation & stream (plugin session import visibility) | E2E-257 |
| F — Persistence (plugin session import visibility) | E2E-257 |
| G — Plugins (session import visibility) | E2E-257 |
| Quality (plugin session import visibility) | E2E-257 |
| Quality (Windows updater cache) | E2E-260 |
| G — Plugins (Session Orchestrator) | E2E-PLUGIN-session-orchestrator-real-workers |
| Security (Session Orchestrator) | E2E-PLUGIN-session-orchestrator-real-workers |
| Quality (Session Orchestrator) | E2E-PLUGIN-session-orchestrator-real-workers |
| C — Conversation & stream (Session list responsiveness) | E2E-SESSION-list-refresh-keeps-desktop-responsive |
| Quality (Session list responsiveness) | E2E-SESSION-list-refresh-keeps-desktop-responsive |
| Security (imported extension dependencies) | E2E-PLUGIN-import-extension-installs-dependencies, E2E-PLUGIN-import-extension-reports-missing-dependency |
| Quality (imported extension dependencies) | E2E-PLUGIN-import-extension-installs-dependencies, E2E-PLUGIN-import-extension-reports-missing-dependency |
| F / G / Security / Quality — Imported extension npm recovery | E2E-PLUGIN-import-extension-recovers-missing-npm |
| G — Plugins (desktop tool dispatch budget) | E2E-PLUGIN-slow-tool-is-not-cut-off-by-host-dispatch |
| C — Conversation & stream (Independent session communication) | E2E-SESSION-independent-top-level-communication |
| D — Plugin security (Independent session communication) | E2E-SESSION-independent-top-level-communication |
| G — Plugins (Independent session communication) | E2E-SESSION-independent-top-level-communication |
| Quality (Independent session communication) | E2E-SESSION-independent-top-level-communication, E2E-SESSION-hover-card-model-and-links |
| C — Conversation & stream (Hover card model and links) | E2E-SESSION-hover-card-model-and-links |
| C — Conversation & stream (Chat file references) | E2E-CHAT-shorthand-file-ref-opens-the-matching-file, E2E-CHAT-file-ref-opens-the-surface-that-owns-it |
| C / Quality / Security (Conversation MP4 attachments) | E2E-CHAT-mp4-attachment-opens-in-system-player |
| G — Plugins (Chat file references) | E2E-CHAT-file-ref-opens-the-surface-that-owns-it, E2E-PLUGIN-file-view-collapse-persists |
| Quality (Chat file references) | E2E-CHAT-shorthand-file-ref-opens-the-matching-file, E2E-CHAT-file-ref-opens-the-surface-that-owns-it, E2E-PLUGIN-file-view-collapse-persists |
| C / Quality (Composer deep file mentions) | E2E-COMPOSER-deep-file-mentions |
| G — Plugins (project folder roots) | E2E-PLUGIN-file-view-switches-folder-per-project |
| Security (project folder roots) | E2E-PLUGIN-file-view-switches-folder-per-project |
| Quality (project folder roots) | E2E-PLUGIN-file-view-switches-folder-per-project |
| D — Workspace (project delete) | E2E-PROJECT-delete-removes-project-and-owned-sessions |
| F — Persistence (project delete) | E2E-PROJECT-delete-removes-project-and-owned-sessions |
| Quality (project delete) | E2E-PROJECT-delete-removes-project-and-owned-sessions |
| Quality (two-click delete) | E2E-SESSION-two-click-delete-arms-first |
| Security (plugin real-time capabilities) | E2E-PLUGIN-global-shortcut-owns-only-its-own-command, E2E-PLUGIN-permission-gate-for-real-time-capabilities, E2E-PLUGIN-background-audio-and-realtime-connection |
| C — Conversation & stream (disclosure reading position) | E2E-CHAT-disclosure-toggle-keeps-reading-position |
| E — Tools & permissions (disclosure reading position) | E2E-CHAT-disclosure-toggle-keeps-reading-position |
| D (surfaces) / Quality — Remote-host Add and Pair form disclosure | E2E-REMOTE-HOST-settings-compact-inventory |
| E — Tools & permissions (capability level move) | E2E-CAPABILITY-move-across-levels |
| F — Persistence (capability level move) | E2E-CAPABILITY-move-across-levels |
| Quality (capability level move) | E2E-CAPABILITY-move-across-levels |

| Milestone | Scenarios |
|---|---|
| Post-MVP experimental interaction maintenance | E2E-LIVE-VOICE-four-stage-ui |
| M1 | E2E-001, E2E-002, E2E-003, E2E-028, E2E-029 |
| M2 | E2E-004, E2E-005, E2E-006, E2E-007, E2E-008, E2E-008d, E2E-008e, E2E-009, E2E-010, E2E-011, E2E-011a, E2E-011b, E2E-011d, E2E-011e, E2E-011g, E2E-020, E2E-021, E2E-021a, E2E-027, E2E-031, E2E-042, E2E-087, E2E-088, E2E-088b, E2E-089, E2E-090, E2E-COMPOSER-narrow-controls, E2E-144, E2E-005J, E2E-201, E2E-202, E2E-207, E2E-206 |
| M2 (sidebar menu placement) | E2E-021c |
| M3 | E2E-012, E2E-013, E2E-014, E2E-015, E2E-016, E2E-017, E2E-018, E2E-019, E2E-040 |
| M4 | E2E-022, E2E-023, E2E-024, E2E-025, E2E-026, E2E-030, E2E-038 |
| M5 | E2E-CHAT-long-history-stream-keeps-responsive, E2E-CHAT-running-status-survives-output-pauses, E2E-008a, E2E-032, E2E-033, E2E-034, E2E-039, E2E-043, E2E-044, E2E-045, E2E-046, E2E-047, E2E-048, E2E-048A, E2E-049, E2E-050, E2E-051, E2E-052, E2E-053, E2E-054, E2E-055, E2E-056, E2E-057, E2E-058, E2E-059, E2E-060, E2E-061, E2E-062, E2E-063, E2E-064, E2E-065, E2E-066, E2E-067, E2E-068, E2E-069, E2E-070, E2E-071, E2E-072, E2E-073, E2E-074, E2E-075, E2E-076, E2E-077, E2E-078, E2E-079, E2E-080, E2E-081, E2E-082, E2E-083, E2E-084, E2E-085, E2E-086, E2E-092, E2E-093, E2E-096, E2E-097, E2E-098, E2E-099, E2E-100, E2E-101, E2E-102, E2E-102a, E2E-102b, E2E-102c, E2E-102d, E2E-102e, E2E-AGENTS-001, E2E-059a, E2E-060b, E2E-060c, E2E-061a, E2E-073a, E2E-094, E2E-095, E2E-143, E2E-145, E2E-146, E2E-146a, E2E-147, E2E-177, E2E-178, E2E-180, E2E-181, E2E-182, E2E-183, E2E-186, E2E-187, E2E-194, E2E-195, E2E-204, E2E-208, E2E-CHAT-content-width-handles, E2E-250, E2E-252, E2E-102i, E2E-BROWSER-capture-resize |
| M5 (project ordering) | E2E-253 |
| M2 (IME slash alias) | E2E-255 |
| M5 (Skill residency) | E2E-254 |
| M6 | E2E-104, E2E-105, E2E-106, E2E-107, E2E-108, E2E-109, E2E-110, E2E-111, E2E-112, E2E-113, E2E-114, E2E-115, E2E-116, E2E-117, E2E-118, E2E-119, E2E-120, E2E-103, E2E-172 |
| M6+ | E2E-121, E2E-122, E2E-148, E2E-150, E2E-151, E2E-154, E2E-155, E2E-158, E2E-159, E2E-160, E2E-161, E2E-162, E2E-163, E2E-166, E2E-168, E2E-173, E2E-174, E2E-176, E2E-179, E2E-196a, E2E-196b, E2E-196c, E2E-198, E2E-199, E2E-200, E2E-202, E2E-203, E2E-205, E2E-209, E2E-SETTINGS-inline-capability-imports, E2E-210, E2E-UPDATE-preference-and-once-only-reminder, E2E-212, E2E-213, E2E-214, E2E-215, E2E-216, E2E-217, E2E-218, E2E-259, E2E-219, E2E-257, E2E-SUBAGENT-settlement-updates-before-parent-poll, E2E-PLUGIN-fs-root-follows-the-calling-session, E2E-SUBAGENT-resume-a-settled-delegation |
| M6+ (Session Orchestrator) | E2E-PLUGIN-session-orchestrator-real-workers |
| M6+ (Selected model order) | E2E-MODEL-selected-order-persists |
| M6+ (MCP server timeout override) | E2E-261 |
| M6+ (Destination loading and focus) | E2E-087b |
| M6+ (Session list responsiveness) | E2E-SESSION-list-refresh-keeps-desktop-responsive |
| M6+ (Windows updater cache) | E2E-260 |
| M6+ (Independent session communication) | E2E-SESSION-independent-top-level-communication, E2E-SESSION-hover-card-model-and-links |
| M5 (Chat file references) | E2E-CHAT-shorthand-file-ref-opens-the-matching-file, E2E-CHAT-file-ref-opens-the-surface-that-owns-it |
| M5 (Composer deep file mentions) | E2E-COMPOSER-deep-file-mentions |
| M5 (Conversation MP4 attachments) | E2E-CHAT-mp4-attachment-opens-in-system-player |
| M6+ (Chat file references) | E2E-PLUGIN-file-view-collapse-persists |
| M6+ (project folder roots) | E2E-PLUGIN-file-view-switches-folder-per-project |
| Post-MVP | E2E-022A, E2E-022B, E2E-022C, E2E-024I, E2E-024J, E2E-024K, E2E-024L, E2E-024M (plugin roadmap R2/R3/R6) |
| Post-baseline local automation | E2E-220 |
| Post-baseline local automation (MCP `pi_session_get` large compaction) | E2E-MCP-session-get-projects-large-compaction |
| Post-MVP remote control | E2E-221, E2E-222, E2E-223, E2E-224, E2E-225, E2E-226, E2E-227, E2E-228, E2E-229, E2E-230, E2E-231, E2E-232, E2E-REMOTE-HOST-settings-compact-inventory |
| Trusted extensions (R7 v1) | E2E-DIALOG-long-text-boundaries, E2E-241, E2E-242, E2E-HOOKS-prompt-chain, E2E-HOOKS-context-every-request, E2E-HOOKS-cancel-and-dispose, E2E-TRUSTED-EXTENSION-custom-agent-stream-and-binding, E2E-243, E2E-TRUSTED-EXTENSION-temporary-session-cwd-is-scratch, E2E-244, E2E-245, E2E-PLUGIN-imported-pi-package-skills, E2E-PLUGIN-import-extension-installs-dependencies, E2E-PLUGIN-import-extension-reports-missing-dependency, E2E-PLUGIN-declared-provider-appears-in-the-native-provider-list, E2E-PLUGIN-provider-catalog-add-service |
| Trusted extensions (R7 v1 npm recovery) | E2E-PLUGIN-import-extension-recovers-missing-npm |
| Post-MVP regression coverage (plugin tool dispatch) | E2E-PLUGIN-slow-tool-is-not-cut-off-by-host-dispatch |
| M6+ (Project delete) | E2E-PROJECT-delete-removes-project-and-owned-sessions |
| M6+ (Two-click delete) | E2E-SESSION-two-click-delete-arms-first |
| C — Conversation & stream (model fallback) | E2E-SUBAGENT-ordered-model-fallback-preserves-work |
| Quality (model fallback isolation) | E2E-SUBAGENT-ordered-model-fallback-preserves-work |
| C — Conversation & stream (legacy subagent turn limit) | E2E-SUBAGENT-legacy-turn-limit-frontmatter-is-ignored |
| Quality (legacy subagent turn limit) | E2E-SUBAGENT-legacy-turn-limit-frontmatter-is-ignored |
| M6+ (disclosure reading position) | E2E-CHAT-disclosure-toggle-keeps-reading-position |
| M6+ (capability level move) | E2E-CAPABILITY-move-across-levels |
| E — Tools & permissions (builtin subagent defaults) | E2E-SUBAGENT-settings-lists-builtin-defaults |
| Quality (builtin subagent defaults) | E2E-SUBAGENT-settings-lists-builtin-defaults |
| C — Conversation & stream (opaque floating surfaces) | E2E-CHAT-opaque-floating-decision-and-retry-surfaces |
| Quality (opaque floating surfaces) | E2E-CHAT-opaque-floating-decision-and-retry-surfaces |
| M6 (opaque floating surfaces) | E2E-CHAT-opaque-floating-decision-and-retry-surfaces |
| B — Model config (catalog window provenance) | E2E-MODEL-catalog-window-correction-reaches-saved-bindings |
| F — Persistence (catalog window provenance) | E2E-MODEL-catalog-window-correction-reaches-saved-bindings |
| Quality (catalog window provenance) | E2E-MODEL-catalog-window-correction-reaches-saved-bindings |
| M6+ (catalog window provenance) | E2E-MODEL-catalog-window-correction-reaches-saved-bindings |
| C — Conversation & stream (delegate context budget) | E2E-SUBAGENT-context-overflow-compacts-before-failing, E2E-SUBAGENT-context-overflow-reports-actionable-failure, E2E-SUBAGENT-resume-seeds-within-context-budget |
| Quality (delegate context budget) | E2E-SUBAGENT-context-overflow-compacts-before-failing, E2E-SUBAGENT-context-overflow-reports-actionable-failure, E2E-SUBAGENT-resume-seeds-within-context-budget |
| M6+ (delegate context budget) | E2E-SUBAGENT-context-overflow-compacts-before-failing, E2E-SUBAGENT-context-overflow-reports-actionable-failure, E2E-SUBAGENT-resume-seeds-within-context-budget |
| C / F / Quality — The context estimate stays safe (calibration) | E2E-CONTEXT-estimate-calibration-stays-safe |
| C — Conversation & stream (unique tool-call ids) | E2E-RUNTIME-unique-tool-call-ids-per-request |
| F — Persistence (stored model binding array) | E2E-PROVIDER-stored-binding-array-reads-entry-by-entry |
| Quality (stored model binding array) | E2E-PROVIDER-stored-binding-array-reads-entry-by-entry |
| Quality (unique tool-call ids) | E2E-RUNTIME-unique-tool-call-ids-per-request |
| C — Conversation & stream (system update during a tool call, restored) | E2E-RUNTIME-system-update-during-tool-call-restore |
| Quality (system update during a tool call, restored) | E2E-RUNTIME-system-update-during-tool-call-restore |
| C — Conversation & stream (loop context ownership) | E2E-RUNTIME-loop-context-ownership |
| C / F / Quality — Transcript invalid UTF-8 recovery | E2E-TRANSCRIPT-invalid-utf8-window-remains-readable |
| Quality (loop context ownership) | E2E-RUNTIME-loop-context-ownership |
| G — Plugin host lifecycle (crash report) | E2E-PLUGIN-crash-report-names-the-exit-code |
| Quality (crash report) | E2E-PLUGIN-crash-report-names-the-exit-code |
| C / E / F / Quality — Background Bash tasks outlive their turn | E2E-265 |
| C / E / Security / Quality — Codemode sandboxed nested calls | E2E-CODEMODE-sandboxed-nested-calls |

The `US-UI-*` visual scenarios (§UI shell visual scenarios) trace to the
Codex parity decisions in [decisions-log §D](../08-meta/decisions-log.md)
rather than the A–H criteria; their gold source is the capture suite.

The release artifact paths are covered by E2E-192, E2E-192a, E2E-196a,
E2E-196b, E2E-196c, and E2E-200 (Quality, M6+).

---

The session background jobs E2E (`scripts/e2e-session-background-jobs.mjs`)
also covers ordinary Bash with a real Host and a deterministic local provider.
A short command returns its original exit code. A longer command returns a
running job, allows another tool call, and runs exactly once before
`TaskWait` receives the terminal output and exit code. The original deadline
and explicit stop are exercised after the initial return.

The vendored File Manager journeys exercise the production view:
`file-manager-directory-location-user-path.e2e.mjs` opens primary and sibling
project directories, unchanged file targets, and rejected external directories;
`file-manager-theme-user-path.e2e.mjs` checks editor controls in both themes.
`e2e-remote-file-manager.mjs` checks scoped SSH reads and local/remote switches
through the Desktop bridge. The pinned source and its document-tab, Git and
loading checks are recorded in the bundled plugin’s `UPSTREAM.md`.

## 9. How AI Must Update This Doc

When adding or changing a feature that affects user-visible or protocol-visible behavior:

1. **Add a new scenario** using the template in §6 to the domain catalog that
   owns it (see [Scenario catalogs](#scenario-catalogs)). Assign the next available ID
   (`E2E-<N>`). IDs retired by ADR 0268 are never reused.
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

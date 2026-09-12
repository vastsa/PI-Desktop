# E2E Test Plan Amendment

Apply this amendment to:

`docs/spec/06-delivery/04-e2e-test-plan.md`

Preserve all existing scenario IDs and scenario definitions unless a scenario's product behavior is intentionally being changed.

This amendment changes E2E execution policy, not the historical scenario catalog.

---

# Goals

Update the Goals section to include:

* Document every user-visible and protocol-visible behavior requiring end-to-end verification.
* Maintain traceability between specs, acceptance criteria, implementation, and executable E2E.
* Define the mandatory E2E merge gate for code-bearing pull requests.
* Define which automated suites apply to which regression surfaces.
* Ensure PR validation evidence represents actual execution rather than expected success.
* Prevent code from reaching `main` when required runtime behavior remains unverified.

---

# Test Pyramid

Keep the existing test pyramid, but add:

> Lower-level tests and E2E serve different purposes. Unit and integration tests localize correctness; E2E validates cross-process runtime behavior. Passing lower-level tests does not waive required E2E for a code-bearing pull request.

E2E should remain selective and high-value.

Mandatory E2E does **not** mean every PR must run every E2E suite.

It means every code-bearing PR must run the suites relevant to its regression surface.

---

# Automation Strategy

Replace wording that implies E2E is merely future documentation or optional execution with:

PI-Desktop uses a mixed E2E model:

* Protocol-level smoke automation
* Electron startup/bridge probes
* Plan workflow automation
* Plan UI automation where supported
* Process supervision automation
* Subagent lifecycle automation
* Platform/release qualification scenarios
* Documented scenarios awaiting additional automation

Existing automated suites are production validation assets and participate in pull-request merge gates.

Scenario documentation remains authoritative even when a scenario has not yet been fully automated.

When a behavior changes and automation is missing, the PR must:

1. Update the scenario.
2. Add automation when practical.
3. Document any remaining manual or platform-specific validation.
4. Avoid claiming unautomated behavior was automatically verified.

---

# E2E PR Merge Gate

Add this section before the scenario catalog.

## Code-bearing PR rule

Every code-bearing pull request must pass relevant E2E before merge.

Code-bearing includes changes affecting:

* Renderer runtime behavior
* Electron Main
* Preload
* IPC
* Agent runtime
* Rust host-core
* Sessions
* Transcript
* Plan
* Plugins
* MCP
* Permissions
* Provider/model runtime
* Persistence
* Process lifecycle
* Packaging/runtime startup
* Build or CI behavior affecting application execution

Documentation-only changes are exempt when no executable behavior changes.

---

# Minimum E2E Selection

The root `package.json` is the source of truth for executable commands.

Current suites include:

```bash
pnpm test:e2e
pnpm test:e2e:plan
pnpm test:e2e:plan-ui
pnpm test:e2e:boot
pnpm test:e2e:supervision
pnpm test:e2e:subagents
```

Use the following selection matrix as the default.

| Changed area                                  | Required E2E                         |
| --------------------------------------------- | ------------------------------------ |
| Cross-cutting runtime / host / IPC            | `test:e2e`                           |
| Electron startup / preload / window lifecycle | `test:e2e` + `test:e2e:boot`         |
| Plan host/runtime behavior                    | `test:e2e` + `test:e2e:plan`         |
| Plan UI behavior                              | `test:e2e:plan` + `test:e2e:plan-ui` |
| Host/sidecar supervision, crash recovery      | `test:e2e` + `test:e2e:supervision`  |
| Subagent lifecycle                            | `test:e2e` + `test:e2e:subagents`    |
| Changes touching several listed domains       | Union of the applicable suites       |
| Documentation only                            | No application E2E required          |

This table defines a minimum, not a maximum.

If the changed behavior clearly affects another suite, run that suite too.

---

# Smoke Baseline

`pnpm test:e2e` is the default cross-system smoke suite.

It should normally be included when changes affect:

* Host RPC
* IPC contracts
* Agent execution
* Tool execution
* Plugin runtime
* Persistence integration
* Shared runtime contracts
* Cross-process behavior

A narrow UI-only change may rely on the UI-specific applicable suite when the generic smoke suite cannot exercise that behavior.

The PR must explain the selected coverage.

---

# Exact Commit Rule

Required E2E results must apply to the executable commit intended to merge.

Record the tested commit SHA when practical.

If executable code changes after E2E passes, rerun affected suites.

The following normally do not invalidate an existing successful E2E run:

* PR description edits
* Comment changes
* Documentation-only corrections
* Non-executable metadata changes

provided they cannot affect runtime behavior.

---

# E2E Evidence

A PR should record E2E evidence in this form:

```markdown
## E2E

Commit: abc1234

Environment:
- macOS arm64
- Node 24
- pnpm 11

Results:

- ✅ `pnpm test:e2e`
- ✅ `pnpm test:e2e:boot`
```

For CI execution, linking or naming the successful required check is sufficient when the check unambiguously corresponds to the PR head commit.

Do not write:

```text
should pass
not expected to fail
looks safe
tested indirectly
```

as substitutes for execution results.

---

# Environment-Limited E2E

Some suites may require capabilities unavailable in an agent environment.

Examples:

* GUI
* Display server
* Platform-specific packaging
* macOS signing/notarization
* Windows-native runner
* Linux desktop environment
* Required release credentials
* Hardware-specific behavior

In that case:

```text
Status: NOT RUN
Reason: <specific environment limitation>
Alternative validation: <tests actually run>
Required environment: <where it must run>
Merge status: BLOCKED
```

The PR may remain Draft.

The required validation may later run in:

* GitHub Actions
* A compatible workstation
* A dedicated test runner
* A release runner

The absence of a capable local environment does not convert the scenario into optional coverage.

---

# Failure Policy

A failed required E2E suite blocks merge.

Failures must be classified before retrying indefinitely.

Possible classifications:

```text
product regression
test regression
infrastructure failure
known flaky scenario
environment mismatch
```

For product regression:

* Fix implementation.
* Rerun the suite.

For a test regression caused by an intentional behavior change:

* Update the governing spec.
* Update the documented E2E scenario.
* Update the automated test.
* Rerun it.

For infrastructure failure:

* Record evidence.
* Rerun in a healthy environment.

For flaky tests:

* Do not simply ignore them.
* Identify the nondeterministic dependency.
* Stabilize the test or affected runtime when reasonably possible.

A known flaky test is still technical debt and must not become an automatic permanent waiver.

---

# Third-Party Pull Requests

External fork PRs require explicit E2E attention.

Forked PRs may not receive all repository secrets or privileged CI execution.

Before merging a code-bearing external contribution:

1. Review the change for safety.
2. Determine the required E2E suites.
3. Execute them against the contributor's actual head commit where possible.
4. Preserve the contributor's commits and authorship.
5. Add only the smallest landing fixes on top when required.
6. Rerun failed suites after those fixes.

Do not replace a sound contribution merely because additional validation or landing fixes are required.

---

# E2E Scenario Status Semantics

Use these meanings consistently:

## Draft

Behavior is identified but the scenario is incomplete or not yet accepted.

## Documented

Scenario is fully specified but no automated implementation currently

## E2E-LAYOUT-three-column-width-priority

### Title

Three-column width priority keeps MainChat usable and coordinates sidebar
collapse/reopen with the work panel.

### Preconditions

- A desktop session is open in a non-Settings route.
- The sidebar is expanded and the work panel has a persisted width in
  `pi.desktop.workPanel`.
- The window can be tested both at a normal size and in maximized/fullscreen
  state.

### Steps

1. Open the work panel and drag its left divider toward MainChat's left edge.
2. Continue dragging after MainChat reaches 360px, including during pointer
   preview, then release.
3. Resize the native window and enter/leave fullscreen with the panel open.
4. Manually reopen the sidebar after it was automatically collapsed.
5. Close the work panel and repeat the flow after manually collapsing the
   sidebar.
6. Repeat divider changes with ArrowLeft, ArrowRight, Home, and End.

### Expected

- MainChat never measures below 360px.
- The expanded sidebar collapses immediately at the 360px threshold, and the
  panel may continue using the newly available width.
- The effective panel maximum is the client width minus the 360px MainChat
  floor and expanded sidebar width, capped at 720px.
- Manual sidebar reopen spends right-panel width first; the MainChat width is
  preserved where possible and otherwise reaches the 370px reopen target.
- Closing a panel restores only a sidebar collapsed automatically by the layout
  mechanism. A manually collapsed sidebar remains collapsed.
- Keyboard and pointer paths expose the same effective ARIA minimum/maximum and
  never violate the MainChat floor.
- A normal window reports matching requested/reserved native panel width with
  no visible width jump. Maximized/fullscreen uses renderer budgeting and
  reports zero native reservation.

### Specs

- `docs/adr/0235-three-column-width-priority.md`
- `docs/spec/04-ux/01-ui-ia.md`
- `docs/spec/04-ux/07-ui-design-system.md` §10
- `docs/spec/04-ux/08-component-spec.md` §1 and §5
- `docs/spec/04-ux/09-interaction-patterns.md` §8

### Acceptance

Issue #267 acceptance checklist: all width-priority, automatic-collapse,
manual-reopen, restoration, ARIA, persistence, and native-reservation bullets
must pass.

### Milestone

Post-M6 desktop shell maintenance.

### Status

Documented. No dedicated automation currently exists; targeted unit tests cover
the budget and state inputs, while Electron UI verification remains required in
a capable desktop E2E environment.

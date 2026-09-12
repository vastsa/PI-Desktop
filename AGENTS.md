# AGENTS.md

Mandatory rules for AI coding agents working in PI-Desktop.

PI-Desktop is released software with real users. Treat every change as production maintenance, not prototype work.

Optimize for:

1. Correctness
2. User data safety
3. Security
4. Backward compatibility
5. Architectural integrity
6. Testability
7. Maintainability
8. Delivery speed

> Optimize for changing the system safely, not merely changing it quickly.

---

## 1. Read Before You Change

Before implementation, read:

* `docs/spec/00-baseline.md`
* relevant documents under `docs/spec/`
* relevant ADRs under `docs/adr/`

For development and validation rules, follow:

* `docs/spec/06-delivery/03-ai-development-workflow.md`
* `docs/spec/06-delivery/04-e2e-test-plan.md`
* `docs/spec/06-delivery/05-change-checklist.md`

Use English for code, identifiers, comments, commits, specifications, ADRs, and repository documentation.

GitHub issue / PR discussion should normally use the language of the original author.

---

## 2. Preserve Existing Behavior by Default

Unless the task explicitly requires behavior to change:

* do not remove existing functionality
* do not change user-visible behavior
* do not change default values
* do not change persisted data semantics
* do not change IPC / RPC contracts
* do not change Plugin SDK contracts
* do not weaken security or permissions
* do not introduce breaking changes

Refactoring must be behavior-preserving by default.

If a breaking change is truly required, document:

* what breaks
* why it is necessary
* affected surfaces
* migration path
* compatibility impact

Never hide behavior changes inside a `refactor` commit.

---

## 3. Respect the Architecture

The frozen process model is:

```text
Renderer
   ↓
Preload IPC
   ↓
Electron Main
   ↓
Rust Host Core / Node Agent Runtime
   ↓
pi-ai / pi-agent-core
```

Ownership rules:

```text
Renderer       = UI and interaction
Electron Main  = thin orchestrator
Rust Host Core = persistence and authoritative host/native state
Agent Runtime  = agent execution
Plugin SDK     = extension contract
Shared         = cross-boundary contracts and schemas
```

Mandatory boundaries:

* Renderer must not access SQLite directly.
* Renderer must not depend on Electron Main implementation internals.
* SQLite remains owned exclusively by Rust host-core.
* Agent execution must not move into the renderer.
* Electron Main must remain a thin orchestrator.
* Shared packages must not depend on desktop implementation code.
* Plugin permissions and sandbox boundaries must not be bypassed.

Changing a frozen architecture, public interface, data ownership model, or security boundary requires an ADR.

---

## 4. Multi-Agent Isolation Is Mandatory

Assume multiple agents are working concurrently.

Every development request must use:

```text
1 request
=
1 branch
+
1 dedicated worktree
```

Never:

* develop directly on `main`
* develop in the primary checkout
* reuse another task's worktree
* modify another agent's branch
* delete another agent's branch or worktree
* reset or discard unrelated work
* include unrelated changes in your task

Start from current `main`:

```bash
git fetch origin main

git worktree add \
  -b <type>/<short-description> \
  <worktree-path> \
  origin/main

cd <worktree-path>
```

Before integration, refresh against the latest `main` and resolve conflicts inside your own worktree.

---

## 5. Keep Changes Small and Coherent

Prefer:

```text
small diff
clear responsibility
one coherent purpose
easy review
easy rollback
```

Avoid:

* feature + unrelated refactor
* drive-by cleanup
* mass formatting
* unrelated dependency upgrades
* giant commits
* big-bang rewrites

Use incremental, behavior-preserving extraction for large refactors.

Every intermediate stage should remain buildable and testable.

---

## 6. Architecture Ratchet

New work must not continuously increase architectural entropy.

Known hotspots include:

```text
apps/desktop/electron/main/index.ts
apps/desktop/src/stores/app-store.ts
apps/desktop/src/components/ChatTranscript.tsx
apps/desktop/src/components/Composer.tsx
crates/host-core/src/plugins.rs
crates/host-core/src/db.rs
crates/host-core/src/providers.rs
crates/host-core/src/plans.rs
```

Treat them as:

```text
SHRINK OR STAY STABLE
```

Do not use a historical God Module as the default place for new functionality.

Also do not solve one God Module by creating another.

Split by real:

* domain
* responsibility
* ownership
* lifecycle

not arbitrary line count.

As a guideline:

* new TS / TSX modules should normally stay below ~500 LOC
* reconsider responsibilities around ~800 LOC
* new Rust modules should normally stay below ~700 LOC
* reconsider responsibilities around ~1000 LOC

Generated files, locales, changelogs, fixtures, and declarative data are exempt.

---

## 7. State, UI, and Host Responsibilities

### Renderer stores

Prefer:

```text
State               → Store
Workflow            → Service
Pure transformation → Reducer / helper
External side effect→ Service / runtime
```

Do not keep pushing complex workflows into a central Zustand store.

### React

Components should primarily handle:

* rendering
* interaction wiring
* local UI state

Complex workflows should move into hooks, models, or services.

### Rust host-core

Keep persistence, schema, migration, repository, domain logic, and filesystem responsibilities separated when they represent distinct concerns.

Do not create abstraction layers without a real responsibility boundary.

---

## 8. Async and Lifecycle Safety

For changes involving sessions, transcripts, agents, plans, plugins, MCP, IPC, filesystem, or background processes, consider:

* stale async results
* cancellation
* duplicate execution
* session/project changes during `await`
* runtime restart
* renderer reload
* process disposal
* race conditions

Never assume state is unchanged across an `await`.

Every long-lived resource must have an owner and cleanup path.

Examples:

* event listeners
* IPC listeners
* timers
* watchers
* WebSockets
* MCP connections
* child processes
* sidecars
* plugin services

Check cleanup during relevant reload, disable, uninstall, close, restart, and shutdown paths.

---

## 9. Compatibility and Persistence

Database and persisted-state changes must preserve existing user data.

Database changes require:

* migration
* schema version update
* upgrade compatibility
* relevant tests
* relevant spec updates

Never assume an empty database.

Plugin SDK / DevKit and other extension contracts are backward-compatible by default.

Do not casually change public plugin behavior.

---

## 10. Security and Error Handling

Use least privilege for:

* filesystem
* shell
* network
* browser
* external URLs
* plugins
* MCP
* clipboard
* credentials
* secrets

Never fix functionality by weakening permission checks, sandbox boundaries, URL validation, filesystem restrictions, or credential isolation.

Do not silently swallow unexpected errors.

Do not bypass type or error systems merely to finish faster.

Avoid unnecessary:

```text
any
as any
@ts-ignore
@ts-nocheck
```

and avoid using Rust `unwrap()` / `expect()` for normal external failure paths.

---

## 11. Specs Stay Synchronized

Observable behavior changes must update the relevant spec.

Changes affecting architecture, public interfaces, data ownership, security boundaries, or frozen decisions require an ADR.

User-visible or protocol-visible behavior changes must update the corresponding E2E scenario documentation.

Pure behavior-preserving refactors normally do not require product-spec changes.

---

## 12. GitHub Issue Intake

A linked GitHub issue is an intake request, not proof that the reported problem exists.

Before implementation:

1. Fetch the issue.
2. Read title, body, comments, labels, and state.
3. Verify the claim against current code.
4. For bugs, reproduce it or provide concrete evidence.
5. For features, verify the requested behavior is actually missing.

If the issue is invalid or already fixed, report the evidence and close it only when the conclusion is clear.

If verification is inconclusive, report what was checked and leave it open.

Do not implement first and investigate later.

---

## 13. GitHub Pull Request Intake

For a linked pull request, evaluate whether its **principle and direction** are sound before replacing anything.

If the direction is sound:

* preserve the contributor's work
* preserve authorship
* do not ask them to restart for minor style/completeness issues
* make only minimal landing fixes when necessary

Do not force-push a contributor's branch.

Do not merge a draft PR unless explicitly authorized or marked ready.

The following are landing blockers:

* build failure
* typecheck failure
* relevant test failure
* required E2E failure
* merge conflict
* data corruption risk
* security violation
* secret leakage
* privilege/sandbox bypass
* unresolved incompatible protocol change

A sound idea does not override a failing landing gate.

---

## 14. Testing Is Part of Implementation

A code change is not complete because the code was written.

The normal lifecycle is:

```text
implement
→ format
→ typecheck
→ unit/integration validation
→ relevant E2E
→ diff review
→ commit
→ PR checks
→ merge
```

Run validation appropriate to the affected source tree.

Typical checks include:

```bash
pnpm build:js
pnpm --filter @pi-desktop/desktop typecheck
pnpm lint
pnpm -r --if-present test

cargo fmt --check
cargo test -p host-core --locked
cargo clippy -p host-core --all-targets
```

Never report a skipped command as passing.

---

## 15. E2E Is a Merge Gate

Every **code-bearing PR** must pass relevant E2E before merge.

Build, typecheck, unit tests, or manual inspection do not replace E2E.

Select suites according to the affected regression surface as defined in:

`docs/spec/06-delivery/04-e2e-test-plan.md`

The root `package.json` is the source of truth for available E2E commands.

If the current environment cannot run required E2E:

* the branch may be committed
* a Draft / blocked PR may be opened
* the PR is **not merge-ready**

Record:

```text
E2E: NOT RUN
Suite:
Reason:
Alternative validation:
Remaining risk:
```

Required E2E must pass in CI or another capable trusted environment before merge.

Never claim an E2E suite passed unless it actually ran successfully.

If executable code changes after E2E passes, rerun the affected suite.

---

## 16. Never Hide Test Failures

Do not make validation green by:

* deleting tests
* skipping tests
* commenting out assertions
* weakening expectations without product justification
* hiding errors
* adding retries only to mask deterministic failures

Classify failures first:

```text
product regression
test regression
environment failure
infrastructure failure
known flake
```

Fix the underlying cause.

Bug fixes should normally add regression coverage.

---

## 17. Multi-Agent-Safe E2E IDs

Do not create new globally sequential E2E identifiers.

Existing numeric IDs such as:

```text
E2E-001
E2E-097
E2E-146a
E2E-220
```

are frozen legacy identifiers.

Do not renumber or recycle them.

New scenarios must use:

```text
E2E-<DOMAIN>-<semantic-slug>
```

Examples:

```text
E2E-SESSION-switch-does-not-show-stale-transcript
E2E-PLAN-approval-survives-renderer-reload
E2E-PLUGIN-disable-cleans-runtime
E2E-MCP-reconnect-after-runtime-restart
E2E-SUBAGENT-parent-cancel-stops-child
```

Rules:

* use the narrowest stable domain
* describe product behavior, not implementation details
* search for equivalent scenarios before creating one
* reuse/update an existing scenario when it covers the same contract
* once merged into `main`, treat the identifier as stable

Do not introduce other manually allocated global counters for multi-agent work unless an authoritative centralized allocator exists.

---

## 18. Commits and Diff Hygiene

Use Conventional Commits:

```text
type(scope): description
```

Allowed types:

```text
feat
fix
docs
test
chore
refactor
perf
build
ci
```

Use English.

Keep one logical concern per commit.

Before delivery, review the complete diff for:

* debug logging
* temporary code
* commented-out implementation
* unrelated cleanup
* accidental formatting
* generated junk
* secrets
* credentials
* local paths
* local databases
* disabled tests
* test bypasses

---

## 19. Remote Publishing

Do not push merely because local development is complete unless remote delivery is part of the task or the user has authorized it.

Before pushing, verify:

* remote
* branch
* commit set
* Git identity

Never force-push unless explicitly authorized for that exact operation.

A linked issue does not authorize unrelated publishing.

A linked PR authorizes actions necessary to review or land that PR within repository policy.

---

## 20. Integration and Cleanup

Before integration:

1. refresh against current `main`
2. resolve conflicts carefully
3. run required validation
4. review the final diff
5. verify required PR checks and E2E

After merge:

1. verify expected commits are present in `main`
2. remove your request worktree
3. delete your merged local branch
4. prune stale worktree metadata

Example:

```bash
git worktree remove <worktree-path>
git branch -d <type>/<short-description>
git worktree prune
```

Delete only your own worktree and branch.

---

## 21. Specialized Workflows

Do not duplicate detailed procedures in this file.

Follow the existing repository specifications for:

* Marketplace/update diagnosis
* Stable release/version surfaces
* Packaging/signing
* E2E suite selection
* Release qualification
* Domain-specific acceptance criteria

When one of those workflows applies, read the relevant spec before implementation.

---

## 22. Definition of Done

A code task is Done only when all applicable conditions are true:

* [ ] Dedicated branch and worktree were used
* [ ] Work started from current `main`
* [ ] Relevant specs / ADRs were reviewed
* [ ] Implementation is complete
* [ ] Existing behavior and compatibility were reviewed
* [ ] Architecture boundaries remain valid
* [ ] No new God Module was introduced
* [ ] Known hotspots did not grow unnecessarily
* [ ] Relevant specs were synchronized
* [ ] ADR was added when required
* [ ] E2E documentation was updated when required
* [ ] New E2E IDs use the multi-agent-safe semantic format
* [ ] Relevant static / unit / integration checks pass
* [ ] Relevant E2E passes for code-bearing PRs
* [ ] Test evidence applies to the intended merge code
* [ ] Complete diff was reviewed
* [ ] No secrets, local data, or unrelated changes are included
* [ ] Logical changes are committed
* [ ] Required merge gates pass
* [ ] Worktree and branch cleanup are complete after integration

The following are **not** equivalent to Done:

```text
code written
build passes
typecheck passes
unit tests pass
looks correct
```

when required validation or merge gates remain unresolved.

---

## 23. Final Handoff

Report only factual results.

Include, when applicable:

```text
What changed:
Architecture / compatibility impact:
Specs / ADRs:
Validation:
E2E:
Commits:
PR / merge status:
Remaining risk:
```

If something was not run, say so.

Never claim:

```text
passed
verified
tested
```

unless it actually was.

---

## Final Principles

> Preserve behavior unless change is intentional.

> Respect process and ownership boundaries.

> New features must not increase architectural entropy by default.

> Multiple agents must never depend on shared manual counters.

> E2E IDs are stable semantic contract references, not sequence numbers.

> A test that did not run did not pass.

> A refactor should reduce coupling, not move it into a differently named file.

> A feature that works today but makes tomorrow's change substantially harder is not fully finished.

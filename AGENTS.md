# AGENTS.md

Policy-Sync: 2026-02-16.1

Mandatory rules for AI coding agents working in PI-Desktop.

`CLAUDE.md` is the Claude Code / Claude Cowork entry point and a condensed
mirror of the non-negotiables in this file. This file is authoritative.
When you change either file, update the other so the non-negotiables stay
aligned, and set the same `Policy-Sync:` token in both. The gate is
`pnpm check:agent-policy` (`scripts/check-agent-policy-sync.mjs`).

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

### Workflow policy precedence

`AGENTS.md` is the top-level repository policy for AI-agent development workflow.

Domain specifications remain authoritative for product behavior, architecture, protocol contracts, persistence semantics, security boundaries, and acceptance criteria.

If a delivery document conflicts with the branch/worktree/integration/E2E workflow defined in this file:

1. do not silently choose one
2. treat the conflict as documentation drift
3. follow the workflow in this file
4. update the conflicting delivery documentation as part of the same policy change when authorized

In particular, do not merge task code into local `main` merely because an older document describes local-main E2E integration.

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

The primary checkout and local `main` are coordination surfaces, not development workspaces.

### Never

* develop directly on `main`
* develop in the primary checkout
* merge unvalidated task code into local `main`
* use local `main` as a temporary integration branch
* reuse another task's worktree
* modify another agent's branch
* delete another agent's branch or worktree
* reset or discard unrelated work
* include unrelated changes in your task
* depend on uncommitted work from another worktree

### Start from current `main`

```bash
git fetch origin main

git worktree add \
  -b <type>/<short-description> \
  <worktree-path> \
  origin/main

cd <worktree-path>
```

All implementation, targeted validation, conflict resolution, and task-candidate E2E must happen inside the task's dedicated worktree.

### Before candidate validation

Refresh the task against the latest remote `main`.

For a private branch that has not been pushed or shared:

```bash
git fetch origin main
git rebase origin/main
```

If the branch has already been shared and rewriting history would be unsafe, do not force-push merely to rebase it. Use a non-destructive integration strategy or rely on the PR integration candidate according to §15.

Resolve conflicts inside your own worktree.

Never resolve task conflicts by modifying the primary checkout.

### Fixed delivery order

The normal delivery order for a code-bearing request is:

```text
1. create dedicated branch + worktree from current origin/main
2. implement in the request worktree
3. run targeted static/unit/integration checks
4. review the task diff
5. commit the task
6. refresh the task branch against latest origin/main
7. resolve conflicts inside the task worktree
8. run required task-candidate E2E in the task worktree
9. push the request branch
10. open/update the PR/MR
11. validate the PR integration candidate
12. merge into remote main through repository gates
13. synchronize local main
14. remove the worktree and merged local branch
```

Do not insert:

```text
merge task → local main
```

between steps 6 and 8.

The task branch itself becomes the local integration candidate by incorporating the latest `origin/main`.

A task-candidate E2E run is valid only when its tested commit and base revision are known.

The PR integration gate then protects against `main` changing between local candidate validation and final merge.

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
State                → Store
Workflow             → Service
Pure transformation  → Reducer / helper
External side effect → Service / runtime
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

Check cleanup during relevant:

* reload
* disable
* uninstall
* project switch
* session switch
* window close
* restart
* shutdown

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

Changes to persisted formats must consider:

```text
old application → existing data
new application → existing data
new application → newly created data
restart/recovery → partially completed operations
```

Data migration must not depend on users manually deleting application state.

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

Never fix functionality by weakening:

* permission checks
* sandbox boundaries
* URL validation
* filesystem restrictions
* origin checks
* credential isolation
* plugin authorization

Do not silently swallow unexpected errors.

Do not bypass type or error systems merely to finish faster.

Avoid unnecessary:

```text
any
as any
@ts-ignore
@ts-nocheck
```

Avoid using Rust:

```text
unwrap()
expect()
```

for normal external failure paths.

Unexpected failures should remain observable and diagnosable without leaking sensitive information.

---

## 11. Specs Stay Synchronized

Observable behavior changes must update the relevant spec.

Changes affecting:

* architecture
* public interfaces
* data ownership
* security boundaries
* frozen decisions

require an ADR when appropriate.

User-visible or protocol-visible behavior changes must update the corresponding E2E scenario documentation.

Pure behavior-preserving refactors normally do not require product-spec changes.

Changes to development workflow or validation policy must synchronize relevant files under:

```text
docs/spec/06-delivery/
```

Do not intentionally leave contradictory workflow instructions in the repository.

---

## 12. GitHub Issue Intake

A linked GitHub issue is an intake request, not proof that the reported problem exists.

Before implementation:

1. Fetch the issue.
2. Read title, body, comments, labels, and state.
3. Verify the claim against current code.
4. For bugs, reproduce it or provide concrete evidence.
5. For features, verify the requested behavior is actually missing.

For bug reports, distinguish:

```text
confirmed regression
confirmed existing defect
already fixed
expected behavior
environment-specific failure
insufficient evidence
```

If the issue is invalid or already fixed, report the evidence and close it only when the conclusion is clear and the task authorizes issue management.

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

### Two validation stages

Code-bearing changes use two distinct validation stages:

```text
Task Candidate Validation
        ↓
PR Integration Validation
```

Task Candidate Validation runs in the request worktree after the request branch has incorporated the latest available `origin/main`.

PR Integration Validation verifies the actual code that is about to land, ideally using:

* GitHub PR merge ref
* merge queue candidate
* equivalent synthetic merge commit
* another trusted integration candidate produced from current target `main`

Do not require the task to be merged into local `main` merely to perform E2E.

A PR head commit and an integration candidate are equivalent only when they produce the same executable tree against the relevant target `main`.

If `main` changed after task-candidate validation, the old local result remains useful evidence but does not by itself prove the new integration candidate.

---

## 14. Testing Is Part of Implementation

A code change is not complete because the code was written.

The normal lifecycle is:

```text
implement
→ format
→ typecheck
→ unit/integration validation
→ diff review
→ commit
→ refresh against latest origin/main
→ resolve conflicts in task worktree
→ task-candidate E2E
→ push branch + open PR
→ PR integration checks / E2E
→ merge into remote main
→ synchronize local main
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

The exact validation set depends on the changed surface.

Do not run unrelated expensive validation merely for ceremony when the repository defines a narrower authoritative gate.

Conversely, do not skip an applicable gate merely because narrower tests passed.

Never report a skipped command as passing.

---

## 15. E2E Validates Integration Candidates, Not Branch Names

E2E exists to validate executable integration state.

It does **not** exist to validate whether Git reports the current branch name as `main`.

The relevant invariant is:

```text
latest applicable main
+
task changes
=
candidate executable state
```

not:

```text
current branch name == main
```

### 15.1 Task-candidate E2E

Every code-bearing change must run the relevant E2E suites against a task candidate that contains:

1. the request's commits
2. the latest `origin/main` incorporated at candidate preparation time
3. all conflict resolutions required to combine them

Normally:

```bash
git fetch origin main
git rebase origin/main
```

followed by E2E from the same task worktree.

Record:

```text
Task candidate:
Base main:
E2E suites:
Result:
Environment:
```

An E2E result applies only to the commit that actually ran.

Do not modify local `main` to create this candidate.

### 15.2 PR integration E2E

The final landing

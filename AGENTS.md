我结合了你现在仓库里的 `AGENTS.md` 来重写。现有版本里 **Issue 验证、PR 尊重贡献者、独立 branch/worktree、Spec/ADR 同步、Marketplace 诊断门禁、Release 规则** 都值得保留。

这次我重点补强了：**架构边界、God Module 防回归、代码规模 ratchet、异步/资源生命周期、兼容性、Definition of Done，以及最重要的 PR 强制 E2E**。当前仓库已经有 `test:e2e`、`plan`、`plan-ui`、`boot`、`supervision`、`subagents` 这些正式脚本，可以直接作为门禁。

# AGENTS.md

Mandatory rules for AI coding agents working in this repository.

PI-Desktop is a released, actively used desktop application. Treat every code change as production software maintenance, not prototype work.

The priorities are:

1. Correctness
2. Backward compatibility
3. User data safety
4. Security boundaries
5. Architectural integrity
6. Testability
7. Maintainability
8. Delivery speed

Do not optimize for writing code quickly at the cost of making the system harder to change safely.

---

# 1. Language

Use English for:

* Code
* Identifiers
* Comments
* Commits
* Specifications
* ADRs
* Repository documentation

GitHub issue and pull request comments should follow the language of the original issue or pull request.

Read and follow:

* [Baseline](docs/spec/00-baseline.md)
* [AI development workflow](docs/spec/06-delivery/03-ai-development-workflow.md)
* Relevant domain specifications under `docs/spec/`
* Relevant ADRs under `docs/adr/`

---

# 2. Core Engineering Principle

The default rule for every task is:

> Preserve existing behavior unless behavior change is explicitly part of the task.

Unless explicitly required, do not change:

* Existing user behavior
* Default values
* Existing UI semantics
* IPC contracts
* Host RPC contracts
* Plugin SDK contracts
* Plugin manifest semantics
* Persisted data formats
* Database behavior
* Configuration formats
* Existing extension behavior
* Existing public APIs

If a change must intentionally break compatibility, clearly identify it as a breaking change and document:

* Why it is necessary
* What is affected
* Migration behavior
* Backward compatibility behavior
* Rollback implications

Never hide a breaking change inside a refactor.

---

# 3. Architecture Is a Constraint

The frozen architecture remains authoritative.

PI-Desktop follows this high-level process model:

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

Core ownership rules:

```text
Renderer        = UI and interaction
Electron Main   = thin orchestrator
Rust Host Core  = persistence, native host services, authoritative host state
Agent Runtime   = agent execution
Plugin SDK      = public extension contract
Shared          = cross-boundary contracts and schemas
```

Do not bypass these boundaries merely because doing so is easier.

In particular:

* Renderer must not open SQLite directly.
* Renderer must not depend on Electron Main implementation internals.
* Renderer must not directly perform privileged native operations.
* Electron Main must not become the default location for business logic.
* SQLite remains exclusively owned by Rust host-core.
* Agent execution remains outside the renderer.
* Shared packages must not depend on desktop implementation details.
* Plugin APIs must respect the plugin permission and sandbox model.

Any change to these architectural boundaries requires an ADR.

---

# 4. Prevent Architectural Entropy

New features must not continuously increase architectural entropy.

Before adding code to an existing module, ask:

> Does this responsibility actually belong here?

Do not automatically append new functionality to the nearest large file.

Prefer domain ownership over convenience.

The following files are known historical architecture hotspots and must be treated as **shrink-or-stable zones**:

```text
apps/desktop/electron/main/index.ts
apps/desktop/src/stores/app-store.ts
apps/desktop/src/components/ChatTranscript.tsx
apps/desktop/src/components/Composer.tsx
crates/host-core/src/plugins.rs
crates/host-core/src/db.rs
crates/host-core/src/providers.rs
crates/host-core/src/plans.rs
apps/desktop/src/pages/PluginsPage.tsx
apps/desktop/src/pages/SettingsPage.tsx
apps/desktop/src/App.tsx
```

Do not add substantial new responsibilities to these files unless there is a strong architectural reason.

When touching one of these files, prefer extracting an existing responsibility or placing new behavior in the correct domain module.

---

# 5. No New God Modules

Do not solve an existing God Module by creating a new one.

Bad outcome:

```text
main/index.ts        → plugin-service.ts with 4000 lines
app-store.ts         → session-service.ts with 3500 lines
plugins.rs           → manager.rs with 5000 lines
```

Split by:

* Domain
* Responsibility
* Ownership
* Lifecycle
* Dependency direction

Do not split files mechanically every N lines.

A module boundary must represent a real conceptual boundary.

---

# 6. Architecture Ratchet

File size is not the only quality metric, but uncontrolled file growth is a strong warning signal.

Use the following ratchet.

## New TypeScript / TSX source files

Target:

```text
≤ 500 LOC
```

A file exceeding approximately:

```text
800 LOC
```

requires explicit reconsideration of its responsibilities before proceeding.

## New Rust modules

Target:

```text
≤ 700 LOC
```

A module exceeding approximately:

```text
1000 LOC
```

requires explicit reconsideration of its responsibilities.

## Existing large files

Legacy large files follow:

```text
NO SIGNIFICANT NET GROWTH
```

If a large file is touched for a new feature, prefer keeping it stable or making it smaller.

Exceptions include:

* Generated files
* Locale data
* Changelogs
* Snapshots
* Fixtures
* Large declarative datasets
* Generated metadata

Do not classify business logic as “data” merely to bypass the rule.

---

# 7. Electron Main Must Stay Thin

`apps/desktop/electron/main/` is an orchestration layer.

The main entrypoint should primarily contain:

* Bootstrap
* Dependency construction
* Window creation
* IPC registration
* Runtime startup
* Application lifecycle
* Shutdown

Domain behavior should live in appropriate modules such as:

```text
bootstrap/
ipc/
services/
runtime/
```

Do not put large feature implementations directly into:

```text
electron/main/index.ts
```

IPC registration and domain implementation should remain separate whenever practical.

---

# 8. Renderer State Rules

Zustand stores should primarily contain:

* State
* State transitions
* Small state-oriented actions

Use this ownership model:

```text
State               → Store
Workflow            → Service
Pure transformation → Reducer / helper
External side effect→ Service / runtime
```

Do not continuously move these responsibilities into a central Store:

* Network orchestration
* Multi-step session workflows
* Native notifications
* Filesystem interaction
* Complex cache synchronization
* Transcript reconciliation algorithms
* Long-running async workflows
* Cross-domain lifecycle management

If maintaining `useAppStore` as a compatibility facade, compose domain slices behind it rather than building another monolithic store.

---

# 9. React Component Rules

React components should primarily handle:

* Rendering
* User interaction wiring
* Local presentation state

Move complex behavior into:

```text
hooks/
model/
services/
helpers/
```

A component should be reconsidered when it simultaneously owns:

* Data loading
* API calls
* Caching
* Large transformations
* Cross-domain state
* Lifecycle coordination
* Complex event processing
* Rendering

Avoid multi-thousand-line UI components.

Do not extract meaningless one-use wrappers solely to satisfy a line-count target.

---

# 10. Rust Host-Core Rules

Rust modules should follow domain boundaries rather than accumulate unrelated responsibilities.

Large domains may use structures such as:

```text
mod.rs
model.rs
repository.rs
service.rs
validation.rs
```

Use only the modules that represent real responsibilities.

For persistence-heavy domains, keep distinct concepts separate when appropriate:

```text
schema
migration
repository
domain logic
filesystem artifacts
validation
```

Do not create abstraction layers that add ceremony without reducing coupling.

---

# 11. Database Rules

SQLite remains host-owned and single-writer.

Any schema change must include:

* A migration
* Correct schema version updates
* Migration coverage
* Upgrade compatibility with existing user databases
* Relevant specification changes
* Correct comments/documentation

Never assume users start from an empty database.

Never silently discard incompatible persisted data.

Database migrations must be forward-safe for supported upgrade paths.

---

# 12. Plugin SDK Is a Public Contract

Treat the following as public extension surfaces:

* Plugin SDK
* Plugin DevKit
* Plugin manifest
* Permissions
* Agent tools
* Skills integration
* MCP integration
* Plugin events
* Plugin storage
* Plugin views
* Plugin message bus
* Plugin-related IPC

Default requirement:

```text
BACKWARD COMPATIBLE
```

Breaking plugin changes require explicit design justification, versioning, migration strategy, documentation, and changelog coverage.

Do not weaken plugin security or permission boundaries for convenience.

---

# 13. Shared Package Rules

`packages/shared` should contain genuine cross-process or cross-package contracts such as:

* Types
* Schemas
* Protocols
* Error contracts
* Shared constants

Do not use `shared` as a dumping ground for arbitrary business implementation.

Avoid creating permanent catch-all files such as:

```text
utils.ts
types.ts
helpers.ts
common.ts
```

when clear domain modules are possible.

Shared must not depend on desktop implementation layers.

---

# 14. Async and Concurrency Safety

Any change involving:

* Sessions
* Agent turns
* Transcript
* Plan
* Plugins
* MCP
* Filesystem operations
* IPC
* Sidecars
* Background services

must explicitly consider:

* Race conditions
* Stale async results
* Cancellation
* Duplicate invocation
* Session changes during `await`
* Runtime disposal
* Window disposal
* Plugin unload
* Process termination
* Retry behavior

Never assume state is unchanged across an `await`.

When an operation depends on identity or generation, validate that identity again before committing the result.

---

# 15. Resource Lifecycle

Any new resource must have a defined owner and cleanup path.

Examples:

* Event listeners
* IPC listeners
* Timers
* Intervals
* File watchers
* WebSockets
* MCP connections
* Child processes
* Sidecars
* Plugin services
* Native handles

Check cleanup during relevant lifecycle events:

```text
reload
session switch
plugin disable
plugin uninstall
window close
runtime restart
application shutdown
```

Do not introduce listeners or processes that accumulate across reloads.

---

# 16. Mutable Global State

Avoid casually adding module-level mutable state such as:

```text
Map
Set
cache
pendingRequests
activeSessions
global timers
mutable singleton state
```

If module-level state is necessary, define:

* Ownership
* Lifetime
* Cleanup
* Concurrency assumptions
* Session/project isolation rules

Global state without an explicit lifecycle is architectural debt.

---

# 17. Security Rules

Changes involving these areas require extra scrutiny:

* Filesystem
* Shell execution
* Browser integration
* External URLs
* Network access
* Plugins
* MCP
* Clipboard
* Credentials
* OAuth
* Secrets
* Native APIs

Follow least privilege.

Do not “fix” a feature by weakening:

* Permission checks
* Filesystem boundaries
* Shell restrictions
* URL validation
* Plugin sandboxing
* Network restrictions
* Credential isolation

Security bypasses are landing blockers.

---

# 18. Error Handling

Do not silently swallow unexpected errors.

Avoid:

```ts
try {
  ...
} catch {}
```

unless failure is intentionally ignorable and the reason is documented.

Errors should be:

* Handled
* Logged
* Translated into a domain error
* Or propagated

Never suppress errors only to make tests pass.

---

# 19. TypeScript Safety

Do not bypass the type system to finish faster.

Avoid introducing unnecessary:

```text
any
as any
@ts-ignore
@ts-nocheck
```

Prefer:

* `unknown`
* Type guards
* Explicit interfaces
* Discriminated unions
* Validated boundary parsing

If an unsafe cast is unavoidable, keep it narrow and document why it is safe.

---

# 20. Rust Safety

Avoid `unwrap()` and `expect()` on paths that can fail due to:

* User input
* Filesystem state
* Database state
* Network state
* Plugin input
* External process behavior

Prefer `Result` with meaningful error context.

Panics should not be normal application error handling.

---

# 21. Dependency Rules

Before adding a dependency, determine:

* Whether existing dependencies already solve the problem
* Whether the dependency is maintained
* Bundle/build impact
* Security implications
* License compatibility
* Long-term maintenance cost

Do not add a large framework to replace a small amount of straightforward code.

---

# 22. Avoid Premature Abstraction

Do not create abstractions merely because they may theoretically be useful later.

Extract abstractions when there is evidence of:

* A real domain boundary
* Multiple implementations
* Meaningful duplication
* Lifecycle ownership
* Dependency inversion need

Prefer understandable concrete code over speculative architecture.

---

# 23. GitHub Issue Handling

When the user provides a GitHub issue URL or an unambiguous issue number for this repository, treat it as an intake gate.

Do not start implementation until the reported problem has been independently verified.

1. Fetch the issue title, body, labels, comments, and state.
2. Verify the claim against the current codebase.
3. For a bug, reproduce it or provide concrete code/spec evidence.
4. For a feature or improvement, confirm the behavior is actually missing or incomplete.
5. If the problem does not exist, comment with evidence and close only when the conclusion is clear.
6. If verification is inconclusive, comment with what was tried and leave it open.
7. If the problem exists, follow the isolated development workflow.
8. After the fix lands, comment with the result and close the issue when appropriate.

Write issue comments in the issue's language.

Repository code, specs, documentation, and commits remain English.

An issue URL authorizes actions only on that issue. It does not authorize unrelated changes or remote pushes.

Do not reopen a closed issue unless explicitly requested.

---

# 24. GitHub Pull Request Handling

When the user provides a GitHub pull request URL or unambiguous PR number, review the contributor's work rather than replacing it.

First determine whether the principle of the change is sound.

Evaluate:

* Whether it solves a real in-scope problem
* Whether the direction is compatible with the baseline
* Whether security boundaries remain valid
* Whether architecture remains valid
* Whether it creates unacceptable compatibility risk

Do not reject or rewrite a sound contribution merely because of:

* Naming nits
* Formatting
* Minor style issues
* Minor documentation omissions
* Small cleanup opportunities

However, the following are **landing blockers**:

* Build failure
* Typecheck failure
* Relevant test failure
* Relevant E2E failure
* Merge conflict
* Data corruption risk
* Security boundary violation
* Secret leakage
* Privilege/sandbox bypass
* Unresolved protocol breakage
* Clearly destructive behavior

Preserve contributor authorship.

Do not force-push a contributor branch.

Do not merge a draft PR unless explicitly requested or the author marks it ready.

---

# 25. Mandatory Isolated Development

Every development request must use its own dedicated branch and worktree.

Before modifying files:

1. Update the primary checkout's local `main`
2. Create a unique branch from updated `main`
3. Create a dedicated worktree
4. Enter the request worktree
5. Only then begin development

Example:

```bash
git switch main
git pull --ff-only
git worktree add ../worktrees/<request-id> -b <type>/<request-id> main
cd ../worktrees/<request-id>
```

Never implement directly in the primary checkout.

Never implement directly on `main`.

---

# 26. Multi-Agent Isolation

Multiple agents may work concurrently.

Each agent must:

* Use its own branch
* Use its own worktree
* Modify only its own request worktree
* Avoid changing another agent's branch
* Avoid deleting another agent's worktree
* Avoid including unrelated changes
* Avoid committing local environment state
* Avoid committing secrets or local databases

The primary checkout exists for synchronization and integration.

---

# 27. Spec Synchronization

Every behavior change must update the relevant `docs/spec/` document.

Architectural changes additionally require an ADR when they affect:

* Process architecture
* Public interfaces
* Data ownership
* Security boundaries
* Frozen decisions
* Protocol contracts

Pure behavior-preserving refactors normally do not require spec changes.

Do not change behavior first and leave specifications knowingly stale.

---

# 28. E2E Documentation

Every user-visible or protocol-visible behavior change must add or update the corresponding scenario in:

```text
docs/spec/06-delivery/04-e2e-test-plan.md
```

User-visible includes:

* UI
* User interactions
* Dialogs
* Notifications
* Observable workflows

Protocol-visible includes:

* IPC
* Host RPC
* Plugin APIs
* Event payloads
* Persisted protocol behavior

E2E documentation and E2E execution are both required where applicable.

One does not replace the other.

---

# 29. Testing Is Part of Implementation

A change is not complete when the code merely compiles.

The development loop is:

```text
implement
→ format
→ typecheck
→ unit/integration validation
→ relevant E2E
→ review complete diff
→ commit
→ PR
→ required remote checks
→ merge
```

Never announce a task as complete before required validation has finished.

---

# 30. Mandatory PR Validation

Any code-bearing PR must pass validation against the exact commit intended to merge.

A code-bearing PR includes changes affecting runtime or build behavior under areas such as:

```text
apps/
packages/
crates/
scripts/
build configuration
CI configuration
runtime configuration
```

Documentation-only changes may use documentation-specific validation and do not require application E2E unless they also alter executable behavior.

Before a code PR is considered ready for merge, run the relevant baseline checks.

Typical repository-wide checks include:

```bash
pnpm build:js
pnpm --filter @pi-desktop/desktop typecheck
pnpm lint
pnpm -r --if-present test

cargo fmt --check
cargo test -p host-core --locked
cargo clippy -p host-core --all-targets
```

Select additional focused checks based on the changed subsystem.

Do not report a command as passing unless it was actually executed successfully.

---

# 31. E2E Is a PR Merge Gate

For every code-bearing PR:

> Relevant E2E testing is mandatory before merge.

This is not optional.

This is not merely recommended.

A PR with unverified relevant E2E coverage must not be merged.

Available repository suites currently include:

```bash
pnpm test:e2e
pnpm test:e2e:plan
pnpm test:e2e:plan-ui
pnpm test:e2e:boot
pnpm test:e2e:supervision
pnpm test:e2e:subagents
```

Use the current `package.json` as the source of truth for command names.

Run suites based on impact.

Examples:

```text
Electron bootstrap/lifecycle
→ test:e2e:boot + smoke

Plan behavior
→ test:e2e:plan
→ test:e2e:plan-ui when UI is affected

Agent supervision/lifecycle
→ test:e2e:supervision

Subagents
→ test:e2e:subagents

General user workflow
→ test:e2e
```

If a change crosses multiple domains, run multiple relevant suites.

Passing unit tests does not replace E2E.

Passing typecheck does not replace E2E.

Manual inspection does not replace E2E.

---

# 32. E2E Before Opening or Merging PRs

When the environment supports the relevant E2E suite:

Run it before presenting the PR as ready for review.

If the agent cannot execute the required E2E because of a genuine environment limitation, for example:

```text
no GUI
missing display server
unsupported operating system
required hardware unavailable
required secrets unavailable
```

the agent may prepare or open the PR as **Draft / Not Ready**, but must clearly report:

```text
E2E: NOT RUN
Reason:
Affected suites:
Alternative validation performed:
Remaining risk:
```

The PR must not be considered merge-ready until the required E2E passes on:

* CI
* A capable development machine
* Or another trusted execution environment

Environment limitations are not a permanent E2E waiver.

---

# 33. Third-Party Fork PRs

Fork PRs require additional caution because repository secrets and privileged CI paths may not be available.

Before merging a code-bearing fork PR:

* Run the relevant E2E against the contributor's head when possible.
* Confirm the exact commit tested.
* Record the result in the PR discussion or merge report.
* Treat E2E failure as a landing blocker.

Do not assume missing CI coverage means the change is safe.

---

# 34. Test Failure Rules

Never make CI green by weakening the validation.

Do not:

* Delete a failing regression test
* Skip a test without justification
* Disable an assertion
* Reduce an assertion merely to accept incorrect behavior
* Comment out E2E
* Hide an error
* Change expected output simply because implementation currently disagrees

Determine whether:

```text
implementation is wrong
```

or:

```text
intended behavior intentionally changed
```

Only intentional behavior changes justify changing expected behavior, and such changes require corresponding spec updates.

---

# 35. Bug Fix Regression Tests

Bug fixes should normally add a regression test.

Preferred sequence:

```text
reproduce
→ add failing regression test
→ implement fix
→ verify regression test
→ run surrounding test coverage
→ run relevant E2E
```

The goal is to prevent the same bug from silently returning.

---

# 36. Test Scope Must Match Change Scope

Use risk-based validation in addition to mandatory PR gates.

Examples:

## Session changes

Consider:

* Session creation
* Session switching
* Session persistence
* Session recovery
* Running-turn behavior

## Transcript changes

Consider:

* User message submission
* Streaming
* Cancellation
* Session switching
* Reload
* Transcript restoration

## Plan changes

Run relevant Plan unit/integration and E2E coverage.

## Agent runtime changes

Consider:

* Startup
* Turn lifecycle
* Cancellation
* Supervision
* Subagents
* Recovery

## Plugin changes

Consider:

* Installation
* Loading
* Enabling
* Disabling
* Reloading
* Uninstalling
* Permission enforcement

## MCP changes

Consider:

* Configuration
* Connection
* Invocation
* Failure
* Disconnect
* Reload
* Cleanup

Do not blindly run unrelated expensive tests when they cannot exercise the changed behavior, but do not under-test cross-cutting changes.

---

# 37. Commit Every Logical Change

Every completed logical change must be committed.

Requirements:

* One logical concern per commit
* No large uncommitted piles
* No unrelated cleanup
* No accidental generated output
* Leave the request worktree clean

Use conventional commits:

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

Examples:

```text
refactor(main): extract plugin ipc handlers

fix(session): prevent stale transcript after session switch

test(plan): cover approval restore flow
```

Commits are English only.

---

# 38. Keep Refactor and Behavior Change Separate

Clearly distinguish:

```text
behavior-preserving refactor
```

from:

```text
behavior change
```

and:

```text
bug fix
```

Do not hide feature changes inside refactor commits.

When a refactor reveals an unrelated bug:

* Record it
* Add a regression test when practical
* Fix it separately

unless the bug directly blocks safe completion of the refactor.

---

# 39. Pull Request Scope

PRs should have one coherent purpose.

Do not combine unrelated:

* Features
* Refactors
* Dependency upgrades
* UI redesigns
* Bug fixes
* Formatting sweeps

A small amount of directly necessary cleanup is acceptable.

Drive-by cleanup that significantly enlarges review scope is not.

---

# 40. Pull Request Description Requirements

Every code-bearing PR should report:

```text
## What changed

## Why

## Architecture impact

## Compatibility impact

## Tests

## E2E

## Risks

## Screenshots
(if UI changed)
```

The `Tests` and `E2E` sections must contain actual results.

Good:

```text
✅ pnpm build:js
✅ pnpm --filter @pi-desktop/desktop typecheck
✅ cargo test -p host-core --locked

✅ pnpm test:e2e
✅ pnpm test:e2e:boot
```

Bad:

```text
Tests should pass.
```

Bad:

```text
E2E not needed.
```

without a concrete non-code exemption.

---

# 41. Review the Diff Before Delivery

Before committing or opening a PR, review the complete diff.

Check for:

* Debug logging
* Temporary code
* Commented-out implementation
* Accidental formatting noise
* Unrelated changes
* Generated junk
* Credentials
* Secrets
* Local filesystem paths
* Test bypasses
* Unnecessary dependency changes

Do not assume generated changes are harmless.

---

# 42. AI Self-Review Gate

Before declaring implementation complete, explicitly review the change from these perspectives.

## Architecture

* Did this create a new God Module?
* Did responsibilities move to the correct domain?
* Did dependency direction remain valid?
* Did a known hotspot grow unnecessarily?

## Compatibility

* Did IPC change?
* Did RPC change?
* Did persisted data change?
* Did Plugin SDK behavior change?
* Did default user behavior change?

## Async

* Could stale async work mutate newer state?
* Is cancellation correct?
* Is duplicate execution possible?
* Can session/project identity change during `await`?

## Lifecycle

* Were listeners added?
* Are they removed?
* Are processes/connections cleaned up?
* Is shutdown safe?
* Is plugin reload safe?

## Security

* Did privilege increase?
* Did permission checks weaken?
* Did network/filesystem/shell scope expand?

## Tests

* Were relevant unit/integration checks run?
* Were required E2E suites run?
* Were failures resolved rather than hidden?

## Scope

* Does the diff contain unrelated work?

A task is not complete until this review is satisfactory.

---

# 43. GitHub PR Contributor Preservation

For an existing external PR whose principle is sound:

* Preserve the contributor's commits and authorship.
* Do not silently replace their implementation with your own.
* Make only the smallest necessary landing-blocker fixes on top when needed.
* Follow-up architectural cleanup may happen separately after merge.

However:

> Relevant E2E is a landing requirement.

A sound idea does not override a demonstrated runtime regression.

If the contributor PR fails required E2E, resolve the failure before merging.

---

# 44. Marketplace and Update Diagnosis Gate

When a request concerns:

* Plugin versions
* Marketplace updates
* Installed plugin version mismatch
* Unexpected latest version
* Marketplace installation failures

do not immediately modify application code.

First:

1. Record plugin ID, installed version, displayed latest version, expected release version, catalog URL, and observation time.
2. Fetch and inspect the live catalog.
3. Inspect cached catalog and installed registry separately.
4. Classify the failure boundary.
5. Run:

```bash
pnpm check:marketplace -- --url <catalog-url> --plugin <id>
```

6. Check release metadata such as checksum, package URL, package size, permissions, and author shape.
7. Reproduce the exact behavior with a deterministic fixture where practical.
8. Add the narrowest regression test for the actual failing layer.
9. Only then modify client code.

Possible failure classifications include:

```text
publisher/catalog data
remote fetch/cache fallback
host version comparison
IPC propagation
renderer presentation
```

Do not make invalid marketplace releases installable merely to hide bad catalog data.

The final report must identify the evidence and failure classification.

---

# 45. Stable Release Rule

Before creating a stable application version tag, update every version surface, including:

```text
packages/shared/src/changelog*.ts
packages/shared/src/changelog.test.ts
package.json
apps/*
packages/*
docs/
Cargo.toml
Cargo.lock
packages/shared/src/protocol.ts
README.md
README.zh-CN.md
```

Run:

```bash
pnpm check:release-docs
```

before tagging.

README files are release surfaces.

If a release changes user-visible behavior, update affected Highlights, Download, Getting Started, Status, or Development claims in both supported README locales.

---

# 46. Merge and Worktree Cleanup

After development:

1. Complete required validation.
2. Review the complete diff.
3. Commit all logical changes.
4. Refresh the request branch against current `main`.
5. Resolve conflicts in the request worktree.
6. Ensure required PR checks and E2E are green.
7. Merge through the repository's accepted workflow.
8. Verify the expected commits landed.
9. Remove the request worktree.
10. Delete the merged request branch.

Example cleanup:

```bash
git worktree remove ../worktrees/<request-id>
git branch -d <type>/<request-id>
git worktree prune
```

Use `git branch -d`, not `-D`, unless explicitly authorized for an exceptional case.

Never remove another agent's worktree.

Never discard another agent's work.

---

# 47. Remote Publishing

Remote publishing is opt-in unless the task explicitly involves preparing or completing a PR workflow that necessarily requires publishing the request branch.

Before any push:

* Verify remote
* Verify branch
* Verify commit set
* Verify Git identity

Never force-push unless explicitly authorized for that exact operation.

Never infer permission to push unrelated changes.

---

# 48. AI Must Implement, Not Merely Diagnose

When the user asks for implementation, do not stop after writing:

```text
I recommend...
You could...
Suggested architecture...
```

Perform the work.

The expected flow is:

```text
inspect
→ understand
→ implement
→ validate
→ E2E
→ review
→ commit/deliver
```

Do not leave straightforward implementation work unfinished merely because additional engineering decisions arise.

Make reasonable low-risk engineering decisions independently.

Ask the user only when necessary, such as when:

* Product behavior is genuinely ambiguous
* A breaking change requires approval
* User data may be irreversibly affected
* A security boundary must change
* Multiple incompatible product decisions exist

Do not repeatedly ask about ordinary internal implementation details.

---

# 49. Definition of Done

A code task is Done only when all applicable items are true:

```text
implementation complete
architecture boundaries preserved
compatibility reviewed
specs synchronized
ADR added when required
E2E documentation synchronized
format passes
typecheck passes
lint passes
relevant unit/integration tests pass
relevant E2E passes
complete diff reviewed
logical changes committed
PR gates satisfied
no known regression introduced
```

“Code written” is not Done.

“Build passes” alone is not Done.

“Unit tests pass” alone is not Done.

For a PR, “E2E not run” means the PR is not merge-ready unless the change is genuinely documentation-only/non-executable.

---

# 50. Boy Scout Rule

When touching code, it is acceptable to leave the directly affected code slightly better than before.

Examples:

* Remove obvious duplication
* Add a missing type
* Extract an already-clear responsibility
* Correct a stale comment
* Simplify directly affected control flow

Do not use this rule to expand a focused task into a broad cleanup project.

---

# 51. Completion Checklist

Before completion, verify:

* [ ] Current `main` was synchronized before development
* [ ] A unique request branch was created
* [ ] A dedicated worktree was used
* [ ] No other agent's worktree or branch was modified
* [ ] Baseline and relevant specifications were reviewed
* [ ] Existing behavior was preserved unless intentionally changed
* [ ] Architectural boundaries remain valid
* [ ] No new God Module was introduced
* [ ] Known architecture hotspots did not grow unnecessarily
* [ ] Relevant specs were updated
* [ ] ADR was added if architecture/security/data ownership changed
* [ ] E2E test-plan scenarios were updated when applicable
* [ ] Formatting passed
* [ ] Typecheck passed
* [ ] Lint passed
* [ ] Relevant unit/integration tests passed
* [ ] Relevant E2E suites passed
* [ ] E2E results correspond to the commit intended to merge
* [ ] Failed tests were not hidden or weakened
* [ ] Bug fixes include regression coverage where practical
* [ ] Complete diff was reviewed
* [ ] No secrets, local data, or unrelated changes are included
* [ ] Logical changes were committed separately
* [ ] PR description contains real validation results
* [ ] Required remote checks passed
* [ ] Merge result was verified
* [ ] Request worktree was removed after merge
* [ ] Merged request branch was deleted
* [ ] Remote publishing occurred only within authorized scope
* [ ] Linked GitHub issue was verified and handled correctly
* [ ] Linked GitHub PR preserved contributor work where applicable

---

# 52. Final Report

The agent's final report must include:

```text
Branch:
Worktree:

What changed:

Architecture impact:

Compatibility impact:

Specs / ADRs updated:

Validation:
- command
- result

E2E:
- suite
- result

Not run:
- command
- reason
- remaining risk

Commits:

PR / merge result:

Worktree cleanup:

Push result:

Linked issue:
- verification
- comment
- close result

Linked PR:
- principle review
- contributor preservation
- E2E result
- merge result

Remaining risks / technical debt:
```

Never claim tests or E2E passed unless they actually ran and passed.

---

# 53. Final Engineering Principle

Always optimize for:

> Changing the system safely, not merely changing it quickly.

Every feature should leave PI-Desktop with:

```text
working functionality
+
clear ownership
+
preserved compatibility
+
test coverage
+
E2E verification
+
no unnecessary architectural entropy
```

A feature that works today but makes the next change substantially harder is not fully finished.

还有一个**必须一起改的地方**：你现在的 `docs/spec/06-delivery/03-ai-development-workflow.md` 仍明确规定“E2E 只有用户主动要求才运行”，甚至 Development Loop 第 7 步也是这么写的。

所以不能只替换 `AGENTS.md`，否则 AI 会同时读到两套互相冲突的规则。建议把这次修改作为一个独立 PR：

**`docs: enforce architecture and e2e development gates`**

同时修改：

`AGENTS.md`
`docs/spec/06-delivery/03-ai-development-workflow.md`
`docs/spec/06-delivery/04-e2e-test-plan.md`（如需要说明执行门禁）

然后再把 **E2E workflow 设置为 GitHub Required Check**。这样“必须 E2E”就不只是提示词，而是真正做到 **没绿就合不了 PR**。

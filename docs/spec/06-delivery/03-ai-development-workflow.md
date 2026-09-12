# AI Development Workflow Amendment

Apply the following amendments to:

`docs/spec/06-delivery/03-ai-development-workflow.md`

Preserve all unrelated existing rules, including issue intake, pull-request contributor preservation, marketplace diagnosis, release gates, commit rules, branch/worktree isolation, spec synchronization, and ADR requirements.

The rules below supersede any existing statement that says E2E execution requires an explicit user request.

---

## Add R7 — Mandatory PR E2E Gate

### R7 — Code-bearing pull requests require relevant E2E before merge

> **No code-bearing pull request may merge without successful relevant E2E validation.**

This rule applies to pull requests that modify executable or runtime-affecting content, including:

* `apps/`
* `packages/`
* `crates/`
* runtime-affecting `scripts/`
* build configuration
* CI configuration
* packaging behavior
* protocol behavior
* persisted data behavior

Documentation-only changes are exempt when they do not alter executable behavior.

E2E execution is no longer opt-in for code-bearing pull requests.

The agent must select E2E suites according to the affected subsystem and execute them before the pull request is considered merge-ready.

Passing any of the following does **not** replace E2E:

* Build
* Typecheck
* Lint
* Unit tests
* Integration tests
* Manual code review
* Source inspection

If a required E2E suite cannot run in the current environment, the pull request may be opened as Draft / Not Ready, but it must not merge until the required E2E passes in a capable trusted environment.

E2E failure is a landing blocker.

---

## Amend R6 — Existing Pull Request Handling

Replace any wording that implies tests are always optional follow-up work with the following distinction:

Missing additional test coverage, documentation, naming cleanup, formatting, or non-blocking polish may be follow-up work when the pull request's principle is sound.

However, the following remain landing blockers:

* Build failure
* Typecheck failure
* Existing relevant unit/integration test failure
* Required E2E failure
* Unresolved merge conflict
* Security boundary violation
* Data corruption risk
* Protocol incompatibility without an approved migration
* Secret leakage
* Privilege or sandbox bypass

For a third-party pull request whose principle is sound, preserve the contributor's work and authorship.

If landing-blocker fixes are needed, make the smallest possible commits on top of the contributor's commits.

Do not replace the contributor's implementation merely because E2E exposed a defect.

Fix the defect, rerun the affected E2E, then merge.

---

# Development Loop

Replace the existing development loop with:

```text
0. If a GitHub issue is linked:
   independently verify the claim before implementation.

0b. If a GitHub pull request is linked:
    review whether the principle is sound before replacement work.

1. Synchronize main.

2. Create a dedicated request branch and worktree.

3. Read:
   - AGENTS.md
   - baseline
   - relevant specs
   - relevant ADRs
   - relevant existing tests

4. Determine:
   - behavior impact
   - architecture impact
   - compatibility impact
   - required spec changes
   - required E2E scenarios
   - required validation

5. Implement the smallest coherent change.

6. Update:
   - specs
   - ADRs where required
   - decisions log where required
   - E2E test-plan scenarios where required

7. Run targeted development validation.

8. Run pre-PR validation.

9. Select and run required E2E suites.

10. Review the complete diff.

11. Commit logical changes with conventional commits.

12. Refresh against current main.

13. If remote PR delivery is requested:
    push request branch and open PR.

14. Verify the PR head commit passes required checks and E2E.

15. Merge only after all landing gates pass.

16. Verify integration into main.

17. Remove the request worktree and delete the merged request branch.

18. Report actual validation results.
```

---

# Validation Policy

## Development-time validation

During implementation, validation remains risk-based.

Agents should prefer the smallest useful checks while iterating.

Examples:

```bash
pnpm --filter @pi-desktop/desktop typecheck
pnpm -r --if-present test
cargo test -p host-core
```

A developer does not need to run every E2E suite after every small edit.

The mandatory E2E gate applies when preparing executable changes to merge through a pull request.

---

## Pre-PR validation

Before a code-bearing pull request is considered ready, run the repository checks relevant to the change.

The normal baseline is:

```bash
pnpm build:js

pnpm --filter @pi-desktop/desktop typecheck

pnpm lint

pnpm -r --if-present test

cargo fmt --check

cargo test -p host-core --locked

cargo clippy -p host-core --all-targets
```

A command may be omitted only when it is demonstrably unrelated to the changed source tree.

For example, a renderer-only change does not automatically require rebuilding every release artifact.

Do not falsely report skipped validation as passing.

---

# Mandatory E2E Execution Policy

Every code-bearing pull request must run at least one relevant E2E suite.

The repository currently exposes:

```bash
pnpm test:e2e
pnpm test:e2e:plan
pnpm test:e2e:plan-ui
pnpm test:e2e:boot
pnpm test:e2e:supervision
pnpm test:e2e:subagents
```

Use the current root `package.json` as the source of truth for available commands.

The generic smoke suite should normally be included for cross-cutting runtime changes:

```bash
pnpm test:e2e
```

Additional suites are selected by affected responsibility.

### Electron startup / preload / lifecycle

Run:

```bash
pnpm test:e2e
pnpm test:e2e:boot
```

### Plan runtime behavior

Run:

```bash
pnpm test:e2e
pnpm test:e2e:plan
```

If Plan UI behavior changed, also run:

```bash
pnpm test:e2e:plan-ui
```

### Agent process supervision / restart / recovery

Run:

```bash
pnpm test:e2e
pnpm test:e2e:supervision
```

### Subagent lifecycle

Run:

```bash
pnpm test:e2e
pnpm test:e2e:subagents
```

### Changes spanning several domains

Run every relevant suite.

Do not choose the smallest suite merely to satisfy the rule.

Select tests based on regression surface.

---

# E2E Environment Limitations

A required E2E suite may occasionally be impossible to execute in the current agent environment because of:

* No graphical session
* Missing display server
* Unsupported operating system
* Required hardware unavailable
* Required credentials unavailable
* Required platform runner unavailable

When this happens, report:

```text
E2E: NOT RUN

Suite:
Reason:
Alternative validation:
Remaining risk:
```

The branch may be committed.

A Draft PR may be opened.

The PR is **not merge-ready**.

Required E2E must subsequently pass through:

* CI
* A compatible development machine
* A release runner
* Or another trusted execution environment

before merge.

Environment limitations are not permanent waivers.

---

# E2E Result Integrity

Never claim:

```text
E2E passed
```

unless that suite actually ran successfully.

E2E evidence must identify:

* Command
* Result
* Tested commit
* Execution environment when relevant

The result should correspond to the commit intended to merge.

If executable changes are made after E2E validation, rerun the affected E2E suites.

Documentation-only changes made after a successful E2E run do not automatically invalidate the result.

---

# E2E Failure Handling

A failed E2E is a defect signal, not an inconvenience to bypass.

Do not:

* Delete the scenario
* Skip the test
* Disable assertions
* Reduce assertions without product justification
* Add unconditional retries to hide deterministic failures
* Mark a known failure as passed
* Merge because the failure is “probably unrelated”

First determine whether the failure is:

```text
implementation regression
test regression
environment failure
known flaky infrastructure
```

Document the evidence.

If implementation is wrong, fix implementation.

If the test is wrong because product behavior intentionally changed, update:

* Relevant spec
* E2E scenario
* Automated E2E implementation

together.

---

# Regression Testing

Bug fixes should normally follow:

```text
reproduce
→ add regression coverage
→ confirm failure before fix when practical
→ implement fix
→ confirm regression coverage passes
→ run related E2E
```

A bug fix should make recurrence harder, not merely make the current symptom disappear.

---

# Architecture Review During Development

Before completing a task, review whether the change:

* Added responsibility to an existing God Module
* Created a new God Module
* Crossed process ownership boundaries
* Introduced unnecessary global mutable state
* Added unmanaged listeners or resources
* Created new race conditions
* Weakened type safety
* Weakened security boundaries
* Expanded a known architecture hotspot unnecessarily

Known hotspots must follow the architecture ratchet defined in `AGENTS.md`.

New features should preferably create or use the correct domain module instead of growing legacy hotspots.

---

# Pull Request Gate

A code-bearing PR is merge-ready only when all applicable gates are green:

```text
build
typecheck
lint
unit/integration tests
relevant E2E
required architecture/security checks
required review
```

A sound design direction does not override a failing merge gate.

Conversely, cosmetic completeness requirements should not be used to discard a sound external contribution.

---

# Pull Request Validation Report

Every code-bearing PR must include actual validation evidence.

Recommended structure:

```markdown
## Validation

### Build / static checks

- ✅ `pnpm build:js`
- ✅ `pnpm --filter @pi-desktop/desktop typecheck`
- ✅ `pnpm lint`

### Unit / integration

- ✅ `pnpm -r --if-present test`
- ✅ `cargo test -p host-core --locked`

### E2E

- ✅ `pnpm test:e2e`
- ✅ `pnpm test:e2e:boot`

Tested commit: `<sha>`
```

If a required suite has not run:

```markdown
### E2E

- ⏸ `pnpm test:e2e:plan-ui` — NOT RUN

Reason: no graphical environ
```

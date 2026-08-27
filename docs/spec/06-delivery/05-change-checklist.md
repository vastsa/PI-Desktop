# 05. Change Checklist

> A practical checklist agents must run before finishing work.  
> Cross-references: [ai-development-workflow](03-ai-development-workflow.md) · [e2e-test-plan](04-e2e-test-plan.md) · [decisions-log](../08-meta/decisions-log.md) · [ADR index](../../adr/README.md) · [BOARD](../../project/BOARD.md)

---

## 1. Request Start Checklist

Before editing any file for a new request:

- [ ] Existing uncommitted work is identified and preserved.
- [ ] `origin/main` is fetched and local `main` is fast-forwarded when its
  worktree is clean.
- [ ] A dedicated `<type>/<short-description>` request branch and worktree are
  created from that updated `main` commit.
- [ ] The request worktree reuses the primary checkout's toolchains, package
  stores, caches, and ignored local configuration where safe.
- [ ] Mutable, incompatible, or concurrency-sensitive environment state stays
  worktree-local and ignored.
- [ ] The current branch is not `main` before implementation begins.

---

## 2. Impact Analysis

Before starting implementation, answer these questions:

- [ ] What behavior changes does this change introduce?
- [ ] Which specs are affected? (list file paths)
- [ ] Does this change touch an architectural boundary? (process model, IPC, storage, security, plugin API)
- [ ] Does this change affect user-visible or protocol-visible behavior?
- [ ] Is local validation necessary for this change's risk and regression
  scope? If so, what is the smallest targeted check set?
- [ ] Which milestone deliverable does this relate to? (M1–M6, or none)

Reference the [spec update matrix](03-ai-development-workflow.md#3-spec-update-matrix) to determine required doc updates.

---

## 3. Spec Sync Checklist

After implementation (or alongside it):

- [ ] Every affected spec file is updated with the new behavior.
- [ ] If architectural boundary changed: ADR is written or updated in `docs/adr/`.
- [ ] If an implementation default changed: `decisions-log.md` entry updated.
- [ ] If baseline frozen decisions are affected: baseline bump + explicit ADR (not MVP-normal).
- [ ] Cross-references between specs are still correct (no stale links).

---

## 4. E2E / Test Doc Checklist

- [ ] If user-visible or protocol-visible behavior changed: new or updated scenario in [04-e2e-test-plan.md](04-e2e-test-plan.md).
- [ ] If a scenario was added or updated, it follows the template (ID, title,
  preconditions, steps, expected, specs, acceptance, milestone, status).
- [ ] If a scenario was added or updated, the traceability matrix in §8 is current.
- [ ] Unit tests added or updated when the change's risk makes them necessary.
- [ ] Integration tests added or updated when an IPC/RPC contract change or
  cross-component regression risk makes them necessary.
- [ ] The smallest necessary targeted local checks passed, or local validation
  was assessed as unnecessary with no separate approval or waiver required.
- [ ] No E2E suite or command was run unless the user explicitly requested E2E
  validation.
- [ ] If the user requested E2E validation, the requested suite and its result
  are documented in the handoff.
- [ ] Automatically triggered remote E2E jobs are treated as merge gates, but
  are not manually dispatched or rerun without an explicit user request.

---

## 5. Git Commit Checklist

- [ ] Change is one logical unit (or split into focused commits).
- [ ] No secrets, tokens, or local data in the diff.
- [ ] No `node_modules/`, build artifacts, or release packages in the diff.
- [ ] Commit message follows conventional format: `type(scope): description` (English only).
- [ ] Spec updates committed with code when tightly coupled, or adjacent `docs:` commit for pure docs.
- [ ] `git diff --stat` reviewed — nothing unexpected.

---

## 6. Pull/Merge Request Checklist

Before marking the request complete:

- [ ] Request branch is pushed to the remote.
- [ ] PR/MR targets `main` and contains only the request's logical changes.
- [ ] PR description lists impacted specs and e2e scenarios.
- [ ] PR self-review checklist completed.
- [ ] Required remote checks and reviews pass.
- [ ] PR/MR is merged into `main` using a permitted merge strategy.
- [ ] Request worktree is removed after merge.
- [ ] Merged request branch is deleted locally (`git branch -d`).
- [ ] Remote request branch is deleted after merge.
- [ ] Issue reference is included when applicable (e.g. `Refs #12` or
  `Closes #12`).

---

## 6.1 Merge Cleanup Checklist

Run immediately after the request branch is integrated into `main`, whether the
merge happened remotely via PR/MR or locally in the primary checkout:

- [ ] Expected merge commits are verified present in `main`.
- [ ] The request worktree is clean — no uncommitted or untracked request files
  remain.
- [ ] `git worktree remove <worktree-path>` succeeded without forcing.
- [ ] `git branch -d <type>/<short-description>` succeeded (no `-D` fallback on
  an unmerged branch).
- [ ] `git worktree prune` leaves `git worktree list` free of stale entries for
  this request.
- [ ] No other agent's worktree or branch was removed.

---

## 7. App version release checklist (stable tag)

Required for every stable app version bump / tag (D164). Skip only for
documentation-only work or non-release chores.

- [ ] `packages/shared/src/changelog.ts` has a newest-first entry for the
      release version under **both** `en` and `zh-CN` (no leading `v`).
- [ ] Highlight counts match across locales; English is the source of truth.
- [ ] Bullets are short user-facing product notes (not raw PR/commit lists).
- [ ] Pre-release-only versions are omitted from the product catalog unless
      product explicitly ships in-app notes for that channel.
- [ ] `packages/shared/src/changelog.test.ts` lists the new version first.
- [ ] `pnpm --filter @pi-desktop/shared test` passes catalog alignment.
- [ ] `README.md` and `README.zh-CN.md` state the current
      `<major>.<minor>.x` release line and contain no toolchain, command,
      Highlights, or roadmap claim the release invalidates.
- [ ] `node scripts/check-release-docs.mjs` passes (version surfaces,
      dual-locale catalog, README release line).
- [ ] Documentation commit is on the release branch **before**
      `node scripts/release.mjs <version> --tag` / `git tag v<version>`.
- [ ] GitHub auto-generated release body is treated as web-only, not the
      in-app source ([06-release-runbook.md §4.1](06-release-runbook.md#41-mandatory-release-version-surface-gate-d164--d260)).

---

## 8. Final Definition-of-Done Gate

Before marking work complete, verify **all** of the following:

| # | Gate | Source |
|---|---|---|
| 1 | Request branch and worktree created from an up-to-date `main`; primary environment reused where safe | [R4 — Request branch + worktree + merge gate](03-ai-development-workflow.md#r4--request-branch--worktree--merge-gate) |
| 2 | Code/doc implements the planned change | Step 4 of [development loop](03-ai-development-workflow.md#2-development-loop) |
| 3 | All impacted specs updated | [R1 — Spec-sync](03-ai-development-workflow.md#r1--spec-first--spec-sync) |
| 4 | E2E scenarios documented (or confirmed not needed) | [R3 — E2E coverage doc](03-ai-development-workflow.md#r3--e2e-coverage-doc) |
| 5 | Necessary targeted local validation passed, or was assessed as unnecessary; automatically triggered remote gates passed; agents ran or dispatched E2E only if explicitly requested | Steps 7 and 11 of development loop |
| 6 | Change committed with conventional message | [R2 — Commit-per-change](03-ai-development-workflow.md#r2--commit-per-change) |
| 7 | BOARD updated if milestone deliverable completed | Step 9 of development loop |
| 8 | No secrets or local data in commit | [§4.4 Never commit](03-ai-development-workflow.md#44-never-commit) |
| 9 | PR/MR merged into `main`; request worktree and branch removed | [R4 — Request branch + worktree + merge gate](03-ai-development-workflow.md#r4--request-branch--worktree--merge-gate) |
| 10 | No merged worktree left on disk; `git worktree list` has no stale entry for this request | [§6.1 Merge Cleanup Checklist](#61-merge-cleanup-checklist) |

If any gate fails, the change is **not Done**.

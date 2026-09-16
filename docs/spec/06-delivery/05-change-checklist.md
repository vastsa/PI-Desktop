# 05. Change Checklist

> A practical checklist agents must run before finishing work.  
> Cross-references: [ai-development-workflow](03-ai-development-workflow.md) · [e2e-test-plan](04-e2e-test-plan.md) · [decisions-log](../08-meta/decisions-log.md) · [ADR index](../../adr/README.md) · [BOARD](../../project/BOARD.md)

---

## 0. GitHub Issue Intake

When the prompt includes a GitHub issue URL or an unambiguous issue number for
this repository, complete this gate before the request-start checklist:

- [ ] Issue title, body, labels, comments, and state were fetched.
- [ ] The reported problem was independently verified (reproduced or evidenced
  for a bug; confirmed missing or incomplete and in scope for a feature).
- [ ] Implementation started only after the problem was confirmed to exist.
- [ ] If the problem does not exist: the issue received a verification comment
  and was closed when the conclusion was clear, or left open when inconclusive.
- [ ] After a confirmed fix was merged: the issue received a resolution comment
  and was closed.
- [ ] The comment uses the issue's language.
- [ ] No unrelated issue was commented on or closed.
- [ ] Git push was not inferred from the issue link.

See [R5 — Verify linked GitHub issues](03-ai-development-workflow.md#r5--verify-linked-github-issues-before-work-then-reply-and-close).

---

## 0.1 GitHub Pull Request Intake

When the prompt includes a GitHub pull request URL or an unambiguous pull
request number for this repository, complete this gate before rewriting the
change or starting follow-up:

- [ ] Pull request title, body, files, commits, comments, checks, draft
  state, base/head, and linked issues were fetched.
- [ ] The **principle** was independently judged (real in-scope problem;
  approach compatible with baseline, security, and architecture).
- [ ] Completeness gaps (specs, tests, i18n, e2e docs, style, naming) were
  not treated as merge blockers.
- [ ] If the principle is sound: the pull request was merged first,
  preserving the contributor's commits; landing blockers received only
  smallest-on-top commits.
- [ ] Follow-up started only after the pull request was in `main`, using a
  new R4 request branch and worktree.
- [ ] If the principle is not sound or a harm blocker exists: the pull
  request was not merged, and a comment recorded the evidence. The idea was
  not silently reimplemented.
- [ ] A draft pull request was not merged unless the user explicitly asked.
- [ ] The comment uses the pull request's language.
- [ ] No unrelated pull request was commented on or merged.
- [ ] The contributor's branch was not force-pushed. Unrelated remote
  publishing was not inferred from the pull request link.

See [R6 — Merge a linked pull request whose principle is sound, then follow up](03-ai-development-workflow.md#r6--merge-a-linked-pull-request-whose-principle-is-sound-then-follow-up).

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
- [ ] Delivery scope is recorded: a commit request includes local `main`
  integration; a push request includes PR-based remote `main` integration and
  local synchronization. Explicit branch-only or draft-only limits are honored.

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
- [ ] If `AGENTS.md` changed: `CLAUDE.md` still mirrors the non-negotiables,
  both files share the same `Policy-Sync:` token, and `pnpm check:agent-policy`
  passes. The reverse applies when only `CLAUDE.md` changed.
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
- [ ] Relevant E2E suites were selected and passed on the integrated local
  `main` before the request branch was pushed and a PR/MR was opened, or before
  a commit-only delivery was declared complete; required validation needs no
  separate user request. Documentation-only changes retain their existing
  exemption.
- [ ] Results apply to the commit the gate ran on, and the affected suites were
  rerun when the landed executable content changed. Any required suite not run
  is recorded with its reason, alternative validation, and remaining risk;
  delivery remains incomplete until that gate passes.
- [ ] Hosting-platform E2E jobs that start before the remote merge were observed
  and reported but do not replace the local `main` gate; a post-merge rerun
  happened when the landed executable content differs from the commit the gate
  ran on. Dispatch or rerun follows the hosting platform's or repository
  workflow's requirements.

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

Before marking requested integration complete, apply the R4 delivery scope;
explicit branch-only or draft-only requests retain their narrower scope:

- [ ] Requested commit/push delivery is integrated into local `main`; a
  task-branch commit or push alone was not reported as completion, and no second
  merge confirmation was requested.
- [ ] For a code-bearing change: the relevant E2E gate ran against the
  integrated local `main` before the branch push and PR/MR creation, or before
  a commit-only delivery was declared complete, or its `NOT RUN` limitation is
  recorded with reason, alternative validation, and remaining risk.
- [ ] Commit-only or local-merge delivery did not publish remotely without
  separate authorization.
- [ ] For authorized remote delivery: the request branch was pushed, its PR/MR
  targeted `main` with only this task's changes, and the description documented
  impacted specs, E2E scenarios, and validation.
- [ ] For authorized remote delivery: PR self-review, required checks, and
  reviews passed; the PR/MR merged into remote `main` using a permitted
  strategy; local `main` was synchronized with the landed change; when the
  landed executable content differs from the commit the gate ran on, the
  affected suites were rerun and recorded.
- [ ] No direct push to `main`, force-push, discarded unrelated work, or bypassed
  gate was inferred from the delivery request. Genuine blockers were reported.
- [ ] Request worktree is removed after merge.
- [ ] Merged request branch is deleted locally (`git branch -d`).
- [ ] Any remotely published request branch is deleted after merge.
- [ ] Issue reference is included when applicable (e.g. `Refs #12` or
  `Closes #12`).

---

## 6.1 Merge Cleanup Checklist

Run immediately after the request branch is integrated into `main`, whether the
merge happened remotely via PR/MR or locally in the primary checkout:

- [ ] Expected commits are verified present in local `main`, and remote `main`
  when remote delivery was requested.
- [ ] The request worktree is clean — no uncommitted or untracked request files
  remain.
- [ ] `git worktree remove <worktree-path>` succeeded without forcing.
- [ ] `git branch -d <type>/<short-description>` succeeded (no `-D` fallback on
  an unmerged branch).
- [ ] `git worktree prune` leaves `git worktree list` free of stale entries for
  this request.
- [ ] No other agent's worktree or branch was removed.
- [ ] If launch was requested after delivery, the app was built and started
  from the integrated `main` checkout and its development environment.

---

## 7. App version release checklist (stable tag)

Required for every stable app version bump / tag (D164). Skip only for
documentation-only work or non-release chores.

- [ ] `packages/shared/src/changelog.ts` has a newest-first entry for the
      release version under `en` and every shipped product locale (no leading
      `v`).
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
      shipped-locale catalog, README release line).
- [ ] Documentation commit is on the release branch **before**
      `node scripts/release.mjs <version> --tag` / `git tag v<version>`.
- [ ] GitHub auto-generated release body is treated as web-only, not the
      in-app source ([06-release-runbook.md §4.1](06-release-runbook.md#41-mandatory-release-version-surface-gate-d164--d260)).

---

## 8. Final Definition-of-Done Gate

Before marking work complete, verify **all applicable** conditions under the
user's delivery scope:

| # | Gate | Source |
|---|---|---|
| 1 | Request branch and worktree created from an up-to-date `main`; primary environment reused where safe | [R4 — Request branch + worktree + merge gate](03-ai-development-workflow.md#r4--request-branch--worktree--merge-gate) |
| 2 | Code/doc implements the planned change | Step 4 of [development loop](03-ai-development-workflow.md#2-development-loop) |
| 3 | All impacted specs updated | [R1 — Spec-sync](03-ai-development-workflow.md#r1--spec-first--spec-sync) |
| 4 | E2E scenarios documented (or confirmed not needed) | [R3 — E2E coverage doc](03-ai-development-workflow.md#r3--e2e-coverage-doc) |
| 5 | Targeted local checks follow the existing risk standard; for a code-bearing change the relevant E2E gate passed on the integrated local `main` before the branch push, the PR/MR, or a commit-only completion (or its `NOT RUN` limitation is recorded); after the remote merge the affected suites were rerun when the landed executable content changed; required tests need no separate user request | Steps 7, 10, and 11 of development loop |
| 6 | Change committed with conventional message | [R2 — Commit-per-change](03-ai-development-workflow.md#r2--commit-per-change) |
| 7 | BOARD updated if milestone deliverable completed | Step 9 of development loop |
| 8 | No secrets or local data in commit | [§4.4 Never commit](03-ai-development-workflow.md#44-never-commit) |
| 9 | Requested local/remote `main` integration completed under R4; expected commits verified and merged worktree/branch removed; any requested launch uses integrated `main` | [R4 — Request branch + worktree + merge gate](03-ai-development-workflow.md#r4--request-branch--worktree--merge-gate) |
| 10 | No merged worktree left on disk; `git worktree list` has no stale entry for this request | [§6.1 Merge Cleanup Checklist](#61-merge-cleanup-checklist) |
| 11 | If a GitHub issue was linked: verified before work; commented in the issue language; closed when conclusive | [R5 — Verify linked GitHub issues](03-ai-development-workflow.md#r5--verify-linked-github-issues-before-work-then-reply-and-close) |
| 12 | If a GitHub pull request was linked: principle reviewed; merged first when sound; follow-up after merge; contributor work not discarded | [R6 — Merge a linked pull request whose principle is sound, then follow up](03-ai-development-workflow.md#r6--merge-a-linked-pull-request-whose-principle-is-sound-then-follow-up) |

If any applicable gate fails, the requested integration is **not Done**; report
the blocker without weakening the gate.

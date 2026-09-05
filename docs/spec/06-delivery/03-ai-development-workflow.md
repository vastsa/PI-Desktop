# 03. AI-Assisted Development Workflow

> Scope: AI agents and human collaborators working on PI-Desktop  
> Status: Accepted  
> Cross-references: [00-baseline](../00-baseline.md) · [decisions-log](../08-meta/decisions-log.md) · [acceptance-criteria](02-acceptance-criteria.md) · [e2e-test-plan](04-e2e-test-plan.md) · [change-checklist](05-change-checklist.md) · [ADR index](../../adr/README.md)

---

## 1. Core Immutable Rules

These five rules govern every change to the PI-Desktop codebase and documentation. They cannot be relaxed by an agent without explicit human override.

### R1 — Spec-first / Spec-sync

> **No behavior change without updating the corresponding spec.**

- Every code, config, or UX change that alters observable behavior must update the relevant `docs/spec/` document before or alongside the change.
- Architectural boundary changes (process model, IPC contract, storage ownership, security boundary) also require an ADR — see `docs/adr/README.md`.
- Pure refactor that preserves behavior and API contracts does not require spec updates, but must still be committed (R2).

### R2 — Commit-per-change

> **Every completed logical change must be git committed.**

- No large uncommitted piles of work. Each logical unit of work — a feature, a fix, a spec update, a chore — gets its own commit.
- Uncommitted work at session end is a violation of this rule.
- If a change is incomplete, either commit it as a draft with a `WIP:` prefix or roll it back.

### R3 — E2E coverage doc

> **Every feature/fix that affects user-visible or protocol-visible behavior must update e2e test documentation.**

- "User-visible": anything the end-user sees or interacts with (UI, CLI output, dialogs, notifications).
- "Protocol-visible": IPC messages, RPC methods, plugin API surfaces, event payloads.
- Document the scenario in `06-delivery/04-e2e-test-plan.md` — even before the automated test exists.
- Internal-only changes (logging format, internal variable rename) do not require e2e doc updates.

### R4 — Request branch + worktree + merge gate

> **Every new request starts from `main` in a dedicated worktree on a dedicated branch and finishes only after its PR/MR is merged into `main`.**

- Before editing, preserve any existing uncommitted work, fetch `origin/main`,
  fast-forward local `main` when its worktree is clean, and create a new request
  branch and worktree from that up-to-date commit. Existing work in the primary
  checkout must never be moved, stashed, or overwritten merely to start a new
  request.
- Use one short-lived branch per request. Name it
  `<type>/<short-description>`, where `type` matches the conventional change
  type when practical, for example `feat/provider-import` or
  `docs/request-branch-workflow`.
- Use one dedicated worktree per request. Do not implement a new request in the
  primary checkout or reuse another request's worktree.
- Reuse the primary checkout's development environment where safe: installed
  toolchains, package-manager stores, build caches, and ignored local
  environment configuration remain the canonical environment. Reference or
  link those resources into the request worktree when required; do not copy
  environment state into tracked files. Install or generate worktree-local
  state only when isolation or version compatibility requires it.
- Development commits and direct pushes on `main` are forbidden.
- After development and any necessary local validation, push the request
  branch, open a pull/merge request targeting `main`, and complete all required
  remote checks and reviews.
- Merge the approved PR/MR into `main`, remove the request worktree, and delete
  the request branch. If
  authentication, permissions, required remote checks, or required reviews prevent
  the merge, report the blocker; the request is not Done.
- Worktree cleanup is mandatory and immediate. As soon as the request branch is
  integrated into `main` — including a local `main` merge when the request is
  delivered without a remote PR/MR — remove the worktree and delete the merged
  branch. A merged request must not leave a worktree on disk. Remove only your
  own worktree and branch, and only after verifying the merge commits are
  present in `main`.

### R5 — Verify linked GitHub issues before work, then reply and close

> **A linked GitHub issue is not a task until the reported problem is shown to exist. After the outcome is conclusive, reply on that issue and close it.**

This rule applies when the user prompt includes a GitHub issue URL or an
unambiguous issue number for this repository.

- Fetch the issue (title, body, labels, comments, and state) before creating a
  worktree or changing files for the claimed problem.
- Independently verify the claim against the current codebase. For a bug,
  reproduce it or cite concrete code/spec evidence. For a feature or
  improvement, confirm the requested behavior is actually missing or incomplete
  and in scope.
- Do not start implementation until verification confirms the problem exists.
- If the problem does not exist (already fixed, invalid, or a
  misunderstanding): comment with the verification evidence and close the issue
  when that conclusion is clear. If verification is inconclusive, comment with
  what was tried and leave the issue open.
- If the problem exists: follow R4, implement the smallest coherent change,
  and after the request is merged into local `main`, comment with the
  resolution and close the issue.
- Write the GitHub comment in the language of the original issue title and
  body. Code, commits, specs, and other repository documentation stay English.
- End every such comment with an explicit AI-handled marker:
  - English issues: `Handled by AI.`
  - Chinese issues: `本回复由 AI 处理。`
- An issue link authorizes commenting on and closing **that** issue only. It
  does not authorize a git push. Remote publishing remains opt-in per R4 and
  `AGENTS.md`.
- Do not comment on or close unrelated issues. Do not reopen a closed issue
  unless the user explicitly asks.

### GitHub issue templates

`.github/ISSUE_TEMPLATE` is the only public intake path (`blank_issues_enabled:
false`). English is the source label language; Chinese remains on the same
fields.

- **Bug report** requires: description, reproduction steps, expected behavior,
  actual behavior, app version, and OS. Logs, extra environment, and
  screenshots are optional. Settings → Info prefills version, OS, and
  environment when opened from the app (D313).
- **Feature request** requires: problem and proposed change. Alternatives and
  extra context are optional.

Do not weaken these required fields. Blank issues stay disabled.

---

## 2. Development Loop

Every change follows this sequence. Steps may be iterated if the implementation reveals new requirements. If the prompt includes a GitHub issue, complete R5 verification before step 1.

```
0. If a GitHub issue is linked: verify the claim (R5) before any implementation
1. Sync main + create a request branch and worktree
2. Read baseline + relevant specs
3. Plan change + list impacted specs and necessary validation
4. Implement
5. Update specs / ADR / decisions-log if needed
6. Update or add e2e scenarios when R3 applies
7. Run the smallest targeted local checks necessary for the change's risk; skip
   local validation when it is unnecessary and continue to step 8. Run E2E only
   when explicitly requested by the user
8. Commit with conventional message
9. Update BOARD if milestone-related
10. Push branch + open PR/MR to main
11. Pass remote gates + merge + remove worktree and branch
```

### Step-by-step

| Step | Action | Output |
|---|---|---|
| **0. Issue verify** | When a GitHub issue is linked, fetch it and independently verify that the reported problem exists. Stop here (comment, and close only if conclusive) when it does not. | Verified issue, or an AI-handled comment and close/leave-open decision. |
| **1. Branch + worktree** | Preserve existing work, update from `origin/main`, and create a dedicated request branch in a dedicated worktree. Reuse the primary checkout's environment where safe. | Isolated task files on current `main` with a consistent development environment. |
| **2. Read** | Read `00-baseline.md` and any specs relevant to the change area. | Mental model of constraints. |
| **3. Plan** | Describe the intended change. List every spec, ADR, and e2e scenario that will need updates, and assess whether local validation is necessary. | Change plan + impact and validation list. |
| **4. Implement** | Write code, config, or assets. | Changed files. |
| **5. Spec-sync** | Update specs per the impact list. Add ADR if architectural. Update `decisions-log.md` if an implementation default changes. | Updated docs/spec/\* and/or docs/adr/\*. |
| **6. E2E doc** | When R3 applies, add or update scenario entries in `04-e2e-test-plan.md` and link to acceptance criteria IDs (A–H). Otherwise, confirm no scenario update is needed. | Updated e2e test plan, or confirmed not applicable. |
| **7. Validate if necessary** | Use change risk and regression scope to decide whether local validation is necessary. If it is, run the smallest relevant set of non-E2E checks, such as a focused lint, typecheck, unit/integration test, or build. If it is not, skip local validation and continue directly to commit and delivery. Run E2E only when the user explicitly requests E2E validation. | Targeted check results, or validation assessed as unnecessary. |
| **8. Commit** | Git commit with conventional message (see §4). | One or more commits. |
| **9. BOARD** | If the change completes a milestone deliverable, update `docs/project/BOARD.md`. | Updated board. |
| **10. Open PR/MR** | Push the request branch and open a pull/merge request targeting `main`. | Reviewable remote change with impacted specs and validation listed. |
| **11. Merge** | Pass required remote checks and reviews, merge into `main`, remove the request worktree, and delete the request branch. | Change integrated into `main`; task worktree and request branch removed. |

### Local Validation and E2E Execution Policy

- Local validation is risk-based rather than an automatic prerequisite for
  delivery. Documentation-only changes and low-risk mechanical edits normally
  require no local tests or checks and proceed directly to commit, push, and
  PR/MR creation. No separate approval or waiver is needed to skip them.
- Changes with material regression risk, including security boundaries,
  protocol contracts, data migrations, build configuration, or widely shared
  behavior, normally require the smallest targeted non-E2E validation that can
  address that risk. A full local suite is not the default.
- E2E scenario documentation and E2E execution are separate concerns. R3 still
  requires scenario updates for user-visible or protocol-visible behavior.
- Agents must not proactively run E2E suites or commands, including
  `pnpm test:e2e*`, Playwright suites, Electron probes, or live-agent E2E
  scripts. Run them only when the user explicitly requests E2E validation.
- A generic instruction to run checks or tests authorizes relevant non-E2E
  validation under Step 7; it does not require every available local check and
  does not authorize E2E execution.
- Required E2E jobs that the hosting platform starts automatically after a
  push or PR remain merge gates. Observe and report their result, but do not
  manually dispatch or rerun them unless the user explicitly requests it.

### Marketplace/update diagnosis gate

Plugin update incidents require an evidence-first prompt flow before code
changes:

1. Capture the exact plugin ID, installed version, displayed version, expected
   release, catalog URL, and observation time.
2. Fetch the live catalog and inspect the exact entry, then inspect the local
   catalog cache and installed registry independently.
3. Classify the failure boundary: publisher/catalog data, fetch/cache fallback,
   host version comparison, IPC propagation, or renderer presentation.
4. Run `pnpm check:marketplace -- --url <catalog-url> --plugin <id>`. Missing
   `shasum`, `url`, positive `sizeBytes`, or `permissions` is a release-data
   failure, not evidence of a stale renderer. Incomplete releases remain
   non-installable.
5. Reproduce with a fixture containing unsorted versions and incomplete
   metadata before changing host or renderer code.

The agent must state which boundary failed and what evidence rules out the
other boundaries. A client-side fallback may preserve safe discovery, but it
must not be used to conceal an invalid marketplace release.

---

## 3. Spec Update Matrix

Which change types require which doc updates.

| Change type | Spec update | ADR | Decisions-log | E2E doc | BOARD |
|---|---|---|---|---|---|
| New feature (user-visible) | Related domain spec | If architectural boundary | — | New scenario | If milestone deliverable |
| Bug fix (user-visible) | Related spec if behavior clarified | — | — | New or updated scenario | — |
| Bug fix (internal) | — | — | — | — | — |
| Refactor (behavior preserved) | — | — | — | — | — |
| Architectural change | Related specs + baseline | **New ADR** | Update entry if default changes | Update affected scenarios | — |
| New IPC/RPC method | `03-runtime/01-ipc-protocol.md` or `06-host-rpc-protocol.md` | If contract boundary | — | New protocol scenario | — |
| Plugin API addition | `07-plugins/03-plugin-api.md` | If boundary change | — | New plugin scenario | If M4 deliverable |
| Security change | `05-security/01-security.md` | If boundary change | Update if D001–D010 touched | New security scenario | — |
| UX change | Related `04-ux/` spec | — | — | New UI scenario | — |
| Spec-only update | The spec itself | — | — | — | — |
| Chore (deps, tooling) | — | — | If tooling decision | — | — |
| **App version release / stable tag** | `06-delivery/06-release-runbook.md` (mandatory version-surface gate before tag: dual-locale `packages/shared/src/changelog.ts`, its test list, all workspace/Cargo/`APP_VERSION` versions, and the release line in `README.md` + `README.zh-CN.md`) | — | If release policy changes | Confirm E2E-067B still accurate | If milestone ship |

---

## 4. Git Commit Rules

### 4.1 Conventional Commits

Format: `type(scope): description`

| Type | Use for |
|---|---|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation-only change |
| `test` | Adding or updating tests |
| `chore` | Build, deps, tooling, CI |
| `refactor` | Code restructuring, no behavior change |
| `perf` | Performance improvement |
| `build` | Build system or external dependency change |
| `ci` | CI/CD configuration change |

**Scope** is optional but encouraged — e.g. `feat(host-core):`, `fix(ui):`, `docs(spec):`.

### 4.2 Language

- Commit messages: **English only** (matches baseline language policy).
- Body: optional; use for non-obvious context.

### 4.3 One logical change per commit

- Prefer small, focused commits.
- Spec updates that are tightly coupled to the code change should be in the same commit.
- Pure doc changes (spec rewrite, ADR) may be a separate adjacent `docs:` commit.

### 4.4 Never commit

- Secrets, API keys, tokens, passwords
- Local-only data (user configs, session data, logs)
- `node_modules/`, build artifacts, release packages
- Generated files that should be rebuilt per CI

### 4.5 Pre-commit checklist

Before committing, verify:

1. Change is one logical unit (or clearly split).
2. No secrets or local data in the diff.
3. Specs updated per §3 matrix.
4. E2E doc updated if behavior changed.
5. `git diff --stat` review — nothing unexpected.
6. Commit message follows conventional format.

---

## 5. Branching Model

The repository uses a mandatory request-branch and worktree workflow:

- **`main`** is always deployable and is the protected integration target. Do
  not develop, commit, or push directly on it.
- **Request branches and worktrees** are mandatory for every new request,
  including docs, chores, and small fixes. Create each branch and worktree from
  an up-to-date `main`, then remove both immediately after the branch is merged
  into `main`.
- **Branch names** use `<type>/<short-description>` with a lowercase,
  kebab-case description. Allowed type prefixes mirror §4.1.
- **No long-lived development branch** exists. Each request gets a new branch;
  an old request branch must not be reused for unrelated work.
- **The primary checkout owns the default development environment.** Request
  worktrees reuse its toolchains, package-manager stores, caches, and ignored
  local configuration where safe. A request may create isolated local state
  when sharing would be unsafe or incompatible, but that state stays ignored
  and must not leak into commits.
- **PR/MR delivery** is mandatory. Push the branch, open a PR/MR targeting
  `main`, pass required remote checks and reviews, then merge using a repository-
  permitted merge strategy.

Typical request start (run from the primary checkout; choose a path outside it):

```bash
git status --short
git fetch origin main
git worktree add -b <type>/<short-description> <worktree-path> origin/main
```

If `main` is checked out in a clean primary worktree, `git switch main` plus
`git pull --ff-only origin main` should be run before `git worktree add`. If the
primary worktree is not clean or is on another branch, leave it untouched and
create the request worktree directly from the fetched `origin/main`. Never
discard, stash, move, or overwrite unrelated work merely to satisfy this
sequence.

Environment reuse is resource-specific. Package-manager stores and language
toolchains are normally shared automatically. Ignored local configuration or a
compatible dependency tree may be referenced or linked from the primary
checkout when a task needs it. Build outputs that can race, mutable runtime
data, and incompatible dependency trees must remain worktree-local.

Typical GitHub delivery (use the hosting platform's equivalent when needed):

```bash
git push -u origin <type>/<short-description>
gh pr create --base main --head <type>/<short-description>
gh pr checks --watch
gh pr merge --merge
git worktree remove <worktree-path>
git branch -d <type>/<short-description>
git push origin --delete <type>/<short-description>
```

Request cleanup when the request is integrated by merging into local `main`
instead of a remote PR/MR (run from the primary checkout):

```bash
git switch main
git merge <type>/<short-description>
git log --oneline -1
git worktree remove <worktree-path>
git branch -d <type>/<short-description>
git worktree prune
```

The worktree must be clean before removal; commit or discard the request's own
leftover changes first. Use `git branch -d` rather than `-D` so an unmerged
branch refuses to delete. If `git worktree remove` reports the worktree as dirty
or locked, resolve that state instead of forcing removal, and never remove
another request's worktree.

---

## 6. Definition of Done

A change is **Done** when all of the following are true:

1. A dedicated request branch and worktree were created from an up-to-date
   `main`.
2. Code (or doc) implements the planned change.
3. All impacted specs are updated.
4. E2E scenarios are documented (or confirmed not needed per §3).
5. Necessary targeted local validation passes, or local validation is assessed
   as unnecessary; automatically triggered remote gates pass, and agents only
   run or dispatch E2E when explicitly requested.
6. Change is committed with a conventional message.
7. BOARD is updated if a milestone deliverable completed.
8. No secrets or local data are present in the commit.
9. The branch was pushed and its PR/MR was reviewed and merged into `main`.
10. The request worktree was removed and the merged request branch was deleted.
11. If a GitHub issue was linked: the claim was verified before implementation;
    the issue received a comment in its language with the AI-handled marker;
    and the issue was closed when the outcome was conclusive.

### Release / version-tag gate

When the change is a **stable app version release** (version bump + tag),
Definition of Done also requires, **before** the tag, that every
version-bearing surface describes the new version: the dual-locale in-app
changelog entry in `packages/shared/src/changelog.ts` (EN + zh-CN, aligned
highlight counts) with its `changelog.test.ts` list, every workspace
`package.json` (including `docs/package.json`), the Cargo workspace version and
`host-core` lockfile entry, `APP_VERSION`, and the release line stated in
`README.md` + `README.zh-CN.md`. `node scripts/check-release-docs.mjs` must
pass; `scripts/release.mjs` runs it and refuses to tag otherwise. See
[06-release-runbook.md §4.1](06-release-runbook.md#41-mandatory-release-version-surface-gate-d164--d260),
D164, and D260. GitHub release notes are not a substitute.

---

## 7. Forbidden Practices

| Practice | Why |
|---|---|
| Committing secrets | Security violation |
| Large uncommitted diffs | Violates R2; loss of granularity |
| Changing behavior without spec update | Violates R1; specs become unreliable |
| Skipping e2e doc for user-visible changes | Violates R3; traceability gap |
| Manually running or dispatching E2E without an explicit user request | Violates the opt-in E2E execution policy |
| Treating the full local test/check suite as an automatic pre-push requirement | Ignores risk-based validation and delays delivery without evidence of need |
| Developing, committing, or pushing directly on `main` | Violates R4; bypasses isolation and review gates |
| Developing a new request in the primary checkout or another request's worktree | Violates R4; mixes task files and local state |
| Reusing a request branch for unrelated work | Mixes request scope and weakens traceability |
| Marking work Done before its PR/MR is merged | Violates R4; change is not integrated into `main` |
| Leaving a merged request worktree on disk | Violates R4; stale worktrees accumulate and invite cross-request contamination |
| Modifying baseline frozen decisions without ADR + version bump | Baseline is frozen; changes need formal process |
| Committing generated artifacts that CI should rebuild | Repo bloat, merge conflicts |
| Mixing multiple logical changes in one commit without clear message | Loss of history granularity |
| Implementing a linked GitHub issue without verifying the problem exists | Violates R5; wastes work on invalid or already-fixed claims |
| Closing a linked GitHub issue without an AI-handled comment in the issue language | Violates R5; leaves no public record of the AI outcome |
| Tagging a stable app release without updating `packages/shared/src/changelog.ts` (EN + zh-CN) | Violates D164 / release runbook; in-app What's new is empty for that version |
| Tagging a stable app release while `README.md` / `README.zh-CN.md` still state an older release line, or bypassing `scripts/check-release-docs.mjs` with `--skip-docs-check` | Violates D260 / release runbook; published documentation advertises a version the release no longer matches |

---

## 8. Acceptance Criteria for This Workflow

This workflow spec itself is accepted when:

- [ ] R1/R2/R3/R4/R5 are stated clearly and cross-linked to relevant specs.
- [ ] Development loop is documented and referenced by `AGENTS.md`.
- [ ] Spec update matrix covers all change types in the baseline.
- [ ] Git commit rules match existing repo commit style (`docs:`, `chore:`).
- [ ] Every request is required to use a dedicated branch and worktree created
      from current `main`.
- [ ] Request worktrees reuse the primary checkout's environment where safe
      without committing local environment state.
- [ ] PR/MR creation, remote gates, merge, and branch cleanup are mandatory.
- [ ] Worktree removal and branch deletion are required immediately after the
      request branch is merged into `main`, including local-merge delivery.
- [ ] E2E execution is opt-in and requires an explicit user request, while E2E
      scenario documentation remains mandatory under R3.
- [ ] Local validation is risk-based; unnecessary checks may be skipped without
      blocking commit, push, or PR/MR creation.
- [ ] Definition of Done is complete and actionable.
- [ ] Forbidden practices list covers known risk areas.
- [ ] `AGENTS.md` points to this doc, `04-e2e-test-plan.md`, and `05-change-checklist.md`.
- [ ] Linked GitHub issues are verified before implementation, then commented
      on in the issue language with an AI-handled marker and closed when
      conclusive.
- [ ] All indexes updated (NAV, delivery README, spec README, docs README, BOARD).

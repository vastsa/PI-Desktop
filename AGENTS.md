# AGENTS.md

Mandatory rules for AI coding agents working in this repository.

## Language

Use English for code, identifiers, comments, commits, specifications, and documentation.

Follow:

* [Baseline](docs/spec/00-baseline.md)

## GitHub Issue Handling

When the user provides a GitHub issue URL (or an unambiguous issue number for
this repository), treat it as an intake gate. Do not start implementation
until the reported problem has been independently verified.

1. Fetch the issue (title, body, labels, comments, and state).
2. Decide whether the claim is real in the current codebase:
   - Bug: reproduce it, or show concrete code/spec evidence that it exists.
   - Feature or improvement: confirm the requested behavior is actually missing
     or incomplete, and in scope.
3. If the problem does **not** exist (already fixed, invalid, or a
   misunderstanding): comment on the issue with the verification evidence, mark
   the comment as AI-handled, and close the issue when the conclusion is
   clear. If verification is inconclusive, comment with what was tried and
   leave the issue open.
4. If the problem **does** exist: follow the isolated development workflow,
   implement the smallest coherent fix, merge into local `main`, then comment
   on the issue and close it.
5. Write the issue comment in the issue's language (the language of the
   original title and body). Repository docs, code, and commits stay English.
6. End every issue comment with an explicit AI-handled marker:
   - English issues: `Handled by AI.`
   - Chinese issues: `本回复由 AI 处理。`
7. An issue link authorizes commenting on and closing **that** issue. It does
   not authorize a git push. Remote publishing remains opt-in.

Do not comment on or close unrelated issues. Do not reopen a closed issue
unless the user explicitly asks.

See:

* [AI development workflow — R5](docs/spec/06-delivery/03-ai-development-workflow.md#r5--verify-linked-github-issues-before-work-then-reply-and-close)

## AI-Generated Page Content

AI-generated pages must not contain redundant explanatory text. Keep visible
copy limited to the information and actions users need to complete the task:

* Do not add filler introductions, repeated summaries, implementation notes,
  or prose that merely explains an obvious control or layout.
* Prefer concise labels, headings, helper text, and empty states; remove copy
  that does not change a user's decision or clarify a non-obvious behavior.
* Put rationale, usage guidance, and implementation detail in documentation
  or code comments, not in the page UI, unless the user explicitly requests
  explanatory content.

## Mandatory Isolated Development

Every request must use its own dedicated branch and worktree.

Before modifying any file, the agent must:

1. Update the primary checkout's local `main`
2. Create a unique branch from the updated `main`
3. Create a dedicated worktree for that branch
4. Enter the new worktree
5. Only then begin development

Example:

```bash
git switch main
git pull --ff-only
git worktree add ../worktrees/<request-id> -b <type>/<request-id> main
cd ../worktrees/<request-id>
```

Branch and worktree names must be unique and clearly associated with the request.

## Multi-Agent Isolation

To ensure multiple AI agents can work concurrently:

* Each agent must use its own branch and worktree
* Never develop directly in the primary checkout
* Never develop directly on `main`
* Never reuse another agent's branch or worktree
* Never modify files inside another request's worktree
* Never switch another agent's branch
* Never delete another agent's branch or worktree
* Never include unrelated changes from another request
* Do not commit local environment files, caches, databases, or secrets

The primary checkout is reserved for synchronizing and merging `main`.

Shared dependencies or environments may be reused only when doing so cannot modify tracked files or interfere with another worktree.

## Immutable Rules

### 1. Keep Specs Synchronized

Every behavior change must update the relevant document under `docs/spec/`.

Add an ADR under `docs/adr/` when changing architecture, public interfaces, data ownership, security boundaries, or frozen decisions.

### 2. Commit Every Logical Change

Every completed logical change must be committed.

* One logical change per commit
* No large uncommitted diffs
* No unrelated cleanup
* Leave the request worktree clean

### 3. Keep E2E Documentation Synchronized

Every user-visible or protocol-visible behavior change must add or update a scenario in:

* [E2E test plan](docs/spec/06-delivery/04-e2e-test-plan.md)

Do not run local E2E commands or manually trigger remote E2E jobs unless explicitly requested by the user.

### 4. Merge Back into Local `main`

After development:

1. Complete targeted validation
2. Review the complete diff
3. Commit all logical changes
4. Update the request branch with the latest local `main`
5. Resolve conflicts inside the request worktree
6. Return to the primary checkout
7. Merge the request branch into local `main`
8. Verify the expected commits are present
9. Remove the request worktree
10. Delete the merged request branch
11. Push only when the user explicitly requested remote publishing for the
    current request

If another agent has updated `main`, the request branch must be refreshed before merging:

```bash
git fetch
git rebase main
```

Use merge instead of rebase when repository policy requires it.

Do not overwrite, reset, or discard changes already merged by another agent.

Remote publishing is opt-in. Never infer a push from ordinary development,
commit, merge, or completion requests. When the user explicitly requests a
push, verify the remote, branch, commit set, and Git identity before publishing.
Never force-push unless the user explicitly requests that exact operation.

### 5. Clean Up the Request Worktree

Once the request branch is merged into local `main`, its worktree has no further
purpose and must be removed. Never leave a merged worktree on disk.

```bash
git worktree remove ../worktrees/<request-id>
git branch -d <type>/<request-id>
git worktree prune
```

Requirements:

* Remove the worktree only after verifying the merge commits are present in local `main`
* The worktree must be clean; commit or discard your own leftover changes first
* Use `git branch -d` (not `-D`) so an unmerged branch refuses to delete
* Delete only your own worktree and branch, never another agent's

## Development Workflow

1. Update local `main`
2. Create a unique request branch
3. Create and enter a dedicated worktree
4. Read the baseline and relevant specs
5. Identify affected specs, ADRs, E2E scenarios, and validation
6. Implement the smallest coherent change
7. Update documentation as required
8. Run targeted, risk-based checks
9. Review the complete diff
10. Commit each logical change
11. Refresh the branch against the latest local `main`
12. Merge into local `main`
13. Remove the request worktree and delete the merged branch
14. Push only when explicitly requested by the user for the current request

Development must not begin before steps 1–3 are complete.

## Marketplace and Update Diagnosis Gate

When a request concerns plugin versions, marketplace updates, or an installed
plugin showing an unexpected latest version, follow this evidence-first prompt
flow before changing application code:

1. Record the exact plugin ID, installed version, displayed latest version,
   expected release version, catalog URL, and the time of observation.
2. Fetch and parse the live catalog from the configured URL. Inspect the exact
   plugin entry and its version records; do not infer the source state from the
   renderer or from a cached response.
3. Inspect the cached catalog and installed registry separately. Classify the
   failure as one of: publisher/catalog data, remote fetch/cache fallback,
   host version comparison, IPC state propagation, or renderer presentation.
4. Run the catalog preflight before proposing an application fix:
   `node scripts/check-marketplace-catalog.mjs --url <catalog-url> --plugin <id>`.
   Missing checksum, package URL, package size, or permissions is a release
   data failure. Report it as such and do not make incomplete releases
   installable merely to hide the bad catalog.
5. Reproduce the exact case with a deterministic fixture, including unsorted
   versions and an incomplete version record, then add the narrowest regression
   test for the diagnosed layer.
6. Only after the source/cache/host/renderer boundary is identified may the
   implementation be changed. The final report must name the evidence,
   failure classification, and the validation that distinguishes the fix from
   a marketplace-data correction.

This gate is mandatory even when the symptom appears to be a simple stale UI
label. A newly published version with invalid catalog metadata must not be
treated as proof of a client regression.

## Commit Format

```text
type(scope): description
```

Allowed types:

```text
feat fix docs test chore refactor perf build ci
```

Requirements:

* English only
* Concise, imperative description
* One logical change per commit

## Stable Release Rule

Before creating a stable application version tag, update every place that states a version, not only the changelog:

```text
packages/shared/src/changelog.ts        # newest-first EN + zh-CN entries
packages/shared/src/changelog.test.ts   # newest-first version list
package.json, apps/*, packages/*, docs/ # workspace package versions
Cargo.toml, Cargo.lock                  # workspace + host-core versions
packages/shared/src/protocol.ts         # APP_VERSION
README.md, README.zh-CN.md              # current <major>.<minor>.x release line
```

Verify with the preflight before tagging; `scripts/release.mjs` runs the same check and refuses to tag while any surface disagrees:

```bash
pnpm check:release-docs
```

READMEs are release surfaces. When a release changes user-visible behavior, refresh the affected Highlights, Download, Getting started, Status, or Development claims in both locales; English is the source of truth and the Chinese file links the `docs/zh-CN/` mirrors.

See:

* [Release runbook](docs/spec/06-delivery/06-release-runbook.md#41-mandatory-release-version-surface-gate-d164--d260)

## Completion Checklist

* [ ] Local `main` was updated before development
* [ ] A unique request branch was created
* [ ] A dedicated worktree was created
* [ ] All development occurred inside that worktree
* [ ] No other agent's branch or worktree was modified
* [ ] Relevant specs and E2E scenarios were updated
* [ ] For a stable version bump: every version surface and both READMEs were updated and `node scripts/check-release-docs.mjs` passed
* [ ] Targeted validation passed or was documented as unnecessary
* [ ] No secrets, local data, or unrelated changes are included
* [ ] All logical changes were committed
* [ ] The branch was refreshed against the latest local `main`
* [ ] Changes were merged into local `main`
* [ ] The request worktree was removed after the merge
* [ ] The merged request branch was deleted
* [ ] Remote publishing was skipped unless explicitly requested
* [ ] If pushed, the remote, branch, commit set, and Git identity were verified
* [ ] If the request included a GitHub issue: the claim was verified before
      implementation; the issue was commented on in its language, marked as
      AI-handled, and closed when the outcome was conclusive

## Final Report

Report:

* Branch and worktree used
* What changed
* Documentation updated
* Validation performed or skipped
* Commit hashes and messages
* Merge result
* Worktree and branch cleanup result
* Push target and result, or confirmation that nothing was pushed
* Linked GitHub issue, verification result, comment, and close result (or N/A)

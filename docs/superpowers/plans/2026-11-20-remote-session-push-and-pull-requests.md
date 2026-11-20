# Remote Session Push, Pull Request, and Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A repository session shows where it runs, lets the user push its work branch and open a pull request, and cleans up its worktree on the remote host when the session is deleted, without ever discarding work the user was not warned about.

**Architecture:** One main-process service sits on top of the host git boot API, the GitHub connector, and the session workspace bindings. It answers status, drives the push job, creates the pull request, and owns worktree removal: at session delete, deferred when the host is offline, and as a conservative reconcile on connect. The renderer adds a bar to the conversation top bar, a pull request dialog, a delete warning, and a leftover-worktrees section in Settings.

**Tech Stack:** TypeScript (Electron main, React 19), Rust (host-core `kv`), `node --test`, `cargo test`, i18next catalogs in nine locales.

**Spec:** `docs/superpowers/specs/2026-11-20-remote-github-sessions-design.md` (Part 5, §10 calls 7 to 9). Plan 5 of 7. It consumes the "Cross-plan contract" sections of `2026-11-20-host-git-workspaces.md`, `2026-11-20-github-connector.md`, and `2026-11-20-environments-and-session-targets.md`.

## Global Constraints

- Work in the worktree and branch you were given. Do not push; the coordinator integrates.
- No SQLite schema change. No protocol version change.
- Push and Create PR never create a commit. Committing is the Agent's job.
- The remote branch on GitHub is never deleted by this feature.
- Nothing unattended discards work the user was not warned about: a forced removal happens only after an explicit warning the user confirmed; reconcile removes only worktrees with no uncommitted files and no unpushed commits.
- Worktrees that belong to another desktop installation are never touched. The host scopes `list` and `remove` by installation id; do not work around it.
- A session whose host is unreachable can still be deleted locally.
- The GitHub token never reaches the renderer.
- New logic goes in new modules. `apps/desktop/src/components/ConversationTopbar.tsx`, `apps/desktop/src/components/settings/RemoteHostsPage.tsx`, and `apps/desktop/electron/main/ipc/session-ipc.ts` gain only mount points and one call each.
- New `.ts`/`.tsx` files stay under 800 lines. All nine locale catalogs keep the English key set, with real translations.
- Do not run `pnpm install`. Stage files by explicit path. Conventional Commits, English, subject + blank line + body explaining why. No `Co-Authored-By` or `Signed-off-by`.
- Decision id for this plan: **D690**. Decision record slug: `remote-session-push-and-pull-requests`.

## Cross-plan contract

**Types** (`packages/shared/src/types/remote-sessions.ts`, added to the existing file):

```ts
type RemoteSessionGitStatus = {
  reachable: boolean;                       // false when the host is offline; the counts are then absent
  workBranch: string; baseBranch: string;
  ahead?: number; behind?: number;
  uncommittedFiles?: number; unpushedCommits?: number; pushedOnce?: boolean;
};
type RemoteSessionDeletePreflight =
  | { kind: "none" }                        // not a repository session, or no worktree yet
  | { kind: "clean" }
  | { kind: "atRisk"; uncommittedFiles: number; unpushedCommits: number }
  | { kind: "unknown" };                    // host unreachable
type LeftoverWorktree = {
  hostKey: string; sessionId: string; repository: { owner: string; name: string };
  workBranch: string; path: string; createdAt: string;
  uncommittedFiles: number; unpushedCommits: number;
};
```

**IPC channels:**

| Key | Channel | Input | Result |
| --- | --- | --- | --- |
| `remoteSessionGitStatus` | `pi-desktop/remoteSession/git/status` | `sessionId` | `{ status: RemoteSessionGitStatus }` |
| `remoteSessionPush` | `pi-desktop/remoteSession/git/push` | `sessionId` | `{ status: RemoteSessionGitStatus }` (resolves when the push job ends) |
| `remoteSessionPullRequestFind` | `pi-desktop/remoteSession/pullRequest/find` | `sessionId` | `{ pullRequest: GitHubPullRequestSummary \| null }` |
| `remoteSessionPullRequestCreate` | `pi-desktop/remoteSession/pullRequest/create` | `{ sessionId, title, body, draft }` | `{ pullRequest: GitHubPullRequestSummary }` |
| `remoteSessionDeletePreflight` | `pi-desktop/remoteSession/deletePreflight` | `sessionId` | `RemoteSessionDeletePreflight` |
| `remoteLeftoverWorktreesList` | `pi-desktop/remoteHost/leftoverWorktrees/list` | `hostKey` | `{ worktrees: LeftoverWorktree[] }` |
| `remoteLeftoverWorktreesRemove` | `pi-desktop/remoteHost/leftoverWorktrees/remove` | `{ hostKey, sessionId }` | `{ ok: boolean }` |
| event `remoteSessionPushProgress` | `pi-desktop/remoteSession/event/pushProgress` | — | `{ sessionId, phase, progress? }` |

**Local host-core RPC** (added to `rpc/remote_sessions_rpc.rs`; `kv` namespace `pendingWorkspaceRemovals`, key `<hostKey>:<sessionId>`): `sessionWorkspace.pendingRemoval.add { hostKey, sessionId, repository, workBranch }`, `.list { hostKey? }`, `.remove { hostKey, sessionId }`.

**Error codes:** `REMOTE_SESSION_NOTHING_TO_PUSH`, `REMOTE_SESSION_UNCOMMITTED_CHANGES` (informational on pull request creation when nothing is committed), `REMOTE_SESSION_NOT_REPOSITORY`.

## Review Focus

1. The user deletes a session while its host is offline: the delete succeeds locally, the warning says unpushed work cannot be checked, and the worktree is removed at the next connection, exactly once, even if the app restarts in between. Pinned in Tasks 2 and 4.
2. Two desktops use one host: reconcile and the leftover list on one desktop never show or remove the other's worktrees. Pinned in Task 4.
3. The user clicks Create PR twice, or a pull request for the branch already exists (created by the Agent through its own tools, or on GitHub): no duplicate is created; the existing one is shown. Pinned in Task 3.
4. The push fails (authentication dropped, branch protection, network): the user sees the specific reason, the bar returns to its previous state, and no pull request is created against an unpushed branch. Pinned in Task 3.
5. A session is deleted while its push is in flight, or while a turn is running on it: the running-turn refusal that exists today still applies first, and an in-flight push is cancelled before removal. Pinned in Task 5.

---

### Task 1: Shared contract

**Files:** `packages/shared/src/types/remote-sessions.ts`, `packages/shared/src/protocol.ts`, `packages/shared/src/errors.ts`, `apps/desktop/electron/main/mcp-control.ts`; tests in `packages/shared/src/protocol.test.ts` and the MCP control test.

- [ ] **Step 1: Write the failing tests:** the eight channel strings and whitelist membership; the local MCP control plane blocks `remoteSessionPush`, `remoteSessionPullRequestCreate`, and `remoteLeftoverWorktreesRemove`.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — `pnpm --filter @pi-desktop/shared build && pnpm --filter @pi-desktop/shared test` and the MCP control tests. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(shared): add the remote session push and pull request contract`

---

### Task 2: Pending removals in host-core

**Files:** create `crates/host-core/src/remote_sessions/pending_removals.rs`; modify `crates/host-core/src/rpc/remote_sessions_rpc.rs` and its tests.

**Interfaces:** `pending_removals::{add, list, remove}` over `&Database`; record `{ hostKey, sessionId, repository, workBranch, requestedAt }`.

- [ ] **Step 1: Write the failing tests:** add then list; list filtered by host; add twice is one record; remove is idempotent; records survive reopening the database.
- [ ] **Step 2: Run and see them fail** — `cargo test -p host-core --locked remote_sessions`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — same command plus `cargo fmt --check && cargo clippy -p host-core --all-targets`.
- [ ] **Step 5: Commit** — `feat(host-core): remember worktree removals owed to offline hosts`

---

### Task 3: Status, push, and pull request service

**Files:** create `apps/desktop/electron/main/remote/session-repository.ts` and `apps/desktop/test/remote-session-repository.test.mjs`.

**Interfaces:**
- Consumes: `WorkspaceGitBoot`, `GitHubConnector`, `sessionWorkspace.get` / `.update`.
- Produces:

```ts
type SessionRepositoryService = {
  status(sessionId: string): Promise<RemoteSessionGitStatus>;
  push(sessionId: string): Promise<RemoteSessionGitStatus>;
  findPullRequest(sessionId: string): Promise<GitHubPullRequestSummary | null>;
  createPullRequest(input: { sessionId: string; title: string; body: string; draft: boolean }): Promise<GitHubPullRequestSummary>;
  cancelPush(sessionId: string): Promise<void>;
};
```

Rules:

- Every method requires a binding in state `ready`; otherwise `REMOTE_SESSION_NOT_REPOSITORY` or `REMOTE_WORKSPACE_NOT_READY`.
- `status` maps a host-unreachable failure to `{ reachable: false, workBranch, baseBranch }`.
- `push` refuses with `REMOTE_SESSION_NOTHING_TO_PUSH` when `unpushedCommits` is zero and the branch was already pushed. It refreshes the host credential first, starts `git.push`, polls the job (same cadence as preparation), emits `remoteSessionPushProgress`, and resolves with fresh status. One push per session at a time; a second call joins the first.
- `createPullRequest`: validate a non-empty title of at most 256 characters; `findPullRequest` first and return an open one unchanged; if the branch has unpushed commits or was never pushed, `push` first; if after that the branch has no commits ahead of the base, refuse with `REMOTE_SESSION_NOTHING_TO_PUSH`; create with `head` = work branch and `base` = the binding's base branch; store `{ number, url }` in the binding's `pullRequest`; emit `remoteSessionWorkspaceChanged`. A push failure aborts with the push's error and creates nothing. Concurrent calls for one session join.
- `findPullRequest` also refreshes the binding's `pullRequest` when GitHub has one the binding does not.

- [ ] **Step 1: Write the failing tests** with fakes: status mapping, including unreachable; push happy path and progress events; nothing-to-push; a failed push job surfaces its error code and message; double `push` makes one host call; `createPullRequest` returns the existing open pull request without creating; pushes first when needed; refuses when the push fails; stores the pull request in the binding; double `createPullRequest` makes one create call; title validation.
- [ ] **Step 2: Run and see them fail** — `cd apps/desktop && node --test test/remote-session-repository.test.mjs`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — same command plus typecheck.
- [ ] **Step 5: Commit** — `feat(desktop): push repository sessions and open pull requests`

---

### Task 4: Removal, deferred removal, and reconcile

**Files:** create `apps/desktop/electron/main/remote/session-worktree-cleanup.ts` and `apps/desktop/test/remote-session-worktree-cleanup.test.mjs`.

**Interfaces:**

```ts
type SessionWorktreeCleanup = {
  preflight(sessionId: string): Promise<RemoteSessionDeletePreflight>;
  removeForDeletedSession(sessionId: string): Promise<void>;   // called before the session row is deleted
  onHostConnected(hostKey: string): Promise<void>;             // pending removals, then reconcile
  leftovers(hostKey: string): Promise<LeftoverWorktree[]>;
  removeLeftover(hostKey: string, sessionId: string): Promise<boolean>;
};
```

Rules:

- `preflight`: no binding or no `path` → `none`; host unreachable → `unknown`; otherwise `clean` or `atRisk` from `git.status`.
- `removeForDeletedSession`: for a `preparing` binding, delegate to `sessionWorkspaces.cancel`. For others: cancel an in-flight push; if the host is reachable, `git.remove(hostKey, sessionId, true)`; if not, `pendingRemoval.add`. Then `sessionWorkspace.remove`. A removal failure other than unreachable is logged and recorded as a pending removal; it never blocks the session delete.
- `onHostConnected`: for each pending removal of that host, `git.remove(…, true)`; on success or `WORKSPACE_GIT_NOT_FOUND`, drop the record. Then reconcile: `git.list(hostKey)`; a worktree is a candidate when no local binding exists for its session id, no pending removal exists, and it was created more than 24 hours ago. A candidate with zero uncommitted files and zero unpushed commits is removed (not forced); every other candidate is kept and reported by `leftovers`.
- `removeLeftover` is the user's explicit choice and forces.
- All host calls go through the boot API, which adds this installation's id; the host returns only this installation's worktrees.

- [ ] **Step 1: Write the failing tests** with fakes: each preflight kind; delete with a reachable host removes and clears the binding; delete with an unreachable host records a pending removal and clears the binding; `onHostConnected` processes a pending removal once, and again does nothing; a restart between (new service instance, same store) still processes it; reconcile removes an old clean orphan, keeps an old dirty orphan and lists it, ignores a recent orphan, ignores a worktree with a binding; `removeLeftover` forces; a deleted `preparing` session delegates to `cancel`.
- [ ] **Step 2: Run and see them fail** — `cd apps/desktop && node --test test/remote-session-worktree-cleanup.test.mjs`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — same command plus typecheck.
- [ ] **Step 5: Commit** — `feat(desktop): clean up remote worktrees without discarding unwarned work`

---

### Task 5: IPC and session delete integration

**Files:** create `apps/desktop/electron/main/ipc/remote-session-repository-ipc.ts`; modify `apps/desktop/electron/main/ipc/register.ts`, `apps/desktop/electron/main/ipc/session-ipc.ts` (inside `sessionDelete`, after the running-turn check and before `session.delete`, call `removeForDeletedSession`; this replaces the `preparing`-only cancel added by the previous plan), and the place that reacts to a host connecting (call `onHostConnected`); create `apps/desktop/test/remote-session-repository-ipc.test.mjs`.

- [ ] **Step 1: Write the failing tests:** each channel calls its service method with validated input; `sessionDelete` of a running session still refuses before any cleanup; `sessionDelete` of a repository session calls cleanup then `session.delete`; a cleanup that throws does not prevent the delete; a host connect calls `onHostConnected`.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — the new test, the existing `test/session-delete-*.test.mjs` files, typecheck.
- [ ] **Step 5: Commit** — `feat(desktop): expose repository session actions and clean up on delete`

---

### Task 6: Top bar and pull request dialog

**Files:** create under `apps/desktop/src/features/chat/session-repository/`: `RepositorySessionBar.tsx`, `PullRequestDialog.tsx`, `use-repository-session.ts`, `session-repository.css`; modify `apps/desktop/src/components/ConversationTopbar.tsx` (mount the bar for sessions with `remoteRepository`), `apps/desktop/src/lib/api.ts`, the nine locale catalogs; create `apps/desktop/test/repository-session-bar-user-path.test.mjs`.

Behavior: the bar shows `host · owner/repo · work branch`, an uncommitted-files count when non-zero, and the actions. **Push branch** is enabled when there are unpushed commits or the branch was never pushed and has commits; while pushing it shows the phase. **Create PR** opens the dialog (title prefilled from the session title, body empty, base shown read-only, a draft switch); after success, and whenever the binding has a pull request, the action is **View PR** and opens the URL through the existing safe external-open path. An unreachable host disables both actions with a tooltip. Status refreshes when a turn ends, when the window regains focus, and after each action; it is not polled on a timer.

English copy (keys under `sessionRepository`): `push` "Push branch"; `pushing` "Pushing…"; `createPr` "Create PR"; `viewPr` "View PR #{{number}}"; `uncommitted_one` "{{count}} uncommitted file"; `uncommitted_other` "{{count}} uncommitted files"; `hostOffline` "{{host}} is offline"; `nothingToPush` "Nothing to push yet"; `prTitle` "Title"; `prBody` "Description"; `prBase` "Base branch"; `prDraft` "Create as draft"; `prCreate` "Create pull request"; `prUncommittedNote` "Uncommitted files are not included. Ask the agent to commit them first."; `pushFailed` "Push failed: {{message}}"; `prFailed` "Could not create the pull request: {{message}}".

- [ ] **Step 1: Write the failing tests** (mocked `api`): the label; Push enabled and disabled states; a push failure shows `pushFailed` and re-enables the button; the dialog prefill; Create PR success switches to View PR; an existing pull request shows View PR on mount; the uncommitted note appears in the dialog when the count is non-zero; offline disables both.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement** with design tokens only.
- [ ] **Step 4: Run** — the new test, existing `test/conversation-topbar*.test.mjs` if present, `pnpm --filter @pi-desktop/i18n test`, typecheck, `pnpm lint`.
- [ ] **Step 5: Commit** — `feat(chat): add the repository session bar with push and pull request`

---

### Task 7: Delete warning and leftover worktrees

**Files:** create `apps/desktop/src/features/chat/session-repository/RepositorySessionDeleteDialog.tsx` and `apps/desktop/src/components/settings/LeftoverWorktreesSection.tsx`; modify the renderer's session delete entry point (find where the sidebar's delete action calls `api.deleteSession`; route repository sessions through the preflight first), `apps/desktop/src/components/settings/RemoteHostsPage.tsx` (mount the section per host), `apps/desktop/src/lib/settings-search.ts` (keywords), the nine catalogs; create `apps/desktop/test/repository-session-delete-user-path.test.mjs`.

Behavior: deleting a repository session runs the preflight. `none` and `clean` use the existing delete flow unchanged. `atRisk` shows the counts and requires confirming "Delete and discard". `unknown` says the host is offline, that unpushed work cannot be checked, and that the worktree will be removed when the host reconnects. The section lists leftovers with repository, branch, age, and counts, and a Delete action with a confirmation; it is hidden when there are none.

English copy (keys under `sessionRepository.delete` and `settings.remoteHosts.leftovers`): `atRiskTitle` "Delete this session and its work?"; `atRiskBody` "The worktree on {{host}} has {{uncommitted}} uncommitted files and {{unpushed}} unpushed commits. Deleting the session removes them."; `unknownBody` "{{host}} is offline, so unpushed work cannot be checked. The worktree will be removed when it reconnects."; `confirm` "Delete and discard"; `title` "Leftover worktrees"; `description` "Worktrees on this host that no session uses and that still hold work."; `remove` "Delete"; `removeConfirm` "Delete this worktree and its unpushed work?".

- [ ] **Step 1: Write the failing tests:** each preflight kind's path; cancel deletes nothing; the section lists and removes; it is hidden when empty.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — the new test, existing sidebar and settings tests, i18n tests, typecheck, `pnpm lint`.
- [ ] **Step 5: Commit** — `feat(chat): warn before deleting repository session work`

---

### Task 8: End-to-end acceptance

**Files:** create `scripts/e2e-remote-repo-session-push.mjs`; modify `package.json` (`test:e2e:remote-repo-session-push`), `scripts/README.md`.

Compose as `scripts/e2e-remote-repo-session.mjs` does and add a local HTTP fixture for the GitHub REST endpoints the connector uses (the connector's API client takes a `fetchImpl`). Scenario `E2E-REMOTE-repo-session-pushes-and-opens-pull-request`: prepare a session; commit in the worktree; `createPullRequest` pushes and creates, and the fixture's git repository has the work branch; a second `createPullRequest` creates nothing new; delete a session with unpushed work after a forced removal and assert the worktree and local branch are gone while the fixture's pushed branch remains. Scenario `E2E-REMOTE-offline-delete-removes-worktree-on-reconnect`: disconnect the host, delete a session, reconnect, assert the worktree is removed and the pending record is gone. Scenario `E2E-REMOTE-reconcile-keeps-worktrees-with-work`: orphan one clean and one dirty old worktree (remove their bindings and age their records), connect, assert only the clean one was removed and the dirty one is listed.

- [ ] **Step 1: Write the script.**
- [ ] **Step 2: Run** — `PI_HOST_CORE_BINARY="$PWD/target/debug/pi-desktop-host-core" pnpm test:e2e:remote-repo-session-push`. Expected: every step `ok`.
- [ ] **Step 3: Commit** — `test(e2e): cover push, pull request, and worktree cleanup`

---

### Task 9: Decision record, specs, and docs

**Files:** create `docs/adr/remote-session-push-and-pull-requests.md`; modify `docs/adr/README.md`, `docs/spec/08-meta/decisions-log.md` (D690), `docs/spec/04-ux/08-component-spec.md`, `docs/spec/04-ux/09-interaction-patterns.md` (delete warning), `docs/spec/04-ux/06-settings-ia.md` (leftover worktrees under Remote hosts), `docs/spec/03-runtime/01-ipc-protocol.md`, `docs/spec/03-runtime/08-error-codes.md`, `docs/spec/03-runtime/04-data-storage.md` (the namespace), `docs/spec/06-delivery/e2e/live-and-remote.md`, `docs/spec/06-delivery/04-e2e-test-plan.md`.

- [ ] **Step 1: Write the decision record** (`# ADR: Push, pull requests, and cleanup for repository sessions`): the desktop never commits; pull request creation is idempotent per branch; forced removal only after a confirmed warning; deferred removal for offline hosts; reconcile removes only clean, fully pushed, day-old orphans of this installation; the remote branch is never deleted. Alternatives: auto-commit before push; deleting worktrees on archive; a time-based sweep that forces.
- [ ] **Step 2: Update the specs.**
- [ ] **Step 3: Verify** — `pnpm docs:check && pnpm check:agent-policy && git diff --check`.
- [ ] **Step 4: Commit** — `docs(remote): record push, pull request, and cleanup behavior`

---

### Final gate for this plan

```bash
pnpm build:js && pnpm --filter @pi-desktop/desktop typecheck && pnpm lint
pnpm --filter @pi-desktop/shared --filter @pi-desktop/i18n test
cargo fmt --check && cargo clippy -p host-core --all-targets && cargo test -p host-core --locked
cd apps/desktop && node --test test/*.test.mjs
PI_HOST_CORE_BINARY="$PWD/../../target/debug/pi-desktop-host-core" pnpm -C ../.. test:e2e:remote-repo-session-push
PI_HOST_CORE_BINARY="$PWD/../../target/debug/pi-desktop-host-core" pnpm -C ../.. test:e2e:remote-repo-session
```

Compare desktop-suite failures against the coordinator's baseline list and report anything new with its output.

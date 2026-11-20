# Host Git Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A paired remote host can clone a GitHub repository once, give each desktop session its own git worktree and work branch, push that branch, and authenticate all git traffic through a loopback proxy that never exposes the GitHub token.

**Architecture:** A new owner-only RACP capability `workspaceGit`. `pi-host` (Node) validates and forwards its operations and runs the credential proxy; the remote host-core (Rust) owns every git invocation, the worktree registry (a `kv` namespace), long operations as pollable jobs, and the environment injected into tools that run inside a worktree. The desktop gains a `workspaceGit` section on its remote-hosts boot object; no renderer or IPC surface is added here.

**Tech Stack:** TypeScript (typebox contracts, Node `http`), Rust (tokio, rusqlite `kv`), git ≥ 2.29, vitest, `cargo test`, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-20-remote-github-sessions-design.md` (Part 2, §4, §6). Plan 2 of 7. Plans 3 to 7 consume the interfaces in "Cross-plan contract" below; do not rename them.

## Global Constraints

- Work in the worktree and branch you were given. Do not push; the coordinator integrates.
- No SQLite schema change (`SCHEMA_VERSION` stays 33). Durable state goes in the `kv` table.
- No `RACP_PROTOCOL_VERSION` change (stays `"1.0"`). No host-core `PROTOCOL_VERSION` change (stays 11).
- `workspace/toolExecute` and every other existing RACP schema stay byte-identical on the wire.
- The GitHub token never reaches host-core, a child process, a file, a log line, or a process argument list. It lives in `pi-host` memory only.
- Only `https://github.com/<owner>/<repo>.git` is ever cloned. Owner, repository, and branch names are validated before they reach git, and every git invocation separates options from operands with `--`.
- A path that is not a registered worktree behaves exactly as it does today, including an empty tool environment.
- New logic goes in new modules. `crates/host-core/src/rpc/mod.rs`, `packages/shared/src/racp.ts`, and `apps/desktop/electron/main/bootstrap/remote-hosts.ts` gain only wiring.
- New `.ts` files stay under 800 lines; new `.rs` files under 1000.
- Do not run `pnpm install`. Dependencies are installed in the primary checkout.
- Stage files by explicit path. Commit messages: Conventional Commits, English, subject + blank line + body explaining why. No `Co-Authored-By` or `Signed-off-by`.
- Decision id for this plan: **D687**. Decision record slug: `remote-git-workspaces`.

## Cross-plan contract

These names are consumed by later plans. They are fixed.

**Capability flag:** `workspaceGit` (optional boolean in `RacpServerCapabilitiesSchema`).

**RACP operations** (all `{ role: "owner", profile: "remote-host" }`):

| Operation | Params | Result | mutation |
| --- | --- | --- | --- |
| `workspace/gitCredentialSet` | `{ installationId, token }` | `{ ok: true }` | true |
| `workspace/gitCredentialClear` | `{}` | `{ ok: true }` | true |
| `workspace/gitRepository` | `{ repository }` | `{ path, cloned }` | false |
| `workspace/gitPrepare` | `{ installationId, sessionId, repository, baseBranch, environment? }` | `{ jobId }` | true |
| `workspace/gitPush` | `{ installationId, sessionId }` | `{ jobId }` | true |
| `workspace/gitJob` | `{ jobId }` | `WorkspaceGitJob` | false |
| `workspace/gitJobCancel` | `{ jobId }` | `{ ok: true }` | true |
| `workspace/gitStatus` | `{ installationId, sessionId }` | `WorkspaceGitStatus` | false |
| `workspace/gitRemove` | `{ installationId, sessionId, force }` | `WorkspaceGitRemoveResult` | true |
| `workspace/gitList` | `{ installationId }` | `{ worktrees: WorkspaceGitWorktree[] }` | false |

**Types** (exported from `@pi-desktop/shared`):

```ts
type WorkspaceGitRepository = { owner: string; name: string };
type WorkspaceGitEnvironment = {
  variables: { name: string; value: string }[];   // at most 64
  setupScript?: string;                             // at most 65536 chars
};
type WorkspaceGitWorktree = {
  sessionId: string; repository: WorkspaceGitRepository;
  baseBranch: string; workBranch: string;
  path: string; mainPath: string; baseCommit: string; createdAt: string;
  setup: { status: "none" | "running" | "ok" | "failed"; logTail?: string };
};
type WorkspaceGitJob = {
  jobId: string; kind: "prepare" | "push";
  state: "running" | "succeeded" | "failed" | "cancelled";
  phase: "queued" | "cloning" | "fetching" | "creatingWorktree" | "runningSetup" | "pushing" | "done";
  progress?: { percent?: number; detail?: string };
  worktree?: WorkspaceGitWorktree;                  // prepare, on success
  pushed?: { branch: string; remoteHead: string };  // push, on success
  error?: { code: string; message: string };
};
type WorkspaceGitStatus = {
  worktree: WorkspaceGitWorktree; ahead: number; behind: number;
  uncommittedFiles: number; unpushedCommits: number; pushedOnce: boolean;
};
type WorkspaceGitRemoveResult = { removed: boolean; uncommittedFiles: number; unpushedCommits: number };
```

**Error codes** (registered in the shared error registry and the RACP error table, not retriable): `WORKSPACE_GIT_UNAVAILABLE`, `WORKSPACE_GIT_AUTH_REQUIRED`, `WORKSPACE_GIT_REPOSITORY_NOT_FOUND`, `WORKSPACE_GIT_BRANCH_NOT_FOUND`, `WORKSPACE_GIT_NOT_FOUND`, `WORKSPACE_GIT_BUSY`, `WORKSPACE_GIT_JOB_NOT_FOUND`, `WORKSPACE_GIT_FAILED`, `WORKSPACE_GIT_TRANSPORT_REFUSED`.

**Work branch:** `pi-desktop/<id>` where `<id>` is the first 12 lowercase hex characters of `SHA-256(installationId + "\n" + sessionId)`. `pi-host` (TypeScript) and host-core (Rust) both compute it. Test vector: installation `00000000-0000-4000-8000-000000000000`, session `session-1` gives id `8b54618f6bc1`. Both test suites pin that literal.

**Host layout:** `<workspacesRoot>/repos/github.com/<owner>/<repo>` (main checkout) and `<workspacesRoot>/worktrees/github.com/<owner>/<repo>/<id>` (session worktree, same `<id>` as the branch). `workspacesRoot` defaults to `~/pi-workspaces`.

**Desktop boot API** (added to `RemoteHostsBoot` as `workspaceGit`):

```ts
type WorkspaceGitBoot = {
  setCredentialProvider(provider: (() => Promise<string | null>) | null): void;
  refreshCredential(): Promise<void>;                       // push or clear on every connected capable host
  supported(hostKey: string): Promise<boolean>;             // realigns once when the capability is missing
  repository(hostKey: string, repository: WorkspaceGitRepository): Promise<{ path: string; cloned: boolean }>;
  prepare(hostKey: string, input: { sessionId: string; repository: WorkspaceGitRepository; baseBranch: string; environment?: WorkspaceGitEnvironment }): Promise<{ jobId: string }>;
  push(hostKey: string, sessionId: string): Promise<{ jobId: string }>;
  job(hostKey: string, jobId: string): Promise<WorkspaceGitJob>;
  cancelJob(hostKey: string, jobId: string): Promise<void>;
  status(hostKey: string, sessionId: string): Promise<WorkspaceGitStatus>;
  remove(hostKey: string, sessionId: string, force: boolean): Promise<WorkspaceGitRemoveResult>;
  list(hostKey: string): Promise<WorkspaceGitWorktree[]>;
};
```

The boot object adds `installationId` itself; callers never pass it.

## Review Focus

1. A repository or branch name crafted to look like an option or a path (`--upload-pack=x`, `../../etc`, `a..b`, a trailing `.lock`, control characters): every layer must reject it before git runs, and no directory outside `workspacesRoot` is ever created. Pinned in Tasks 1 and 3.
2. The desktop disconnects, or `pi-host` restarts, while a session still has a worktree: git through the old handle must fail closed with an authentication error, never hang and never reach GitHub with a stale token. Pinned in Task 9.
3. A push names a ref other than the session's work branch (another branch, a tag, a delete of the base branch, several refs in one push where only one is foreign): the proxy must refuse the whole request before any byte of it reaches GitHub. Pinned in Task 9.
4. `gitPrepare` is called twice for the same session (retry after a lost reply, or a double click): the second call must return the existing worktree, not create a second one or fail. A `gitPrepare` for a session whose job is still running must report `WORKSPACE_GIT_BUSY`. Pinned in Task 6.
5. A clone is interrupted (cancel, host restart, disk full): the next prepare must succeed, with no half-cloned directory left where the main checkout belongs. Pinned in Task 5.

---

### Task 1: Shared contract

**Files:**
- Create: `packages/shared/src/racp-workspace-git.ts`
- Create: `packages/shared/src/racp-workspace-git.test.ts`
- Modify: `packages/shared/src/racp.ts` (capability flag near line 480; ten rows in `RACP_OPERATIONS` after `workspace/pluginFiles`; error table near line 852; re-export)
- Modify: `packages/shared/src/errors.ts` (nine codes, next to `REMOTE_PATH_NOT_FOUND`)
- Modify: `packages/shared/src/index.ts` (export the new module)
- Modify: `packages/shared/fixtures/racp.schema.json` (regenerated snapshot)
- Test: `packages/shared/src/racp.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: everything under "Cross-plan contract", plus these exports from `racp-workspace-git.ts`:
  - typebox schemas, each a closed object: `WorkspaceGitCredentialSetSchema`, `WorkspaceGitRepositoryRequestSchema`, `WorkspaceGitPrepareSchema`, `WorkspaceGitSessionRefSchema` (`{ installationId, sessionId }`, used by push and status), `WorkspaceGitRemoveSchema`, `WorkspaceGitJobRefSchema`, `WorkspaceGitListSchema`
  - `isGitHubOwner(value: string): boolean` — 1 to 39 characters of `[A-Za-z0-9-]`, not starting or ending with `-`
  - `isGitHubRepositoryName(value: string): boolean` — 1 to 100 characters of `[A-Za-z0-9._-]`, not `.` or `..`, not ending in `.git`
  - `isGitBranchName(value: string): boolean` — 1 to 244 characters of `[A-Za-z0-9._/@+-]`; rejects a leading `-` or `/`, a trailing `/`, `.`, or `.lock`, and any of `..`, `//`, `@{`, `/.`
  - `isEnvironmentVariableName(value: string): boolean` — `^[A-Za-z_][A-Za-z0-9_]{0,127}$`, and not one of `PATH HOME SHELL USER LOGNAME PWD OLDPWD IFS ENV BASH_ENV PROMPT_COMMAND NODE_OPTIONS ELECTRON_RUN_AS_NODE`, and not starting with `GIT_ PI_ LD_ DYLD_ BASH_FUNC_`

Field limits: `installationId` is a UUID string; `sessionId` 1 to 256 characters; `token` 1 to 4096 characters with no control characters; variable `value` at most 8192 characters; `jobId` 1 to 64 characters.

- [ ] **Step 1: Write the failing tests**

In `racp-workspace-git.test.ts`, one `describe` per validator with accept and reject tables. The reject tables must include, for owners `"-a"`, `"a-"`, `""`, `"a/b"`, a 40-character name; for repository names `"."`, `".."`, `"a/b"`, `"repo.git"`, `"--upload-pack=x"`; for branches `"-x"`, `"/a"`, `"a/"`, `"a..b"`, `"a//b"`, `"a@{b"`, `"a/.b"`, `"a.lock"`, `"a b"`, `"a\u0000b"`; for variable names `"PATH"`, `"GIT_DIR"`, `"PI_PORT"`, `"LD_PRELOAD"`, `"1A"`, `"A-B"`. Accept tables include `"main"`, `"feature/x-1"`, `"release/1.2"`, `"my_var"`.

Add:

```ts
it("rejects unknown fields and bad names at the schema boundary", () => {
  const good = { installationId: "00000000-0000-4000-8000-000000000000", sessionId: "s", repository: { owner: "o", name: "r" }, baseBranch: "main" };
  expect(Value.Check(WorkspaceGitPrepareSchema, good)).toBe(true);
  expect(Value.Check(WorkspaceGitPrepareSchema, { ...good, extra: 1 })).toBe(false);
  expect(Value.Check(WorkspaceGitPrepareSchema, { ...good, baseBranch: "-x" })).toBe(false);
  expect(Value.Check(WorkspaceGitPrepareSchema, { ...good, repository: { owner: "o", name: ".." } })).toBe(false);
});
```

In `racp.test.ts`, extend the catalog test: all ten operations exist with `role: "owner"` and `profile: "remote-host"`, and `RacpServerCapabilitiesSchema` accepts `workspaceGit: true`.

- [ ] **Step 2: Run and see them fail**

Run: `pnpm --filter @pi-desktop/shared exec vitest run src/racp-workspace-git.test.ts src/racp.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Schemas use typebox `pattern` for the character classes; each validator is the single place the extra rules live, and handlers in Task 2 call the validators after `check`. This module must stay free of Node-only imports: the renderer imports this package. The work-branch derivation needs SHA-256 and therefore lives in `pi-host` (Task 8) and host-core (Task 3), not here.

- [ ] **Step 4: Regenerate the fixture and run**

Run: `pnpm --filter @pi-desktop/shared exec vitest run src/racp.test.ts -u`, review the diff of `fixtures/racp.schema.json` (only the new capability and schemas), then run `pnpm --filter @pi-desktop/shared build && pnpm --filter @pi-desktop/shared test`.
Expected: PASS.

- [ ] **Step 5: Commit** — `feat(shared): add the workspaceGit remote-host contract`

---

### Task 2: RACP server routing

**Files:**
- Modify: `packages/racp/src/host-operations.ts` (interface member after `workspaceTools`)
- Modify: `packages/racp/src/server.ts` (capability flag in the constructor near line 170; cleanup in `release` near line 260)
- Modify: `packages/racp/src/operations.ts` (helper and handlers after the `workspace/toolShell` handler)
- Test: `packages/racp/src/racp.test.ts`

**Interfaces:**
- Consumes: Task 1 schemas and validators.
- Produces, in `RacpHostOperations`:

```ts
workspaceGit?: {
  setCredential(input: { installationId: string; token: string }, owner: { deviceId: string; connectionId: string }): Promise<void>;
  clearCredential(owner: { deviceId: string; connectionId: string }): Promise<void>;
  repository(input: { repository: WorkspaceGitRepository }): Promise<{ path: string; cloned: boolean }>;
  prepare(input: Static<typeof WorkspaceGitPrepareSchema>, owner: { deviceId: string; connectionId: string }): Promise<{ jobId: string }>;
  push(input: { installationId: string; sessionId: string }, owner: { deviceId: string; connectionId: string }): Promise<{ jobId: string }>;
  job(input: { jobId: string }): Promise<WorkspaceGitJob>;
  cancelJob(input: { jobId: string }): Promise<void>;
  status(input: { installationId: string; sessionId: string }): Promise<WorkspaceGitStatus>;
  remove(input: { installationId: string; sessionId: string; force: boolean }): Promise<WorkspaceGitRemoveResult>;
  list(input: { installationId: string }): Promise<WorkspaceGitWorktree[]>;
  disconnect(connectionId: string): Promise<void>;
};
```

- [ ] **Step 1: Write the failing tests**

Model them on the existing "owner-only workspace tool boundary" block (around line 420): with a fake `workspaceGit`, the handshake advertises `workspaceGit: true`; an owner call to `workspace/gitPrepare` reaches the fake with the validated input and the owner; a viewer gets `FORBIDDEN`; a server built without the service answers `CAPABILITY_UNAVAILABLE` and advertises `workspaceGit: false`; a request with an extra field or with `baseBranch: "-x"` is rejected as `INVALID_ARGUMENT` and never reaches the fake; closing the socket calls `disconnect(connectionId)`.

- [ ] **Step 2: Run and see them fail**

Run: `pnpm --filter @pi-desktop/racp exec vitest run src/racp.test.ts`
Expected: FAIL, `METHOD_NOT_FOUND` or missing capability.

- [ ] **Step 3: Implement**

`requireWorkspaceGit(context)` mirrors `requireWorkspaceTools`. Each handler runs `check(schema, params)`, then the Task 1 validators on owner, repository name, branch, and every variable name, throwing `RacpError("INVALID_ARGUMENT", …)` on a miss. Void operations return `{ ok: true }`; `gitList` returns `{ worktrees }`.

- [ ] **Step 4: Run** — `pnpm --filter @pi-desktop/racp test`. Expected: PASS.

- [ ] **Step 5: Commit** — `feat(racp): route the owner-only workspaceGit operations`

---

### Task 3: host-core layout, validation, and registry

**Files:**
- Create: `crates/host-core/src/workspace_git/mod.rs` (module root, `WorkspaceGitError { code: &'static str, message: String }`)
- Create: `crates/host-core/src/workspace_git/layout.rs`
- Create: `crates/host-core/src/workspace_git/registry.rs`
- Modify: `crates/host-core/src/main.rs` (declare `mod workspace_git;`)
- Modify: `crates/host-core/src/db/repositories.rs` (add `kv_entries` next to `kv_delete`)

**Interfaces:**
- Consumes: the work-branch test vector from "Cross-plan contract".
- Produces:
  - `Database::kv_entries(&self, ns: &str) -> Result<Vec<(String, Value)>>` — ordered by key
  - `layout::Repository { owner: String, name: String }` with `Repository::parse(owner: &str, name: &str) -> Result<Repository, WorkspaceGitError>` applying the Task 1 rules
  - `layout::validate_branch(name: &str) -> Result<(), WorkspaceGitError>`
  - `layout::validate_variable_name(name: &str) -> Result<(), WorkspaceGitError>`
  - `layout::short_id(installation_id: &str, session_id: &str) -> String`
  - `layout::work_branch(installation_id: &str, session_id: &str) -> String`
  - `layout::Layout::new(workspaces_root: &Path) -> Result<Layout, WorkspaceGitError>` — root must be absolute; `main_path(&Repository) -> PathBuf`; `worktree_path(&Repository, short_id: &str) -> PathBuf`; `clone_url(&Repository) -> String` returning `https://github.com/<owner>/<repo>.git`
  - `registry::WorktreeRecord` (serde, camelCase): `installation_id, session_id, repository, base_branch, work_branch, path, main_path, base_commit, created_at, variables: Vec<Variable>, setup_script: Option<String>, setup_status, setup_log_tail: Option<String>`
  - `registry::{insert, get, remove, list_for_installation, find_by_path, set_setup}` over `&Database`; namespace `workspaceGitWorktrees`, key `<installationId>:<sessionId>`. `find_by_path(db, root: &Path)` returns the record whose `path` equals `root` or is an ancestor of it.

- [ ] **Step 1: Write the failing tests** (in each file's `#[cfg(test)]` module)

- `layout`: the same accept and reject tables as Task 1 (copy the values); `short_id("00000000-0000-4000-8000-000000000000", "session-1")` equals `"8b54618f6bc1"`; `main_path` and `worktree_path` stay under the root for every accepted name; `Layout::new` rejects a relative root.
- `registry`: round trip through a temporary database; `list_for_installation` returns only that installation's records; `find_by_path` matches the worktree root and a nested directory, and does not match a sibling whose name merely starts with the same characters (`…/abc` versus `…/abcd`).
- `kv_entries`: returns entries of one namespace only, ordered.

- [ ] **Step 2: Run and see them fail** — `cargo test -p host-core --locked workspace_git`. Expected: compile errors for the missing items.

- [ ] **Step 3: Implement.** Error codes come from the "Cross-plan contract" list; validation failures use `INVALID_ARGUMENT`.

- [ ] **Step 4: Run** — `cargo test -p host-core --locked workspace_git && cargo fmt --check && cargo clippy -p host-core --all-targets`. Expected: PASS, no new warnings.

- [ ] **Step 5: Commit** — `feat(host-core): add workspace git layout and registry`

---

### Task 4: A network variant of the git runner

**Files:**
- Modify: `crates/host-core/src/session_worktrees/git.rs`
- Modify: `crates/host-core/src/session_worktrees/mod.rs` (make `repo_lock` `pub(crate)`)

**Interfaces:**
- Produces: `GitRunner::run_network(&self, dir: &Path, config: &[(&str, &str)], args: &[&str], timeout: Duration) -> Result<GitOutput, GitError>`

The existing runner removes `GIT_CONFIG_COUNT` and `GIT_CONFIG_PARAMETERS` from the environment so inherited configuration cannot redirect git, and has a fixed 120-second limit. The network variant keeps that removal and every existing safety flag, then sets `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`, and `GIT_CONFIG_VALUE_<n>` from `config` on the child only. Configuration is passed through the environment, not `-c`, because a process's argument list is readable by other local users and the value carries the proxy handle.

- [ ] **Step 1: Write the failing tests** using `GitRunner::with_program` and a stub script that prints its arguments and environment: the child sees the two supplied keys and no `-c` argument containing them; an inherited `GIT_CONFIG_COUNT=7` in the parent is not visible; the hook and fsmonitor flags are still present; a child that sleeps past the given timeout yields `GitError` with the timeout code within the timeout plus two seconds.

- [ ] **Step 2: Run and see them fail** — `cargo test -p host-core --locked session_worktrees::git`.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** — `cargo test -p host-core --locked session_worktrees`. Expected: PASS, including every existing test in the module.

- [ ] **Step 5: Commit** — `feat(host-core): add a network variant to the git runner`

---

### Task 5: Repository and worktree operations

**Files:**
- Create: `crates/host-core/src/workspace_git/repository.rs`
- Create: `crates/host-core/src/workspace_git/worktree.rs`

**Interfaces:**
- Consumes: Tasks 3 and 4.
- Produces:
  - `repository::NetworkContext<'a> { git: &'a GitRunner, config: &'a [(&'a str, &'a str)] }`
  - `repository::ensure(ctx: &NetworkContext<'_>, remote_url: &str, main_path: &Path, on_phase: &dyn Fn(Phase)) -> Result<(), WorkspaceGitError>` — clones when `main_path` is absent, fetches with `--prune` otherwise. `Phase` is `Cloning | Fetching`.
  - `worktree::create(git: &GitRunner, main_path: &Path, worktree_path: &Path, work_branch: &str, base_branch: &str) -> Result<String /* base commit */, WorkspaceGitError>`
  - `worktree::status(git: &GitRunner, worktree_path: &Path, work_branch: &str) -> Result<StatusCounts, WorkspaceGitError>` with `StatusCounts { ahead, behind, uncommitted_files, unpushed_commits, pushed_once }`
  - `worktree::remove(git: &GitRunner, main_path: &Path, worktree_path: &Path, work_branch: &str) -> Result<(), WorkspaceGitError>`
  - `worktree::push(ctx: &NetworkContext<'_>, worktree_path: &Path, work_branch: &str) -> Result<String /* remote head */, WorkspaceGitError>`

Behavior the tests fix:

- Clone goes to a sibling temporary directory (`<main_path>.cloning-<random>`) and is renamed into place only on success; a leftover temporary directory from an earlier attempt is removed first. Timeout 60 minutes for clone, 30 for fetch and push.
- All repository-changing steps hold `session_worktrees::repo_lock::lock` on the main checkout's git directory.
- `create` fails with `WORKSPACE_GIT_BRANCH_NOT_FOUND` when `refs/remotes/origin/<base>` does not exist, runs `git worktree add -q -b <work> -- <path> refs/remotes/origin/<base>`, locks the worktree, and writes `branch.<work>.remote = origin` and `branch.<work>.merge = refs/heads/<work>` so a bare `git push` inside the worktree targets the work branch.
- `status`: `uncommitted_files` counts `git status --porcelain=v1 -z` entries; `unpushed_commits` counts `git rev-list --count <work> --not --remotes=origin`; `pushed_once` is whether `refs/remotes/origin/<work>` exists; `ahead` and `behind` are relative to it and are zero when it does not exist.
- `remove` reuses `session_worktrees::remove::remove_worktree` (build a `WorktreeRow` in memory) and deletes the local work branch.
- An authentication failure from git (HTTP 401 or 403 in stderr) maps to `WORKSPACE_GIT_AUTH_REQUIRED`; "repository not found" to `WORKSPACE_GIT_REPOSITORY_NOT_FOUND`; a missing git or a version below 2.29 to `WORKSPACE_GIT_UNAVAILABLE`; anything else to `WORKSPACE_GIT_FAILED` with the last 2 KiB of stderr.

- [ ] **Step 1: Write the failing tests.** Each test builds a local bare repository in a temporary directory with two branches and uses its `file://` URL as `remote_url`. Cover: first `ensure` clones, second fetches a commit added to the remote; a pre-existing `<main_path>.cloning-*` directory does not break `ensure` and is gone afterwards; `create` yields a worktree on the work branch at the base commit, and a second worktree from a different base branch coexists; `create` on a missing base reports `WORKSPACE_GIT_BRANCH_NOT_FOUND` and leaves no directory; `status` before and after a commit, after a push, and with an untracked file; `push` then `status` shows `pushed_once` and zero unpushed; `remove` deletes directory and branch and leaves the other worktree intact.

- [ ] **Step 2: Run and see them fail** — `cargo test -p host-core --locked workspace_git`.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** — `cargo test -p host-core --locked workspace_git && cargo clippy -p host-core --all-targets`. Expected: PASS.

- [ ] **Step 5: Commit** — `feat(host-core): clone repositories and manage session worktrees`

---

### Task 6: Jobs, setup script, and the RPC surface

**Files:**
- Create: `crates/host-core/src/workspace_git/jobs.rs`
- Create: `crates/host-core/src/workspace_git/setup.rs`
- Create: `crates/host-core/src/rpc/workspace_git_rpc.rs`
- Create: `crates/host-core/src/rpc/workspace_git_rpc_tests.rs`
- Modify: `crates/host-core/src/rpc/mod.rs` (`mod workspace_git_rpc;`, test module declaration, one dispatch arm `method if method.starts_with("workspaceGit.")`)
- Modify: `crates/host-core/src/state.rs` (one field: the job table)

**Interfaces:**
- Consumes: Tasks 3 to 5.
- Produces host-core RPC methods. Every method takes `workspacesRoot: string`; the network ones also take `gitProxy: { url: string }`, where `url` is `http://127.0.0.1:<port>/<handle>/`.
  - `workspaceGit.repository { workspacesRoot, repository }` → `{ path, cloned }`
  - `workspaceGit.prepare { workspacesRoot, gitProxy, installationId, sessionId, repository, baseBranch, environment? }` → `{ jobId }`
  - `workspaceGit.push { workspacesRoot, gitProxy, installationId, sessionId }` → `{ jobId }`
  - `workspaceGit.job { jobId }` → `WorkspaceGitJob`
  - `workspaceGit.jobCancel { jobId }` → `{ ok: true }`
  - `workspaceGit.status { installationId, sessionId }` → `WorkspaceGitStatus`
  - `workspaceGit.remove { installationId, sessionId, force }` → `WorkspaceGitRemoveResult`
  - `workspaceGit.list { installationId }` → `{ worktrees }`

Rules:

- The per-command git configuration for network operations is one pair: key `url.<gitProxy.url><owner>/<repo>.git.insteadOf`, value `https://github.com/<owner>/<repo>.git`.
- Jobs run as tokio tasks and are polled; no RPC waits on git. The table keeps at most 64 finished jobs for 10 minutes. `job` and `jobCancel` on an unknown id return `WORKSPACE_GIT_JOB_NOT_FOUND`.
- `prepare` for a session that already has a registry record whose directory exists returns a job that is already `succeeded` with that worktree. `prepare` or `push` while a job for the same `(installationId, sessionId)` is running returns `WORKSPACE_GIT_BUSY`.
- Cancelling a prepare aborts the running git process and removes a partly created worktree and its branch; the main checkout stays.
- After the worktree exists, when `environment.setupScript` is non-empty, the job enters `runningSetup` and runs the script as a Bash tool call with the worktree as root (the same call `session_worktrees::lifecycle::run_setup` makes), a 30-minute limit, and the environment from Task 7. The record's setup status becomes `ok` or `failed` with the last 16 KiB of output. A failed script does not fail the job.
- `remove` returns `removed: false` with the counts when either count is non-zero and `force` is false. With no record it returns `WORKSPACE_GIT_NOT_FOUND`.
- `status`, `remove`, `list`, `push` read the worktree path from the registry; they never take a path from the caller.

- [ ] **Step 1: Write the failing tests** in `workspace_git_rpc_tests.rs`, driving the RPC handler against a temporary database and a local bare repository. The handler takes the remote URL from `Layout::clone_url`; tests substitute it through a test-only constructor of the handler context (`WorkspaceGitContext::with_remote_base(base: &str)`), never through an RPC parameter. Cover: prepare to success through polling, with phases observed in order; idempotent second prepare; `WORKSPACE_GIT_BUSY`; cancel during clone leaves no worktree and a later prepare succeeds; setup script success and failure both end `succeeded` with the right setup status; push job result; remove refusing with counts, then succeeding with `force`; list scoped to the installation; unknown job id; a repository name of `..` is rejected before any directory is created.

- [ ] **Step 2: Run and see them fail** — `cargo test -p host-core --locked workspace_git_rpc`.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** — `cargo test -p host-core --locked && cargo fmt --check && cargo clippy -p host-core --all-targets`. Expected: PASS. Then `node scripts/check-architecture.mjs`; expected: no new violation.

- [ ] **Step 5: Commit** — `feat(host-core): run workspace git operations as pollable jobs`

---

### Task 7: Tool environment inside a worktree

**Files:**
- Create: `crates/host-core/src/workspace_git/environment.rs`
- Modify: `crates/host-core/src/rpc/remote_tools.rs` (the `tools.workspaceExecute` branch: replace the hard-coded empty `extra_env`, around line 343)
- Test: `crates/host-core/src/rpc/remote_tools_tests.rs`

**Interfaces:**
- Consumes: Task 3 registry.
- Produces: `environment::for_tool(db: &Database, root: &Path, git_proxy_url: Option<&str>) -> Vec<(String, String)>`. `tools.workspaceExecute` accepts one new optional parameter, `gitProxyUrl: string`, read and removed from the params before they are deserialized into `ToolsExecuteParams`.

For a root inside a registered worktree the result is, in order: the record's variables; `PI_WORKTREE_ROOT`; `PI_PROJECT_ROOT` (the main checkout); and, only when `git_proxy_url` is given, `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0`, `GIT_CONFIG_VALUE_0` (the same pair as Task 6). For any other root the result is empty, whatever `gitProxyUrl` says.

- [ ] **Step 1: Write the failing tests:** a Bash call through `tools.workspaceExecute` in a registered worktree sees a registered variable and `PI_WORKTREE_ROOT`; with `gitProxyUrl` it also sees the git configuration pair; in an unregistered directory it sees none of them even when `gitProxyUrl` is sent; a record whose stored variable has a now-forbidden name is skipped, not injected.

- [ ] **Step 2: Run and see them fail** — `cargo test -p host-core --locked remote_tools`.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** — `cargo test -p host-core --locked remote_tools workspace_git`. Expected: PASS, including the existing remote tool tests unchanged.

- [ ] **Step 5: Commit** — `feat(host-core): inject the worktree environment into remote tools`

---

### Task 8: pi-host operations

**Files:**
- Modify: `apps/pi-host/src/config.ts` (`workspacesRoot`)
- Create: `apps/pi-host/src/workspace-git.ts`
- Create: `apps/pi-host/src/workspace-git.test.ts`
- Modify: `apps/pi-host/src/host-operations.ts` (wire `workspaceGit`)
- Modify: `apps/pi-host/src/workspace-tools.ts` (pass `gitProxyUrl`)
- Modify: `apps/pi-host/src/app.ts` (construct the proxy and pass the new dependencies)
- Test: `apps/pi-host/src/config.test.ts`, `apps/pi-host/src/workspace-tools.test.ts`

**Interfaces:**
- Consumes: Task 2 interface, Task 6 RPC, Task 9 `GitCredentialProxy` (use its interface; Task 9 implements it).
- Produces:
  - `PiHostConfig.workspacesRoot: string` — flag `--workspaces-root`, environment `PI_HOST_WORKSPACES_ROOT`, default `join(homedir(), "pi-workspaces")`. `resolveConfig` throws `INVALID_ARGUMENT` unless it is inside `browseRoot` and outside `dataDir`.
  - `createWorkspaceGit(deps: { getHost: () => HostRpc | null; workspacesRoot: string; proxy: GitCredentialProxy }): NonNullable<RacpHostOperations["workspaceGit"]> & { proxyUrlFor(connectionId: string, sessionId: string): string | undefined }`
  - `createWorkspaceTools(getHost, options?: { gitProxyUrlFor?: (connectionId: string, sessionId: string) => string | undefined })`
  - `workspaceGitShortId(installationId: string, sessionId: string): string` and `workspaceGitWorkBranch(installationId: string, sessionId: string): string`, exported from `workspace-git.ts`, using `node:crypto`. The test pins `workspaceGitShortId("00000000-0000-4000-8000-000000000000", "session-1") === "8b54618f6bc1"`.

Behavior:

- `setCredential` records `connectionId → installationId`, hands the token to the proxy for that installation, then asks host-core for `workspaceGit.list` and registers a proxy scope for every existing worktree of that installation.
- `prepare` and `push` register a proxy scope for `(installationId, sessionId)` (repository plus `workspaceGitWorkBranch`) and call host-core with `workspacesRoot` and `gitProxy.url` for that scope.
- `clearCredential` and `disconnect` drop the connection's token. A token stays only while at least one live connection that set it remains.
- `remove`, after host-core reports `removed: true`, drops the scope.
- `workspace-tools.ts` passes `gitProxyUrl` to `tools.workspaceExecute` only when `gitProxyUrlFor(owner.connectionId, input.sessionId)` returns one. Note that it forwards a hashed session id to host-core today; the lookup uses the raw `input.sessionId`.
- A host-core restart (`getHost()` identity changes) yields `AGENT_UNAVAILABLE`, as in `workspace-tools.ts`.

- [ ] **Step 1: Write the failing tests** with a fake `HostRpc` and a fake proxy that records calls: the config rule (default, inside-browse-root, outside-data-dir); every operation forwards `workspacesRoot`; prepare registers the scope before calling host-core and passes its URL; `setCredential` registers scopes for listed worktrees; `disconnect` of the only connection clears the token, and of one of two does not; `workspace-tools` adds `gitProxyUrl` for a scoped session and omits it otherwise, and the existing tool tests pass unchanged.

- [ ] **Step 2: Run and see them fail** — `pnpm --filter @pi-desktop/pi-host exec vitest run src/workspace-git.test.ts src/config.test.ts src/workspace-tools.test.ts`.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** — `pnpm --filter @pi-desktop/pi-host build && pnpm --filter @pi-desktop/pi-host test`. Expected: PASS.

- [ ] **Step 5: Commit** — `feat(pi-host): serve workspace git operations`

---

### Task 9: Credential proxy

**Files:**
- Create: `apps/pi-host/src/git-credential-proxy.ts`
- Create: `apps/pi-host/src/git-credential-proxy.test.ts`
- Create: `apps/pi-host/src/git-receive-pack.ts` (the ref-update parser)
- Create: `apps/pi-host/src/git-receive-pack.test.ts`

**Interfaces:**
- Produces:

```ts
type GitProxyScope = { installationId: string; sessionId: string; repository: WorkspaceGitRepository; workBranch: string };
type GitCredentialProxy = {
  start(): Promise<void>;                                   // binds 127.0.0.1 on a free port
  close(): Promise<void>;
  setToken(installationId: string, token: string | null): void;
  register(scope: GitProxyScope): string;                   // returns http://127.0.0.1:<port>/<handle>/ ; same scope, same handle
  unregister(installationId: string, sessionId: string): void;
};
function createGitCredentialProxy(options?: { upstream?: string; log?: (level: "info" | "warn", message: string, data?: unknown) => void }): GitCredentialProxy;
function parseReceivePackCommands(prefix: Buffer): { complete: boolean; refs: string[] };
```

`upstream` defaults to `https://github.com` and is settable only through this constructor argument. `config.ts` and `cli.ts` must not expose it.

Rules:

- The handle is 32 random bytes, hex. An unknown handle answers 404 with no upstream request.
- A request under a known handle whose path is `/<owner>/<repo>.git/…` for the scope's repository is the **scoped** case. With a token for the scope's installation, it is forwarded with `Authorization: Basic base64("x-access-token:" + token)`. Without one it answers 401 and makes no upstream request.
- Any other path under a known handle is forwarded with no credentials.
- A scoped `POST …/git-receive-pack` is inspected first: the proxy reads the command section (pkt-lines up to the first flush packet), bounded at 64 KiB, decoding a `Content-Encoding: gzip` body. Every command must name `refs/heads/<workBranch>`. If any does not, or the section does not complete within the bound, the proxy answers 403 with a one-line reason and makes no upstream request. Otherwise it forwards the buffered prefix followed by the rest of the stream.
- Inbound `Authorization`, `Cookie`, and `Proxy-Authorization` headers are never forwarded. The token and the handle never appear in a log line; logs carry the scope's session id.
- Responses stream through. The proxy sets no timeout shorter than git's own.

- [ ] **Step 1: Write the failing tests.** For the parser: a single command with capabilities after the NUL, several commands, a delete (all-zero new id), an incomplete prefix (`complete: false`), a malformed length. For the proxy, against a local `http` server standing in for the upstream that records what it receives: scoped fetch carries the basic credential; scoped request with no token answers 401 and the upstream sees nothing; after `setToken(id, null)` the same request answers 401; unknown handle answers 404; a different repository under a valid handle is forwarded without `Authorization`; a client-supplied `Authorization` header is not forwarded; a push to the work branch is forwarded intact (compare the upstream's received body byte for byte); a push to another branch, a push mixing the work branch with a tag, and a gzip-encoded foreign push all answer 403 with nothing reaching the upstream; `register` twice for one scope returns the same URL; `unregister` makes the handle 404.

- [ ] **Step 2: Run and see them fail** — `pnpm --filter @pi-desktop/pi-host exec vitest run src/git-credential-proxy.test.ts src/git-receive-pack.test.ts`.

- [ ] **Step 3: Implement** with `node:http` and `node:https` only; no new dependency.

- [ ] **Step 4: Run** — `pnpm --filter @pi-desktop/pi-host test`. Expected: PASS.

- [ ] **Step 5: Commit** — `feat(pi-host): proxy git credentials on loopback`

---

### Task 10: Desktop boot API

**Files:**
- Create: `apps/desktop/electron/main/remote/workspace-git-boot.ts`
- Modify: `apps/desktop/electron/main/remote/racp-remote-host-client.ts` (capability type near line 110, `workspaceCapabilities`, the per-method gate near line 218)
- Modify: `apps/desktop/electron/main/bootstrap/remote-hosts.ts` (options, `RemoteHostsBoot.workspaceGit`, a hook after a host connects)
- Create: `apps/desktop/test/remote-workspace-git-boot.test.mjs`
- Test: `apps/desktop/test/racp-remote-host-client.test.mjs`

**Interfaces:**
- Consumes: the RACP operations.
- Produces: `WorkspaceGitBoot` exactly as in "Cross-plan contract", built by `createWorkspaceGitBoot(deps)` where `deps` is `{ connectedHost(hostKey), ensureReady(hostKey), realign(hostKey): Promise<boolean>, record(hostKey): RemoteHostRecord | undefined, getInstallationId(): Promise<string>, log }`. `BootRemoteHostsOptions` gains `getInstallationId?: () => Promise<string>`.

Rules:

- `RemoteWorkspaceCapabilities` gains `workspaceGit: boolean`. `assertWorkspaceCapabilities` is unchanged: a host without `workspaceGit` still connects and serves folder projects.
- The client gate refuses the ten `workspace/git*` methods with `HOST_VERSION_MISMATCH` when the connected host does not advertise the capability.
- `supported(hostKey)` returns true when advertised. When not, it runs the existing realignment once for that host and desktop release, reconnects, and reports the result. It never loops.
- Every call uses a 30-second request timeout. Nothing here waits on a job; callers poll `job`.
- Credential refusal: before sending `workspace/gitCredentialSet`, the host record must be `transport: "ssh"`, or its URL must be `wss://`, or `ws://` to `127.0.0.1`, `[::1]`, or `localhost`. Otherwise the call fails with `WORKSPACE_GIT_TRANSPORT_REFUSED` and nothing is sent.
- After a host connects or reconnects and advertises the capability, the boot calls the credential provider and sends `gitCredentialSet`, or `gitCredentialClear` when the provider returns null. A provider error is logged and leaves the host without a credential; it does not fail the connection.
- `refreshCredential()` does the same for every connected capable host.
- The token is never logged and never included in an error message.

- [ ] **Step 1: Write the failing tests** with a fake adapter that records requests: each method sends the right operation and adds `installationId`; the gate refuses without the capability; `supported` calls `realign` exactly once and returns its outcome; the transport rule for `ssh`, `wss://x`, `ws://127.0.0.1:1`, `ws://[::1]:1`, and `ws://10.0.0.5:1` (refused, nothing sent); a connect triggers `gitCredentialSet` with the provider's token; a null provider result sends `gitCredentialClear`; a throwing provider leaves the connection usable; no log call contains the token.

- [ ] **Step 2: Run and see them fail** — `cd apps/desktop && node --test test/remote-workspace-git-boot.test.mjs test/racp-remote-host-client.test.mjs`.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** — the same command plus `test/boot-remote-hosts.test.mjs test/remote-host-realign.test.mjs`, then `pnpm --filter @pi-desktop/desktop typecheck`. Expected: PASS.

- [ ] **Step 5: Commit** — `feat(desktop): add the workspace git boot API for remote hosts`

---

### Task 11: End-to-end acceptance

**Files:**
- Create: `scripts/e2e-remote-workspace-git.mjs`
- Create: `scripts/e2e/git-http-fixture.mjs`
- Modify: `package.json` (script `test:e2e:remote-workspace-git`)
- Modify: `scripts/README.md` (one row in the End-to-end table)

**Interfaces:**
- Consumes: everything above, composed in-process the way `scripts/e2e-local-agent-remote-tools.mjs` composes them: a real host-core binary (`PI_HOST_CORE_BINARY`), `createHostOperations`, `RacpServer`, `bindRacpWebSocket`, and `createRemoteHostsBoot`. The proxy is constructed with `upstream` pointing at the fixture.

`git-http-fixture.mjs` serves one bare repository over smart HTTP by running `git http-backend` as a CGI child, requires the basic credential `x-access-token:<fixture token>` for the repository path, and records every request (method, path, whether a credential was present).

Scenario `E2E-REMOTE-repo-session-prepares-isolated-worktree`:

1. Set the credential provider; connect; assert the fixture never saw the token in a URL.
2. `prepare` for session A from `main`; poll to `succeeded`; assert the worktree exists on `pi-desktop/<id>` at `main`'s head and the main checkout exists.
3. `prepare` for session B from the second branch; assert a second worktree and that A's is untouched.
4. Through `boot.executeWorkspaceTool`, run Bash in A's worktree: commit a file, then `git push`. Assert success and that the fixture's repository has the work branch.
5. In A's worktree run `git push origin HEAD:main`. Assert it fails and the fixture's `main` is unchanged (scenario `E2E-REMOTE-git-proxy-rejects-foreign-ref`).
6. `status` for A: zero unpushed, `pushedOnce` true. Add an uncommitted file; `remove` without force reports `removed: false`; with force removes it; `list` shows only B.
7. Clear the credential (provider returns null, `refreshCredential`). In B's worktree `git fetch` fails with an authentication error within 30 seconds.
8. Assert no file under the host's data directory or `workspacesRoot` contains the fixture token.

- [ ] **Step 1: Write the script and fixture.** The script exits non-zero with the failing step's name.

- [ ] **Step 2: Run** — `cargo build -p host-core --locked && pnpm build:js && PI_HOST_CORE_BINARY="$PWD/target/debug/pi-desktop-host-core" pnpm test:e2e:remote-workspace-git`. Expected: every step reports `ok`.

- [ ] **Step 3: Commit** — `test(e2e): cover remote git worktrees through the credential proxy`

---

### Task 12: Decision record, specs, and docs

**Files:**
- Create: `docs/adr/remote-git-workspaces.md`
- Modify: `docs/adr/README.md` (one row, appended)
- Modify: `docs/spec/08-meta/decisions-log.md` (row D687 after D686; dated narrative at the end)
- Modify: `docs/spec/03-runtime/19-remote-agent-control-protocol.md` (§6.2.1: the capability, the ten operations, the job model, the work-branch derivation)
- Modify: `docs/spec/05-security/02-remote-control-security.md` (credential path, proxy scoping, transport refusal)
- Modify: `docs/spec/03-runtime/08-error-codes.md` (nine codes)
- Modify: `docs/spec/03-runtime/03-tools-and-permissions.md` (§4d: remote worktrees and their tool environment)
- Modify: `docs/spec/06-delivery/e2e/live-and-remote.md` and `docs/spec/06-delivery/04-e2e-test-plan.md` (the two scenarios from Task 11)
- Modify: `apps/pi-host/README.md` (`--workspaces-root`, the capability)
- Modify: `docs/superpowers/specs/2026-11-20-remote-github-sessions-design.md` (Part 2: git configuration is passed to host-run git through the child's environment, not `-c`, so the handle is not readable in the process list)

**Interfaces:** none.

- [ ] **Step 1: Write the decision record** (`# ADR: Remote git workspaces and the credential proxy`; Status Accepted; Context, Decision, Consequences, Alternatives). It must state: host-core owns git on the remote host as it does locally; the token lives only in `pi-host` memory and reaches git only through the loopback proxy; the proxy's repository and work-branch scoping; the installation id as an ownership label and why it is not a credential; the transport refusal; jobs instead of long calls; the layout under `workspacesRoot` and why it is outside the data directory; the test-only upstream override being a constructor argument only. Alternatives: desktop-composed shell commands; a git credential helper that returns the token; a bare mirror as the main checkout.

- [ ] **Step 2: Update the specs and docs listed above.** Reference the decision record in the decisions-log row in the log's usual form, by its id `remote-git-workspaces`.

- [ ] **Step 3: Verify** — `pnpm docs:check && pnpm check:agent-policy && git diff --check`. Expected: `Verified <n> documentation pages.` and exit 0.

- [ ] **Step 4: Commit** — `docs(remote): record remote git workspaces and the credential proxy`

---

### Final gate for this plan

Run and record the results:

```bash
pnpm build:js
pnpm --filter @pi-desktop/desktop typecheck
pnpm lint
pnpm --filter @pi-desktop/shared --filter @pi-desktop/racp --filter @pi-desktop/pi-host test
cargo fmt --check && cargo clippy -p host-core --all-targets && cargo test -p host-core --locked
cd apps/desktop && node --test test/remote-*.test.mjs test/racp-*.test.mjs test/boot-remote-hosts.test.mjs
node scripts/check-architecture.mjs
PI_HOST_CORE_BINARY="$PWD/target/debug/pi-desktop-host-core" pnpm test:e2e:remote-workspace-git
PI_HOST_CORE_BINARY="$PWD/target/debug/pi-desktop-host-core" node scripts/e2e-local-agent-remote-tools.mjs
```

The last command proves the existing remote tool path is unchanged. Report any failure with its output; do not skip or edit a test to make it pass.

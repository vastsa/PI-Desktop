# Environments and Session Targets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Under the new-session composer the user picks an environment, a GitHub repository, and a branch; sending the first prompt prepares an isolated worktree on the environment's remote host and the Agent then works in it.

**Architecture:** The local host-core stores environments, marks repository projects, and keeps one workspace binding per session in `kv` namespaces; its remote-workspace resolution consults the binding first and fails closed when it is not ready. Electron main orchestrates the host's prepare job and relays progress. The renderer adds a target row to the home composer, creates the session in the repository's project group, and holds the first prompt until the workspace is ready.

**Tech Stack:** Rust (host-core `kv`), TypeScript (Electron main, React 19, zustand), `cargo test`, `node --test`, vitest (`packages/shared`), i18next catalogs in nine locales.

**Spec:** `docs/superpowers/specs/2026-11-20-remote-github-sessions-design.md` (Part 4, §4, §10 calls 6 and 8). Plan 4 of 7. It consumes the "Cross-plan contract" sections of `2026-11-20-host-git-workspaces.md` (the `workspaceGit` boot API and its types) and `2026-11-20-github-connector.md` (the connector service, its IPC, and `useGitHubConnector`). Plans 5 and 7 consume the contract below.

## Global Constraints

- Work in the worktree and branch you were given. Do not push; the coordinator integrates.
- No SQLite schema change (`SCHEMA_VERSION` stays 33). All new durable state is in `kv` namespaces. `RemoteWorkspace { hostKey, path }` must not gain fields: it is deserialized with `deny_unknown_fields`.
- No host-core `PROTOCOL_VERSION` change (stays 11). New RPC methods are additive.
- In a repository project no session ever runs tools in the main checkout. A session whose binding is missing or not `ready` fails tool calls closed with `REMOTE_WORKSPACE_NOT_READY`; it never falls back to the group's path or to local execution.
- Existing "host plus folder" remote projects, local projects, and users who never connect GitHub see no behavior change. The target row offers "This computer" first and selects it by default until the user chooses otherwise.
- Selecting a target creates nothing. Project group, session, and worktree are created when the first prompt is sent.
- The GitHub token never reaches the renderer. The renderer gets repositories and branches from the connector's IPC only.
- New logic goes in new modules. `crates/host-core/src/rpc/mod.rs`, `apps/desktop/src/stores/app-store.ts`, `apps/desktop/src/components/Composer.tsx`, `apps/desktop/src/components/Sidebar.tsx`, and `apps/desktop/electron/main/index.ts` gain only wiring and mount points.
- New `.ts`/`.tsx` files stay under 800 lines; new `.rs` files under 1000.
- All nine locale catalogs keep the same key set as English, with real translations.
- Do not run `pnpm install`.
- Stage files by explicit path. Commit messages: Conventional Commits, English, subject + blank line + body explaining why. No `Co-Authored-By` or `Signed-off-by`.
- Decision id for this plan: **D689**. Decision record slug: `environments-and-session-targets`.

## Cross-plan contract

**Types** (`packages/shared/src/types/remote-sessions.ts`):

```ts
type RemoteEnvironment = {
  id: string; name: string; hostKey: string;
  setupScript: string; variables: { name: string; value: string }[];
  isDefault: boolean;                 // the implicit environment of its host
};
type RemoteEnvironmentInput = {
  id?: string; name: string; hostKey: string;
  setupScript?: string; variables?: { name: string; value: string }[];
};
type SessionRemoteRepository = {
  environmentId: string; hostKey: string; hostLabel?: string;
  repository: { owner: string; name: string };
  baseBranch: string; workBranch?: string;
  state: "preparing" | "ready" | "failed" | "removing";
  phase?: "queued" | "cloning" | "fetching" | "creatingWorktree" | "runningSetup" | "pushing" | "done";
  progress?: { percent?: number; detail?: string };
  error?: { code: string; message: string };
  setup?: { status: "none" | "running" | "ok" | "failed"; logTail?: string };
  pullRequest?: { number: number; url: string };   // written by the push and pull request plan
};
```

`SessionSummary` gains `remoteRepository?: SessionRemoteRepository`. `ProjectGroupRecord` (the renderer-facing shape) gains `repository?: { owner: string; name: string; defaultBranch: string; hostKey: string }`.

**Default environment id:** `default:<hostKey>`. It exists for every paired host without being stored; saving it stores a record under that id.

**Local host-core RPC** (module `crates/host-core/src/remote_sessions/`, dispatched from `rpc/remote_sessions_rpc.rs`):

| Method | Params | Result |
| --- | --- | --- |
| `environments.list` | `{}` | `{ environments: StoredEnvironment[] }` |
| `environments.upsert` | `{ id?, name, hostKey, setupScript?, variables? }` | `{ environment }` |
| `environments.remove` | `{ id }` | `{ ok: true }` |
| `environments.removeForHost` | `{ hostKey }` | `{ removed: number }` |
| `project.group.ensureRepository` | `{ hostKey, path, repository, defaultBranch }` | `{ group, created }` |
| `sessionWorkspace.bind` | `{ sessionId, environmentId, hostKey, repository, baseBranch, fromSessionId? }` | `{ binding }` |
| `sessionWorkspace.update` | `{ sessionId, patch }` | `{ binding }` |
| `sessionWorkspace.get` | `{ sessionId }` | `{ binding: Binding \| null }` |
| `sessionWorkspace.list` | `{ states? }` | `{ bindings }` |
| `sessionWorkspace.remove` | `{ sessionId }` | `{ ok: true }` |

`kv` namespaces: `remoteEnvironments` (key: environment id), `repositoryProjects` (key: project group id), `sessionWorkspaces` (key: session id).

`Binding` is `{ sessionId, environmentId, hostKey, repository, baseBranch, fromSessionId?, workBranch?, path?, state, jobId?, error?, setup?, pullRequest?, createdAt, updatedAt }`. `patch` may set `state`, `workBranch`, `path`, `jobId`, `error`, `setup`, `pullRequest`; it cannot change identity fields.

**IPC channels:**

| Key | Channel | Input | Result |
| --- | --- | --- | --- |
| `environmentsList` | `pi-desktop/environments/list` | none | `{ environments: RemoteEnvironment[] }` |
| `environmentsUpsert` | `pi-desktop/environments/upsert` | `RemoteEnvironmentInput` | `{ environment: RemoteEnvironment }` |
| `environmentsRemove` | `pi-desktop/environments/remove` | `id: string` | `{ ok: boolean }` |
| `remoteSessionTargetResolve` | `pi-desktop/remoteSession/target/resolve` | `{ environmentId, repository: { owner, name }, defaultBranch }` | `{ projectPath: string }` |
| `remoteSessionWorkspaceStart` | `pi-desktop/remoteSession/workspace/start` | `{ sessionId, environmentId, repository, baseBranch }` | `{ remoteRepository: SessionRemoteRepository }` |
| `remoteSessionWorkspaceRetry` | `pi-desktop/remoteSession/workspace/retry` | `sessionId: string` | `{ remoteRepository: SessionRemoteRepository }` |
| event `remoteSessionWorkspaceChanged` | `pi-desktop/remoteSession/event/workspaceChanged` | — | `{ sessionId: string; remoteRepository: SessionRemoteRepository \| null }` |
| event `environmentsChanged` | `pi-desktop/environments/event/changed` | — | `{ environments: RemoteEnvironment[] }` |

**Main-process services:**

```ts
// apps/desktop/electron/main/remote/environments.ts
type EnvironmentsService = {
  list(): Promise<RemoteEnvironment[]>;
  get(id: string): Promise<RemoteEnvironment | null>;
  upsert(input: RemoteEnvironmentInput): Promise<RemoteEnvironment>;
  remove(id: string): Promise<boolean>;
  removeForHost(hostKey: string): Promise<void>;
};
// apps/desktop/electron/main/remote/session-workspaces.ts
type SessionWorkspaces = {
  start(input: { sessionId: string; environmentId: string; repository: { owner: string; name: string }; baseBranch: string; fromSessionId?: string }): Promise<SessionRemoteRepository>;
  retry(sessionId: string): Promise<SessionRemoteRepository>;
  get(sessionId: string): Promise<SessionRemoteRepository | null>;
  cancel(sessionId: string): Promise<void>;       // stop a running prepare; used when a preparing session is deleted
  resume(): Promise<void>;                        // startup and host reconnect
  dispose(): void;
};
function getActiveSessionWorkspaces(): SessionWorkspaces | null;
```

**Error codes:** `REMOTE_WORKSPACE_NOT_READY`, `REMOTE_ENVIRONMENT_NOT_FOUND`, `REMOTE_TARGET_UNSUPPORTED`, `REMOTE_TARGET_HOST_OFFLINE`.

**Renderer:** `useSessionTargetStore` (`apps/desktop/src/features/chat/session-target/session-target-store.ts`) holding `{ environmentId: "local" | string; repository?: { owner: string; name: string; defaultBranch: string }; baseBranch?: string }`.

**Renderer API methods** (`apps/desktop/src/lib/api.ts`), one per channel: `listEnvironments`, `upsertEnvironment`, `removeEnvironment`, `resolveRemoteSessionTarget`, `startRemoteSessionWorkspace`, `retryRemoteSessionWorkspace`, `onRemoteSessionWorkspaceChanged`, `onEnvironmentsChanged`.

## Review Focus

1. The user sends a prompt, the prepare job is running, and they delete the session, switch sessions, or quit: the job is cancelled or resumed correctly, the prompt is never sent to a workspace that is not ready, and nothing is sent into another session. Pinned in Tasks 6 and 9.
2. The app restarts while a binding is `preparing`: the binding ends `ready` or `failed` with a retry, never stuck `preparing` forever, including when the host no longer knows the job. Pinned in Task 6.
3. A session in a repository project has no binding (created by a plugin, the local MCP control plane, or an older build): its tools fail closed with a clear error, and it never edits the main checkout. Pinned in Task 4.
4. The chosen environment's host is offline, lacks the capability, or the GitHub connector was disconnected between choosing the target and sending: the send is refused with a specific message before any project or session is created. Pinned in Tasks 7 and 9.
5. Two remote hosts each have the same repository, or two environments share one host: sessions land in the right project group, and two environments on one host share that host's repository project. Pinned in Task 3.

---

### Task 1: Shared contract

**Files:**
- Create: `packages/shared/src/types/remote-sessions.ts`
- Modify: `packages/shared/src/types.ts`, `packages/shared/src/types/sessions.ts` (`remoteRepository`), `packages/shared/src/types/workspace.ts` or the file that declares `ProjectGroupRecord` (`repository`)
- Modify: `packages/shared/src/protocol.ts` (six invoke keys, two event keys), `packages/shared/src/errors.ts` (four codes)
- Modify: `apps/desktop/electron/main/mcp-control.ts` (classification)
- Test: `packages/shared/src/protocol.test.ts`, the MCP control test in `apps/desktop/test`

**Interfaces:** produces the types, channels, and error codes above.

- [ ] **Step 1: Write the failing tests:** the eight channel strings and their presence in `IPC_WHITELIST`; the local MCP control plane blocks `environmentsUpsert`, `environmentsRemove`, `remoteSessionTargetResolve`, `remoteSessionWorkspaceStart`, and `remoteSessionWorkspaceRetry` (they create projects and run code on another machine), and may read `environmentsList`.
- [ ] **Step 2: Run and see them fail** — `pnpm --filter @pi-desktop/shared exec vitest run src/protocol.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — `pnpm --filter @pi-desktop/shared build && pnpm --filter @pi-desktop/shared test`, then the MCP control tests. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(shared): add the environment and session target contract`

---

### Task 2: Environments in host-core

**Files:**
- Create: `crates/host-core/src/remote_sessions/mod.rs`, `crates/host-core/src/remote_sessions/environments.rs`
- Create: `crates/host-core/src/rpc/remote_sessions_rpc.rs`, `crates/host-core/src/rpc/remote_sessions_rpc_tests.rs`
- Modify: `crates/host-core/src/main.rs` (module), `crates/host-core/src/rpc/mod.rs` (module declarations and dispatch arms for the `environments.` and `sessionWorkspace.` prefixes and for `project.group.ensureRepository`)

**Interfaces:**
- Produces: `environments::{list, get, upsert, remove, remove_for_host}` over `&Database`; `StoredEnvironment { id, name, host_key, setup_script, variables, created_at, updated_at }` (serde camelCase).

Rules: `name` is trimmed, 1 to 80 characters, no control characters. `hostKey` follows `RemoteWorkspace::validate`'s host-key rule. `setupScript` at most 65536 characters. At most 64 variables; names follow the rule in the host git plan (`^[A-Za-z_][A-Za-z0-9_]{0,127}$`, excluding `PATH HOME SHELL USER LOGNAME PWD OLDPWD IFS ENV BASH_ENV PROMPT_COMMAND NODE_OPTIONS ELECTRON_RUN_AS_NODE` and the prefixes `GIT_ PI_ LD_ DYLD_ BASH_FUNC_`), unique within one environment; values at most 8192 characters. An `upsert` with no `id` mints a UUID. An `id` of the form `default:<hostKey>` is accepted only when its suffix equals `hostKey`. Names need not be unique.

- [ ] **Step 1: Write the failing tests** (unit and RPC): round trip; validation of each rule; `default:` id rule; `remove_for_host` removes exactly that host's records; an unknown `remove` is `REMOTE_ENVIRONMENT_NOT_FOUND`.
- [ ] **Step 2: Run and see them fail** — `cargo test -p host-core --locked remote_sessions`.
- [ ] **Step 3: Implement.** Use `Database::kv_entries` added by the host git plan.
- [ ] **Step 4: Run** — `cargo test -p host-core --locked remote_sessions && cargo fmt --check && cargo clippy -p host-core --all-targets`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(host-core): store remote environments`

---

### Task 3: Repository projects and session bindings

**Files:**
- Create: `crates/host-core/src/remote_sessions/repository_projects.rs`, `crates/host-core/src/remote_sessions/bindings.rs`
- Modify: `crates/host-core/src/rpc/remote_sessions_rpc.rs`, its test file
- Modify: `crates/host-core/src/db/project_groups.rs` only if `create_remote_project_group` needs a returned-existing variant; prefer composing it from `repository_projects.rs`

**Interfaces:**
- Produces:
  - `repository_projects::ensure(db, host_key, path, repository, default_branch) -> Result<(ProjectGroupRecord, bool /* created */)>` — returns the existing group whose remote binding equals `{ hostKey, path }`, else creates one named `<owner>/<name>` and writes the marker.
  - `repository_projects::marker_for_group(db, group_id) -> Result<Option<RepositoryMarker>>` and `marker_for_project_path(db, project_path)`.
  - `bindings::{bind, update, get, list, remove}`; `bindings::Binding` as in the contract; `bindings::State { Preparing, Ready, Failed, Removing }`.

Rules: `bind` requires the session to exist and to belong to a repository project whose marker matches `hostKey` and `repository`; it refuses a session that already has a binding. `update` to `ready` requires `path` and `workBranch` to be present after the patch, and `path` must be absolute. A marker for an existing group with a different repository is an error, never an overwrite. Project group JSON returned by the existing `project.groups.list` gains `repository` when a marker exists.

- [ ] **Step 1: Write the failing tests:** `ensure` creates then returns the same group; two hosts with the same repository get two groups; two calls with the same host and path but a different repository error; `bind` on a session in a folder remote project errors; double `bind` errors; `update` to `ready` without a path errors; `remove` then `get` is null; `project.groups.list` shows `repository` for marked groups only.
- [ ] **Step 2: Run and see them fail** — `cargo test -p host-core --locked remote_sessions`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — `cargo test -p host-core --locked remote_sessions project_groups`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(host-core): mark repository projects and bind sessions to worktrees`

---

### Task 4: Resolve a session's remote workspace through its binding

**Files:**
- Modify: `crates/host-core/src/rpc/remote_tools.rs` (`remote_workspace_of`, `decorate_session`)
- Modify: `crates/host-core/src/rpc/mod.rs` (`resolve_tool_workspace_for_call` near line 1453, `resolve_persisted_project_workspace` near line 1380): replace the direct `remote_workspace_for_path` reads with the session-aware function
- Modify: `crates/host-core/src/rpc/worktree_rpc.rs` (`ensure_local_project` is unchanged in outcome: repository projects are remote and still refused)
- Modify: `apps/desktop/electron/main/remote/workspace-file-scope.ts` (`remoteWorkspaceForFiles` uses the session's `remoteWorkspace` when a session id is known)
- Test: `crates/host-core/src/rpc/remote_tools_tests.rs`, `apps/desktop/test/` file that covers `workspace-file-scope.ts`

**Interfaces:**
- Produces: `remote_sessions::resolve_for_session(db, summary: &SessionSummary) -> Result<Option<RemoteWorkspace>, ResolveError>` with `ResolveError::NotReady { state }`. For a session in a repository project: binding `ready` → `RemoteWorkspace { host_key, path: binding.path }`; anything else → `NotReady`, mapped to RPC error `REMOTE_WORKSPACE_NOT_READY`. For any other session: exactly today's result.
- Session JSON gains `remoteRepository` (the binding's public fields) whenever a binding exists, and its `remoteWorkspace.path` is the worktree path once ready. For a repository-project session with no ready binding, `remoteWorkspace` is omitted.

- [ ] **Step 1: Write the failing tests:** a tool call for a ready session is relayed with the worktree path; for a `preparing`, `failed`, or unbound session in a repository project it fails with `REMOTE_WORKSPACE_NOT_READY` and emits no `tools.remoteExecute`; a session in an ordinary remote folder project is relayed with the group path exactly as before; `session.get` JSON carries `remoteRepository` and the worktree path; the files scope for a ready session resolves the worktree.
- [ ] **Step 2: Run and see them fail** — `cargo test -p host-core --locked remote_tools`.
- [ ] **Step 3: Implement.** Route every one of the five call sites the design names through `resolve_for_session`; search `remote_workspace_for_path` and justify in the commit body any remaining direct use.
- [ ] **Step 4: Run** — `cargo test -p host-core --locked && cargo clippy -p host-core --all-targets`, and the desktop test file. Expected: PASS, with every pre-existing remote tool test unchanged.
- [ ] **Step 5: Commit** — `feat(host-core): resolve remote tools through the session's worktree binding`

---

### Task 5: Environments service and IPC

**Files:**
- Create: `apps/desktop/electron/main/remote/environments.ts`
- Create: `apps/desktop/electron/main/ipc/environments-ipc.ts`
- Modify: `apps/desktop/electron/main/ipc/register.ts` (register), `apps/desktop/electron/main/ipc/remote-host-ipc.ts` (after a host is removed, call `removeForHost`)
- Create: `apps/desktop/test/remote-environments.test.mjs`

**Interfaces:** produces `EnvironmentsService` and `createEnvironmentsService({ call, listHosts, emit })`.

Rules: `list` returns stored environments whose host is still paired, plus one implicit `default:<hostKey>` per paired host that has no stored default, named after the host's label, sorted by host label then with the default first. `upsert` rejects an unknown `hostKey` with `REMOTE_ENVIRONMENT_NOT_FOUND`. `remove` of an implicit or stored default is refused. Every mutation emits `environmentsChanged`.

- [ ] **Step 1: Write the failing tests** with fake `call` and `listHosts`: the composed list and its order; a stored default replaces the implicit one; an environment for a removed host is hidden; upsert for an unknown host; removing a default; emit on mutation; host removal triggers `removeForHost`.
- [ ] **Step 2: Run and see them fail** — `cd apps/desktop && node --test test/remote-environments.test.mjs`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — same command plus `pnpm --filter @pi-desktop/desktop typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(desktop): add remote environments to the main process`

---

### Task 6: Session workspace orchestrator

**Files:**
- Create: `apps/desktop/electron/main/remote/session-workspaces.ts`
- Create: `apps/desktop/test/remote-session-workspaces.test.mjs`

**Interfaces:**
- Consumes: `WorkspaceGitBoot` (host git plan), `EnvironmentsService`, the `sessionWorkspace.*` RPC.
- Produces: `SessionWorkspaces` and `createSessionWorkspaces({ call, git, environments, hostLabel(hostKey), emit, sleep, now, log })`.

Behavior:

- `start`: load the environment (`REMOTE_ENVIRONMENT_NOT_FOUND` if missing), `sessionWorkspace.bind`, then `git.prepare(hostKey, { sessionId, repository, baseBranch, fromSessionId, environment: { variables, setupScript } })`, record `jobId`, and begin polling. It returns as soon as the binding exists; preparation continues in the background.
- Polling: `git.job` every second for the first 30 seconds, then every 2 seconds. Each change of phase or progress emits `remoteSessionWorkspaceChanged`. On `succeeded`: update the binding to `ready` with `path`, `workBranch`, and `setup`. On `failed` or `cancelled`: `failed` with the job's error.
- A poll that fails because the host is unreachable does not fail the binding; polling pauses and `resume()` continues it on reconnect.
- `resume`: for each `preparing` binding, poll its job. If the host answers `WORKSPACE_GIT_JOB_NOT_FOUND`, call `git.list` and look for the session: a worktree whose setup status is not `running` becomes `ready`; otherwise the binding becomes `failed` with a retriable error.
- `retry`: allowed only from `failed`; sets `preparing`, clears the error, and starts a new prepare. Prepare on the host is idempotent, so a worktree that already exists is returned.
- `cancel`: stops polling, calls `git.cancelJob`, then `git.remove(hostKey, sessionId, true)` ignoring `WORKSPACE_GIT_NOT_FOUND`. It does not touch the binding record; the caller deletes the session.
- One poll loop per session at most. After every `await`, the loop re-reads the binding and stops if it is gone or no longer `preparing`.
- `dispose` stops all loops without cancelling host jobs.

- [ ] **Step 1: Write the failing tests** with fake `git`, `call`, and an injected `sleep`:
  - happy path: phases emitted in order, binding ends `ready` with the worktree path;
  - a failed job yields `failed` with its error; `retry` then succeeds;
  - the binding is removed mid-poll: the loop stops and makes no further `update`;
  - `cancel` during polling calls `cancelJob` and forced `remove`, and no later `update` happens;
  - an unreachable host pauses without failing; `resume` continues to `ready`;
  - `resume` with an unknown job and an existing worktree yields `ready`; with no worktree yields `failed`;
  - `start` twice for one session rejects the second;
  - `start` forwards the environment's variables, setup script, and `fromSessionId`.
- [ ] **Step 2: Run and see them fail** — `cd apps/desktop && node --test test/remote-session-workspaces.test.mjs`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — same command plus typecheck. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(desktop): orchestrate remote worktree preparation per session`

---

### Task 7: Target IPC and main-process wiring

**Files:**
- Create: `apps/desktop/electron/main/ipc/remote-session-target-ipc.ts`
- Create: `apps/desktop/electron/main/remote/session-target.ts` (target resolution and the post-create hooks)
- Modify: `apps/desktop/electron/main/ipc/register.ts` (construct and register; wire `connector.onChange` to `boot.workspaceGit.refreshCredential()` and set the credential provider to `() => connector.token()`)
- Modify: `apps/desktop/electron/main/ipc/session-ipc.ts` (after `sessionCreate` and `sessionFork` succeed, call the hook; before `sessionDelete` of a `preparing` session, call `sessionWorkspaces.cancel`)
- Modify: the scheduled runner's session creation under `apps/desktop/electron/main/runtime/` (call the same hook)
- Modify: `apps/desktop/electron/main/bootstrap/remote-hosts.ts` or its caller (call `sessionWorkspaces.resume()` after a host connects; pass `getInstallationId`)
- Create: `apps/desktop/test/remote-session-target.test.mjs`

**Interfaces:**
- Produces:
  - `resolveTarget({ environmentId, repository, defaultBranch }): Promise<{ projectPath: string }>` — checks the environment exists, the host is connected (`REMOTE_TARGET_HOST_OFFLINE`), `git.supported(hostKey)` (`REMOTE_TARGET_UNSUPPORTED`), and the connector is connected (`GITHUB_NOT_CONNECTED`); then `git.repository`, then `project.group.ensureRepository`, returning the group's primary path.
  - `ensureWorkspaceForNewSession(session, options?: { parentSessionId?: string }): Promise<void>` — for a session in a repository project that has no binding: when `parentSessionId` has a binding, start with the parent's environment, repository, and base branch and `fromSessionId: parentSessionId`; otherwise start with the host's default environment and the project's default branch. For any other session it does nothing.

`remoteSessionWorkspaceStart` is the explicit path the composer uses; the hook covers sessions created elsewhere (fork, scheduled tasks). A hook failure is logged and leaves the session unbound, which fails closed by Task 4.

- [ ] **Step 1: Write the failing tests** with fakes: each refusal of `resolveTarget` happens before `ensureRepository` is called; the happy path returns the group path; the hook starts a fork from the parent with `fromSessionId`; the hook starts a scheduled session from the default branch and default environment; the hook ignores local and folder-remote sessions and sessions that already have a binding; deleting a `preparing` session calls `cancel`; a connector change calls `refreshCredential`.
- [ ] **Step 2: Run and see them fail** — `cd apps/desktop && node --test test/remote-session-target.test.mjs`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — same command, the existing `test/session-*.test.mjs` files that read `session-ipc.ts`, and typecheck. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(desktop): resolve remote session targets and bind new sessions`

---

### Task 8: Target row

**Files:**
- Modify: `apps/desktop/src/lib/api.ts` (methods for the eight channels)
- Create under `apps/desktop/src/features/chat/session-target/`: `session-target-store.ts`, `SessionTargetRow.tsx`, `EnvironmentPicker.tsx`, `RepositoryPicker.tsx`, `BranchPicker.tsx`, `NewEnvironmentDialog.tsx`, `use-environments.ts`, `session-target.css`
- Modify: `apps/desktop/src/components/Composer.tsx` (mount `<SessionTargetRow />` under the toolbar, for the home variant only)
- Modify: `packages/i18n/src/locales/*/index.ts` (keys under `sessionTarget`)
- Create: `apps/desktop/test/session-target-row-user-path.test.mjs`, `apps/desktop/test/session-target-store.test.mjs`

**Interfaces:**
- Consumes: `useGitHubConnector`, `api.listGithubRepositories`, `api.listGithubBranches` (connector plan); the environment channels.
- Produces: `useSessionTargetStore` with `setEnvironment(id)`, `setRepository(repository | undefined)`, `setBaseBranch(name)`, `preselect({ environmentId, repository })`, and selector `remoteTargetReady(state): boolean` (a remote environment with a repository and a branch). The selection persists in `localStorage` under `pi-desktop.sessionTarget.v1`; a stored environment that no longer exists falls back to `"local"`.

Row layout, left to right, under the composer:

```text
 ☁ my-server ▾    ▣ owner/repo ▾    ⑂ main ▾
```

- **Environment**: "This computer"; then environments grouped under their host label, with an offline mark for a disconnected host; then "New environment…" and "Add remote host…" (opens Settings → Remote hosts).
- **Repository** (hidden for "This computer"): a searchable list from `listGithubRepositories`, with a refresh action, a "showing the first 1000" note when truncated, and, when the result has `ssoPartial`, a note that some organizations require single sign-on authorization for this token so the list may be incomplete (key `sessionTarget.ssoPartial`, English "Some organizations need single sign-on authorization for this token. Their repositories are not listed."). When the connector is not connected it is replaced by a "Connect GitHub" button that opens Settings → Connectors. When the connector needs re-authentication, the same button with the re-authentication wording.
- **Branch** (hidden until a repository is chosen): branches from `listGithubBranches`; defaults to the repository's default branch; resets when the repository changes.
- `NewEnvironmentDialog` asks for a name and a host and calls `environmentsUpsert`. Setup script and variables are added by a later plan.
- Pickers use `components/settings/AnchoredMenu.tsx` with `side: "top"` and the search pattern of `ComposerModelList.tsx`; they close each other.
- With no paired host, the row shows only the environment picker ("This computer" plus "Add remote host…").

English copy (keys under `sessionTarget`): `thisComputer` "This computer"; `newEnvironment` "New environment…"; `addRemoteHost` "Add remote host…"; `hostOffline` "{{host}} (offline)"; `chooseRepository` "Choose a repository"; `searchRepositories` "Search repositories"; `connectGitHub` "Connect GitHub"; `reconnectGitHub` "Reconnect GitHub"; `refresh` "Refresh"; `truncated` "Showing the first 1000 repositories"; `chooseBranch` "Choose a branch"; `searchBranches` "Search branches"; `environmentName` "Name"; `environmentHost` "Remote host"; `create` "Create"; `repositoryRequired` "Choose a repository to start a remote session"; `loadFailed` "Could not load: {{message}}".

- [ ] **Step 1: Write the failing tests.** Store: defaults to `"local"`; persistence round trip; unknown stored environment falls back; changing repository resets the branch; `remoteTargetReady`. Row (mocked `api`): only the environment picker shows for "This computer"; choosing a remote environment reveals the repository picker; not-connected shows "Connect GitHub"; typing filters the list; choosing a repository selects its default branch; a failed repository load shows `loadFailed` and keeps the previous selection; creating an environment calls `environmentsUpsert` and selects it.
- [ ] **Step 2: Run and see them fail** — `cd apps/desktop && node --test test/session-target-store.test.mjs test/session-target-row-user-path.test.mjs`.
- [ ] **Step 3: Implement** with design tokens only (`pnpm lint` rejects hardcoded style values).
- [ ] **Step 4: Run** — the two test files, the existing composer tests under `apps/desktop/test/composer-*.test.mjs`, `pnpm --filter @pi-desktop/i18n test`, typecheck, and `pnpm lint`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(composer): add the environment, repository, and branch target row`

---

### Task 9: Send flow, preparation status, and project entry points

**Files:**
- Create: `apps/desktop/src/stores/runtime/remote-target-session.ts`
- Modify: `apps/desktop/src/stores/slices/queue-slice.ts` (`sendPrompt`: when there is a ready remote target and the active session is not already a bound session, delegate session creation to the new module; hold queued prompts while the session's workspace is not ready)
- Modify: `apps/desktop/src/stores/slices/events-slice.ts` or the module that applies session updates (apply `remoteSessionWorkspaceChanged` to the session's `remoteRepository`)
- Create: `apps/desktop/src/features/chat/session-target/WorkspacePreparationStatus.tsx`
- Modify: `apps/desktop/src/features/chat/composer/ComposerStatus.tsx` (mount the status)
- Create: `apps/desktop/src/lib/repository-projects.ts` (helpers: `isRepositoryProject`, `repositoryProjectLabel`)
- Modify: `apps/desktop/src/components/Sidebar.tsx` (use the helper for the label and tooltip of repository projects; "New task in this project" for a repository project calls `preselect` and opens the home composer without creating a session)
- Modify: `packages/i18n/src/locales/*/index.ts`
- Create: `apps/desktop/test/remote-target-session.test.mjs`, `apps/desktop/test/workspace-preparation-status-user-path.test.mjs`

**Interfaces:**
- Consumes: Task 8 store and API.
- Produces: `materializeRemoteTargetSession(access): Promise<string | null>` — `api.resolveRemoteSessionTarget` → `activateProject(projectPath)` → reuse the active session when it is empty, unbound, and in that project, else `persistSessionAndSelect({ projectPath })` → `api.startRemoteSessionWorkspace`. Returns the session id, or null when navigation moved on.

Behavior:

- The first prompt is enqueued through the existing queued-prompt path and shown with the existing queued-prompt UI. It is dispatched when the session's `remoteRepository.state` becomes `ready`. While the state is `preparing` or `failed`, nothing is dispatched for that session.
- `WorkspacePreparationStatus` shows one line per phase ("Cloning owner/repo…", "Fetching…", "Creating branch pi-desktop/…", "Running setup…"), with the percentage when present. On `failed` it shows the message with **Retry** and **Delete session**. When setup failed on a ready workspace it shows a dismissible warning with the log tail in a disclosure.
- A refusal from `resolveRemoteSessionTarget` shows a toast with a message specific to the code and leaves the composer text in place; no session is created.
- A session that already has `remoteRepository` ignores the target row (the row is not shown outside the home variant).
- The sidebar labels a repository project `owner/repo`, with the host label as secondary text and tooltip; ordinary remote folder projects keep their current label.

English copy (keys under `sessionTarget.preparation`): `cloning` "Cloning {{repository}}…"; `fetching` "Fetching {{repository}}…"; `creatingWorktree` "Creating branch {{branch}}…"; `runningSetup` "Running setup…"; `queued` "Preparing workspace…"; `failed` "Could not prepare the workspace: {{message}}"; `retry` "Retry"; `deleteSession` "Delete session"; `setupFailed` "The setup script failed. The workspace is ready."; `showLog` "Show log". Refusal toasts (keys under `sessionTarget.refused`): `hostOffline` "{{host}} is offline. Reconnect it and try again."; `unsupported` "{{host}} needs an update to run repository sessions."; `notConnected` "Connect GitHub to start a repository session."; `environmentMissing` "This environment no longer exists."

- [ ] **Step 1: Write the failing tests.**
  - `materializeRemoteTargetSession`: the call order; reuse of an empty unbound session in the same project; a new session otherwise; a refusal creates no session and rethrows; a navigation change mid-way returns null and starts nothing further.
  - Queue: a prompt for a `preparing` session stays queued; it dispatches once on `ready`; it stays queued on `failed` and dispatches after a successful retry; a workspace-changed event for another session dispatches nothing here; with "This computer" selected the existing send path is used unchanged.
  - Status component: each phase line; failure with Retry calling `retryRemoteSessionWorkspace`; setup-failed warning with the log disclosure.
- [ ] **Step 2: Run and see them fail** — `cd apps/desktop && node --test test/remote-target-session.test.mjs test/workspace-preparation-status-user-path.test.mjs`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — the two files, the existing queue and composer tests (`test/*queue*.test.mjs`, `test/composer-*.test.mjs`, `test/sidebar-*.test.mjs`), `pnpm --filter @pi-desktop/i18n test`, typecheck, `pnpm lint`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(chat): start repository sessions from the composer target`

---

### Task 10: End-to-end acceptance

**Files:**
- Create: `scripts/e2e-remote-repo-session.mjs`
- Modify: `package.json` (`test:e2e:remote-repo-session`), `scripts/README.md`

Compose in-process as `scripts/e2e-remote-workspace-git.mjs` does (remote host-core, `pi-host` operations, credential proxy pointed at the git HTTP fixture, desktop boot), and add a local host-core, the environments service, the session workspace orchestrator, the target resolver, and the remote tool relay.

Scenario `E2E-REMOTE-composer-target-starts-isolated-repo-session`:

1. Resolve a target on the default environment; assert one repository project group exists.
2. Create a session in it; `start`; observe `preparing` then `ready`; assert the session JSON carries `remoteRepository.state === "ready"` and a worktree path.
3. Execute a Bash tool call for the session through the relay; assert it ran in the worktree, not the main checkout (`pwd` and a marker file).
4. Create a second session in the group with no binding; assert its tool call fails with `REMOTE_WORKSPACE_NOT_READY` and the main checkout is unchanged (scenario `E2E-REMOTE-unbound-repo-session-fails-closed`).
5. Commit in the first session's worktree without pushing; run the fork hook for a new session; assert its worktree head is that commit.
6. Recreate the orchestrator while a prepare is in flight (simulated restart) and call `resume`; assert the binding ends `ready`.
7. Remove the host; assert its environments are gone and the session's tools fail closed.

- [ ] **Step 1: Write the script.**
- [ ] **Step 2: Run** — `cargo build -p host-core --locked && pnpm build:js && PI_HOST_CORE_BINARY="$PWD/target/debug/pi-desktop-host-core" pnpm test:e2e:remote-repo-session`. Expected: every step `ok`.
- [ ] **Step 3: Commit** — `test(e2e): cover repository sessions from target to worktree`

---

### Task 11: Decision record, specs, and docs

**Files:**
- Create: `docs/adr/environments-and-session-targets.md`
- Modify: `docs/adr/README.md`, `docs/spec/08-meta/decisions-log.md` (D689)
- Modify: `docs/spec/04-ux/01-ui-ia.md` and `docs/spec/04-ux/08-component-spec.md` (the target row, the preparation status, repository project labels)
- Modify: `docs/spec/03-runtime/10-session-state-machine.md` (workspace binding states and the fail-closed rule)
- Modify: `docs/spec/03-runtime/04-data-storage.md` (three `kv` namespaces), `docs/spec/03-runtime/01-ipc-protocol.md` (eight channels), `docs/spec/03-runtime/08-error-codes.md` (four codes), `docs/spec/03-runtime/03-tools-and-permissions.md` (§4d)
- Modify: `docs/spec/06-delivery/e2e/live-and-remote.md`, `docs/spec/06-delivery/04-e2e-test-plan.md` (the two scenarios)
- Modify: `docs/superpowers/specs/2026-11-20-remote-github-sessions-design.md` (Part 4: the target selection lives in its own small store rather than in the draft session configuration, because "New task" creates an empty session eagerly; the target row is shown for the home composer whether or not an empty session exists)

- [ ] **Step 1: Write the decision record** (`# ADR: Environments and composer session targets`). State: environments as named configurations bound to a host with an implicit default; one repository project per host and repository; the per-session binding in `kv` and the fail-closed resolution; why no session runs in the main checkout; fork, sidebar new-task, and scheduled behavior; the main-process orchestrator and restart recovery. Alternatives: a project group per session; extending `RemoteWorkspace`; a schema migration with a foreign key.
- [ ] **Step 2: Update the specs.**
- [ ] **Step 3: Verify** — `pnpm docs:check && pnpm check:agent-policy && git diff --check`.
- [ ] **Step 4: Commit** — `docs(remote): record environments and composer session targets`

---

### Final gate for this plan

```bash
pnpm build:js
pnpm --filter @pi-desktop/desktop typecheck
pnpm lint
pnpm --filter @pi-desktop/shared --filter @pi-desktop/i18n test
cargo fmt --check && cargo clippy -p host-core --all-targets && cargo test -p host-core --locked
cd apps/desktop && node --test test/*.test.mjs
node ../../scripts/check-architecture.mjs
PI_HOST_CORE_BINARY="$PWD/../../target/debug/pi-desktop-host-core" pnpm -C ../.. test:e2e:remote-repo-session
PI_HOST_CORE_BINARY="$PWD/../../target/debug/pi-desktop-host-core" node ../../scripts/e2e-local-agent-remote-tools.mjs
```

The desktop suite has known timeout-sensitive failures in this container; compare against the baseline list the coordinator provides and report anything new with its output.

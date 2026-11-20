# Remote GitHub sessions on paired hosts — design

- Status: Approved by the owner on 2026-11-20
- Date: 2026-11-20
- Scope: fork `david-yang-pixel/PI-Desktop`
- Size: project (seven ordered parts, each planned and landed separately)

## 1. Intent

The owner runs their own remote host and wants the new-session experience of
Claude Code's cloud sessions on it: pick an **environment**, a **GitHub
repository**, and a **branch** under the composer, send a prompt, and have the
Agent work in an isolated checkout of that repository on the remote host, then
push a branch and open a pull request.

Today a remote project is "a host plus a directory that already exists on it",
created through the Create project dialog. Nothing signs in to GitHub, lists
repositories or branches, clones on the host, or isolates one session from
another on the host.

## 2. Goals, non-goals, anti-goals

### Goals

1. A built-in GitHub connector: sign in once, on by default once signed in.
2. Named environments bound to a paired remote host, each with a setup script
   and environment variables.
3. A target row under the new-session composer: environment, repository,
   branch.
4. Each session gets its own git worktree and work branch on the host; the
   repository is cloned on the host once and fetched afterwards.
5. Push the work branch and create a pull request from the desktop; the Agent
   can also `git fetch` / `git push` from its own Bash commands.
6. GitHub tools for the Agent (issues, pull requests, comments).
7. The fork publishes its own desktop builds and `pi-host` bundles from GitHub
   Actions, and paired hosts upgrade to them automatically.

### Non-goals (this project)

- Network policy for commands on the host. It needs a command sandbox on the
  host and is a separate later project (planned approach: network namespace
  plus an allowlist proxy).
- Sessions that keep running while the desktop is closed. The Agent, model
  requests, and provider credentials stay on the desktop, as decided in
  `docs/adr/local-agent-remote-workspace-tools.md`.
- Repository and branch pickers for the local environment ("This computer").
  Local work keeps the existing project switcher.
- GitLab, Bitbucket, GitHub Enterprise Server, multiple GitHub accounts.
- Windows remote hosts.
- Rebranding (product name, `appId`, data directory, marketplace, docs site).

### Anti-goals

- The GitHub token is written to the remote host's disk, or appears in a
  process argument list, a command's environment, a log line, or a renderer
  payload.
- A remote tool call falls back to local execution, or a session whose
  worktree is not ready runs tools in some other directory.
- Existing "host plus folder" remote projects, local projects, or users who
  never sign in to GitHub see any behavior change.
- The data directory stops being readable by a build without this feature
  (see §4.1).
- A permission prompt is removed or weakened to make the flow smoother.

## 3. Approaches considered

| Approach | Summary | Trade-off |
| --- | --- | --- |
| A. Desktop-composed shell | Desktop drives `git clone` / `git worktree` through the existing remote Bash relay | No host change, but the token rides inside shell strings, git logic is duplicated in TypeScript, and lifecycle is inferred from stdout |
| B. Agent runs on the host | Revive the host-run Agent backend so sessions survive a closed desktop | True parity, but reverses an accepted decision, moves model credentials to the host, and loses most composer features |
| **C. Dedicated host git capability** | New owner-only RACP capability; the remote host-core owns git, worktrees, and their registry | Clean contract and credential handling; needs a fork-published host bundle and a protocol addition |

The owner chose **C**, with fork releases built by GitHub Actions. C follows
the rule ADR 0329 set for local isolation: host-core owns all git execution and
the worktree registry.

## 4. Cross-cutting decisions

### 4.1 No SQLite schema bump

All new durable state uses the existing `kv` table through new namespaces. The
fork must not claim SQLite `user_version` 34: upstream will, and the two
histories would collide on every merge. It also keeps the data directory
readable by an upstream build, because host-core refuses a database newer than
it supports.

Consequence: there is no foreign key from a session to its remote workspace.
Cleanup is explicit (session delete) plus a reconcile pass (startup and host
connect).

### 4.2 No RACP or host protocol version bump

RACP `1.0` compatibility is major-only and its specification treats additive
operations as compatible. The host-core stdio `PROTOCOL_VERSION` stays 11; new
host-core RPC methods are additive.

### 4.3 Repository coordinates

One constant in `packages/shared` names the repository that owns releases,
host bundles, update feeds, and feedback issues. It changes from
`vastsa/PI-Desktop` to `david-yang-pixel/PI-Desktop`. The plugin marketplace
catalog and the documentation site keep pointing at upstream.

### 4.4 Module placement

New logic goes into new domain modules. The files under the architecture
ratchet (`electron/main/index.ts`, `app-store.ts`, `Composer.tsx`,
`Sidebar.tsx`, `rpc/mod.rs`) gain only dispatch lines and mount points.

## 5. Design by part

Parts are listed in delivery order. Each part is independently testable.

### Part 1 — Fork release pipeline

**What changes**

- The shared repository constant (§4.3), `apps/desktop/package.json`
  `build.publish` and `homepage`, `apps/desktop/resources/app-update.yml`, and
  `RELEASES_URL` in `updater.ts` point at the fork.
- `.github/workflows/release.yml`: macOS signing becomes conditional on the
  signing secrets being present. Without secrets the macOS lane produces
  unsigned artifacts instead of failing the release.
- The upstream signed lane, its scripts, and its hard-coded Apple team
  identity are left untouched and dormant behind the repository variable
  `MACOS_SIGN_RELEASE`. The owner has no certificate (§9), so parameterizing
  the team identity would rewrite three scripts and three test files for no
  user, and would add merge conflicts with upstream.
- An unsigned macOS build is stamped at build time with a metadata marker,
  next to the existing `piDistribution` field. `supportsAutomaticUpdates`
  reads it. Today every packaged macOS build counts as auto-update capable,
  and nothing inspects the signature.
- The `pi-host-bundle` job is unchanged in content; it now publishes to the
  fork's release, which is where the desktop looks.
- `mirror-to-cnb.yml` and `pi-triage.yml` / `pi.yml` are disabled on the fork
  if they need upstream-only secrets (builder verifies each).

**Behavior**

- A tag `vX.Y.Z` on the fork produces desktop installers and
  `pi-host-X.Y.Z-linux-{x64,arm64}.tar.gz` with `.sha256` sidecars.
- An unsigned macOS build, through that marker, reports the existing "manual"
  update mode; it never attempts an in-app update.
- Version numbers keep the upstream `X.Y.Z` shape and are bumped with
  `scripts/release.mjs`. The host bundle version must equal `APP_VERSION`.

**Decided (owner)**: unsigned, macOS arm64 only; see §9.

### Part 2 — Host git workspace capability (`workspaceGit`)

**Layout on the host**

```text
<workspacesRoot>/repos/github.com/<owner>/<repo>/               main checkout, never edited by sessions
<workspacesRoot>/worktrees/github.com/<owner>/<repo>/<shortid>/ one per session, branch pi-desktop/<shortid>
```

`workspacesRoot` is a new `pi-host` setting that defaults to
`~/pi-workspaces`. It must be inside the browse root and outside the data
directory: `pi-host` treats its data directory as protected, and plugin file
reads refuse any root inside it.

The main checkout is a normal (non-bare) clone left on the default branch. It
is the remote project's directory, so the existing remote-project features
that need a directory (file view, plugin file reads) keep working at project
level. Session worktrees are created from `refs/remotes/origin/<baseBranch>`
after a fetch, so the base branch choice is per session.

**Worktree ownership**

RACP mints a new random device id on every pairing, and host realignment
re-pairs. A registry keyed by device id would orphan every worktree on each
fork release. The registry is therefore keyed by the desktop's stable
installation id (the existing `createInstallationIdentity` value), which the
desktop supplies with each `workspaceGit` request.

That id is a label, not a credential. Every caller of these operations already
holds the owner role, which can run arbitrary Bash on the host, so a forged
label grants nothing the caller lacks. It exists so one desktop's reconcile
never removes another desktop's worktrees by accident.

**Transport restriction**

The credential operation is accepted only for hosts reached over the desktop's
own SSH forward, a `wss://` URL, or a loopback `ws://` URL (a forward the user
opened themselves). A non-loopback `ws://` host is refused before the token is
sent, with a typed error.

**RACP surface** (all `role: "owner"`, `profile: "remote-host"`; capability
flag `workspaceGit: Optional<boolean>`):

| Operation | Purpose |
| --- | --- |
| `workspace/gitCredentialSet` | Hand the host the GitHub token for this connection; held in `pi-host` memory only |
| `workspace/gitCredentialClear` | Drop it; also implicit on disconnect |
| `workspace/gitRepository` | Resolve a repository to its canonical main checkout path on this host and report whether it is cloned. No side effects |
| `workspace/gitPrepare` | Start a prepare job: ensure clone, fetch, create worktree and work branch, run setup script. Returns a job id immediately |
| `workspace/gitPush` | Start a push job for a worktree's work branch |
| `workspace/gitJob` | Poll a job: phase, optional progress, terminal result or typed error |
| `workspace/gitJobCancel` | Cancel a running job |
| `workspace/gitStatus` | One worktree: branch, ahead/behind its upstream, uncommitted file count, unpushed commit count |
| `workspace/gitRemove` | Remove a worktree and its local work branch; refuses when work would be lost unless `force` |
| `workspace/gitList` | Worktrees this device owns on the host, for reconcile |

Jobs, not long calls: the host-core RPC layer, the `pi-host` RPC client, and
the RACP client all have request budgets between 15 and 135 seconds, and RACP
has no progress notification outside session events. A job id plus polling
needs neither a timeout exemption nor a new notification kind, and a desktop
that reconnects can resume polling.

Request schemas are closed typebox objects. Repository owner, name, and branch
are validated against strict patterns before they reach a git argument list,
and every git invocation separates options from operands with `--`.

**Ownership split on the host**

- Remote **host-core** (Rust): new RPC family `workspaceGit.*` in its own
  module. It reuses the database-free parts of `session_worktrees`
  (`GitRunner`, probe, remove, merge helpers, repo lock), keeps the worktree
  registry in a `kv` namespace on the host's own database, runs jobs as tasks,
  and runs the setup script through the Bash tool path with a 30-minute limit
  and a retained log tail, as the local setup command does.
- `GitRunner` gains a network variant for clone, fetch, and push. The existing
  runner has a fixed 120-second limit and strips environment-carried git
  configuration on purpose. The variant takes a caller-supplied limit and
  passes the proxy rewrite as an explicit `-c` option; it keeps stripping
  inherited configuration and keeps every other safety flag.
- **pi-host** (Node): validates and forwards the RACP operations, namespaces
  session keys by device as `workspace-tools.ts` does, and runs the credential
  proxy below.

**Credential proxy**

`pi-host` runs a loopback HTTP proxy on a random port. It forwards git
smart-HTTP requests to `https://github.com` and adds the authorization header
from the in-memory token. Each worktree gets a random 256-bit handle; the
proxy accepts `/<handle>/<owner>/<repo>.git/...` only for that worktree's
repository. For `git-receive-pack` it parses the ref-update lines and rejects
any ref other than the worktree's own work branch.

Git reaches the proxy through a per-command URL rewrite scoped to the
session's repository. Host-run git gets it as a `-c` option; the Agent's Bash
gets it as environment-carried git configuration. The stored remote URL stays
`https://github.com/<owner>/<repo>.git`, so a host restart with a new port
needs no rewrite.

The token is attached only to requests for the session's repository. Any
other GitHub URL behaves as if there were no proxy: public repositories,
submodules, and git-based dependencies work anonymously. Private repositories
other than the session's own are not reachable; that is a known limit of this
version.

The handle appears in host-run git arguments and in the Agent's environment.
It is not the token: it is usable only on the host's loopback interface, only
for one repository, and for pushes only to one branch.

Result: host-core's own clone, fetch, and push, and the Agent's `git` inside
Bash, all authenticate without the token ever reaching host-core, a child
process, or the disk. When the owning desktop disconnects, the token is
dropped and the proxy answers 401.

**Environment injection for tools**

`workspace/toolExecute` is unchanged on the wire. When remote host-core
executes a tool whose root is a registered worktree, it adds that worktree's
environment: the environment's variables, the git proxy configuration,
`PI_WORKTREE_ROOT`, and `PI_PROJECT_ROOT`. The remote tool path's hard-coded
empty `extra_env` becomes this lookup. Paths that are not registered worktrees
behave exactly as today.

**Desktop gating**

`workspaceGit` is checked per method, not in the connect-time assertion, so
hosts without it keep working for folder projects. When the user targets a
host that lacks it, the desktop runs the existing realignment (verified SSH
re-bootstrap) once and retries; a host that still lacks it reports
`HOST_VERSION_MISMATCH` with the existing action-required state.

### Part 3 — GitHub connector

**Sign-in**

- Primary: OAuth device flow with a GitHub OAuth App the owner registers for
  the fork. Only the client ID ships in the build; there is no client secret.
- Fallback: paste a personal access token. Always available; the only option
  when no client ID is configured.
- Scopes: `repo` and `read:org`. A checkbox at sign-in ("allow changes to
  GitHub Actions workflow files") adds `workflow`; default off.

**Storage and boundaries**

- The token lives in the host-core secret store under a fixed first-party ref
  (`secret:app:github-connector`), following the existing Jev credential
  precedent. That store is an encrypted file under the data directory, not the
  OS keychain.
- Only Electron main reads the token. The renderer sees account login, avatar,
  scopes, and connection state.
- New IPC channels that move or use the credential are added to the local MCP
  control plane's blocked list.
- All GitHub REST calls come from Electron main through the proxy-aware fetch,
  pinned to `api.github.com`.

**Capabilities exposed to the renderer**: status, start/cancel device login,
set token, disconnect, list repositories (paged, cached, filtered
client-side), list branches, find and create pull request.

**Settings**: a new **Connectors** destination in the Agent cluster, after
MCP. It shows the GitHub card: account, scopes, sign in / sign out, and the
"GitHub tools for the Agent" switch (Part 6). The device-code dialog reuses
`OAuthLoginDialog` through an adapter.

### Part 4 — Environments and the new-session flow

**Environment**

```text
Environment { id, name, hostKey, setupScript, envVars: [{ name, value }] }
```

- Stored by host-core in a `kv` namespace, through a small RPC family in its
  own module.
- Every paired host has an implicit default environment named after the host.
  More can be created. Removing a host removes its environments.
- Environment variables are plain configuration. They are stored unencrypted
  on the desktop and, per worktree, on the host. The editor says so.
- Changes apply to sessions created afterwards.

**Target row**

Shown under the composer only while the session does not exist yet:

```text
┌──────────────────────────────────────────────────────────────┐
│ Ask PI-Desktop to help with anything                           │
│ +  Agent ▾  Ask every time ▾                     Model ▾   ➤  │
└──────────────────────────────────────────────────────────────┘
 ☁ my-server ▾    ▣ owner/repo ▾    ⑂ main ▾
```

- **Environment**: "This computer", then environments grouped under their
  host with connection state, then "New environment…" and "Add remote host…".
- **Repository**: searchable list from the connector. Hidden for "This
  computer". When GitHub is not connected it is replaced by "Connect GitHub".
- **Branch**: branches of the chosen repository; defaults to its default
  branch.
- The last used environment, repository, and branch are remembered.
- A remote environment with no repository chosen cannot send; the send button
  explains why.

The draft session configuration gains `environmentId`, `repository`, and
`baseBranch`. Selecting a remote target does not create anything until the
first prompt is sent.

**Project identity**

One project group per `(hostKey, owner/repo)`, created on first use, bound to
the main checkout path with the existing `RemoteWorkspace { hostKey, path }`
shape (which must not gain fields: it rejects unknown ones). The sidebar shows
it as `owner/repo` with a cloud mark and the host label. Two environments on
the same host share the repository's project group.

A separate `kv` record keyed by group id marks the group as a repository
project and stores `owner/repo` and the default branch. In a repository
project **no session ever runs tools in the main checkout**:

- A session with no workspace binding fails tool calls closed.
- "New task in this project" from the sidebar opens the new-session composer
  with that host and repository preselected, so the user picks the branch.
- Forking a session creates a new worktree at the parent work branch's current
  commit. Uncommitted changes are not carried over, as with local isolated
  sessions.
- A scheduled task in a repository project prepares a worktree from the
  default branch when it fires.

**Session workspace binding**

A `kv` record keyed by session id:

```text
{ environmentId, hostKey, repository, baseBranch, workBranch, path,
  state: preparing | ready | failed | removing, jobId?, error?, pullRequest? }
```

`remote_tools::remote_workspace_of` consults this record first and, when the
state is `ready`, returns the worktree path instead of the group's path. Five
known places read the group binding directly and are routed through the same
resolution:

- `decorate_session`, which feeds `session.remoteWorkspace` and therefore the
  Agent's working directory and instruction loading;
- `resolve_tool_workspace_for_call`;
- `resolve_persisted_project_workspace`;
- Electron's `remoteWorkspaceForFiles`;
- the worktree probe's remote refusal.

A session whose record is not `ready` fails tool calls closed with
`REMOTE_WORKSPACE_NOT_READY`.

**First prompt**

1. Renderer sends the create request with the remote target.
2. Electron main asks the host for the repository's main checkout path
   (`workspace/gitRepository`), ensures the repository project group with that
   path, then host-core creates the session and its binding in state
   `preparing`.
3. Main sets the credential on the host, starts `workspace/gitPrepare`, polls
   the job, and relays phases to the renderer: cloning or fetching, creating
   the branch, running setup.
4. On success host-core marks the binding `ready` with the path and work
   branch; the queued prompt starts.
5. On failure the binding is `failed` with a typed error. The session and the
   typed prompt are kept; the user can retry or delete.

A failed setup script does not fail the prepare: the worktree is ready, the
status row shows the failure and the log tail.

The work is asynchronous across several awaits, so each step re-checks that
the session still exists and is still `preparing`. A session deleted mid-way
cancels the job and removes the worktree.

**Restart**: a binding found in `preparing` at startup is resumed by polling
its job id. If the host no longer knows the job, the desktop checks
`workspace/gitList`: a complete worktree becomes `ready`, anything else
becomes `failed` and retryable.

### Part 5 — Push, pull request, cleanup

- The conversation top bar of a repository session shows the host, repository,
  work branch, and two actions.
- **Push branch** starts `workspace/gitPush` and shows its progress.
- **Create PR** opens a dialog with title (from the session title), body, base
  (the session's base branch), and a draft switch. It pushes when needed, then
  creates the pull request through the connector. Afterwards the action
  becomes **View PR**.
- Neither action commits for the user. With uncommitted changes the top bar
  shows the count; committing is the Agent's job.
- **Delete session**: the desktop asks the host for status first. Unpushed
  commits or uncommitted files produce the loss warning. Deletion then removes
  the worktree and the local work branch. The remote branch on GitHub is never
  deleted.
- **Host offline at delete**: the warning says unpushed work cannot be
  checked. On confirmation the session is deleted locally and a pending
  removal is recorded; it is carried out, forced, on the next connection. The
  user consented to the loss.
- **Reconcile on connect**: the desktop lists its own worktrees on the host
  and looks at those that have neither a local binding nor a pending removal
  and are older than a day. It removes one only when it has no uncommitted
  files and no unpushed commits. The rest are listed under Settings → Remote
  hosts as leftover worktrees with a manual delete. Nothing unattended ever
  discards work the user was not warned about.
- Worktrees labelled with another installation id are never touched.
- Archiving a session cleans nothing up.

### Part 6 — GitHub tools for the Agent

- When the connector is signed in and its tools switch is on, Electron main
  injects a built-in HTTP MCP server with id `github` pointing at GitHub's
  hosted MCP endpoint, restricted to the issues and pull-request toolsets by
  request header.
- There is no record file. The token is supplied through the existing MCP
  OAuth token hook, so it is never written to `~/.agents`.
- A user-created MCP record with the id `github` wins; the built-in one is not
  injected next to it.
- The tools follow every existing MCP rule: main-process execution, medium
  risk with approval, deferred activation.
- They are available in local sessions too.

**Gate before building this part**: confirm with a real device-flow token
that the hosted endpoint accepts a third-party OAuth App token. GitHub's
documentation implies it and does not state it. If it does not, this part
becomes a small set of main-dispatched tools over the REST API (issue get,
list, create, comment; pull request get, list, comment, list review comments),
designed at that point.

### Part 7 — Setup script and environment variables

- The environment editor (reachable from the target row and from Settings →
  Remote hosts) edits name, host, setup script, and variables.
- The setup script runs once per new worktree, in the worktree, as the SSH
  user, with the environment's variables. It is user-authored configuration
  and runs without a permission prompt, as the local worktree setup command
  does.
- Variable names are validated; names that would redirect git, the shell
  loader, or the tool runner are refused.

## 6. Security summary

| Asset or risk | Treatment |
| --- | --- |
| GitHub token at rest | Desktop secret store only |
| GitHub token in transit | A dedicated owner-only RACP operation, refused unless the host is reached over SSH, `wss://`, or loopback |
| GitHub token on the host | `pi-host` memory, dropped on disconnect; never in host-core, child processes, disk, or logs |
| Agent-run git | Authenticates through the proxy; limited to its repository and, for pushes, its work branch |
| Injection through repository or branch names | Strict validation, `--` separation, no shell composition |
| Hooks in host-run git | Disabled, as in local worktree isolation |
| Setup script | Arbitrary code by design; authored by the owner; documented |
| Environment variables | Plain text by design; documented; not for secrets |

This changes a security boundary (a credential now reaches a paired host's
memory, and the host gains a mutation capability). It needs a decision record
before implementation of Part 2.

## 7. Documentation and decision records owed

- New decision records: fork release coordinates and unsigned macOS builds; host
  git workspace capability and credential proxy; GitHub connector and built-in
  MCP server; environments and the composer target row.
- Decisions log entries starting at D686.
- Specs: remote agent control protocol (§6.2.1), remote control security,
  secrets storage, tools and permissions (§4d), UI IA, settings IA (the
  destination count and order), release runbook.
- E2E scenario documents with semantic IDs, for example
  `E2E-REMOTE-repo-session-prepares-isolated-worktree`,
  `E2E-REMOTE-git-proxy-rejects-foreign-ref`,
  `E2E-CONNECTOR-device-login-stores-no-renderer-secret`.
- Changelog entries for the released surfaces; all nine locale catalogs.

## 8. Testing

- **Contracts**: shared RACP schema tests and the regenerated schema fixture;
  owner-only routing, viewer refusal, and missing-capability tests in the RACP
  package.
- **Host**: host-core unit tests for prepare, remove, status, registry, and
  environment injection against temporary repositories; `pi-host` tests for
  the proxy (repository scoping, ref restriction, token drop on disconnect).
- **Desktop main**: device flow against a local fixture; REST client against a
  local fixture; session binding state machine including delete during
  prepare and restart recovery.
- **Renderer**: component tests for the target row, the environment editor,
  the Connectors page, and the PR dialog.
- **E2E**: extend the packaged-host remote harness with a local git server
  standing in for GitHub and a local REST fixture. No real GitHub account, no
  real provider.
- **Manual acceptance** on the owner's host after the first fork release:
  sign in, create a session on a private repository, push, open a PR.

## 9. Owner answers

1. **Signing**: the fork has no Apple Developer ID certificate. macOS builds
   are unsigned: no in-app update, and first launch needs a manual allow.
2. **Platforms**: the fork releases the desktop for macOS arm64 only. The
   Windows, Linux, and macOS Intel desktop lanes are removed from the fork's
   release workflow. The host bundles (Linux x64 and arm64) are always built.
3. **OAuth App** (still owed, not blocking): the owner registers a GitHub
   OAuth App with device flow enabled and provides its client ID. Until then,
   sign-in is by pasted token only.

## 10. Calls made by the designer

These were not decided by the owner. Each is the designer's call and can be
overturned in review.

1. Worktree ownership is labelled with the desktop installation id, not the
   RACP device id (Part 2).
2. The git credential is refused on non-loopback `ws://` hosts (Part 2).
3. The proxy authenticates only the session's own repository; other private
   repositories are unreachable in this version (Part 2).
4. Repositories and worktrees live under `~/pi-workspaces` on the host
   (Part 2).
5. Scopes are `repo` and `read:org`; `workflow` is an opt-in checkbox
   (Part 3).
6. Repository projects never run tools in the main checkout; fork, sidebar
   new-task, and scheduled tasks behave as listed (Part 4).
7. Unattended removal forces only after an explicit warning; reconcile removes
   only clean, fully pushed worktrees (Part 5).
8. The work branch is `pi-desktop/<shortid>`, and the proxy restricts pushes
   to it (Parts 2 and 5).
9. Push and Create PR never commit for the user (Part 5).
10. A user-created MCP record with id `github` overrides the built-in one
    (Part 6).
11. Feedback issue links follow the release repository to the fork; the
    plugin marketplace and docs site stay on upstream (§4.3).

## 11. Left to the builder

- Exact names of new modules, IPC channels, kv namespaces, and error codes.
- Polling cadence and job retention on the host.
- Whether the first clone uses a partial-clone filter.
- Where the "preparing workspace" status renders (transcript row or composer
  status) and how it is restored after a renderer reload.
- How the fork's disabled upstream-only workflows are switched off.

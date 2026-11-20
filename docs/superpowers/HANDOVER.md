# Handover: remote GitHub sessions on paired hosts

- Snapshot: 2026-11-20, about 10:10 UTC
- Repository: `david-yang-pixel/PI-Desktop` (fork of `vastsa/PI-Desktop`)
- Branch: `claude/trusting-darwin-gnyao7`, with a pull request into `main`
- Status in one line: parts 1 to 3 of 7 are merged into the branch; part 2 still has
  open review findings; parts 4 to 7 are planned and not started. The owner
  paused the work here.

## What this project is

The owner wants the new-session experience of Claude Code's cloud sessions on
their own remote host: choose an environment, a GitHub repository, and a
branch under the composer; the Agent then works in an isolated checkout of that
repository on the host, and the result is pushed as a branch and opened as a
pull request.

Read these first, in this order:

1. `docs/superpowers/specs/2026-11-20-remote-github-sessions-design.md` — the
   approved design. §10 lists the decisions the designer made on the owner's
   behalf; §9 has the owner's answers.
2. The plan for the part you are about to touch, under
   `docs/superpowers/plans/`. Each plan has a "Cross-plan contract" section
   whose names are fixed, because other parts are built against them.
3. `AGENTS.md` and `CLAUDE.md` — repository rules.

## Decisions the owner made

- Each session gets its own git worktree and work branch on the host; the
  repository is cloned on the host once.
- A dedicated host capability (`workspaceGit`), not shell commands composed by
  the desktop.
- The fork releases through GitHub Actions on a tag.
- No Apple Developer ID certificate; desktop releases are macOS arm64 only.
- Agent GitHub tools and environment setup scripts and variables are in scope.
- Network policy for host commands is out of scope: a separate later project.
- Sessions do not keep running while the desktop is closed. The Agent, model
  requests, and model credentials stay on the desktop.
- The owner's remote host connects to the internet directly, without an HTTP
  proxy.
- The owner stopped the part 2 fix pass partway and asked for the branch to be
  pushed with a pull request, the remaining items written down here.

## Progress by part

| Part | Plan file | State |
| --- | --- | --- |
| 1. Fork release pipeline | `2026-11-20-fork-release-pipeline.md` | Done: reviewed, fixed, merged. Dry run passed. One owner check left |
| 2. Host git workspaces | `2026-11-20-host-git-workspaces.md` | Merged with **open review findings** (see below). Not yet called by the app |
| 3. GitHub connector | `2026-11-20-github-connector.md` | Done: reviewed, fixed, merged. Two minor findings deferred |
| 4. Environments and session targets | `2026-11-20-environments-and-session-targets.md` | Planned (11 tasks). Not started |
| 5. Push, pull request, cleanup | `2026-11-20-remote-session-push-and-pull-requests.md` | Planned (9 tasks). Not started; depends on 4 |
| 6. GitHub tools for the Agent | `2026-11-20-github-agent-tools.md` | Planned (5 tasks). Not started; depends on 3 only |
| 7. Setup script and variables | `2026-11-20-environment-setup-and-variables.md` | Planned (5 tasks). Not started; depends on 4 |
| Network policy | none | Not planned. Deferred by the owner |

Counted in plan tasks: 25 done (parts 1 to 3), 30 not started (parts 4 to 7),
plus the open part 2 review findings below.

## Outstanding work, in priority order

### A. Part 2 review findings not yet fixed

An independent review of part 2 found one critical and four important
defects plus several minor ones. Fixed and merged: the critical one (pushes
over 1 MiB failed), the proxy now serves only its own user and rotates handles
on every credential set, cancel kills git's whole process group, and host-run
git ignores the host user's credential helpers and proxy settings.

**Not fixed — fix these before part 2 is relied on:**

1. **Unpushed commits are destroyed when the registry and the disk disagree.**
   In `crates/host-core/src/rpc/workspace_git_rpc.rs` and
   `crates/host-core/src/workspace_git/worktree.rs`:
   - record present, directory gone: prepare deletes the local work branch and
     restarts from the base branch. Fix: when `refs/heads/<work>` exists,
     `git worktree prune` then `git worktree add -- <path> <work>`;
   - same state, `remove` with `force: false`: the counts are skipped and the
     branch is deleted. Fix: count unpushed commits from the branch even
     without a directory and refuse;
   - no record, non-empty directory present: prepare empties it. Fix: refuse.
2. **Agent git bypasses the proxy after a reconnect.** In
   `apps/pi-host/src/workspace-git.ts`, `proxyUrlFor` uses a per-connection
   map, so on a new connection before `gitCredentialSet` arrives — and forever
   after a `gitCredentialClear` — tool calls carry no rewrite and git goes to
   github.com with the host user's own credentials, without the work-branch
   limit. Fix: resolve the scope from the worktree record by the tool's root
   path (a host-core lookup through `registry::find_by_path`), always inject
   the rewrite and `GIT_TERMINAL_PROMPT=0` for a registered worktree, and let
   the proxy answer 401 when no token is live. This also fixes scopes left
   behind by a failed or cancelled prepare, and a prepare for an existing
   session with a different repository re-scoping that session's handle.
3. **Sign-out leaves the token on hosts.** In
   `apps/desktop/electron/main/remote/workspace-git-boot.ts`,
   `refreshCredential()` does nothing when the provider is `null`, and a
   provider that throws leaves the old token. Fix: send
   `workspace/gitCredentialClear` in both cases.
4. **`workspacesRoot` is created with the default umask**, and the decision
   record `docs/adr/remote-git-workspaces.md` and the design's Part 2 text
   still claim the proxy handle is not readable in the process list. git
   itself puts the handle in its `git remote-http` argument list, in
   `.git/FETCH_HEAD`, and in its output. Fix: create the root and its
   `repos` and `worktrees` directories with mode 0700, and correct both
   documents to name the real protections (same-user check, per-repository
   and per-branch scope, rotation, loopback-only).
5. **A host-core restart during a setup script** leaves the record's setup
   status `running` forever. Fix: turn `running` into `failed` with an
   "interrupted" note on start.
6. **`WORKSPACE_GIT_BUSY` carries no job id**, so a caller whose reply was lost
   cannot resume polling. Fix: put the running job id in the error details,
   through host-core, pi-host, and RACP.
7. **Lock keys differ under a symlinked root**: `push` locks the canonical git
   directory, `ensure` and `create` lock `<main>/.git`. Fix: canonicalize once.
8. **Trusted fields are spread before caller input** in pi-host's host-core
   call helper (`{ workspacesRoot, ...params }`). Fix: put trusted fields last.

Deferred by decision (low impact): an idle timeout on push inspection; `remove`
holding a lock against a concurrent prepare or push beyond the existing BUSY
check; the proxy's own upstream request ignoring `HTTPS_PROXY` (the owner's host
does not use a proxy).

Behaviors the review said are effectively untested: temp-clone cleanup when a
real clone is cancelled midway is now covered; still untested are tools after a
reconnect without a credential, unpushed commits behind a stale record, a null
provider on refresh, and a gzip-encoded push split across chunks.

Other part 2 facts to know:

- Minimum git on the host is 2.31 (`GIT_CONFIG_COUNT`); older hosts get
  `WORKSPACE_GIT_UNAVAILABLE`.
- `getInstallationId` is a boot option that `startup.ts` does not pass yet, so
  the desktop side of the API fails closed until part 4 wires it.
- When the fix pass was stopped, about 420 lines of uncommitted, unverified
  work on finding 1 sat in the local worktree
  `/home/user/PI-Desktop-worktrees/host-git-workspaces`. It is not merged and
  will be lost with the container; redo it from the description above.

### B. Part 3 findings deferred

- A login keeps polling until the device code expires (at most 30 minutes) if
  the window reloads or closes mid-login, and stores the token if the user
  approves. Abort on main-window navigation or destroy.
- Device polling treats a 4xx with a non-JSON body (a proxy block page) as
  transient and waits until expiry. Fail after a few consecutive ones.

Notes for the plans that build on part 3:

- All connector errors now show a translated catalog sentence, so GitHub's own
  detail (an SSO message, "a pull request already exists") is not displayed.
  The pull request dialog in part 5 should append GitHub's message.
- Electron's `net.fetch` with `redirect: "manual"` throws "Redirect was
  cancelled" instead of returning the 3xx; the client recognizes it by the word
  "redirect". An Electron upgrade that changes that wording turns "repository
  moved" back into a retriable network error.
- Repository names still refuse a trailing `.git`.
- List results carry `ssoPartial`; part 4's repository picker must show the
  "list may be incomplete" note (already in that plan).

### C. Part 1 minor items deferred

A stale header comment in `apps/desktop/electron/main/updater.ts`; two comments
that still tie host bundles to the desktop build matrix; the `sign_macos` input
description; an E2E fixture that still carries the upstream releases URL; the
runbook's fork section does not mention enabling Issues and Actions; ADR 0022
is not amended for the unsigned mode. Upstream's dormant signed lane has the
same `--` flag-forwarding bug that part 1 fixed for the unsigned lane.

### D. Parts 4 to 7

Implement in this order, re-checking each plan against the merged code first:
part 4 and part 6 (independent), then parts 5 and 7 (both need part 4). Part 4
must first wire `getInstallationId` and set the connector as the git credential
provider. Decision ids are reserved: D689 (part 4), D690 (5), D691 (6),
D692 (7).

After any change to `pi-host`, cut a fork release so paired hosts pick it up:
the host bundle is downloaded at the desktop's version, so it needs a new
version number.

## Verification at hand-off

Run on the merged branch before the owner stopped the remaining checks:

- `pnpm build:js`, desktop typecheck, `pnpm lint`: pass.
- Package tests: shared 1720, racp 33, pi-host 113 (4 skipped), i18n 33 — all
  pass.
- `cargo fmt --check`, `cargo clippy -p host-core --all-targets` (4 warnings, in
  untouched files): pass. `cargo test -p host-core --locked`: 1402 passed, 1
  ignored.
- `pnpm test:e2e:remote-workspace-git` (8 steps) and
  `scripts/e2e-local-agent-remote-tools.mjs`: pass.
- `node scripts/check-architecture.mjs`: pass after splitting one test file.
- `pnpm docs:check`: pass.
- **Not run on the final merge:** the desktop `node --test` suite (the owner
  asked to stop testing). It passed on each branch before merging, apart from
  the container's known baseline failures.
- Part 1 on GitHub Actions:
  <https://github.com/david-yang-pixel/PI-Desktop/actions/runs/44699269208>,
  conclusion success, artifacts kept until 2027-02-18. Parts 2 and 3 have not
  run on Actions.

## Owner actions outstanding

1. **Verify the part 1 build on a Mac.** Download `dist-mac-arm64` from the dry
   run, install the DMG, run
   `xattr -dr com.apple.quarantine /Applications/PI-Desktop.app`, open the app,
   and confirm "Check for updates" offers the releases page and starts no
   in-app download.
2. **Register a GitHub OAuth App** for the fork with device flow enabled and
   provide its client ID. It goes into `GITHUB_OAUTH_CLIENT_ID` in
   `packages/shared/src/github-connector.ts`. Until then sign-in works with a
   pasted personal access token only.
3. **Enable Issues on the fork.** The in-app feedback link now points there.
4. **After the OAuth App exists**, run `scripts/probe-github-mcp.mjs` (created
   by part 6) with a device-flow token to confirm GitHub's hosted MCP server
   accepts it. If it does not, part 6 needs REST-backed tools instead.
5. **Cut the first fork release** when ready:
   `node scripts/release.mjs <version> --tag`, then push the branch and the
   tag.

## Open risks

- **GitHub's hosted MCP server and device-flow tokens** are unverified (see
  owner action 4).
- **Shared data directory.** The fork keeps upstream's application identifier,
  so a fork build and an upstream build on one machine share `~/.pi-desktop`.
  The design avoids any SQLite schema change so both can open the same data.
- **Merges from upstream will conflict** in `.github/workflows/release.yml`
  (the fork keeps one matrix row) and in the RACP contract packages.
- **The generic renderer `secrets/set` and `secrets/delete` channels** accept
  any reference, so a compromised renderer could overwrite or delete the
  connector credential (it cannot read it). Pre-existing; documented.

## Working notes for whoever continues

- This container runs as root. Electron needs `--no-sandbox`, which the
  repository's own Electron E2E scripts do not pass. Drive the app with
  Playwright's `_electron` instead, with `xvfb-run`.
- Some tests fail here and pass on GitHub's runners: one in
  `packages/agent-runtime` (`managed-exec.test.ts`) and about fifteen
  timeout-sensitive ones in `apps/desktop`. `pnpm -r test` stops at the first
  failing package and skips its dependents, so run the desktop suite directly:
  `cd apps/desktop && node --test test/*.test.mjs`, and compare against a
  baseline taken before your change.
- The pinned pnpm forwards a literal `--` to scripts. Pass electron-builder
  flags without it.
- Run `scripts/check-architecture.mjs` from the repository root; it uses the
  working directory as the root.
- A git worktree for a change that spans workspace packages needs its own
  `pnpm install` (seconds, from the local store). For Rust, pointing
  `CARGO_TARGET_DIR` at the primary checkout's `target` reuses compiled
  dependencies, as long as only one build runs.
- The session may push only to `claude/trusting-darwin-gnyao7`.

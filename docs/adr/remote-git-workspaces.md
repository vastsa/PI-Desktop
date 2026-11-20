# ADR: Remote git workspaces and the credential proxy

- Status: Accepted
- Date: 2026-11-20
- Related: D687, ADR 0285, ADR 0327, ADR 0329,
  [local-agent-remote-workspace-tools](local-agent-remote-workspace-tools.md),
  [fork-release-coordinates](fork-release-coordinates.md)

## Context

A remote project is "a paired Host plus a directory that already exists on it".
The owner wants to start a session from a GitHub repository and a branch
instead: the Host clones the repository once, each session gets its own
checkout and work branch, and the session's work can be pushed.

That needs three things the Host does not have. Something on the Host must run
git on the desktop's behalf. Sessions must not share a working tree. And git on
the Host must authenticate to GitHub with a token that today exists only in the
desktop's secret store.

The Agent, model requests, and provider credentials stay on the desktop
([local-agent-remote-workspace-tools](local-agent-remote-workspace-tools.md)).
The Agent's tools already run on the Host through `workspace/toolExecute`, and a
caller of that operation holds the owner role, which can run arbitrary Bash
there.

This changes a security boundary: a credential reaches a paired Host, and the
Host gains a mutation capability. Hence this record.

## Decision

1. **A new optional, owner-only RACP capability, `workspaceGit`.** Ten
   operations under `workspace/git*` (protocol spec §6.2.1). The RACP version
   stays `1.0` and the host-core protocol version stays 11: the operations and
   the `workspaceGit.*` host-core methods are additive. A Host without the
   capability keeps serving folder projects; the desktop checks it per call,
   not at connect time.

2. **host-core owns git on the remote Host, as it does locally.** Every git
   invocation for these workspaces, and the worktree registry, live in the
   remote host-core (`crates/host-core/src/workspace_git`). It reuses the
   hardened runner of ADR 0329: hooks and fsmonitor disabled, redirecting
   environment removed. `pi-host` validates and forwards; the desktop never
   composes a git command.

3. **The token lives only in `pi-host` memory.** The desktop sends it with
   `workspace/gitCredentialSet`. `pi-host` hands it to a loopback proxy and
   keeps it while a connection that set it is open; clearing it or closing the
   connection drops it. It never reaches host-core, a child process, a file, a
   log line, or a process argument list.

4. **git reaches GitHub through a loopback credential proxy.** `pi-host` runs
   an HTTP proxy on `127.0.0.1` and a random port. Each session's scope gets a
   random 256-bit handle; git is pointed at
   `http://127.0.0.1:<port>/<handle>/<owner>/<repo>.git` by one per-command
   rewrite (`url.<proxy>.insteadOf = https://github.com/<owner>/<repo>.git`).
   The stored remote stays the GitHub URL, so a Host restart on a new port
   needs no rewrite. The rewrite is delivered as environment-carried git
   configuration (`GIT_CONFIG_COUNT`), not `-c`, to host-run git and to the
   Agent's Bash. Git 2.31 or newer is required. Git can expose the handle in
   `git remote-http` process arguments, `.git/FETCH_HEAD`, and command output.
   The proxy is loopback-only, checks the connecting user on Linux, scopes
   handles to a repository and work branch, and rotates them on credential
   replacement. The workspaces root, `repos`, and `worktrees` use mode 0700
   on Unix.

5. **A handle is scoped to one repository and one branch.** The proxy attaches
   the credential only to the smart-HTTP endpoints (and the two Git LFS
   endpoints a clone and a push need) of the scope's repository. For
   `git-receive-pack` it reads the ref-update commands, bounded at 64 KiB, and
   forwards nothing unless every command names the session's work branch.
   Any other path under a handle is forwarded without a credential: public
   repositories, submodules, and git dependencies work anonymously, and other
   private repositories are not reachable. Paths with dot segments, escapes,
   or empty segments are refused, so GitHub can never resolve a request to a
   different repository than the proxy checked. Without a token the proxy
   answers 401 and contacts nobody.

6. **Each session gets a worktree on a derived work branch.** The branch is
   `pi-desktop/<id>`, where `<id>` is the first 12 hex characters of
   `SHA-256(installationId + "\n" + sessionId)`. `pi-host` and host-core each
   compute it; neither trusts a stored or supplied branch name. The worktree's
   upstream is its own work branch, so a bare `git push` cannot target the
   base branch. A session can instead start from another session's local work
   branch (`fromSessionId`), which is how a fork inherits unpushed commits.

7. **The installation id is an ownership label, not a credential.** The
   registry is keyed by the desktop's stable installation id, because RACP
   mints a new device id on every pairing and a host realignment re-pairs: a
   device-keyed registry would orphan every worktree on each release. Every
   caller already holds the owner role, so a forged label grants nothing the
   caller lacks. It exists so one desktop's listing and cleanup never touch
   another desktop's worktrees.

8. **The credential is refused on a transport an observer could read.** The
   desktop sends the token only to a Host reached over its own SSH forward, a
   `wss://` URL, or a loopback `ws://` URL. Otherwise nothing is sent and a
   prepare or push fails with `WORKSPACE_GIT_TRANSPORT_REFUSED`.

9. **Long work is a job, not a long call.** Every request budget between the
   desktop and host-core is between 15 and 135 seconds, and RACP has no
   progress notification outside session events. `workspace/gitPrepare` and
   `workspace/gitPush` return a job id; the caller polls `workspace/gitJob`.
   A second prepare for a session that already has a worktree answers with
   that worktree; a session with a running job is `WORKSPACE_GIT_BUSY`.
   Cancelling a prepare leaves no worktree behind.

10. **Workspaces live under `workspacesRoot`, outside the data directory.**

    ```text
    <workspacesRoot>/repos/github.com/<owner>/<repo>            main checkout
    <workspacesRoot>/worktrees/github.com/<owner>/<repo>/<id>   session worktree
    ```

    The root defaults to `~/pi-workspaces`. It must be inside the browse root,
    so the remote project features that need a directory keep working, and
    outside the data directory, which `pi-host` protects and refuses to read
    through plugin file access. Only `https://github.com/<owner>/<repo>.git`
    is ever cloned; owner, repository, and branch names are validated by the
    shared contract, by the RACP server, and again by host-core, and operands
    follow `--`. Branch names follow git's own reference-name rules rather
    than an allowlist, so every branch GitHub lists can be chosen; a branch
    name never reaches a shell and never becomes part of a path.

11. **No schema change.** The registry is a `kv` namespace
    (`workspaceGitWorktrees`). The fork must not claim the next SQLite
    `user_version`, which belongs to upstream.

12. **The proxy's upstream is a constructor argument only.** Tests point the
    proxy at a local git server through `createGitCredentialProxy({ upstream })`.
    No flag, environment variable, configuration field, or RPC parameter can
    redirect it, because whatever it points at receives the token.

## Consequences

- A paired Host can now hold a GitHub token in memory for as long as its
  owner's desktop is connected. A process running as the same user on the Host
  could read `pi-host` memory; that user already runs the Agent's Bash.
- The Agent's own `git fetch` and `git push` work without the Agent ever
  seeing a credential. Its pushes are limited to its session's work branch,
  whatever it runs.
- Private repositories other than the session's own (private submodules,
  private git dependencies) are not reachable in this version.
- Signed pushes (`push-cert`) are refused by the proxy.
- There is no foreign key from a session to its worktree. Cleanup is explicit
  (remove) plus a reconcile pass the desktop runs against `workspace/gitList`.
- Environment variables of a worktree are stored unencrypted in the Host
  registry. They are configuration, not secrets.
- Hosts with git older than 2.31 report `WORKSPACE_GIT_UNAVAILABLE`.
- A job table is process-local: a host-core restart forgets running jobs. An
  interrupted clone leaves nothing where the main checkout belongs, and the
  next prepare clears what it left beside it.

## Alternatives

- **Desktop-composed shell commands** over the existing remote Bash relay. No
  Host change, but the token would ride inside shell strings and process
  arguments, git logic would be duplicated in TypeScript, and lifecycle would
  be inferred from command output.
- **A git credential helper that returns the token.** git would receive the
  token itself, in a child process, and the Agent's Bash could ask the same
  helper for it. Nothing would limit what the Agent pushes.
- **A bare mirror as the main checkout.** Slightly less disk, but the remote
  project's directory would stop being browsable, and the features that need
  a working tree at project level (file view, plugin file reads) would break.
- **A registry keyed by the RACP device id.** Simpler, but every realignment
  re-pairs and would orphan every worktree.
- **A `-c` option for the rewrite.** Works on older git, but puts the handle
  in the argument list of every host-run git process.

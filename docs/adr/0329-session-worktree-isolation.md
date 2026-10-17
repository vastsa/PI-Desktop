# ADR 0329: Isolate parallel sessions of one project in git worktrees

- Status: Accepted
- Date: 2026-10-12
- Deciders: PI-Desktop maintainers
- Related: ADR 0062 (parallel delegates), ADR 0089 (delegation tools),
  D114 (per-session scratch), `docs/spec/03-runtime/03-tools-and-permissions.md` §4d

## Context

Several sessions of one project can run at the same time, but they all
resolve the same tool root (`resolve_tool_workspace`, `crates/host-core/src/rpc/mod.rs`).
Writes are serialized only per session; two sessions editing one file are
guarded only by the Edit content tag, and they share one build tree and one
git state. Subagents of one session share the same root as well.

Every mainstream agent product that offers parallel local work isolates it in
a git worktree: Claude Code (`--worktree`, subagent `isolation: worktree`),
Cursor (Agents Window, `/worktree`), Codex (Local / Worktree with Handoff),
VS Code (Agents window "New Worktree"), Windsurf / Devin Desktop, Conductor,
and JetBrains IDEs. Four of the six desktop products place worktrees outside
the project directory.

## Decision

1. An isolated session is opt-in per new session, default off. It owns one git
   worktree on branch `pi-desktop/<id>`, created by host-core under
   `~/.pi-desktop/worktrees/<project-key>/` from the project's current branch
   tip. Uncommitted project changes are not carried over.
2. host-core owns all git execution, worktree paths, and the `worktrees`
   registry (schema v24). The renderer and the agent runtime send only a
   session id and, for subagents, a delegation id; they never send a worktree
   path.
3. Tool containment is unchanged in mechanism: the isolated session's root is
   its worktree (or `<worktree>/<prefix>` when the project is a repository
   subdirectory), so the main checkout is "outside workspace" and needs the
   existing permission. Project identity (skills, plugins, MCP, memory,
   subagent catalog, group context) stays keyed by the project path; only
   files, instruction files, and the shell run in the worktree.
4. "Merge into project" preserves the session's commits. It first shows the
   commit count and changed files for confirmation, then merges the project
   branch into the session branch inside the worktree (conflicts stay there),
   then fast-forwards the project branch. The project never enters a
   merge-in-progress state and git refuses to overwrite uncommitted project
   changes. The preview token also covers the project branch tip and the
   full content of untracked files, so nothing the user did not see lands.
   Both checkouts' branches are checked before every write, the
   fast-forward is bound to the checked commit and verified afterwards, and
   the session's own tools are held for the whole merge or sync (at most
   five seconds' wait for a running tool, then `WORKTREE_BUSY`).
5. Inside an isolated session, a subagent whose tools include Write or Edit
   gets its own temporary worktree and is merged back automatically with the
   same algorithm; a conflict is reported to the parent, which can resume the
   subagent to resolve it. Other subagents share the session worktree.
6. Deleting an isolated session removes its worktrees and branches after a
   loss warning; there is no separate discard. Removal deletes links as links
   before calling git, because Git for Windows follows directory junctions
   during `git worktree remove --force` (openai/codex#34702, #49995). A
   registered worktree folder that was itself replaced by a link is treated
   as missing everywhere and only the link is removed.
7. Every git command host-core runs disables hooks and `core.fsmonitor` and
   sets `safe.bareRepository=explicit`. A relative `core.hooksPath` resolves
   inside the worktree, so a hook written with Write/Edit alone would
   otherwise run when host-core commits or merges, bypassing the Bash
   permission.
8. New worktrees copy ignored files listed in `.worktreeinclude` (the format
   Claude Code and Conductor read), then run an optional per-project setup
   command with `PI_PROJECT_ROOT`, `PI_WORKTREE_ROOT`, and `PI_PORT` (a block
   of 10 ports per worktree, after Conductor's `CONDUCTOR_PORT`).
9. Minimum git version is 2.29 (`git worktree repair`). Relative worktree
   links are not used because they raise the repository format version.
10. "Sync from project" merges the project branch into an isolated session's
    worktree with the rules of decision 4 (pending session work is committed
    first, conflicts stay in the worktree) and never touches the project.
    Without it a session only receives other sessions' work, including their
    conflict resolutions, when it is merged, so it keeps working on stale
    code. The sidebar marks a session that lacks project commits (`↓N`); the
    counts come from one background host call (`worktree.behindAll`) when
    isolated sessions change, after a merge or sync, and on window focus, so
    rendering the list never waits for git.
11. The conflict status follows the worktree, not only the next merge: after
    each Write, Edit, or Bash call of a conflicted session, after a failed
    merge or sync, when the session menu opens, and in the background behind
    check, host-core clears the status once every conflict is resolved (by
    the rule the merge uses to conclude it) or the merge was aborted. Text
    conflicts merged by git's text driver count as resolved when their
    markers (of the file's `conflict-marker-size`) are gone; binary,
    add/delete, modify/delete, and `merge=binary` / `-merge` / custom-driver
    conflicts need an explicit `git add` or `git rm`.
12. While host-core commits or merges in a session worktree for a subagent,
    it holds the session's own tools (new calls queue, also while the hold is
    awaited). Calls of subagents rooted in their own worktrees are not held.
    It waits at most five seconds for tools already running, then falls back
    to holding only the session's write permit, so a long Bash run never
    blocks subagents. The runtime gives these host calls a 10-minute
    deadline so it never reports a merge that is still running as failed.

## Alternatives considered

- Worktrees inside the project (`.pi/worktrees/`, Claude Code's choice):
  rejected after verification; test runners (vitest default `exclude`),
  `tsc` (default `include: **/*`), watchers, and `git clean -ffdx` see or
  delete the copies.
- Apply changes as uncommitted edits instead of merging the branch: rejected
  by the user in favor of keeping history.
- Merging directly in the project: rejected; a conflict would leave the
  project half-merged.
- No automatic subagent merge-back (Claude Code, VS Code, Codex): rejected by
  the user in favor of zero-click integration, with serialization and a
  no-force fallback as safeguards.
- Per-project file locks without worktrees: rejected; it cannot isolate builds
  or git state.

## Consequences

- Project history contains "Merge branch …" and checkpoint commits.
- Automatic commits do not run the project's pre-commit hooks.
- MCP stdio servers stay per project with the main checkout as cwd, so MCP
  tools are not isolated.
- Builds that reach outside the repository by relative path need links made
  by the setup command.
- Isolation is a development boundary, not a security boundary; Bash can
  still reach the main checkout through absolute paths.

## Validation

host-core tests against real temporary git repositories cover creation,
merge (including conflicts, markerless conflicts, and dirty-project refusal),
sync from project, behind counts, conflict-status refresh, the session hold,
hook suppression, link-safe removal, orphan cleanup, `.worktreeinclude`, port
assignment, and repository-subdirectory projects; IPC, renderer, and Electron
user-path tests cover the sidebar. `pnpm test:e2e:worktree-live` runs the
lifecycle against a real model. The hook-suppression, link-safe removal, and
`.worktreeinclude` link tests also run on Windows with directory junctions,
where Git for Windows runs hooks without an executable bit and lists files
inside a junction. On Windows, RPC user-path tests also create and delete a
session with a path beyond 260 characters and show that a delete blocked by a
locked file fails with `WORKTREE_IO`, keeps the session, and succeeds on
retry; the renderer-level live-model run of the scenario is still manual.

# ADR 0329: Isolate parallel sessions of one project in git worktrees

- Status: Accepted
- Date: 2026-10-12
- Related: ADR 0062 (parallel delegates), ADR 0089 (delegation tools),
  D114 (per-session scratch), `docs/spec/03-runtime/03-tools-and-permissions.md` §4d

## Context

Several sessions of one project can run at once but all resolve the same tool root,
so two sessions editing one file are guarded only by the Edit content tag and they
share one build tree and one git state, as do their subagents. Every mainstream agent
product that offers parallel local work isolates it in a git worktree.

## Decision

1. An isolated session is opt-in per new session and owns one worktree on branch
   `pi-desktop/<id>` under `~/.pi-desktop/worktrees/<project-key>/`, created from the
   project's current branch tip; uncommitted project changes are not carried over.
2. host-core owns all git execution, worktree paths, and the `worktrees` registry, and
   the renderer and runtime send only a session id or delegation id.
3. Containment is unchanged in mechanism: the session's root is its worktree (or
   `<worktree>/<prefix>` for a repository subdirectory), while project identity stays
   keyed by the project path.
4. "Merge into project" shows the commit count and changed files, merges the project
   branch into the session branch inside the worktree so conflicts stay there, then
   fast-forwards the project branch, so the project never enters a merge-in-progress
   state. The preview token covers the project branch tip and untracked content, every
   write re-checks both branches, and the session's tools are held for the merge (then
   `WORKTREE_BUSY`).
5. A subagent whose tools include Write or Edit gets its own temporary worktree and is
   merged back with the same algorithm, with conflicts reported to the parent; other
   subagents share the session worktree.
6. Deleting an isolated session removes its worktrees and branches after a loss
   warning, deleting links as links before calling git because Git for Windows follows
   directory junctions during `git worktree remove --force`.
7. Every git command disables hooks and `core.fsmonitor` and sets
   `safe.bareRepository=explicit`, so a relative `core.hooksPath` hook cannot bypass
   the Bash permission.
8. New worktrees copy ignored files listed in `.worktreeinclude` and then run an
   optional per-project setup command with `PI_PROJECT_ROOT`, `PI_WORKTREE_ROOT`, and
   `PI_PORT`.
9. Minimum git version is 2.29, and relative worktree links are not used because they
   raise the repository format version.
10. "Sync from project" merges the project branch into the session worktree under
    decision 4's rules and never touches the project; the sidebar marks a session that
    lacks project commits (`↓N`) from one `worktree.behindAll` call.
11. Conflict status follows the worktree: host-core clears it once every conflict is
    resolved by the merge's own rule, with text conflicts counted as resolved when
    their markers are gone and binary or add/delete conflicts needing an explicit
    `git add` or `git rm`.
12. While host-core commits or merges for a subagent it holds the session's own tools,
    waiting at most five seconds for running tools before falling back to the write
    permit.

## Consequences

- Project history gains merge and checkpoint commits, and automatic commits do not run
  the project's pre-commit hooks.
- MCP stdio servers stay per project with the main checkout as cwd, so MCP tools are
  not isolated.
- Isolation is a development boundary, not a security boundary: Bash can still reach
  the main checkout through absolute paths.

## Alternatives

- Worktrees inside the project, or per-project file locks without worktrees —
  rejected: test runners, `tsc`, watchers, and `git clean -ffdx` would see or delete
  the copies, and locks isolate neither builds nor git state.
- Merging directly in the project — rejected: a conflict would leave the project
  half-merged.

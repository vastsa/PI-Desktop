# ADR 0329: Isolate parallel sessions of one project in git worktrees

- Status: Accepted
- Date: 2026-10-12
- Deciders: PI-Desktop maintainers
- Related: ADR 0062 (parallel delegates), ADR 0089 (delegation tools),
  D114 (per-session scratch), `docs/spec/03-runtime/03-tools-and-permissions.md` §4d

## Context

Several sessions of one project can run at the same time, but they all resolve
the same tool root (`resolve_tool_workspace`,
`crates/host-core/src/rpc/mod.rs`). Writes are serialized only per session; two
sessions editing one file are guarded only by the Edit content tag, and they
share one build tree and one git state.

## Decision

1. An isolated session is opt-in per new session, default off.
2. host-core owns all git execution, worktree paths, and the `worktrees`
   registry (schema v24).
3. Tool containment is unchanged in mechanism: the isolated session's root is
   its worktree (or `<worktree>/<prefix>` when the project is a repository
   subdirectory), so the main checkout is "outside workspace" and needs the
   existing permission.
4. "Merge into project" preserves the session's commits.
5. Inside an isolated session, a subagent whose tools include Write or Edit gets
   its own temporary worktree and is merged back automatically with the same
   algorithm; a conflict is reported to the parent, which can resume the
   subagent to resolve it.
6. Deleting an isolated session removes its worktrees and branches after a loss
   warning; there is no separate discard.
7. Every git command host-core runs disables hooks and `core.fsmonitor` and sets
   `safe.bareRepository=explicit`.
8. New worktrees copy ignored files listed in `.worktreeinclude` (the format
   Claude Code and Conductor read), then run an optional per-project setup
   command with `PI_PROJECT_ROOT`, `PI_WORKTREE_ROOT`, and `PI_PORT` (a block of
   10 ports per worktree, after Conductor's `CONDUCTOR_PORT`).
9. Minimum git version is 2.29 (`git worktree repair`).
10. "Sync from project" merges the project branch into an isolated session's
    worktree with the rules of decision 4 (pending session work is committed
    first, conflicts stay in the worktree) and never touches the project.
11. The conflict status follows the worktree, not only the next merge: after
    each Write, Edit, or Bash call of a conflicted session, after a failed merge
    or sync, when the session menu opens, and in the background behind check,
    host-core clears the status once every conflict is resolved (by the rule the
    merge uses to conclude it) or the merge was aborted.
12. While host-core commits or merges in a session worktree for a subagent, it
    holds the session's own tools (new calls queue, also while the hold is
    awaited).

## Alternatives considered

- Worktrees inside the project (`.pi/worktrees/`, Claude Code's choice):
  rejected after verification; test runners (vitest default `exclude`), `tsc`
  (default `include: **/*`), watchers, and `git clean -ffdx` see or delete the
  copies.**
- Apply changes as uncommitted edits instead of merging the branch: rejected by
  the user in favor of keeping history.
- Merging directly in the project: rejected; a conflict would leave the project
  half-merged.
- No automatic subagent merge-back (Claude Code, VS Code, Codex): rejected by
  the user in favor of zero-click integration, with serialization and a no-force
  fallback as safeguards.

## Consequences

- Project history contains "Merge branch …" and checkpoint commits.
- Automatic commits do not run the project's pre-commit hooks.
- MCP stdio servers stay per project with the main checkout as cwd, so MCP tools
  are not isolated.
- Builds that reach outside the repository by relative path need links made by
  the setup command.
- Isolation is a development boundary, not a security boundary; Bash can still
  reach the main checkout through absolute paths.

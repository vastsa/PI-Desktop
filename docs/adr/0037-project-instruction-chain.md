# ADR 0037: Resolve project instructions in Electron main

- Status: Accepted
- Date: 2026-07-30
- Updated: 2026-10-08 (independent global and project budgets; visible
  truncation notice, issue #1490)
- Related: [Agent runtime](../spec/03-runtime/02-agent-runtime.md)

## Context

Loading only `<project root>/AGENTS.md` omits directory-specific rules in
monorepos and offers no path for `CLAUDE.md` projects, while letting the
model-driven sidecar scan the workspace would weaken the boundary that keeps
workspace file access in Electron main and host-core.

## Decision

1. Electron main resolves instructions only inside the session-bound project
   root and never follows a file whose canonical path escapes it. The global
   `~/.pi/agent/AGENTS.md` loads first: Settings manages that fixed path, and a
   project's `AGENTS.md` is managed from its Projects list-menu action over an
   IPC that accepts only a host-core-registered project root.
2. Per project directory the first non-empty candidate wins:
   `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`.
3. Sources concatenate from root to target directory under independent 32 KiB
   UTF-8 budgets for the global file and the project chain, so an oversized
   global file never removes project instructions. A file cut at its budget keeps
   whole UTF-8 characters and gets a notice naming the source with loaded and
   total byte counts, and project files after a truncated one are not loaded.
4. The root chain loads at runtime creation. Before a file-path tool executes,
   the sidecar may request a path-specific chain through the Electron-owned
   `project.instructions.resolve` local proxy and never reads instruction files
   directly. Main registers the session-bound project root before each prompt or
   compaction request, so the proxy resolves against that binding rather than a
   per-file `session.get` RPC.

## Consequences

- Repository-wide rules load without a recursive scan, global defaults stay
  editable without a project, and nested rules appear only when a file tool
  touches a matching path and replace the active chain, so sibling rules cannot
  leak into later calls.
- Path-specific resolution is best-effort and bounded at two seconds; an
  unavailable resolver falls back to the base chain, and preflight keeps its own
  duration and markers so `hostRttMs` still describes the host tool call.

## Alternatives

- Load every nested file at startup: rejected, monorepos would inject unrelated
  rules before the task identifies a directory.
- Let the sidecar scan the workspace: rejected, discovery stays in main so
  containment is explicit for model-directed paths.

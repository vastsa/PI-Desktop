# ADR 0037: Resolve project instructions in Electron main

- Status: Accepted
- Date: 2026-07-30
- Updated: 2026-10-08 (independent global and project budgets; visible
  truncation notice, issue #1490)
- Related: [Agent runtime](../spec/03-runtime/02-agent-runtime.md)

## Context

PI-Desktop initially loaded only `<project root>/AGENTS.md` at runtime
creation. That omits directory-specific rules in monorepos and provides no
compatibility path for projects that use `CLAUDE.md`. Letting the model-driven
agent sidecar scan the workspace would weaken the existing boundary that keeps
workspace file access in Electron main and host-core.

## Decision

1. Electron main resolves instructions only inside the session-bound project
   root; it never follows an instruction file whose canonical path escapes that
   root.
2. The global file `~/.pi/agent/AGENTS.md` is loaded before all project
   entries. Settings manages this fixed path. A project's `AGENTS.md` is
   managed from that project's list-menu action in the Projects view; dedicated
   IPC accepts only a project root registered by host-core and never an
   arbitrary file path.
3. For every project directory, the first non-empty candidate wins in this order:
   `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`,
   `.claude/CLAUDE.md`.
4. Sources are concatenated from root to target directory. The global file and
   the project entries have independent 32 KiB budgets of UTF-8 content, so an
   oversized global file never removes project instructions. A file cut at its
   budget keeps whole UTF-8 characters and is followed by a notice that names
   the source and the loaded and total byte counts; project files after a
   truncated one are not loaded. Later, closer entries take precedence and
   each source is labelled in the prompt.
5. The root chain is loaded when the runtime is created. Before a file-path
   tool executes, the sidecar may request a path-specific chain through the
   Electron-owned `project.instructions.resolve` local proxy. The sidecar does
   not read instruction files directly.
6. Electron main passes the session-bound project root with runtime launch
   metadata and registers it before each prompt or compaction request. The
   local proxy resolves the target path against that main-owned binding instead
   of issuing a per-file `session.get` RPC. The sidecar caches one resolution
   claim per project-root/target-directory pair for the current prompt only.

## Consequences

- Repository-wide rules load without a recursive workspace scan.
- Global defaults are editable without a project; project instructions remain
  reviewable and versionable in the repository root.
- Nested rules become available only when an agent accesses a matching path.
  Each file tool replaces the active chain with that target's complete chain,
  preventing sibling-directory rules from leaking into later tool calls.
- Path-specific resolution is best-effort and bounded at two seconds. If the
  resolver or its host RPC is unavailable, the tool falls back to the base
  chain instead of waiting on the general host RPC deadline.
- Path preflight records its own duration and cache/fallback markers so
  `hostRttMs` continues to describe the actual host tool call.
- The instruction section can hold up to 64 KiB of file content: 32 KiB from
  the global file and 32 KiB from the project chain. This mirrors Codex, where
  `~/.codex/AGENTS.md` is loaded outside the 32 KiB `project_doc_max_bytes`
  budget that its project files share. A truncated file is visible to the
  model instead of ending silently.
- Root instruction changes rebuild an idle runtime on the next prompt. Nested
  rules are re-resolved for future file-path tool calls.
- This private sidecar proxy remains constrained to a session id and a path
  that Electron main validates against that session's project root.

## Alternatives

### Load every nested instruction file at startup

Rejected. Large monorepos could inject unrelated rules and consume the model
context before the task identifies a relevant directory.

### Let the sidecar scan the workspace

Rejected. The sidecar executes model-directed paths. Workspace discovery stays
in Electron main so the existing containment boundary remains explicit.

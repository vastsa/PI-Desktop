# ADR 0037: Resolve project instructions in Electron main

- Status: Accepted
- Date: 2026-07-30
- Updated: 2026-10-08 (independent global and project budgets; visible
  truncation notice, issue #1490)
- Related: [Agent runtime](../spec/03-runtime/02-agent-runtime.md)

## Context

PI-Desktop initially loaded only `<project root>/AGENTS.md` at runtime creation.
That omits directory-specific rules in monorepos and provides no compatibility
path for projects that use `CLAUDE.md`.

## Decision

1. Electron main resolves instructions only inside the session-bound project
   root; it never follows an instruction file whose canonical path escapes that
   root.
2. The global file `~/.pi/agent/AGENTS.md` is loaded before all project entries.
3. For every project directory, the first non-empty candidate wins in this
   order: `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`.
4. Sources are concatenated from root to target directory.
5. The root chain is loaded when the runtime is created.
6. Electron main passes the session-bound project root with runtime launch
   metadata and registers it before each prompt or compaction request.

## Consequences

- Repository-wide rules load without a recursive workspace scan.
- Global defaults are editable without a project; project instructions remain
  reviewable and versionable in the repository root.
- Nested rules become available only when an agent accesses a matching path.
- Path-specific resolution is best-effort and bounded at two seconds.
- Path preflight records its own duration and cache/fallback markers so
  `hostRttMs` continues to describe the actual host tool call.

## Alternatives

### Load every nested instruction file at startup

Rejected. Large monorepos could inject unrelated rules and consume the model
context before the task identifies a relevant directory.

### Let the sidecar scan the workspace

Rejected. The sidecar executes model-directed paths.

# ADR 0057: Permission-gated external paths and portable native search

- Status: Accepted for implementation (amended by D315)
- Date: 2026-08-05

## Context

Read/search tools were classified as low risk before their path resolver ran, so
an absolute path outside the workspace skipped the permission card and failed
later as `PATH_OUTSIDE_WORKSPACE`, which looked like a broken Plan turn. The host
already had bounded Rust `Read`/`Glob`/`Grep` implementations, but the sidecar
schemas exposed only part of their scoping controls.

## Decision

### 1. Explicit outside paths are permission-gated

For `Read`, `Glob`, `Grep`, `Write`, and `Edit`, the host classifies an explicit
path against the workspace and scratch roots before the risk matrix. Auto
executes it, Ask and Accept edits emit the inline permission request, Allow once
covers one call while Allow for session uses the existing tool-name grant, and
deny, timeout, or cancellation return `TOOL_DENIED`. Relative parent traversal
and symlink escapes follow the same rule, canonicalized resolution is reused, and
the external location never becomes a workspace root. Plan's hard deny for
Write/Edit/plugin/unknown tools still applies.

### 2. Native search is the portable default

The runtime exposes the full bounded contract: `Read` takes `offset` and
`limit`, `Glob` takes `path` and `limit`, `Grep` takes `path`, `include`,
`outputMode`, `headLimit`, and `caseInsensitive`. `outputMode` accepts
`content`, `filesWithMatches`, and `count`, with `files_with_matches` and
`files-with-matches` normalized as compatibility aliases. Grep may exec a
user-installed `rg` (D181 / D315) as an implementation backend without a shell,
keeping budgets and the same JSON shape, and falls back to the in-process
searcher when `rg` is missing or fails.

## Consequences

- Plan inspection outside the project waits for a user decision instead of
  failing at the resolver.
- Auto still suits fully automated sessions; Ask and Accept edits keep an
  explicit consent boundary.
- Search narrows scope and output before execution, reducing shell fallbacks
  and context growth; the security denylist and host-core authority remain.

## Alternatives rejected

- Keep returning `PATH_OUTSIDE_WORKSPACE`: rejected; a denied request is
  indistinguishable from a missing permission opportunity.
- Treat all low-risk reads as Auto: rejected; a low-risk read can still disclose
  data from an unrelated directory.

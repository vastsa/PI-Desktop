# ADR 0057: Permission-gated external paths and portable native search

- Status: Accepted for implementation (amended by D315)
- Date: 2026-08-05
- Baseline: `0.4.14`
- Protocol: v9
- Storage schema: v10

## Context

Read/search tools were classified as low risk before their path resolver ran.
An absolute path outside the session workspace therefore bypassed the normal
permission card and failed later as `PATH_OUTSIDE_WORKSPACE`. That made a
legitimate inspection request look like a broken Plan turn and gave the agent
an incentive to retry or replace the native tools with shell commands.

The host already had bounded, cross-platform Rust implementations for
`Read`/`Glob`/`Grep`, but the sidecar schemas exposed only a subset of their
scoping controls. Models could not reliably provide `path`, `include`,
`outputMode`, `headLimit`, `offset`, `limit`, or `Glob.limit`; some providers
also emitted a shell-style `files_with_matches` value that the host rejected.

## Decision

### 1. Explicit outside paths are permission-gated

For `Read`, `Glob`, `Grep`, `Write`, and `Edit`, the host classifies an explicit
path against the session workspace and scratch roots before applying the normal
risk matrix:

- Auto executes the explicit outside path without a card.
- Ask and Accept edits emit the existing inline permission request.
- Allow once covers only the current call; Allow for session uses the existing
  tool-name grant scope.
- Deny, timeout, and cancellation return `TOOL_DENIED` without execution.
- Relative parent traversal and symlink escapes use the same rule as absolute
  paths.

After approval, host-core resolves the path with the same canonicalized-ancestor
logic used for contained paths. It never turns the external location into a
new workspace root, and implicit Bash cwd or recursive walks do not gain this
exception. Successful external results report `root: "external"` where a root
field exists and keep absolute canonical paths visible to the model.

Plan's existing hard deny for Write/Edit/plugin/unknown tools remains above this
path rule.

### 2. Native search is the portable default

The runtime exposes the host's complete bounded search contract:

- `Read`: `offset` and `limit`;
- `Glob`: `path` and `limit`;
- `Grep`: `path`, `include`, `outputMode`, `headLimit`, and
  `caseInsensitive`.

`outputMode` exposes exactly `content`, `filesWithMatches`, and `count` in the
schema. The host also normalizes `files_with_matches` and
`files-with-matches` as compatibility aliases before execution.
Search guidance prefers workspace-relative paths and the native tools on every
platform. Grep may exec a user-installed `rg` when one is on the process PATH
or the Unix login PATH (D181 / D315). That is an implementation backend, not a
shell search: stdin is null, arguments are not quoted through a shell, and the
host still applies budgets, newest-first order, scoped ignore (`--no-ignore-parent`
when `path` is explicit), and the same JSON shape. A missing, overridden-invalid,
or failing `rg` (spawn error or exit 2) falls back to the in-process `ignore` +
`regex` searcher. `PI_DESKTOP_RG` selects a binary; `PI_DESKTOP_DISABLE_RG`
forces the fallback. Bash search remains a bounded last resort and still does
not assume POSIX utilities, PowerShell, or `rg` availability.

## Consequences

- A Plan inspection outside the project can wait for a clear user decision
  instead of failing at the resolver boundary.
- Auto remains suitable for fully automated sessions, while Ask and Accept
  edits preserve an explicit consent boundary for external data and mutations.
- Search requests can narrow scope and output before execution, reducing shell
  fallbacks, invalid output-mode retries, and context growth.
- External reads and searches are visible through absolute paths; external
  mutations do not create workspace Review or artifact records.
- The security denylist remains the default. This ADR changes the decision
  point for explicit paths, not the authority of host-core or the Bash cwd.

## Alternatives rejected

### Keep returning `PATH_OUTSIDE_WORKSPACE`

Rejected because the agent cannot distinguish a user-denied request from a
missing permission opportunity, and Plan loses a legitimate inspection path.

### Treat all low-risk reads as Auto

Rejected because a low-risk operation can still disclose data from an unrelated
directory. Scope and user consent must be evaluated separately.

### Use shell-specific search commands

Rejected because command availability and quoting differ across macOS, Linux,
and Windows, and unbounded shell output was a measured source of context
exhaustion. Execing `rg` from Grep is not this alternative: the model still
calls Grep, and host-core owns the result budget.

## Related docs

- `docs/spec/03-runtime/03-tools-and-permissions.md`
- `docs/spec/03-runtime/05-host-core-rust.md`
- `docs/spec/03-runtime/06-host-rpc-protocol.md`
- `docs/spec/03-runtime/08-error-codes.md`
- `docs/spec/03-runtime/15-workspace-ignore-rules.md`
- `docs/spec/03-runtime/16-tool-result-limits.md`
- `docs/spec/04-ux/03-permission-ux.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md` (E2E-019/E2E-019e)

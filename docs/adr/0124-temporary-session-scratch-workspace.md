# ADR 0124: Bind Temporary Sessions to Their Own Scratch Workspace

- Status: Accepted
- Date: 2026-08-26
- Related: ADR 0059, ADR 0118, Issue #16

## Context

Temporary sessions keep `projectPath` empty so they neither inherit nor mutate the
visible project, which left their native tools without a root even though each
session already owns a deterministic scratch directory under the data directory.
The empty home also reused one hero copy for a temporary chat and for no session.

## Decision

### 1. The scratch directory is the tool workspace

Host-core resolves a persisted path-less session's tool workspace to its own
`<data_dir>/scratch/<sessionId>` directory, creating it on first resolution. The
session schema is unchanged and `projectPath` stays absent.

### 2. Native tools root at the scratch directory

Read, Glob, Grep, Write, Edit, and Bash treat that directory as the root, never the
mutable global workspace, with existing containment and permission checks intact.
A missing-session compatibility call may keep the legacy fallback.

### 3. Plan and Goal keep the project requirement

Workspace validation for Plan and Goal still requires a persisted project binding,
so a scratch workspace does not widen contract-mode execution.

### 4. The empty home reflects the selected session

Project sessions keep the project welcome, temporary sessions show temporary-chat
copy without a project action, and no active session shows the generic welcome.

## Consequences

- Temporary chats use native tools without touching or inheriting a project.
- Relative paths work immediately; scratch data stays ephemeral and follows the
  existing deletion and startup sweep.
- No new session type or persistence migration is introduced.

## Alternatives

- Inherit the visible project: rejected because it breaks temporary-session
  isolation.
- Leave tools unavailable: rejected because it blocks otherwise isolated work.

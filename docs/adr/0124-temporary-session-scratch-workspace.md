# ADR 0124: Bind Temporary Sessions to Their Own Scratch Workspace

- Status: Accepted
- Date: 2026-08-26
- Related: Issue #16, ADR 0059, ADR 0118

## Context

Temporary sessions intentionally keep `projectPath` empty so they do not
inherit or mutate the currently visible project. That left their native tools
without a root, however, even though each session already owns a deterministic
`<data_dir>/scratch/<sessionId>` directory. The empty home also used the same
hero copy for a temporary chat and for having no active session.

## Decision

1. Host-core resolves a persisted path-less session's tool workspace to its own
   `<data_dir>/scratch/<sessionId>` directory and creates that directory when
   the binding is first resolved. The session schema remains unchanged and
   `projectPath` stays absent.
2. Read, Glob, Grep, Write, Edit, and Bash use that scratch directory as the
   temporary session's workspace root. The root is never taken from the
   mutable global workspace, and the existing containment and permission
   checks still apply. A missing-session compatibility call may retain the
   legacy global-workspace fallback.
3. Plan and Goal workspace validation continues to require a persisted project
   binding, so a scratch workspace does not broaden contract-mode execution.
4. The renderer derives the empty-home hero state from the selected session:
   project sessions retain the project-underlined welcome, temporary sessions
   show dedicated temporary-chat copy without a project action, and no active
   session shows the generic welcome.

## Consequences

- Temporary chats can safely use native tools without touching a project or
  inheriting the most recently active project.
- Relative tool paths in temporary chats are useful immediately; scratch data
  remains ephemeral and follows the existing session deletion/startup sweep.
- Temporary sessions remain visibly and structurally distinct from project
  sessions without introducing a new session type or persistence migration.
- Plan and Goal keep their existing project-root boundary.

## Alternatives considered

- **Inherit the visible project:** rejected because it violates the temporary
  session isolation invariant and can mutate unrelated project files.
- **Add a new persisted session type:** rejected because the existing
  path-less session model already provides the correct lifecycle and grouping.
- **Leave tools unavailable:** rejected because it makes temporary chats
  unable to perform otherwise isolated inspection and scratch work.

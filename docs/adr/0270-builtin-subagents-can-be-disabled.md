# ADR 0270: Builtin Subagents Can Be Switched Off

- Status: Accepted
- Date: 2026-09-17
- Related: D202, ADR 0062, ADR 0063, ADR 0112, ADR 0126

## Context

Settings > Agent > Subagents lists the shipped builtins next to user documents,
but only user documents had an enablement switch, because the builtins are
runtime constants and ADR 0063 §2 tied activation to the document scan that
prunes state for deleted files. Copying a builtin into `~/.agents/subagents` and
disabling the copy shadowed nothing, so a delegate the instructions steer toward
could not be turned off at all.

## Decision

Activation for a handle with no document lives in its own app-local file:
host-core stores switched-off builtin handles in
`<data>/agent-capabilities/subagent-builtins.json` because the user-document
scan would prune a builtin exclusion stored in `subagents.json`.
`agents.disabledBuiltins` reads them and `agents.setBuiltinEnabled(id, enabled)`
writes one, storing an unknown handle inertly since host-core does not ship the
builtin list. Electron main passes the disabled handles to
`loadSubagentDefinitions`, which drops them from `definitions` and returns every
builtin that still wins its handle in a sibling `builtins` field, and
`subagent/catalog` answers with both lists. Switching a builtin off is not
deleting it: a user document of the same handle still shadows it, and turning it
back on needs no document.

## Consequences

- The Built-in group gains the same optimistic switch as user rows, with no
  reveal or delete because there is still no file.
- A switched-off builtin stays listed and dimmed, which is the only way back on.
- An unreadable state file contributes no exclusions, so it offers a delegate
  the user had turned off rather than removing one they kept.
- No Markdown file is written and `~/.agents/subagents` remains the only
  user-managed subagent source (ADR 0063 §1, ADR 0112 §1).

## Alternatives

- A tombstone document under `~/.agents/subagents`: rejected, it writes a file
  the user never asked for and shows up in the Global group.
- State in `agent-capabilities/subagents.json`: rejected, the scan-time prune
  would delete a builtin exclusion as it was written.

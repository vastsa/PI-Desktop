# ADR 0270: Builtin Subagents Can Be Switched Off

- Status: Accepted
- Date: 2026-09-17
- Related: D202, ADR 0062, ADR 0063, ADR 0112, ADR 0126

## Context

Settings > Agent > Subagents lists two groups: the five shipped builtins
(`explorer`, `code-reviewer`, `test-runner`, `fixer`, `ui-designer`) and the
user's own `~/.agents/subagents/*.md` documents. Only the user group had an
enablement switch, because only those records are files: the builtins are
constants in `packages/agent-runtime`, and ADR 0063 §2 tied activation to the
document scan that prunes state for deleted files.

That left one delegate the user could not turn off. The only route was to copy a
builtin into `~/.agents/subagents`, disable the copy — and the shipped definition
still reached the catalog, because disabled user documents are filtered out
before the loader merges, so the copy shadowed nothing. Turning off a delegate
the instructions steer toward (a `fixer` that may write files, a `test-runner`
that may run commands) had no supported path at all.

## Decision

1. **Activation for a handle with no document lives in its own app-local file.**
   host-core stores switched-off builtin handles in
   `<data>/agent-capabilities/subagent-builtins.json`, keyed by `Task` handle at
   the global level. It is deliberately not `subagents.json`: the user-document
   scan prunes state for ids it can no longer see, a builtin is never scanned, so
   a shared file would drop every builtin exclusion on the next scan.
2. **Two RPCs own that state.** `agents.disabledBuiltins` reads the switched-off
   handles (sorted), `agents.setBuiltinEnabled(id, enabled)` writes one and
   echoes the normalized handle. A handle no current builtin uses is stored
   inertly rather than refused: host-core does not ship the builtin list, and a
   stale entry costs nothing.
3. **The catalog carries the switch, not the document.** Electron main supplies
   the disabled handles to `loadSubagentDefinitions`, which drops them from
   `definitions` — what `Task` may offer — and returns every builtin that still
   wins its handle in a sibling `builtins` field, switched off ones included, so
   Settings can render that row and its switch. `subagent/catalog` answers with
   both lists.
4. **Switching a builtin off is not deleting it.** A user document of the same
   handle keeps working and keeps shadowing the shipped definition, and turning
   the builtin back on needs no document, because nothing was removed.

## Consequences

- The Built-in group gains the switch the user rows already have, in the same
  place and with the same optimistic flip. Reveal and delete stay absent: there
  is still no file.
- A switched-off builtin stays listed and dimmed, which is the only way back on.
- Session launch and the Settings catalog read the same state, so the page shows
  what `Task` offers — the property E2E-SUBAGENT-settings-lists-builtin-defaults
  asserts.
- A host that is unavailable contributes no exclusions: an unreadable state file
  offers a delegate the user had turned off rather than removing one they kept.
- No Markdown file is written, no project capability layer appears, and
  `~/.agents/subagents` remains the only user-managed subagent source (ADR 0063
  §1, ADR 0112 §1).

## Alternatives

- **A tombstone document in `~/.agents/subagents`.** Switching a builtin off
  would write a file the user never asked for, show up in the Global group, and
  turn a one-click toggle into visible filesystem state.
- **Keeping the state in `agent-capabilities/subagents.json`.** Cheapest to
  write, but the scan-time prune that keeps deleted documents from leaving
  orphaned rows would delete a builtin exclusion at the same moment it was
  written.

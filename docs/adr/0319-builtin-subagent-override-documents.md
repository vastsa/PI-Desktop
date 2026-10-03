# ADR 0319: Builtin Subagents Can Be Retuned By Override Documents

- Status: Implemented candidate
- Date: 2026-10-04
- Related: D202, ADR 0062, ADR 0063, ADR 0270

## Context

Settings > Agent > Subagents lists the five shipped builtins
(`explorer`, `code-reviewer`, `test-runner`, `fixer`, `ui-designer`) next to the
user's own `~/.agents/subagents/*.md` documents. ADR 0270 gave every builtin an
enablement switch, but the switch is binary: a user who wanted the `fixer`
delegate with a stricter write policy, or `test-runner` pinned to a cheaper
model, had no supported way to get it.

The obvious workaround — copying the builtin's Markdown into
`~/.agents/subagents` and editing the copy — did not work either: user
documents outrank builtins by the merge order in `loadSubagentDefinitions`, but
the copy keeps the builtin's `name` only if the user reproduces it exactly,
and Settings then renders two rows that both claim the same handle, with the
enablement switches now ambiguous (the user document's switch governs the
user row, ADR 0063 §2, while the builtin row keeps its own).

We needed a first-class place where a shipped delegate can be retuned without
duplicating its row or fighting the activation model.

## Decision

1. **Overrides live in an app-owned directory inside the installation data
   dir.** `builtinSubagentOverridesDir(dataDir)` returns
   `<data>/subagent-overrides`; the directory does not exist by default.
   Documents are Markdown with the same frontmatter contract as user
   documents. The directory is read on every session launch and on every
   `subagent/catalog` request, alongside the other definition sources, so an
   edit reaches every session — open ones included — on its next prompt.
2. **An override retunes a builtin by name; it never adds a delegate.**
   `loadBuiltinOverrides` keeps a document only when its `name` matches a
   shipped builtin. A name no builtin uses is a load diagnostic (visible in
   the catalog's diagnostics surface), not a new delegate: new delegates
   belong in `~/.agents/subagents`.
3. **Overrides parse as `builtin` source.** They reach the merge as
   `source: "builtin"`, so:
   - the ADR 0270 Settings switch keeps governing the handle — switching a
     builtin off also switches off its retuned definition, and the Settings
     row shows the retuned document, not a second row;
   - user documents still outrank overrides: a user document with the same
     name wins the handle over both the override and the shipped definition.
4. **Merge order is user documents, overrides, builtins.** The existing
   `mergeSubagentDefinitions` first-wins rule applies unchanged; overrides sit
   between the user registry and the shipped constants.
5. **Electron main wires the directory, the loader stays directory-agnostic.**
   `createSessionLaunchRuntime` and the `subagent/catalog` IPC both pass
   `builtinOverridesDir: builtinSubagentOverridesDir(dataDir)`; the loader
   accepts it as an option and never computes it itself. The override
   directory therefore travels with the app data dir, including test
   harnesses that point `dataDir` at a temp directory.

## Consequences

- Retuning a shipped delegate is now an edit-and-save operation in an
  app-owned directory; no settings UI is required to ship the capability.
- The five shipped definitions remain the only handles a session may offer
  unless the user adds documents; the override directory cannot grow the
  catalog.
- A stale override (name no longer shipped) surfaces as a diagnostic rather
  than disappearing silently; the user sees why the retune stopped applying.
- Disabled-builtin state (ADR 0270) is untouched: it still keys the handle,
  and it governs the retuned definition exactly as it governs the shipped
  one.

## Alternatives considered

- **Copy the builtin into `~/.agents/subagents` and edit it.** Rejected: two
  rows claim one handle, activation splits across both switches, and deleting
  the document silently reverts to the shipped definition with no signal.
- **Settings UI for editing builtins in place.** Rejected for now: it needs
  an editor surface, a draft model, and conflict handling with the shipped
  constants — cost that a directory of Markdown documents does not carry. The
  directory is also scriptable and diffable; a UI can later write the same
  documents.
- **A per-builtin settings blob in host-core state.** Rejected: it splits the
  definition format across two stores and makes the catalog's
  document-scan diagnostics inapplicable.

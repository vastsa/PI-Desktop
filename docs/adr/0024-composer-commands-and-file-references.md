# ADR 0024: Composer Slash Commands and @ File References

- Status: Accepted
- Date: 2026-07-27
- Deciders: PI-Desktop core
- Related: D123, D124, D125, D197, D209, D250, ADR 0019, ADR 0059, ADR 0070, ADR 0106, D114, D119

## Context

The composer is a plain textarea: the command palette holds app commands, but the
chat input has no in-place command system and no way to reference workspace
files, and spec 08 §11.7 scope-cut both. The embedded pi runtime defines both
concepts for its CLI:

- **Prompt templates**: markdown files in `.pi/prompts/` and
  `~/.pi/agent/prompts/` with `description` / `argument-hint` frontmatter.
  `/name args` expands client-side and is sent as an ordinary user message, so
  the model never sees the slash form.
- **`@path` references**: literal prompt text the model follows up on with its
  Read tool — no inlining, no attachment conversion.

PI-Desktop uses the low-level `Agent` class, so neither is active today, although
the installed package exports the reusable loader and expansion helpers.

## Decision

1. **Slash commands come from three merged sources**: pi prompt templates
   (project directory overrides user-global on a name conflict), the builtin
   command-palette registry holding the five core commands (ADR 0106), and plugin
   palette commands executed via `commandPalette/execute`. Unknown `/foo` is sent
   as literal text, matching the pi CLI.
2. **Template expansion happens in the Electron main `agent/prompt` handler
   before persistence.** The persisted user message stores `content` (expanded)
   plus an optional `command` field with the typed invocation, so agent reseed
   replays identical model context and the transcript renders a compact chip.
3. **`@path` stays a plain-text light reference** at dispatch. Fuzzy autocomplete
   inserts `@dir/` when a directory is accepted, and completed files become
   renderer-owned compact references (ADR 0070) that serialize to
   `@relative/path ` (quoted when the path contains spaces); Plan and Agent both
   carry Read/Glob/Grep. Nothing is inlined, and clipboard files or images
   arrive as session-scratch references (ADR 0059) instead of pi-ai
   `ImageContent`.
4. **Electron main serves the workspace file index**, not agent tools, so
   user-initiated browsing raises no permission prompts or audit entries (ADR
   0019). Read-only `pi-desktop/fs/index` returns up to 8000 workspace-rooted
   entries and `pi-desktop/composer/commands` returns the merged command list;
   both fail soft without a workspace and change no host RPC version.
   *(Amended by D669: while that index is truncated, `pi-desktop/fs/search`
   answers a typed query from the full listing.)*

## Alternatives

- Expand templates in the agent sidecar: main persists the message first, so
  reseed could not replay the expansion without a second write path. Rejected.
- Migrate the runtime to `AgentHarness`: replaces the whole prompt/loop
  integration for one feature. Rejected; the helpers give identical semantics.
- Inline referenced file content: inflates context and needs truncation rules and
  a binary attachment channel. Rejected; the Read-tool reference is pi's
  interactive semantic.

## Consequences

- The composer gains a keyboard-first autocomplete surface (D125 defines the IME
  contract), and `.pi/prompts` templates become assets shared with the pi CLI.
- The transcript user message gains an optional `command` field that renderers
  may ignore; inline binary attachments stay deferred.

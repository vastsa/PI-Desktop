# ADR 0024: Composer Slash Commands and @ File References

- Status: Accepted
- Date: 2026-07-27
- Deciders: PI-Desktop core
- Related: D123, D124, D125, D197, D209, D250, ADR 0019 (work panel subsystems), ADR 0059 (clipboard file paste), ADR 0070 (compact reference display), ADR 0106 (core five builtin commands), D114 (scratch dir), D119 (transcript file store)

## Context

The composer is a plain textarea today. The command palette (Cmd/Ctrl+Shift+P)
holds app commands, but the chat input itself has no in-place command system and
no way to reference workspace files, and spec 08 §11.7 explicitly scope-cut
both.

- **Prompt templates**: markdown files in `<workspace>/.pi/prompts/` and
  `~/.pi/agent/prompts/` with `description` / `argument-hint` frontmatter.
- **`@path` references**: literal text in the prompt; the model follows up with
  its Read tool.
- pi's built-in slash commands (`/new`, `/model`, …) are client-side behaviors
  of its TUI, not runtime features.

## Decision

1. **Slash commands come from three sources**, merged into one composer menu: pi
   prompt templates (project dir overrides user-global on name conflict), the
   builtin command-palette registry (slash aliases defined in
   `electron/main/builtin-commands.ts`, executed by the existing renderer-side
   switch), and plugin palette commands (executed via `commandPalette/execute`).
2. **Template expansion happens in the Electron main `agent/prompt` handler,
   before persistence.** The persisted user message stores `content = expanded
   text` plus a new optional `command` field holding the typed invocation
   (`/name args`).
3. **`@path` stays a plain-text light reference** exactly like pi CLI at prompt
   dispatch.
4. **Workspace file index is served by Electron main**, not agent tools — same
   rationale as ADR 0019: user-initiated browsing must not spam permission
   prompts or the audit trail.

## Alternatives considered

- **Expand templates in the agent sidecar**: keeps pi imports in one place, but
  main persists the user message first, so the sidecar cannot influence what
  reseed replays without a second write path.
- **Migrate the runtime to `AgentHarness`** for `promptFromTemplate`: replaces
  the whole prompt/loop integration for one feature.
- **Inline referenced file content into the prompt** (pi CLI argument-mode
  behavior): inflates context, needs truncation rules and an attachment channel
  for binaries.
- **Reuse `fs/list` recursively from the renderer**: one IPC round-trip per
  directory level makes fuzzy search sluggish and chatty.

## Consequences

- The composer gains a keyboard-first autocomplete surface (D125 defines the
  interaction/IME contract — the first explicit IME spec in the project).
- `.pi/prompts` templates become shared assets between pi CLI and PI-Desktop.
- The transcript user-message schema gains an optional `command` field;
  renderers that ignore it keep working.
- Inline binary attachments and preview tiles remain deferred.

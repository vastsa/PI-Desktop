# ADR 0024: Composer Slash Commands and @ File References

- Status: Accepted
- Date: 2026-07-27
- Deciders: PI-Desktop core
- Related: D123, D124, D125, D197, D209, D250, ADR 0019 (work panel subsystems), ADR 0059 (clipboard file paste), ADR 0070 (compact reference display), ADR 0106 (core five builtin commands), D114 (scratch dir), D119 (transcript file store)

## Context

The composer is a plain textarea today. The command palette (Cmd/Ctrl+Shift+P)
holds app commands, but the chat input itself has no in-place command system
and no way to reference workspace files, and spec 08 §11.7 explicitly
scope-cut both. The embedded pi runtime (`@earendil-works/pi-agent-core`
0.82) natively defines both concepts for its CLI:

- **Prompt templates**: markdown files in `<workspace>/.pi/prompts/` and
  `~/.pi/agent/prompts/` with `description` / `argument-hint` frontmatter.
  `/name args` is expanded client-side (`parseCommandArgs` +
  `substituteArgs`: `$1..$n`, `$@`, `$ARGUMENTS`, `${@:N:L}`) and sent as an
  ordinary user message — the model never sees the slash form.
- **`@path` references**: literal text in the prompt; the model follows up
  with its read tool. No inlining, no attachment conversion.
- pi's built-in slash commands (`/new`, `/model`, …) are client-side
  behaviors of its TUI, not runtime features.

PI-Desktop uses the low-level `Agent` class (not `AgentHarness`), so none of
this is active in the desktop today, but the loader/expansion helpers are
exported by the installed package and directly reusable.

## Decision

1. **Slash commands come from three sources**, merged into one composer menu:
   pi prompt templates (project dir overrides user-global on name conflict),
   the builtin command-palette registry (slash aliases defined in
   `electron/main/builtin-commands.ts`, executed by the existing
   renderer-side switch), and plugin palette commands (executed via
   `commandPalette/execute`). The builtin registry is intentionally limited to
   the five core entries defined by ADR 0106. Unknown `/foo` is sent as literal
   text (pi CLI parity).
2. **Template expansion happens in the Electron main `agent/prompt`
   handler, before persistence.** The persisted user message stores
   `content = expanded text` plus a new optional `command` field holding the
   typed invocation (`/name args`). Agent reseed replays `content`, so the
   model context stays identical across restarts; the transcript renders the
   `command` field as a compact chip. Extra message fields are already
   tolerated by host storage (revision* precedent).
3. **`@path` stays a plain-text light reference** exactly like pi CLI at prompt
   dispatch. The composer provides fuzzy autocomplete; directory acceptance
   inserts `@dir/` so completion can continue, while completed files become
   renderer-owned compact references under ADR 0070. Before dispatch those
   references serialize to `@relative/path ` (quoted `@"a b.txt"` when the
   path contains spaces). Plan and Agent carry read/glob/grep, so references
   work in both. No content inlining or binary content enters the prompt. OS
   clipboard file/image paste is materialized as a session-scratch file
   reference by ADR 0059; it does not use pi-ai `ImageContent` or change the
   text-only prompt contract.
4. **Workspace file index is served by Electron main**, not agent tools —
   same rationale as ADR 0019: user-initiated browsing must not spam
   permission prompts or the audit trail. New read-only channel
   `pi-desktop/fs/index` returns up to 8000 workspace-rooted entries
   (`git ls-files -co --exclude-standard` fast path, ignore-set walk
   fallback, short TTL cache); `pi-desktop/composer/commands` returns the
   merged command list. Both fail soft without a workspace. These
   Electron-only channels do not change the host RPC protocol version.

## Alternatives considered

- **Expand templates in the agent sidecar**: keeps pi imports in one place,
  but main persists the user message first, so the sidecar cannot influence
  what reseed replays without a second write path. Rejected.
- **Migrate the runtime to `AgentHarness`** for `promptFromTemplate`:
  replaces the whole prompt/loop integration for one feature. Rejected for
  now; the standalone helpers give identical semantics.
- **Inline referenced file content into the prompt** (pi CLI argument-mode
  behavior): inflates context, needs truncation rules and an attachment
  channel for binaries. Rejected — the read-tool light reference is pi's
  interactive semantic and costs nothing.
- **Reuse `fs/list` recursively from the renderer**: one IPC round-trip per
  directory level makes fuzzy search sluggish and chatty. Rejected.

## Consequences

- The composer gains a keyboard-first autocomplete surface (D125 defines the
  interaction/IME contract — the first explicit IME spec in the project).
- `.pi/prompts` templates become shared assets between pi CLI and
  PI-Desktop.
- The transcript user-message schema gains an optional `command` field;
  renderers that ignore it keep working.
- Inline binary attachments and preview tiles remain deferred. Compact textual
  reference chips are renderer-only draft state under ADR 0070; clipboard
  files/images still use session-scratch `@` references as defined by ADR 0059.

# ADR 0108: Remove the built-in interactive terminal

- Status: Accepted
- Date: 2026-08-19
- Deciders: PI-Desktop maintainers
- Related: [ADR 0019](0019-work-panel-subsystems.md) ·
  [ADR 0105](0105-files-as-a-bundled-plugin.md) ·
  [01-ui-ia](../spec/04-ux/01-ui-ia.md) ·
  [08-component-spec §5](../spec/04-ux/08-component-spec.md) ·
  [01-ipc-protocol §13a](../spec/03-runtime/01-ipc-protocol.md) ·
  E2E-058
- Supersedes in part: D249 and the interactive-terminal clauses of ADR 0019
  and ADR 0105; records D251

## Context

The work panel carried an interactive shell backed by a PTY in Electron Main and a
terminal renderer. It was separate from the agent's non-interactive `Bash` tool and
added a native module, renderer dependencies, terminal-specific IPC, packaging rules,
and a second shell lifecycle, while the product does not need to own an interactive
shell to keep Agent Bash useful.

## Decision

1. Remove the work-panel interactive terminal. The panel keeps plugin-contributed
   views including the bundled Files and Browser views (ADR 0170), artifact file
   tabs, and the Review tab the user opens themselves (D451).
2. Keep Agent Bash unchanged: a permission-aware, non-interactive tool whose
   command, output, status, copy behavior, and `IconTerminal` presentation stay in
   the transcript, and generic lifecycle values such as `"terminal"` in plan refresh
   state remain valid.
3. Delete the terminal-only Main manager, renderer components and styles, IPC
   channels, shared payload types, and terminal tests, along with the PTY/xterm
   dependencies and their build configuration.
4. Do not replace it with a plugin PTY API — interactive shell access is delegated to
   an external terminal — and do not increment the frozen desktop protocol version,
   since the removed channels were desktop IPC additions.

## Consequences

- The work panel has no shell tab or launcher, packaging drops the PTY native module
  and terminal renderer dependencies, and interactive shell work moves to an external
  terminal while Agent Bash remains the in-app bounded path.
- Historical D099 and D249 records remain history, but their terminal clauses are
  superseded here.

## Alternatives

- Keep the PTY in the host: a second shell lifecycle and native dependency for a
  surface the product no longer owns.
- Move the PTY into a plugin: a plugin PTY permission would grant arbitrary execution
  as the user.
- Turn Agent Bash into an interactive terminal: that changes the agent protocol and
  security model instead of removing a work-panel surface.

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

The work panel previously included an interactive shell backed by a PTY in
Electron Main and a terminal renderer in the work-panel UI. That surface was
separate from the agent's non-interactive `Bash` tool, but it added a native
module, renderer dependencies, terminal-specific IPC, packaging rules, and a
second shell lifecycle to the desktop application.

## Decision

1. Remove the work-panel interactive terminal.
2. Keep Agent Bash unchanged.
3. Delete the terminal-only Electron Main manager, renderer component and
   styles, IPC invoke/event channels, shared terminal payload types, and
   terminal-specific tests.
4. Do not replace the removed surface with a plugin PTY API.
5. Do not increment the frozen desktop protocol version.

## Consequences

- The work panel has no interactive shell tab or terminal launcher, and its
  empty state lists the Review row, Browser, and in-scope plugin views.
- Desktop packaging no longer carries the PTY native module or terminal renderer
  dependencies, reducing native build and release surface.
- Interactive shell workflows require an external terminal.
- Historical D099/D249 records remain useful as history, but their terminal
  implementation and retention clauses are superseded by this decision.

## Alternatives considered

### Keep the PTY in the host

Rejected: it preserves a second shell lifecycle and native dependency for a
surface the product no longer needs to own.

### Move the PTY into a plugin

Rejected: a plugin PTY permission would grant arbitrary execution as the user,
and a bundled-only channel would create a private trust-boundary exception.

### Turn Agent Bash into an interactive terminal

Rejected: Bash is intentionally bounded, permission-aware, and transcript-
owned.

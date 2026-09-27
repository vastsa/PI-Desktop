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

The product does not need to own an interactive shell to keep Agent Bash
useful. Users who need an interactive shell can use the external terminal
provided by their operating system or development environment, while command
invocations and bounded output remain visible in the conversation.

## Decision

1. Remove the work-panel interactive terminal. The panel retains
   plugin-contributed views including the bundled Files and Browser views
   (ADR 0170), and Review/file tabs opened by conversation artifacts.
2. Keep Agent Bash unchanged. It remains a permission-aware, non-interactive
   agent tool whose command, output, status, copy behavior, and `IconTerminal`
   presentation stay in the transcript. Generic lifecycle values such as
   `"terminal"` in plan refresh state are unrelated and remain valid.
3. Delete the terminal-only Electron Main manager, renderer component and
   styles, IPC invoke/event channels, shared terminal payload types, and
   terminal-specific tests. Remove the PTY/xterm dependencies and their
   build, unpack, and lockfile configuration.
4. Do not replace the removed surface with a plugin PTY API. Interactive shell
   access is intentionally delegated to an external terminal, and no new
   plugin permission or private bundled-plugin channel is introduced.
5. Do not increment the frozen desktop protocol version. The removed channels
   were desktop IPC additions; Agent Bash, host RPC, and the shared lifecycle
   protocol remain unchanged.

## Consequences

- The work panel has no interactive shell tab or terminal launcher, and its
  empty state lists Browser and in-scope plugin views only.
- Desktop packaging no longer carries the PTY native module or terminal
  renderer dependencies, reducing native build and release surface.
- Interactive shell workflows require an external terminal. Agent Bash remains
  the in-app path for bounded, model-directed command execution.
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
owned. Changing it into a long-lived interactive session would alter the agent
protocol and security model rather than simply removing the work-panel surface.

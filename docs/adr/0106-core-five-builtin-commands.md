# ADR 0106: Keep only five core builtin commands

- Status: Accepted
- Date: 2026-08-19
- Deciders: PI-Desktop core
- Related: D250, ADR 0024, ADR 0034, `04-ux/04-builtin-commands.md`

## Context

The first-party command registry had grown to fifteen entries while the composer
`/` menu and global-search Commands section exposed several actions that already
had dedicated UI surfaces. It also retained dispatch-only aliases and
specification-only IDs that were no longer registered.

## Decision

1. Freeze the first-party registry at exactly these five IDs:
   `builtin.session.new`, `builtin.agent.compact`, `builtin.mode.agent`,
   `builtin.mode.plan`, and `builtin.mode.goal`.
2. Keep the matching aliases `/new`, `/compact`, `/agent-mode`, `/plan-mode`,
   and `/goal-mode`.
3. Remove the session deletion, abort, project, settings, plugin, log,
   session-rename, command-palette, reload-window, and DevTools entries from the
   builtin registry and renderer dispatch.
4. Keep plugin command contributions and dedicated UI actions independent of
   this registry.

## Consequences

- Global search and the composer `/` menu have a smaller, stable first-party
  command surface.
- New-task, compaction, and mode switching remain keyboard- and slash-first
  workflows.
- Abort, delete, project, settings, plugin, log, reload, and DevTools actions
  remain available only through their dedicated controls or surfaces where those
  workflows still exist; they are not discoverable as builtin commands.
- Unknown former aliases fall through as ordinary slash text unless another
  command source contributes the same name.

## Alternatives considered

### Keep all app-navigation commands in the registry

Rejected: project, settings, plugin, and diagnostic actions duplicate existing
surfaces and compete with task-oriented commands in global search.

### Preserve old IDs as hidden compatibility aliases

Rejected: hidden aliases still expand the command contract and keep dead entries
executable from stale UI or copied invocations.

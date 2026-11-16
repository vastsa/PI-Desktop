# ADR 0106: Keep only five core builtin commands

- Status: Accepted
- Date: 2026-08-19
- Related: D250, ADR 0024, ADR 0034

## Context

The first-party command registry had grown to fifteen entries while the composer
`/` menu and the global-search Commands section exposed actions that already had
dedicated UI surfaces, and it kept dispatch-only aliases and specification-only
IDs that were no longer registered.

## Decision

1. Freeze the first-party registry at exactly `builtin.session.new`,
   `builtin.agent.compact`, `builtin.mode.agent`, `builtin.mode.plan`, and
   `builtin.mode.goal`.
2. Keep the matching aliases `/new`, `/compact`, `/agent-mode`, `/plan-mode`, and
   `/goal-mode`; mode aliases keep the one-shot form, switching mode first and
   sending the remaining text as the visible user turn.
3. Remove the session deletion, abort, project, settings, plugin, log,
   session-rename, command-palette, reload-window, and DevTools entries from the
   builtin registry and renderer dispatch, along with the legacy `newChat`,
   `openProject`, and `openSettings` dispatch aliases.
4. Keep plugin command contributions and dedicated UI actions independent of this
   registry; an old builtin ID is not a compatibility alias.

## Consequences

- The `/` menu and global search keep a smaller, stable first-party surface; the
  removed actions remain on their dedicated controls.
- Unknown former aliases fall through as ordinary slash text unless another
  command source contributes the same name.

## Alternatives

- Keep app-navigation commands in the registry: they duplicate existing surfaces.
- Preserve old IDs as hidden compatibility aliases: hidden aliases still expand
  the command contract.

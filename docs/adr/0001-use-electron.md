# ADR 0001: Use Electron as the desktop shell

- Status: Accepted
- Date: 2026-07-25

## Context

PI-Desktop needs desktop distribution, local permission control, session UI, and
system integration capabilities. The main candidate options are Electron and
Tauri.

## Decision

Adopt **Electron** as the desktop shell.

## Rationale

1. Close to the technical path of the already-researched ChatGPT Desktop /
   WorkBuddy, making it easier to draw on their engineering experience
2. Smoother fit between the Node ecosystem and pi's TypeScript runtime
3. More mature native modules, debugging toolchain, and packaging resources
4. The team's current roadmap clearly prefers Electron

## Consequences

### Positive
- Fast development speed
- The agent runtime can be placed directly on the main/node side
- Later integration of pty, sqlite, and auto-update is more conventional

### Negative
- Heavier bundle size and memory footprint relative to Tauri
- Requires strict enforcement of the Electron security baseline

## Alternatives

- Tauri 2: lighter, but inconsistent with the current roadmap; dropped as the
  MVP baseline

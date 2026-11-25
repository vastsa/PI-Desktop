# ADR 0001: Use Electron as the desktop shell

- Status: Accepted
- Date: 2026-07-25

## Context

PI-Desktop needs desktop distribution, local permission control, session UI, and
system integration. The candidates were Electron and Tauri.

## Decision

Adopt **Electron**: it continues the researched ChatGPT Desktop / WorkBuddy path,
fits pi's TypeScript runtime in the Node ecosystem, has maturer native modules and
packaging tooling, and matches the roadmap.

## Consequences

Fast development and conventional pty, sqlite, and auto-update integration, at the
cost of a heavier bundle and a strictly enforced security baseline.

## Alternatives

- Tauri 2: lighter, but off the current roadmap; dropped as the MVP baseline.

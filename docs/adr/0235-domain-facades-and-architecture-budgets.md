# ADR 0235: Preserve Domain Facades and Enforce Architecture Budgets

- Status: Accepted
- Date: 2026-09-12

## Context

Several large desktop modules combined wiring with multiple domain
responsibilities. Splitting them reduces change coupling, but replacing
established entry points would break imports, source contracts, plugin
integrations, or protocol assumptions, and nothing stopped the same hotspots from
growing again.

## Decision

1. Keep stable facades at the established paths: Electron main `index.ts`,
   renderer page entries, shared `types.ts`, and the Rust `plugins`, `db`,
   `providers`, and `plans` modules.
2. Put implementation responsibility in domain modules — Electron IPC and runtime
   modules, renderer `features/*`, host-core domain submodules, and
   `packages/shared/src/types/*` — where a facade may wire or re-export but never
   become a second implementation.
3. Keep source-contract tests at the owning module boundary and shared E2E boot,
   session, plan, plugin, host, fixture, wait, and assertion helpers as the common
   test surface.
4. Enforce source-size budgets with `node scripts/check-architecture.mjs`, which
   protects the facade limits, rejects newly oversized TypeScript files, and
   requires a documented reason for oversized Rust files. It also warns when an
   existing oversized production file grows relative to the comparison base.
5. Run the focused Biome lint, architecture checker, Rust formatting, and
   workspace Clippy checks in CI alongside build, typecheck, and test.

## Consequences

- Import paths, IPC channels, plugin SDK contracts, host RPC data, and persisted
  formats stay stable while implementation ownership becomes easier to locate.
- New domain work has a clear home and is measured against size limits, with the
  remaining legacy modules documented as technical debt.

## Alternatives considered

- Replace the public modules with new paths: rejected; it makes compatibility
  every caller's and plugin's problem.
- Use an undocumented size exception: rejected; a ratchet without a reason lets
  new hotspots accumulate.

# ADR 0235: Preserve Domain Facades and Enforce Architecture Budgets

- Status: Accepted
- Date: 2026-09-12
- Deciders: PI-Desktop maintainers

## Context

The desktop application had several large modules that combined wiring with
multiple domain responsibilities. Splitting those modules reduces change
coupling, but replacing established entry points would break imports, source
contracts, plugin integrations, or protocol assumptions.

## Decision

1. Keep stable facade modules at established public paths.
2. Put implementation responsibility in domain modules: Electron IPC and runtime
   modules, renderer `features/*` modules, host-core domain submodules, and
   `packages/shared/src/types/*` files.
3. Keep source-contract tests at the owning module boundary and retain public
   re-export coverage for compatibility paths.
4. Enforce source-size budgets with `node scripts/check-architecture.mjs`.
5. Run the focused Biome lint, architecture checker, Rust formatting, and
   workspace Clippy checks in CI alongside the existing build, typecheck, and
   test gates.

## Consequences

- Existing import paths, IPC channels, plugin SDK contracts, host RPC data, and
  persistence formats remain stable while implementation ownership is easier to
  locate.
- New domain work has a clear home and is measured against source-size limits.
- A small set of legacy modules remains explicitly documented as technical debt
  instead of being expanded silently.
- The architecture checker adds a repository-level maintenance gate and its
  metrics make future refactor progress reviewable.

## Alternatives considered

- **Replace the public modules with new paths:** rejected because it would make
  compatibility the responsibility of every caller and plugin.
- **Apply a broad formatter or stylistic lint migration:** rejected because it
  would mix historical cleanup with the architecture change and obscure
  behavioral review.
- **Use an undocumented size exception:** rejected because a ratchet without an
  explicit reason would allow new hotspots to accumulate.

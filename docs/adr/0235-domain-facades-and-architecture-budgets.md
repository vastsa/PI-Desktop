# ADR 0235: Preserve Domain Facades and Enforce Architecture Budgets

- Status: Accepted
- Date: 2026-09-12
- Deciders: PI-Desktop maintainers

## Context

The desktop application had several large modules that combined wiring with
multiple domain responsibilities. Splitting those modules reduces change
coupling, but replacing established entry points would break imports, source
contracts, plugin integrations, or protocol assumptions. The repository also
needs a repeatable way to prevent the same hotspots from growing again.

The refactor covers Electron main IPC and runtime wiring, renderer pages,
host-core persistence and service domains, shared public types, and E2E test
infrastructure. These boundaries must preserve existing IPC channels, plugin
SDK behavior, host RPC data, and persisted formats.

## Decision

1. Keep stable facade modules at established public paths. Electron main
   `index.ts`, renderer page entry points, shared `types.ts`, and the Rust
   `plugins`, `db`, `providers`, and `plans` modules remain compatible facades
   over their domain implementations.
2. Put implementation responsibility in domain modules: Electron IPC and
   runtime modules, renderer `features/*` modules, host-core domain
   submodules, and `packages/shared/src/types/*` files. The facades may wire
   or re-export these modules but must not become a second implementation.
3. Keep source-contract tests at the owning module boundary and retain public
   re-export coverage for compatibility paths. Shared E2E boot, session, plan,
   plugin, host, fixture, wait, and assertion helpers are the common test
   surface for protocol and lifecycle suites.
4. Enforce source-size budgets with
   `node scripts/check-architecture.mjs`. The checker reports repository
   metrics, protects the main and store facade limits, rejects newly added
   oversized ordinary TypeScript files, and requires a documented reason for
   oversized Rust files. Exceptions are explicit and reviewed with the
   allowlist.
5. Run the focused Biome lint, architecture checker, Rust formatting, and
   workspace Clippy checks in CI alongside the existing build, typecheck, and
   test gates. Existing Clippy warnings remain visible while they are reduced
   in focused follow-up changes.

## Consequences

- Existing import paths, IPC channels, plugin SDK contracts, host RPC data,
  and persistence formats remain stable while implementation ownership is
  easier to locate.
- New domain work has a clear home and is measured against source-size limits.
- A small set of legacy modules remains explicitly documented as technical
  debt instead of being expanded silently.
- The architecture checker adds a repository-level maintenance gate and its
  metrics make future refactor progress reviewable.

## Alternatives considered

- **Replace the public modules with new paths:** rejected because it would
  make compatibility the responsibility of every caller and plugin.
- **Apply a broad formatter or stylistic lint migration:** rejected because
  it would mix historical cleanup with the architecture change and obscure
  behavioral review.
- **Use an undocumented size exception:** rejected because a ratchet without
  an explicit reason would allow new hotspots to accumulate.

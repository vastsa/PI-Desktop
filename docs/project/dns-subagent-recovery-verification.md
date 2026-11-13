# Native DNS and subagent recovery verification

Date: 2026-11-08
Status: Source integration verified within the checks below; not deployed.

## Result

The same worktree now contains native Desktop DNS and independent subagent
controls. Parent Stop remains parent-scoped, keeps existing children running,
and permits another parent prompt. Explicit user continuation can restore a
same-session interrupted child after restart, including a provider-created Task
with a saved task but no first reply. Model-issued resume restrictions, current
model authorization, context budgets, tool cancellation, and child ownership
remain enforced. Unfinished tools are not replayed automatically.

Native DNS settings, renderer controls/search/translations, Chromium resolution,
provider relay routing, Host HTTP routing, validation, persistence, and local-only
config-sync behavior are integrated. Unrelated settings writes preserve DNS.
Strict DoH does not silently fall back. Startup publishes only configured,
current sidecars; confirmed shutdown disposes an unpublished candidate. Plugin
recovery still finishes before agent startup. Existing retry, plugin watcher,
project capability layout, and child execution ownership repairs are preserved.

## Diagnosis correction

Read-only inspection of all ASAR JavaScript chunks established:

| Installation | Native DNS code/UI | Independent parent Stop |
| --- | --- | --- |
| D:/PI-Desktop (running at diagnosis) | Present | Missing |
| E:/PI-Desktop | Missing | Present |

The initial entry-file-only inspection incorrectly reported missing DNS in both
installations. That conclusion is superseded. The scratch diagnosis JSON now
records the correction and the three matching D archive chunks. Saved native DNS
preferences existed in DoH mode, with fallback disabled and the endpoint intact.
No real DNS, provider, agent-definition, or session configuration was changed.

## Main source locations

- `packages/agent-runtime/src/delegation-chain.ts`, `runtime.ts`: explicit user
  recovery of interrupted chains while keeping model resume restrictions.
- `apps/desktop/src/components/settings/NetworkDnsSection.tsx` and
  `NetworkProxySection.tsx`: restored DNS controls with validation and save states.
- `packages/shared/src/network-dns.ts`: shared normalization and validation.
- `apps/desktop/electron/main/network-dns.ts`, `network-proxy.ts`, settings IPC,
  and runtime startup: native resolver ownership and ordered configuration.
- `packages/agent-runtime/src/node-proxy.ts`, proxy relays, `socks5.ts`, and
  `sidecar.ts`: authenticated relay routing without changing parent-only Stop.
- `crates/host-core/src/network_dns.rs`, `network_proxy.rs`, settings RPC,
  plugin HTTP call sites, and config sync: persistence and Host transport.
- ADR 0348, native DNS ADR, runtime/settings specs, E2E scenarios, and unreleased
  notes describe the final behavior.

## Executed checks

Counts are per invocation and may overlap; they are not a single full-suite total.

| Check | Result | Scratch log stem |
| --- | --- | --- |
| Subagent runtime, chain, history, ownership, parent Stop | 117 passed | `subagent-dns-integrated-runtime` |
| Main IPC, child execution, terminal persistence, renderer continuation, quit guard | 39 passed | `subagent-dns-integrated-desktop-green` |
| DNS renderer user path and startup/plugin recovery races | 22 passed | `dns-ui-startup-final` |
| Real Chromium DoH with two local resolvers and real relay | 1 test / 7 checks passed | `dns-native-acceptance` |
| Desktop DNS/settings/catalog/proxy, retry UI, plugin hot reload | 85 passed | `dns-integrated-desktop-contracts` |
| Shared DNS and retry contracts | 28 passed | `dns-shared-contracts` |
| Runtime relay/transport and retry behavior | 69 passed | `dns-runtime-transport-retry` |
| Translation catalogs, renderer keys, user-facing copy | 31 passed | `dns-i18n-contracts` |
| Rust DNS/settings/relay/config-sync/retry/plugin HTTP regressions | 48 passed, 1,182 filtered | `dns-rust-replacement-scoped-regressions-20261108T053656-361200Z` |
| Shared, agent-runtime, i18n TypeScript compilation | Passed | `dns-shared-build`, `dns-runtime-build`, `dns-i18n-build-v2` |
| Desktop TypeScript no-emit check | Passed | `dns-desktop-typecheck` |
| Rust all-targets offline locked compile check | Passed | `dns-rust-replacement-compile-check-20261108T053939-576091Z` |
| Biome on the changed file within configured lint coverage | 1 file passed | `dns-scoped-biome` |
| Git diff whitespace and new Rust-line whitespace checks | Passed | `dns-subagent-final-diff-check`, Rust diff receipt |

All listed logs have successful exit receipts. Earlier RED failures, interrupted
commands, the stale-dist import failure, and the hidden-renderer synchronization
failures remain separate evidence and are not counted as passing. The native
Electron fixture used loopback services and only its certificate's SPKI; it did
not disable global TLS verification or modify installed Desktop processes.

Evidence directory for this session:
`C:/Users/23881/.pi-desktop/scratch/77cf8d0e-8800-4cc7-b284-0e694040c5be/`

## Preservation and limits

`dns-subagent-final-protection.json` verifies unchanged HEAD, REBASE_HEAD, index,
lockfile, both installed ASAR/sidecar originals, and the protected watcher/retry/
child-ownership files. Rust source hashes match the files tested by the delegate.
Read-only process inspection found no remaining task test processes.

- No installer, ZIP, plugin package, installation, runtime switch, or real-app
  restart was performed. The running D installation still needs an explicitly
  authorized deployment to receive these source changes.
- Rustfmt and Clippy could not run because the installed toolchain lacks those
  components. No toolchain/dependency installation was attempted. The existing
  unrelated `unused_mut` warning in `computer/backend.rs:128` remains.
- Some saved subagent definitions reference an unavailable provider. Bindings
  were not silently replaced; the user must select an available permitted model
  for those definitions or commands.
- No live external DNS/provider acceptance, package acceptance, overnight plugin
  soak, or unrelated desktop/native full suite was run. Historical full-suite
  failures remain separate and are not reclassified as harmless by this work.
- No Git staging, commit, fetch, rebase, push, or lockfile change was performed.

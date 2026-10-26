# Provider template accounts — candidate validation

Date: 2026-10-26. This record describes an uncommitted request candidate, not a
release, PR integration result, real-vendor certification or full-suite pass.

## Candidate

- Worktree: `worktrees/plugin-model-providers`; branch `feat/plugin-model-providers`.
- HEAD and fetched base main: `541471d55648df021b232b5d01f0e1dd14cbb033`.
- Candidate: that base plus the preserved, uncommitted feature/audit changes.
- SHA-256 of sorted `[path, SHA-256(file)]` pairs for the 99 changed/untracked
  source/test files under apps/packages/crates/scripts plus `pnpm-lock.yaml`:
  `450e4ec441c861734253e6b16ef69d25b5dafe05e49a9936afafa10aec9e563d`.
  Documentation is excluded to avoid a self-referencing report hash.
- Built debug Host SHA-256:
  `be1dc4b9b711f55b0716dc6afb1cabd6f84ab33c07052996983df5f0000b37a2`.
- Environment: Windows/Git Bash; Node 24.19.0, pnpm 12.8.1, Rust 1.98.1;
  existing workspace dependencies, isolated temporary profiles/plugin children.
- No commit, release/version update, application packaging, real credentials,
  external inference, paid API or running-user Desktop attachment.

## Delivered path and key modules

[Decision](../../adr/plugin-provider-template-accounts.md) and
[V1 contract/example](../07-plugins/17-provider-template-accounts.md) define the
separation: install adds a reusable service template; native setup creates
independent Host-generated accounts. Official services and legacy singleton
contributions retain their existing paths. Standard key/no-auth transport and
Host-run PKCE/device OAuth do not require custom execution grants. Proprietary
OAuth/inference requires separate trust, with fixed safe error channels.

SDK `provider-template.ts`, Rust `plugins/provider_templates.rs` and
`db/provider_templates_migration.rs`, Main `provider-template-oauth.ts` and
`plugin-provider-source.ts`, native `ProviderTemplateSetupForm.tsx`, shared
contracts and the existing inference broker/native model editor own their
respective responsibilities. Schema25 preserves legacy data without adopting
it. Runtime account invalidation now includes image calls and stale results.

## Checks actually executed

| Check | Result |
| --- | --- |
| `pnpm build:js` | Passed after correcting three VitePress source-link formats in the historical audit report; findings unchanged |
| Desktop typecheck | Passed, rerun after final implementation |
| `pnpm lint` | Passed (configured Biome scope and style-token gate, not universal source lint) |
| SDK `vitest run src` | 235 passed, source-only |
| Shared `vitest run src` | 656 passed, source-only; default run also passed but counted source/dist twice |
| DevKit `vitest run src` | 53 passed |
| i18n tests | 31 passed, nine catalogs including unsupported-probe copy |
| Agent targeted runtime/provider/subagent/image suites | 488 passed |
| Host-runtime provider inference | 4 passed |
| Desktop template/plugin-provider/vendor-OAuth/chooser/default/image-default selection | 168 passed |
| `cargo fmt --check` | Passed |
| Rust `providers::` | 71 passed |
| Rust `plugins::` | 124 passed, 1 ignored (overlaps provider filter; do not sum) |
| Rust `provider_template` | 6 passed: actual RPC/lifecycle/storage/cleanup/migration |
| `cargo clippy -p host-core --all-targets --locked` | Exit 0; four warnings remain |
| `cargo build -p host-core --locked` | Passed, debug candidate binary |
| Actual Host + plugin child E2E | 1 passed |
| `pnpm check:pr-base`, `git diff --check` | Passed |
| Added local documentation links | 44 checked, no missing destinations at link-check time |
| Documented JSON template manifest | Validated by built SDK `validateManifest` |

Red-green regressions additionally reproduced and fixed completed image-call
registration leaks, disabled-template reauthentication refusal, unexpired
credential resolution after disable/unload, account late-result rejection and
new-template cross-language validation gaps. SDK manifests serialize numeric
integers canonically; Rust still rejects noncanonical float/exponent JSON number
representations through its existing integer reader. Legacy validation was not
relaxed to accommodate the new template contract.

## Representative cross-process evidence

```sh
node --test apps/desktop/test/provider-template-native-host.e2e.mjs
```

The candidate Rust Host/database/encrypted secret store and actual plugin child
exercise install-without-account → two OAuth accounts → independent name/model
preferences and refresh → reauth without a third row → native chat completion
and subagent completion → image scratch output → one-account delete → restart
→ retained account/credentials/preferences → uninstall removes owned accounts
and secrets but retains the historical session. It uses synthetic OAuth and
adapter implementations, not a real provider. Unused tool dispatch is stubbed.

Separate native component tests cover chooser/key/no-auth setup and model
editing. Declarative-account fixtures execute public OAuth orchestration and
the actual PKCE loopback/device engine against a synthetic HTTPS boundary.
Lifecycle fixtures cover cancellation/unload, pending cleanup and privacy;
Rust RPC tests cover revocation, template removal/restoration, sensitive update,
restart and retryable failed cleanup. No single fixture claims the whole
application/window or live-service behavior.

## Full Host result and remaining blockers

`cargo test -p host-core --locked`: **1032 passed, 18 failed, 1 ignored**.
Failures are in `data_relocation::tests` (3), `rpc::remote_tools::tests` (2),
`rpc::worktree_rpc::tests` (3), `session_worktrees::delegate::tests` (2),
`session_worktrees::lifecycle::tests` (3), and
`session_worktrees::merge::tests` (5). Several actual/expected values differ by
Windows CRLF. These areas also failed in previous runs; a clean-base comparison
was not established, so this record does not certify them as unrelated or the
full Host suite as green. They remain a full-suite acceptance blocker.

Not run: whole-window Electron acceptance, `verify:ui:*`, real Antigravity or
other live-service OAuth/protocol/entitlement checks, paid generation,
Semgrep/CodeQL or dependency-security certification. Raw Node plugin code is
still trusted code, not an OS sandbox. Historical audit findings and fingerprints
remain historical, not evidence that these limitations disappeared.

Detailed command logs and the per-file candidate fingerprint are retained in
the session scratch directory (`template-final-*.log`,
`template-candidate-fingerprint.json`), not committed as application telemetry.

## PR 1897 current-main integration follow-up

This follow-up supersedes neither the historical record above nor its limitations.
The request worktree is `worktrees/pr-1897-main-conflicts`, branch
`fix/pr-1897-main-conflicts`. Base main is
`5aa253883c4e34fd65d31c434256d424c352bf0b`; preserved PR head is
`a2fadb33795e3b41df3656524e76c1f161ac7f27`. No push or remote merge is authorized.

Conflict resolution preserves discovery membership and plugin operation/image
filters together. Schema 26 orders discovery v24→v25 before templates v25→v26,
including template-only development v25 databases. Regression fixtures verify
saved accounts, synthetic credentials, model configuration, template identities,
sessions, readable backups and idempotent reopen. No production database is used.

- Sorted source/lockfile fingerprint (112 files, same algorithm as above):
  `8af8ea15392b59cd38e82f81edb2ffdabc54017ff408e74a34acc8478c612b45`.
- Candidate debug Host SHA-256:
  `954d5b4da5c6b11b2c1c343a87d6fd9345acd669f44a2ead18ef419a7821d239`.
- Environment: Windows/Git Bash, Node 24.19.0, pnpm 12.8.1, Rust 1.98.1.
  Third-party dependencies and Electron were reused. pnpm automatically
  materialized task-local links from the existing store (zero downloads).
  Rust dependency artifacts were copied without sharing mutable Host outputs.
- Passed: `pnpm build:js`, recursive package typecheck, `pnpm lint`,
  `pnpm docs:check`, `pnpm check:agent-policy`, `pnpm check:pr-base`,
  `cargo fmt --check`, `cargo build -p host-core --locked`, and
  `cargo clippy -p host-core --all-targets --locked` (four existing warnings).
- Passed source tests: shared 656, SDK 235, DevKit 53, i18n 31,
  Host Runtime 125 (3 skipped), Agent provider/runtime/subagent/image selection
  576, and Desktop template/plugin/OAuth/chooser/discovery/Composer selection 170.
- Passed Rust filters: `db::` 41, `plugins::` 124 (1 ignored), `providers::` 71,
  `turn_queue::` 12, `provider_template` 12. Filters overlap; do not sum them.
- Passed isolated E2E: `node scripts/e2e-model-discovery-state.mjs` and
  `node --test apps/desktop/test/provider-template-native-host.e2e.mjs
  apps/desktop/test/provider-template-cleanup-host.e2e.mjs` (2 tests).
- Full Host candidate: **1039 passed, 18 failed, 1 ignored**. A clean source
  snapshot of the same main, using the same toolchain, produced **1007 passed,
  the identical 18 failures, 1 ignored**. These are data-relocation (3), remote
  tool dispatch (2), and worktree (13) tests, including Windows path/CRLF issues.
  This is not a full-suite pass. A process-only autocrlf override did not fix it.
  After baseline comparison, Host artifacts were cleaned and the candidate was
  explicitly recompiled to prevent cross-source Cargo cache reuse.

Logs and fingerprints are session scratch artifacts prefixed `pr1897-`.
Whole-window Electron acceptance, real-provider checks, paid APIs and
`verify:ui:*` remain unrun. Original worktrees, local main, application profiles
and the untracked root `.workflow/` are unchanged.

# Provider template security remediation

This is a follow-up to the [read-only audit](2026-10-26_security-provider-template-accounts-report.md), not a rewrite of its findings or historical probes.

## Candidate and scope

- Branch: `feat/plugin-model-providers`, dedicated `worktrees/plugin-model-providers`.
- Base/HEAD: `541471d55648df021b232b5d01f0e1dd14cbb033` plus uncommitted implementation and remediation.
- Environment: Windows, Node 24.19.0, pnpm 12.8.1, Rust/Cargo 1.98.1; existing dependencies, temporary profiles and synthetic credentials only.
- Candidate implementation fingerprint: `170c960f25c462f12fea8684af612c7532e3962531685b144db62f14a15f319c` (103 modified/untracked implementation paths; sorted compact JSON `[path,SHA256(file)]`, scoped to apps/packages/crates/scripts and lockfile, docs excluded).
- Rebuilt debug Host SHA-256: `ebcc8ee33edaaa03901da193f8d0c5f76d733d2274c5a59f23b525c827fa3126`.
- Historical audit probe SHA-256 remains `bdf85cf80eb0690125baf9b6c19bdc8f0539d6fae6f6e885f9840ce21552aad5`. Those probes assert pre-fix defects and are not remediation acceptance tests.

## F-01: Fail-closed, retryable uninstall

`crates/host-core/src/plugins/provider_cleanup.rs` owns the cleanup lifecycle. A transaction disables **all** owned rows and stores Host-only `config_json.pluginCleanupPending: true` before registry removal or secret-file deletion. Failure to commit intent aborts before either destructive operation. No schema change or new plugin-manifest field is introduced.

Removal attempts every account and both API-key/OAuth channels even if an earlier deletion fails. A row remains as a disabled tombstone until its credentials and metadata can be erased. Registry failure does not skip credential cleanup. The internal `plugins.uninstall` RPC now rejects failures as `INTERNAL` (1000) with fixed, safe retry diagnostics, rather than returning `{ok:true}` or raw storage errors.

Reconciliation, account update/key changes, OAuth completion and low-level plugin enablement cannot clear or bypass tombstones. Startup, repeated uninstall (even after registration is gone), and same-ID registration retry cleanup. Successful recovery deletes old template accounts/grants; a new account needs explicit creation and login. Legacy singleton identity remains stable but cannot inherit the old credentials. Official/peer accounts and historical sessions are retained.

This does not promise successful physical erasure while the filesystem refuses deletion. It makes that failure observable and prevents account reuse until cleanup succeeds. Do not downgrade to an older binary that does not recognize the cleanup marker while cleanup is pending.

## F-02: Authenticate callback before acceptance

`apps/desktop/electron/main/provider-template-oauth.ts` shares callback parsing between the real loopback listener and the engine's post-I/O validation. Acceptance requires exactly one timing-safe matching state and exactly one bounded nonempty code **or** error, never both.

Invalid/duplicate/missing values receive generic HTTP 400 without settling login or exchanging a token. A later legitimate callback can finish within the original timeout. A valid state-bound denial still terminates login without token exchange. PKCE, cancellation, resource cleanup, HTTPS policy and manual token-endpoint redirects remain in force.

## Verification

Executed from the candidate worktree; logs are in the session scratch directory under `template-fix-*`.

| Check | Result |
| --- | --- |
| Uninstall red RPC regressions against prior code | 3 expected failures (`f01-red.log`) |
| OAuth red regression against prior listener | 17 tests, 16 passed / 1 expected failure |
| OAuth + declarative-account green tests | 21 passed |
| Template/custom/native OAuth and inference Desktop regression selection | 105 passed |
| `pnpm build:js` | Passed |
| Desktop typecheck | Passed |
| `pnpm lint` | Passed |
| `cargo fmt --check` | Passed |
| `cargo test -p host-core --locked provider_template` | 11 passed, including five uninstall fault regressions |
| `cargo test -p host-core --locked providers::` | 71 passed |
| `cargo test -p host-core --locked plugins::` | 124 passed, 1 ignored |
| `cargo clippy -p host-core --all-targets --locked` | Passed with 4 warnings (duplicated for test target) |
| `cargo build -p host-core --locked` | Passed; rebuilt binary above |
| Real Host remediation + native account E2E | 2 passed |
| `git diff --check`, `pnpm check:pr-base` | Passed |
| `pnpm docs:build` and incremental local links | Passed |

Rust filters overlap and must not be summed. The 21-test green run overlaps the 105-test selection.

Reproduce the cross-process acceptance after building JS and the Host, pinning `PI_DESKTOP_HOST_BIN` to this candidate's `target/debug/pi-desktop-host-core.exe` (or the non-Windows binary):

```sh
node --test apps/desktop/test/provider-template-oauth.test.mjs
cargo test -p host-core --locked provider_template
node --test apps/desktop/test/provider-template-cleanup-host.e2e.mjs apps/desktop/test/provider-template-native-host.e2e.mjs
```

The new cleanup E2E exercises actual RPC/process/SQLite/encrypted-store boundaries: multiple faults → truthful failure → unavailable rows → same-ID reload/enable → process restart → persistent failure → fault removal → retry → no old account/grant → fresh pending account. Rust RPC tests additionally cover registry persistence/atomic-intent failures, both credential channels, legacy identity, peer services and history. OAuth tests cover invalid-then-valid callbacks, valid denial, post-seam revalidation, timeout and cancellation. A bounded independent read-only review found no concrete blocker in these two fixes; the reviewer did not run tests.

## Limits and remaining acceptance

- This is targeted remediation, not full Host acceptance. The previous full Host run had 1032 passed / 18 failed / 1 ignored; this repair does not attribute or resolve those failures and did not rerun that unrelated full suite.
- No whole-window Electron or live-vendor OAuth/inference test was run; no running user Desktop or real credentials were used. `verify:ui:*` was not authorized or run.
- Semgrep/CodeQL were unavailable; no SAST, dependency-CVE or general sandbox certification is claimed. Installed Node plugins remain trusted code with raw Node I/O.
- No commit, publish, version bump, package or release action was performed.

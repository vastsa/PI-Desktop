# Provider template native-account security review

> **Historical snapshot:** this report records the pre-remediation state. Both findings were subsequently addressed; see [remediation evidence](remediation.md). The original findings below are retained for traceability.
>
> **Two verified findings remain open: conditional credential retention after uninstall (Medium), and first-callback login interruption (Low). No remediation was performed.**

## Executive summary

This review examined the current plugin-template/native-account implementation, not a released build. A real Rust Host fault-injection probe confirmed that uninstall can report success while retaining an enabled account and its OAuth grant; same-ID plugin registration before startup orphan cleanup preserves that grant. This is a pre-existing uninstall error-handling defect that also affects the new template accounts, not a newly introduced ownership bypass. An OAuth probe also confirmed that an invalid first callback consumes a pending login, without exchanging a code or leaking credentials. No high/critical vulnerability, cross-account credential read, or account-ownership takeover was confirmed within this scope. Installed Node plugin code remains trusted and unsandboxed; this review does not certify protection against a malicious installed plugin or real-vendor compatibility.

## Scope and target

See [scope](scope.md) for authorization, trust boundaries, offline restrictions and exclusions. Repository documentation is English; user-facing findings are summarized separately in Chinese. Report flavor: null, with a thin vulnerability-analysis overlay; no malware attribution, IOC or ATT&CK mapping applies.

| Item | Value |
| --- | --- |
| Review date | 2026-10-26, UTC+08:00 |
| Branch / HEAD | `feat/plugin-model-providers` / `541471d55648df021b232b5d01f0e1dd14cbb033` plus dirty implementation |
| Source fingerprint | `450e4ec441c861734253e6b16ef69d25b5dafe05e49a9936afafa10aec9e563d` (99 changed/untracked implementation files; method in scope) |
| Executed debug Host SHA-256 | `be1dc4b9b711f55b0716dc6afb1cabd6f84ab33c07052996983df5f0000b37a2` |
| Archived probe SHA-256 | `bdf85cf80eb0690125baf9b6c19bdc8f0539d6fae6f6e885f9840ce21552aad5` |
| Tools actually used | Git, structural/manual source review, Node v24.19.0, pnpm 12.8.1, Cargo 1.98.1, one bounded independent Rust review |
| Automated SAST | Semgrep and CodeQL unavailable on PATH; no installation or SAST certification |

The historical report under `docs/security/plugin-provider-audit/` describes an earlier implementation and is not overwritten or used as proof of current exploitability.

## Findings

| ID | Severity | Confidence | Status | Evidence | Location |
| --- | --- | --- | --- | --- | --- |
| F-01 | Medium, conditional | High for retention and same-ID reuse | Open; existing defect also affects templates | E-01, E-02 | `crates/host-core/src/rpc/mod.rs:5001`, `crates/host-core/src/providers/repository.rs:634` |
| F-02 | Low, availability only | High for known-port local request | Open; hardening opportunity | E-03 | `apps/desktop/electron/main/provider-template-oauth.ts:187` |

### F-01: Uninstall acknowledges success after credential cleanup fails

**Root cause.** `plugins.uninstall` unregisters the plugin first. A subsequent `remove_plugin_providers` error is only logged and the RPC still returns `{ok:true}` (`rpc/mod.rs:5012`). Removal iterates owned IDs and propagates the first failure (`plugins/providers.rs:537`). `delete_provider_row` deletes API-key and OAuth blobs before deleting the row, and returns immediately if either deletion fails (`providers/repository.rs:645`). No unavailable/tombstone state is committed before this cleanup.

**Verified result.** In a disposable real-Host profile, the probe creates and completes one OAuth template account with synthetic access/refresh tokens. It creates a directory at that account's unused API-key blob path, causing the first `remove_file` to fail deterministically. Uninstall returns success and removes the plugin registration, but `providers.get` still reports `enabled:true` and `hasOauth:true`; internal runtime secret retrieval returns the unchanged synthetic OAuth grant. Removing the injected obstacle and registering the same plugin ID in the same Host process retains the same enabled account and grant without another login.

**Impact and prerequisites.** The user receives a successful uninstall result while credential-erasure intent has not been fulfilled. Re-registration before the next successful orphan cleanup can recover the retained grant. A credential deletion/storage fault and a previously configured account are necessary. The probe uses controlled filesystem fault injection, not a remotely reachable method for inducing that fault. Retained credentials remain encrypted on disk: the internal RPC assertion is evidence of persistence, not a general-plugin secret-read exploit.

**Important limits.** Electron unloads plugin code before calling uninstall (`apps/desktop/electron/main/ipc/plugin-ipc.ts:397`); source-bound new calls normally reject an absent plugin. This review did **not** demonstrate continued inference after a normal UI uninstall, remote exploitation, or cross-account access. Startup reconciliation retries orphan removal (`plugins/providers.rs:599`), but that does not make the earlier success response truthful, and same-ID registration can occur first. Both the warning-only uninstall handler and early-return secret deletion are already present in HEAD; comparison establishes an existing defect, not a new regression caused by this feature.

**Recommended change, not applied.** Commit a disabled/unavailable cleanup-pending state for all owned rows before unregistering/removing secrets. Surface partial cleanup as a safe structured error or explicit pending result rather than success. Keep durable retry ownership, attempt cleanup for every owned account even if one fails, and do not let same-ID registration revive cleanup-pending grants. A database transaction alone cannot atomically delete external secret files. Add a regression covering deletion failure, immediate same-ID reinstallation, persistent failure and successful retry.

### F-02: Invalid first callback consumes an OAuth login

**Root cause.** The loopback listener checks method, host/origin and callback path, then sets `settled = true` and resolves on the first matching request (`provider-template-oauth.ts:194`). State validation occurs later (`:245`), after the listener has irrevocably accepted that request.

**Verified result.** A GET to the correct local callback with an incorrect state receives HTTP 200; the OAuth run fails with `OAUTH_STATE` and closes the listener. No token exchange is attempted. This corroborates the existing mismatch test but explicitly records the availability consequence.

**Impact and prerequisites.** A process able to address the active loopback port/path can interrupt that login attempt. The random port must be known or discovered while login is pending. No remote-browser port-discovery exploit was attempted or established. Same-user local code already has substantial capabilities, so this is Low severity hardening, not a login-CSRF/account-takeover result. PKCE and state still prevent credential acceptance.

**Recommended change, not applied.** Validate expected state and callback shape before settling the listener; ignore/reject unauthenticated requests while retaining a strict overall timeout, connection limits and safe error messages. Preserve proper handling of state-bound OAuth denial responses. Test an invalid request followed by the legitimate callback.

## Evidence and reproduction

Run from the request worktree using the existing compatible dependency/build environment. The archived probes use synthetic tokens, temporary profiles and real loopback callbacks; they never contact the example HTTPS hosts. A passing risk probe asserts the defect is present, **not** that it is fixed.

```bash
node --test docs/security/provider-template-review/probes.mjs
```

The Host probe defaults to this worktree's `target/debug` binary, not another checkout. If necessary, explicitly set `PI_DESKTOP_HOST_BIN` to a candidate built from the reviewed source. Binary identity above applies to this run only.

| Evidence | Source reference | Reproduction / result | Content hash |
| --- | --- | --- | --- |
| E-01 | `probes.mjs`, test `failed cleanup leaves an enabled account and OAuth grant despite uninstall success` | Archived command above: retained account/grant and same-ID reuse assertions pass on the real Rust Host | Archived probe SHA-256 above |
| E-02 | `rpc/mod.rs:5001`, `providers/repository.rs:634`, `plugins/providers.rs:532` | Read current code; compare `git show HEAD:crates/host-core/src/rpc/mod.rs` and `git show HEAD:crates/host-core/src/providers/repository.rs` | Current-file hashes included in implementation fingerprint; HEAD above identifies comparison source |
| E-03 | `probes.mjs`, first callback test | Archived command above: `OAUTH_STATE`, zero token exchanges, listener closes | Archived probe SHA-256 above |
| E-04 | `probes.mjs`, refresh redirect test | Archived command above: one POST only, `redirect:manual`, `OAUTH_HTTP`; no second endpoint call | Archived probe SHA-256 above |
| E-05 | Existing security/lifecycle tests below | Fresh passing runs; no product changes | n/a: test stdout; counts and log names below |

### Verified call paths

- **P-01** (`path_type=callflow`, F-01): successful account setup → injected first secret deletion failure → plugin unregistered → cleanup error logged → RPC success → enabled row and OAuth blob remain → same-ID registration retains grant. Evidence: E-01/E-02.
- **P-02** (`path_type=callflow`, F-02): matching loopback GET with wrong state → listener settles → deferred state validation rejects → login closes without exchange. Evidence: E-03.
- **P-03** (`path_type=callflow`, preserved control): refresh POST containing synthetic token → 307 response → reject status → no redirect follow. Evidence: E-04.

### Timeline

1. Confirmed user authorization, dirty worktree/HEAD and unchanged 99-file implementation fingerprint; checked local audit tooling.
2. Traced standard OAuth, credential normalization/refresh, custom inference and reverse-RPC authorization; independently reviewed Rust ownership and uninstall paths.
3. Executed fresh Desktop, Host-runtime and Rust template tests; reproduced wrong-state callback behavior and redirect refusal.
4. Independently reproduced the uninstall finding with the real candidate Host and disposable encrypted store; checked same-ID reuse and baseline source.
5. Archived/re-ran three probes, rechecked source fingerprint/diff whitespace, and wrote this separate report. No fixes, commits or release actions were performed.

## Fresh verification results

| Command / scope | Result | Scratch log |
| --- | --- | --- |
| `node --test apps/desktop/test/provider-template-{oauth,accounts,declarative-account,inference,image-lifecycle,connection}.test.mjs apps/desktop/test/plugin-provider-{oauth,inference,oauth-inference}.test.mjs` | 39 passed, 0 failed | `template-security-current-desktop.log` |
| `pnpm --filter @pi-desktop/host-runtime exec vitest run src/provider-inference.test.ts` | 4 passed, 0 failed | `template-security-current-host-runtime.log` |
| `cargo test -p host-core --locked provider_template` | 6 passed, 0 failed | `template-security-current-rust.log` |
| Archived risk/control probes above | 3 passed, 0 failed; F-01/F-02 remain present | `template-security-current-archived.log` |
| Candidate fingerprint / `git diff --check` | Unchanged / passed before report; final report checks recorded by delivery | Console output |

Scratch logs are temporary session artifacts, not permanent report dependencies. The archived probes are the durable executable evidence. Earlier scratch-only probes were also executed successfully but duplicate the archived cases and are not counted as additional coverage.

## Controls checked and residual limits

- Template-create/complete DTOs reject caller-owned IDs, owner fields and secret references; Host generates account IDs and binds the validated declaration. Relevant Rust RPC tests passed.
- Inference authorization binds session, native account, model and plugin runtime; Host-runtime tests reject unauthorized/changed bindings and account invalidation. No peer-account-read path was confirmed through reviewed Host APIs.
- Standard OAuth uses PKCE S256, random state, loopback-only callbacks, no redirect replay, bounded response/request lifetimes and safe fixed diagnostics. Network policy checks use the production public-HTTPS guard; no live DNS/proxy/TLS penetration test or DNS-rebinding guarantee is claimed.
- Custom OAuth/inference errors are normalized before public error channels. This does not prevent authorized plugin code from intentionally placing its own credentials in ordinary content/notifications or sending them via raw Node I/O.
- Image output uses bounded base64/MIME-signature validation and Host-selected scratch paths. This is not comprehensive image-decoder fuzzing or a proof against all local filesystem races.
- Trusted Node plugins are **not OS sandboxes**. Host API grants constrain the Host API, not arbitrary Node filesystem/network access. This is a known architectural trust limit, not a newly proven cross-account authorization bypass.
- No build/typecheck/full regression suite was rerun for this read-only review: product source fingerprint is unchanged and targeted boundary tests were run instead. Prior full Host validation recorded 18 failures without a clean-base attribution; this report does not certify those failures unrelated or resolved. See `docs/spec/06-delivery/provider-template-validation.md` for historical implementation validation, not fresh audit proof.
- No dependency/CVE scan, Semgrep/CodeQL scan, whole-window Electron verification, real vendor OAuth/paid inference, resource-exhaustion fuzzing or production-profile testing was performed. Absence of a confirmed high-severity finding is not proof that none exists.

## Recommended priority

1. Address F-01's fail-closed unavailable state, truthful result and durable cleanup retry before treating uninstall as verified credential erasure.
2. Harden F-02's callback acceptance without weakening PKCE/state validation.
3. Keep the trusted-code warning explicit; use separate OS-enforced isolation if hostile-plugin containment becomes a product requirement. That would require its own approved architecture change, not a silent audit fix.

## Subsequent remediation and archive maintenance

This report preserves the pre-remediation findings. See [remediation.md](remediation.md) for the subsequently implemented fixes and red/green evidence. During PR preparation `probes.test.mjs` was renamed to `probes.mjs` with identical bytes and the hash above unchanged, excluding historical defect assertions from automatic product-test discovery. Explicit commands use the new name; historical conclusions and results are unchanged.

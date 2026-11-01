# Publication-time verification

Scope: the uncommitted autonomous Goal candidate based on
`68868dfc8f7d040481ba2432c2178399386d2a9d`, shared to the user's fork as a feature
proposal. **Not integrated with latest upstream main. No PR is opened.**

## Checks rerun for publication

| Check | Observed result |
| --- | --- |
| Desktop Goal/service/component/user-path/keyboard + Composer/Plan/compiler regressions | 71 passed, 0 failed, 0 skipped |
| Goal runtime and settlement suites | 95 passed |
| AgentHost Goal admission | 28 passed |
| Goal coordinator and real sidecar boundary | 11 passed |
| Rust `goals` filter, offline locked dependencies | 46 passed, 0 failed, 1076 filtered out |
| Desktop noEmit typecheck | Passed |
| Style-token / architecture / git diff --check | Passed |

The JS/TS rows are separate suites (205 passing tests). Rust is reported separately,
not summed into a cross-language unique-test count. External providers are mocked
or controlled loopback fixtures; a test name mentioning paid usage tests accounting,
not a paid-provider call. No production credentials or user data are used.

## Commands actually run

From the existing dedicated worktree, reusing compatible dependencies:

```sh
node --test apps/desktop/test/goal-*.test.mjs apps/desktop/test/composer-mode-menu.test.mjs apps/desktop/test/composer-permission-mode.test.mjs apps/desktop/test/composer-send-state.test.mjs apps/desktop/test/plan-mode-source-contract.test.mjs apps/desktop/test/rollup-namespace.test.mjs
node node_modules/typescript/bin/tsc -p apps/desktop/tsconfig.json --noEmit
(cd packages/agent-runtime && node ../../node_modules/vitest/vitest.mjs run src/goals --no-cache)
(cd packages/agent-host && node ../../node_modules/vitest/vitest.mjs run src/goal-admission.test.ts --no-cache)
(cd packages/host-runtime && node ../../node_modules/vitest/vitest.mjs run src/goals --no-cache)
cargo test -p host-core --locked --offline goals -- --test-threads=1
node scripts/check-style-tokens.mjs
node scripts/check-architecture.mjs
git diff --check
```

Rust uses an existing isolated Cargo target directory. Only documentation links and
public evidence packaging changed for publication; no product source was altered.

## Earlier screenshot-candidate evidence, not rerun as publication checks

The immediately preceding UI iteration passed the production Electron/i18n build,
Desktop typecheck, 71-test UI suite, relevant lint/static checks, actual built-Desktop
61-capture flow and real Host control flow. Those screenshots are copied byte-for-byte
here, with one unscaled budget crop and a separate lifecycle diagram. The historical
source snapshot is in [source-manifest.json](source-manifest.json). Raw local logs,
profiles, databases, build output and machine-specific manifests are not published.

## Deliberately unverified gates

- Latest upstream main integration, `check:pr-base`, and PR integration acceptance.
  These must be completed before a later PR; this is fork/Issue-only publication.
- Full repository suites, Linux/macOS and release/package/install acceptance.
- Real-provider task completion or independent truth validation of model audits.

Existing bundle-size warnings and previously documented broader baseline findings
are not claimed fixed. Do not treat this proposal as a release or a landing-ready PR.

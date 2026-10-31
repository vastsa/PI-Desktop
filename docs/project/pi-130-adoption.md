# Pi 1.3.0 adoption

## Scope

Upgrade all five direct Pi dependencies from 1.1.0 to exactly 1.3.0:
Agent Runtime's `pi-agent-core`, `pi-ai`, and `pi-coding-agent`, and Desktop's
`pi-ai` and `pi-mcp`. Internal release-group dependencies stay aligned through
the lockfile. No Host protocol, database schema, persisted provider endpoint,
permission policy, extension VERSION marker, or storage ownership changes.

Official release notes: [1.2.0](https://github.com/earendil-works/pi/releases/tag/v1.2.0)
and [1.3.0](https://github.com/earendil-works/pi/releases/tag/v1.3.0).

## Compatibility work

- Rebase all three pnpm patches against the published 1.3.0 tarballs. Preserve
  hosted-search streaming/replay/estimation, bounded Anthropic OAuth handling,
  DeepSeek reasoning replay and endpoint-scoped system-message capability,
  local request errors, and native session context estimation/image degradation.
- Preserve upstream Anthropic strict-tool fallback and thinking-off handling.
  Re-enter local request preparation on each fallback attempt so callback and
  serialization failures remain classified and do not expose raw payloads.
- Move `requiresNonEmptyReasoningReplay` to the new provider compat schema,
  keeping runtime validation and TypeScript declarations aligned.
- Remove the patch for the deleted experimental assistant-frame codec and its
  codec-only tests. Keep the real stream-decoder, hosted-search consumer, and
  final-message regression coverage; no production consumer used that codec.
- Adopt upstream foreign-model thinking omission. Same-model DeepSeek reasoning
  remains replayable; visible transcript history is not rewritten.
- Verify malformed final tool JSON never reaches Host execution and the next
  model request receives the raw input error. Corrected calls still succeed,
  and literal invalid Unicode escapes no longer lose subsequent input fields.
- Add `messageType: "user"` to the Desktop extension shim's startup event.
  Its legacy supported subset and unsupported custom-message runs are unchanged;
  native Pi sessions continue using the real SDK's lifecycle.

## Explicitly unchanged

Desktop still owns its model/endpoint projection, retry policy, MCP ownership,
and compaction implementation. Pi 1.3.0 ships capabilities that Desktop does not
project; each is deliberate, and each pre-dates this upgrade unless noted:

- `ToolCall.argumentsError`, new in 1.3.0, is not consumed. Desktop's own
  adapter guard classifies malformed tool-argument JSON before Host execution
  and returns the raw error to the next request, so the SDK field would only
  duplicate an existing local path.
- Transport capabilities stay limited to the five keys in
  `packages/agent-runtime/src/transcript-compat.ts`; provider-native effort
  replay on `AssistantMessage` is not projected.
- `samplingParams`, `samplingParamsByThinkingLevel`, `promptCache`, and
  `inputLimits` are carried on `ModelConfig` but not forwarded into the
  streaming `Model` built at `packages/agent-runtime/src/provider-binding.ts:462`.
- The Kimi For Coding preset still requests Anthropic Messages
  (`packages/shared/src/provider-presets.ts:232-238`), and the live vendor probe
  still reports `anthropic-messages` at `https://api.kimi.com/coding`
  (`apps/desktop/electron/main/vendor-live-models.ts:32,41`), although upstream
  1.3.0 moved `kimi-coding` to Chat Completions at `/coding/v1`. Both Desktop
  paths keep targeting `/v1/messages` and are unchanged; rewriting saved rows
  would change transport for existing users.
- OpenRouter keeps the models.dev catalogue route
  (`apps/desktop/electron/main/vendor-live-models.ts:44`) instead of per-key
  personalization, and OpenCode Go keeps its `/zen` catalogue route
  (`packages/agent-runtime/src/provider-binding.ts:236-261`).

Native SDK summarization now omits thinking; Desktop's own summary serializer
retains its current behavior. Chat metadata remains owned by models.dev, not Pi
sibling defaults.

## Fresh-release policy and patch identity

The seven Pi 1.3.0 release-group packages have exact-version release-age
exclusions. Removed `chord` is no longer excluded or installed. Do not widen
these entries to package names or ranges. The lockfile records the canonical
patch hashes; `check:pi-dependencies`, `check:pi-patches`, and their fixture tests
verify exact pins, mappings, installed instances, and audited declarations.

## Validation

Task candidate: this change on task base
`de57f05aa65b05c93a4113bf5d4db9723884b080` (`origin/main`).

- Runtime regression: 102 files / 1,412 tests passed.
- Extension discriminator regression: failed before the shim fix, then passed.
- Anthropic fallback local-error regressions: both failed before preparation-state
  reset, then passed in the full runtime suite.
- `pnpm build:js`, Desktop typecheck, lint, architecture, documentation checks,
  dependency/patch gates, and all 7 patch-gate fixture tests passed.
- `pnpm -r --workspace-concurrency=1 --if-present test` passed across all
  packages, including Desktop's 4,134 passed / 3 skipped and pi-host's 61
  passed / 1 platform skip. The parallel run exceeded packaging-test timeouts;
  the unchanged tests pass when run alone and in the serial workspace run.
- Protocol smoke passed 23 checks; 2 real-model checks were skipped without
  credentials. Hosted-search bundle E2E passed all 8 scenarios; isolated
  Electron trusted-extension E2E passed 57/57 checks.
- Additional `test:e2e:provider-api-style` UI probing did not pass: two runs
  stopped at the no-auth save and StepFun selection steps respectively. Its
  fixture, renderer, shared, and i18n source are unchanged from `origin/main`.
  This separate UI harness failure is recorded, not counted as a pass or fixed
  by expanding this kernel-upgrade change.
- Environment: macOS arm64, Node 24.14.0, pnpm 12.8.1, existing Electron and
  release Host binary reused. Pi 1.3 requires a worktree-local dependency
  install because the primary checkout's 1.1.0 packages are incompatible; the
  existing pnpm store was reused. Hosted-search E2E runs via the pnpm script
  entry to avoid bootstrapping Corepack under its isolated, network-disabled HOME.
- Hosted-search artifact SHA-256:
  `bbadf71cb71c451af469084ac1ae18091fd53788d2c9abaa7488af2890280f75`.
- Rust checks were not rerun: no Rust source, Cargo dependency, or Host contract
  changed. Real Host RPC coverage used the existing release binary.
- No real-provider, paid API, installed-app, or user-data tests are authorized.
- PR integration validation is recorded on the pull request; see the delivery
  report for the CI gate results.

## Rollback

Roll back direct manifests, lockfile, exact release-age exclusions, patch files,
version gates, and compatibility adaptations together. Never mix a patched
1.1.0 package with the 1.3.0 release group. Existing user data needs no migration.

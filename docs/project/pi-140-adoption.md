# Pi 1.4.0 adoption

## Scope

Upgrade Agent Runtime's `pi-agent-core`, `pi-ai`, and `pi-coding-agent`, plus
Desktop's `pi-ai` and `pi-mcp`, to exactly 1.4.0. Keep the Pi release group
aligned through the lockfile and exact release-age exclusions. No Host protocol,
database schema, persisted provider endpoint, permission policy, extension
`VERSION` marker, or storage ownership changes.

Official release notes: [Pi 1.4.0](https://github.com/earendil-works/pi/releases/tag/v1.4.0),
[pi-ai changelog](https://github.com/earendil-works/pi/blob/v1.4.0/packages/ai/CHANGELOG.md),
[pi-agent-core changelog](https://github.com/earendil-works/pi/blob/v1.4.0/packages/agent/CHANGELOG.md),
and [pi-coding-agent changelog](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/CHANGELOG.md).

## Compatibility work

- Rebase the three pnpm patches onto the published 1.4.0 package layouts.
  Preserve hosted-search streaming, replay and estimation; bounded Anthropic
  OAuth handling; DeepSeek reasoning replay and endpoint-scoped capability;
  local request errors; and model-aware native session context estimation and
  image degradation.
- Adopt the new pi-ai client identity API at the agent boundary. Agent Runtime
  and subagents explicitly set `attribution: null`, which suppresses the new
  pi-agent-core default attribution headers while retaining pi-ai's detailed,
  versioned `User-Agent`.
- Keep Desktop's native-session and trusted-extension use of `pi-coding-agent`
  behind their existing compatibility seams. Do not expand the extension shim
  or change its legacy `VERSION` marker.
- Native Pi sessions continue to use pi-coding-agent's telemetry preference
  for its SDK-managed attribution headers. The Desktop-owned main and delegated
  agent requests explicitly suppress Pi attribution.
- Keep Desktop-owned endpoint projection, provider retry policy, MCP ownership,
  context projection, compaction, and session persistence unchanged.

## Explicitly unchanged

- Existing user data needs no migration. No persisted format, RPC, Plugin SDK,
  or permission contract changes.
- The Pi 1.4.0 release's model catalog and provider adapter improvements are
  available through the pinned upstream package. Desktop continues to own its
  model catalog overlays and endpoint projection.
- `pi-coding-agent` remains transitional; it is not the normal Desktop agent
  loop, compaction engine, or durable session store.
- The Desktop main and delegated agent identity is fixed at runtime and is not
  persisted with provider/model configuration. Native sessions use the
  pi-coding-agent SDK's install-telemetry setting for its attribution headers.

## Validation

Validation was run from the dedicated request worktree based on
`c014b32060ca2dc7ace4c83f181685a6e0140c78` (`origin/main`, 2026-10-28).

- Task candidate: `b460e75806f433085c4915c6da4ceb57a60dd466`; base main:
  `c014b32060ca2dc7ace4c83f181685a6e0140c78`. Candidate suites:
  `pnpm --filter @pi-desktop/agent-runtime test` (1,556/1,556),
  `pnpm test:e2e:hosted-search` (10/10), and
  `PI_DESKTOP_HOST_BIN=<reused debug host binary> pnpm test:e2e:trusted-extensions`
  (57/57). All three passed. E2E used isolated temporary profiles and fixtures,
  Electron 43.6.0 from the primary checkout, and the existing debug Host binary;
  it used no real provider credentials or live services.
- `pnpm build:js`, Desktop typecheck, lint, and `pnpm docs:check` passed.
- All 111 Agent Runtime test files passed (1,556 tests). The focused 1.4
  identity/contract/runtime/subagent set passed (426 tests).
- Pi dependency and patch gates passed; all 7 patch-hash fixture tests passed.
- Hosted-search E2E passed 10/10 scenarios. Trusted-extension E2E passed 57/57
  using the existing primary-checkout Electron and debug Host binaries with
  isolated fixture state. No real provider or live service was used.
- `pnpm -r --workspace-concurrency=1 --if-present test` completed with 4,550
  Desktop tests passed, 3 skipped, and one failure. The OAuth assertion passes
  in the complete run. The unchanged `composer-deep-file-search-user-path`
  Electron fixture also fails on a detached `origin/main` diagnostic worktree;
  both runs return no rows, with different final assertions. The test and its
  renderer search sources are unchanged by this task.
- Rust checks were not run because no Rust source, persistence, or Host contract
  changed. The trusted-extension E2E reused the existing debug Host binary.

## Rollback

Roll back the direct manifests, lockfile, exact release-age exclusions, three
patch files, version gates, identity wiring, tests, and synchronized specs
together. Never mix a patched 1.3.0 package with the 1.4.0 release group.

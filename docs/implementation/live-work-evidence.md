# Live Voice Work Integration Evidence

Implementation status: **COMPLETE** for Live Work v2.1. The task candidate is
based on `origin/main` at
`b360e04eb11edb8256b85ad314a8fdda7dc54e30`. No real provider account, paid
endpoint, user project, or running Electron instance was used. The v2.1 case
map is [`live-work-v21-coverage.md`](live-work-v21-coverage.md), and its manual
device matrix is [`live-work-v21-device-matrix.md`](live-work-v21-device-matrix.md).
This status and the evidence below describe that prior v2.1 candidate only; they
do not claim acceptance for the multi-backend extension.

## Multi-backend session-targeting extension candidate (2026-09-30)

- Worktree: `feat/live-voice-all-sessions` at
  `/Users/lan/Project/AI/PI-Desktop-worktrees/live-voice-all-sessions-20260930`,
  based on `e93295ad9`; changes remain uncommitted.
- The current Composer session is the default target. Main revalidates it against
  Desktop/Native Pi/Remote catalogs. Voice switching uses opaque references;
  prior operations retain their own target. Context consent remains separate.
- Verified locally: `pnpm build:js`; Desktop typecheck; host-runtime typecheck;
  29 Coordinator tests; 34 Desktop Live Voice/Work tests; 28 i18n tests;
  local-fixture Live Voice E2E (5/5 journeys); mounted interaction E2E
  (46/46 checks).
- The local fixture E2Es use a local TLS Realtime fixture, temporary data/profile,
  and synthetic microphone. Real provider, hardware, and user Desktop checks
  were not performed.
- **Task-candidate gate remains unmet:** latest `pnpm check:pr-base` reports
  `origin/main` `4b4a1fc95b90` is 15 commits ahead of this worktree. Per task
  constraints this branch was not rebased or merged, so the fixture E2Es above
  are exploratory rather than latest-base task-candidate evidence.

## Historical v2.1 candidate snapshot

- Branch/worktree: `codex/live-voice-v21-reliability` at
  `/Users/lan/.codex/worktrees/live-voice-v21-refresh/PI-Desktop`.
- Candidate commit: `61aaa6eb64441c0534c0e3118f941a2ba33fc301`.
- Base: `b360e04eb11edb8256b85ad314a8fdda7dc54e30`; `pnpm check:pr-base`
  confirms the base is an ancestor of the candidate.
- R01: fixed by synchronously capturing the Host active-turn target at
  candidate ingress; explicit null is preserved. Evidence:
  `packages/host-runtime/src/live-work/coordinator.test.ts` — “keeps an
  ingress-time empty turn target instead of stopping a later turn”.
- R02: fixed by removing implicit queue from ordinary submit and retaining
  explicit queue admission only. Production composition and Host queue tests
  cover the mapping; lock-race integration remains partial.
- R03: fixed for in-process operations with exact read-only Host lookup,
  bounded reconciliation, no resubmission, and monotonic terminal evidence.
  Evidence: coordinator unknown-dispatch/terminal cases and AgentHost exact
  lookup cases in the v2.1 coverage table. Restart-time Live recovery remains
  intentionally unsupported.
- R04: fixed at the local scheduler boundary with a reserved validated control
  classifier lane, cancellation signal, classifier deadline, write stop
  barrier, and bounded Host dispatch. A provider SDK honoring physical stream
  cancellation is not claimed.
- R05: fixed by separating admission and result fields, limiting results to
  exact-turn root assistant content, bounded re-reads, and keeping stop
  acknowledgements separate from task results.
- R06: fixed with a private workspace fingerprint checked again by AgentHost
  before turn or queue admission. Changed workspace rejection is covered at
  the Host boundary; a full classification-race composition remains partial.
- R07: fixed by draining explicit idle enqueue through AgentHost while leaving
  restored held queues held; both paths have AgentHost tests.
- R08: improved but **partial**. The deterministic production composition now
  instantiates `createLiveWorkBridge`, `createAgentHostBridge`, the registered
  `agentPrompt` handler, and real `AgentHost`. Host-core RPC, sidecar/model
  completion, and provider wire IO are fixtures. Concrete Gemini/Realtime
  adapters, Codex DataChannel controller, Rust persistence, MCP/plugin
  permissions, and real-device journeys remain unverified.
- R09: current live-work behavior docs, E2E plan, v2.1 case mapping, W2 audit,
  ADR, and NOT RUN device matrix are committed in this candidate.

The baseline deterministic reproductions were recorded before the fixes on
base `f9543be51a2eea4f5010dd059fed6d68dddb8745`: an explicit null turn target
could resolve to a later task; terminal evidence could be lost behind a
missing submit ACK; result queries could return admission wording; and idle
enqueue had no tested self-drain guarantee. Current regression evidence and
its exact limits are in the v2.1 case map.

## Current task-candidate validation

The refreshed task candidate is commit
`61aaa6eb64441c0534c0e3118f941a2ba33fc301` on `origin/main` at
`b360e04eb11edb8256b85ad314a8fdda7dc54e30`. Task-candidate validation below
was run after that base was incorporated.

| Check | Result |
|---|---|
| `pnpm build:js` | Passed. VitePress reported its existing missing `gitignore` highlighter and large-chunk warnings. |
| `pnpm -r --if-present test` | Passed all workspace suites; desktop 3,179, shared 1,124, agent-runtime 1,113, and plugin SDK 374 tests passed, as did the remaining suites. |
| `pnpm --filter @pi-desktop/desktop typecheck` | Passed. |
| `pnpm lint` | Passed, including Biome and desktop style-token validation. |
| `pnpm docs:check` | Passed: 83 English/Chinese specification pairs and 534 documentation pages; existing ADR format notes remain advisory. |
| `pnpm check:agent-policy` | Passed. |
| `node scripts/check-architecture.mjs` | Passed. |
| `cargo fmt --check` | Passed. |
| Host Core build for E2E | Passed with one existing dead-code warning in `permissions.rs`. |
| `pnpm test:e2e` | Passed: 23/23 local Host E2E cases; two optional live-model cases skipped because the API key was explicitly unset. |
| `git diff --check` | Passed for the task candidate. |

## PR integration candidate validation

- PR: [#1220](https://github.com/vastsa/PI-Desktop/pull/1220).
- Candidate: GitHub merge ref `6c06747940579574a812e0495d1449fba6d50b8c`,
  with base `b360e04eb11edb8256b85ad314a8fdda7dc54e30` and head
  `7c0e79e3aaed1826be7da0bb360b79d453ad5c46`.
- Host Core was built from that candidate using the shared Cargo target.
- `pnpm test:e2e`: 23/23 local Host E2E cases passed; two optional live-model
  cases skipped because provider credentials were explicitly unset.
- All GitHub checks passed on PR head
  `75efaa0bbbe7294168a8f4e8908cef47266c4e37`: JS build/typecheck/lint/
  architecture/unit tests, docs, Rust format/lint/tests, and latest-base.
  GitHub reported the PR clean and mergeable.
- The later PR head `7c0e79e3aaed1826be7da0bb360b79d453ad5c46` changes only
  this evidence document. Its CI checks were still running when this
  evidence-only follow-up was prepared; the updated head is gated by its own
  checks before merge.

The isolated composition tests exercise the Live Work bridge, registered
prompt handler, and AgentHost; Host-core RPC, sidecar/model completion, and
provider wire IO are fixtures. `cargo test` and `cargo clippy` were not run
because the task changes no Rust source; `cargo fmt --check` and the locally
built Host Core E2E were run. The real-provider/device matrix and full Electron
acceptance journey remain `NOT RUN`. No real account, paid endpoint, user
project, or running Desktop instance was used.

## Historical v2 phase-2 candidate and CI evidence

The following records describe the earlier v2 candidate only. They are not
v2.1 test results and must not be used as the current candidate SHA or PR
state.

## Candidate and base

- Request branch: `codex/live-voice-v1`; dedicated worktree:
  `/Users/lan/.codex/worktrees/live-voice-v1/PI-Desktop`.
- Phase-2 implementation base: `1ec74701f` (the v1 implementation commit).
- Latest fetched `origin/main`: `8fcca3d25c98d66c46d0f9cddab76167b6ddb294`;
  it is included in the request candidate through merge commit
  `4afe31c4a3178c06024d3ebcac25a678ef98f9fd` and `pnpm check:pr-base` passes.
- The phase-2 changes originated from `1ec74701f1c23219bc6c68fc723e77cc432419df`.
  The provider integration fixture and W2 case-level audit are part of the
  current candidate; the fixture does not instantiate the production Main
  work-bridge or concrete provider transport adapters.
- Existing pull request: [#1161](https://github.com/vastsa/PI-Desktop/pull/1161),
  open on `codex/live-voice-v1`. This task updates that PR and does not merge it.
- The worktree has an untracked `PI-Desktop-Live-Voice-v1-Spec.md`; it is not a
  task deliverable and is excluded from the change.

## Implemented paths

### Binding and provider ingress

- The user selects a local Desktop session and context-sharing preference in
  the existing Live controls. Main resolves the session and freezes the
  `LiveWorkBinding` to the new call. Missing sessions fail closed; `remote` and
  `pi-native` sources return `LIVE_WORK_BACKEND_UNSUPPORTED`. The Main work port
  rechecks the call binding and Host session metadata before work operations.
- A call without `workTarget` keeps the voice-only profile. The provider can
  submit only `delegate_to_work_session({ instruction })`; Main takes the
  session identity, binding revision, and operation identity from trusted call
  state.
- Codex native delegation continues through the existing Renderer DataChannel
  and `liveVoiceReportDelegation` IPC. Gemini and Realtime parse complete
  function calls, validate the declared tool and arguments, and send a single
  provider-native `received` or `rejected` receipt. Realtime GA and compat
  retain distinct audio/session profiles.
- The call-scoped ledger deduplicates identical request IDs, rejects changed
  parameters under the same ID, bounds candidate capacity, and is discarded
  when the call closes. Work admitted before call closure remains owned by
  AgentHost/Host.

### Classification and Host admission

- `packages/host-runtime/src/live-work/` contains strict intent validation,
  bounded context projection, operation ledger, result projection, and the
  coordinator. Classification uses the bound session's configured text model
  with tools disabled. Context-disabled calls do not read prior messages;
  recent operation context carries only bounded operation IDs and status facts.
- The coordinator returns the provider receipt before classification and does
  not dispatch when the local receipt was not sent. It routes work through the
  existing `AgentHostBridge` and registered prompt/steer handlers, or the
  existing durable Host queue. Voice messages retain their preallocated
  `userMessageId` and `voiceOrigin`.
- Steer uses the captured `expectedTurnId` and is checked in Main and again by
  the sidecar/runtime after Host I/O. Graceful stop and immediate abort carry
  the frozen turn ID; Main and the sidecar compare it at the active-run owner.
  Stop failure never becomes a new prompt or queue item.
- Session metadata is rechecked immediately before dispatch so deletion,
  source change, or call closure during classification cannot start work in a
  stale scope. Queue entries and voice provenance are persisted by host-core;
  schema v20 migrates v19 queue rows without dropping them.
- Only authoritative Host turn-terminal events settle operations. The summary
  projector reads the exact terminal turn, filters unrelated/tool/user
  content, bounds output, and uses an honest status fallback. A result query
  reads the latest terminal operation for this call or an explicit operation
  reference, and does not create a turn. Route/rejection reasons and bounded
  terminal summaries are visible in the Live work panel.

### Project/session selection and feedback

- Project/session list intents use existing Host metadata. Responses expose at
  most 20 labels and opaque `selectionRef`s scoped to call, binding revision,
  and a 60-second lifetime; raw paths and session IDs stay in Main. Opening a
  unique session navigates through the existing renderer. Duplicate labels
  remain an explicit panel choice. Creating requires a listed registered
  project and a user click in the Live panel, uses existing defaults, and does
  not change the current call's work binding.
- Feedback is held in a bounded eight-item queue, deduplicated, and coalesced
  on overflow. It waits for provider generation, user speech, and local
  playback to be idle, then applies a 700 ms quiet window and three-second
  speech gap. Stale automatic speech is downgraded after 15 seconds; silent
  mode suppresses automatic announcements while explicit status/result
  queries can still speak. Shared terminal turns produce one final feedback
  item, while all linked operations receive the same feedback delivery status.
- Gemini Live and Realtime use PCM output-credit drain. Codex work calls route
  the remote audio element through a local Web Audio analyser; if monitoring
  fails or its AudioContext is not running, Main keeps feedback held. The
  analyser observes renderer output samples before the output device; it
  cannot prove that a person heard the audio.

### Main changed areas

- Main/provider integration: `apps/desktop/electron/main/live-voice/`,
  `apps/desktop/electron/main/live-voice-ipc.ts`,
  `apps/desktop/electron/main/agent-host-bridge.ts`, and
  `apps/desktop/electron/main/ipc/agent-ipc.ts`.
- Renderer controls and localized labels:
  `apps/desktop/src/features/voice/live/`, Composer integration, shared Live
  DTOs, and `packages/i18n` locales.
- Host/Runtime admission and provenance:
  `packages/host-runtime/src/live-work/`, `packages/agent-host/`,
  `packages/agent-runtime/src/sidecar.ts`, `packages/shared/`, and
  `crates/host-core/src/{db.rs,db/,turn_queue.rs,sessions.rs}`.
- Product/evidence docs: the English and Chinese Live work spec, E2E plan,
  navigation, storage spec, and queue ADR.

## Automated evidence

| Check | Result |
|---|---|
| `node --test test/live-work-provider-integration.test.mjs` (from `apps/desktop`) | 4 passed: Codex Live, Gemini Live, Realtime GA, and Realtime compat-v1. These use real protocol parsers/encoders, the coordinator, and AgentHost admission/terminal APIs; the work port, Runtime prompt, and provider transport are fixtures. |
| `pnpm -r --if-present test` | Passed all workspace suites on the current candidate; desktop: 3,173 passed, 0 failed; docs: 11 passed, 0 failed. |
| `pnpm --filter @pi-desktop/desktop typecheck` | Passed on the current candidate. |
| `pnpm build:js` | Passed on the current candidate; docs, workspace packages, Electron main, preload, and renderer built. Existing VitePress highlighting and large-chunk warnings remain. |
| `pnpm lint` | Passed, including style-token validation. |
| `cargo fmt --check` | Passed on the current candidate. |
| `cargo test -p host-core --locked` | 670 tests passed; the later `origin/main` merge changed Runtime/shared TypeScript and docs only. |
| `cargo clippy -p host-core --all-targets --locked` | Passed; the later `origin/main` merge changed no Rust files. |
| `pnpm docs:check` | Passed; 83 English/Chinese specification pairs and 530 documentation pages verified. Existing ADR format notes remain. |
| `pnpm check:agent-policy`, `pnpm check:pr-base`, and `node scripts/check-architecture.mjs` | Passed. PR base check confirms `origin/main` at `8fcca3d25c98` is an ancestor of the candidate. |
| GitHub PR checks at code head `6b9ee4432581` | Passed: Docs, latest-base, JS build/typecheck/lint/architecture/tests, and Rust format/lint/tests. The later follow-up changes this evidence record only. |

The directly exercised W2 behaviors are mapped below. A mapped test proves
only the named seam and assertions, not a complete provider-to-device journey.

- No-work-scope voice-only behavior and explicit work-scope forwarding:
  `apps/desktop/test/live-voice-service.test.mjs`.
- Declared tool parsing and provider-specific receipt encoding:
  `packages/voice-runtime/src/live/protocol.test.ts`.
- Receipt-before-classification, no dispatch after receipt delivery failure,
  Host queue routing, stale steer rejection, duplicate request handling,
  early terminal correlation, query-result without a second turn, and call
  closure during classification:
  `packages/host-runtime/src/live-work/coordinator.test.ts`.
- Context opt-out, bounded prior operation facts, and request-preserving context
  caps: `packages/host-runtime/src/live-work/context.test.ts`.
- Exact-turn result summary and honest fallback:
  `packages/host-runtime/src/live-work/result-summary.test.ts`.
- Durable queue provenance, v19 migration, and malformed provenance reporting:
  `crates/host-core/src/turn_queue.rs` tests.
- Bound session source/call checks and session deletion during Host lookup:
  `apps/desktop/test/live-work-scope.test.mjs`.
- Legacy session-wide calls and stale exact-turn rejection at the sidecar run
  owner: `packages/agent-runtime/src/turn-target.test.ts`.
- Escaped terminal summary rendering:
  `apps/desktop/test/live-work-operations.test.mjs`.
- Call-scoped, expiring selection references and stale session revalidation:
  `apps/desktop/test/live-work-scope.test.mjs`; panel actions:
  `apps/desktop/test/live-work-operations.test.mjs`.
- Feedback debounce, speech gap, silent mode, stale downgrade, overflow, and
  deduplication: `packages/host-runtime/src/live-work/feedback-scheduler.test.ts`.
- Provider generation plus local Codex playback gating and shared-turn
  feedback status: `apps/desktop/test/live-voice-service.test.mjs`.
- Codex local output signal threshold and strict playback-activity IPC:
  `packages/voice-runtime/src/live/playback-monitor.test.ts` and
  `apps/desktop/test/live-voice-ipc-media.test.mjs`.
- Four-profile parser/encoder → `LiveWorkCoordinator` → actual
  `AgentHost.startTurn` / terminal event → feedback encoder fixture:
  `apps/desktop/test/live-work-provider-integration.test.mjs`. Its local
  `LiveWorkPort` mirrors the production admission shape but is not the
  production `createLiveWorkBridge` mapping.

The full W2-001—W2-096 case-level mapping, with Direct / Partial / Gap status
and evidence boundaries, is in
`docs/implementation/live-work-w2-coverage.md`. The fixture is deterministic
and crosses into AgentHost, but does not exercise the registered Main
`createLiveWorkBridge` handler mapping or concrete socket/WebRTC adapters; it
therefore remains partial evidence for W2-025 and W2-096.

## Remaining acceptance work

- Cross-boundary integration now covers four protocol profiles through the
  shared coordinator and actual AgentHost admission/terminal events. The Main
  bridge mapping and concrete socket/WebRTC adapter transport remain untested.
- The W2 matrix has a row for every acceptance ID, but Partial and Gap rows
  remain; this implementation does not claim all 96 behaviors pass.
- M01—M16 and each Codex OAuth, Gemini Live, Realtime GA, and Realtime compat
  real-account/media journey are `NOT RUN`. No credentials, paid endpoints, or
  audio-device journey were used. Repository policy also reserves
  `verify:ui:*` for explicit user requests; this task used isolated fixtures.
- Codex playback monitoring verifies renderer output samples before the device,
  not physical output completion or human audibility. Real playback buffers,
  WebSocket/provider behavior, and race behavior must be confirmed by the
  isolated manual matrix.
- GitHub PR checks at code head `6b9ee4432581` passed. The checks validate the
  pushed code candidate with latest `main`; the manual provider/device journey
  remains unrun. The PR is open and has not been merged.

## Spoken asktool answers and pending-card recovery (2026-10-01, uncommitted)

- Base: current `main` (`9b3f9ba15`) in the primary checkout. No branch or
  worktree was created for this change, so this is local evidence only.
- A work call can now resolve the bound session's single open AskTool question
  through the Host input path, selecting only among that question's own option
  labels ([ADR 0315](../adr/0315-live-voice-spoken-asktool-answers.md)).
  Permission, Plan, and Goal approvals remain desktop-UI decisions.
- A reloaded renderer rebuilds its pending AskTool and permission cards from
  Host state (`IPC.invoke.pendingInteractive` →
  `AgentHostBridge.pendingInteractiveRequests`).
- Verified locally: `pnpm build:js`; `pnpm -r --if-present typecheck`; Desktop
  tests 3339 (including the new `spoken-answer.test.mjs`,
  `live-work-decision.test.mjs`, `pending-interactive-restore.test.mjs`);
  host-runtime 119 (including `ask-answer.test.ts`); agent-host 57; shared 1166;
  racp 21; voice-runtime 51; i18n 28; `pnpm docs:check` (542 pages).
- Not run: any `verify:ui:*` or Electron E2E, and no real provider account,
  microphone, or device. The spoken-answer path is covered by unit, routing and
  SSR-level tests only; the end-to-end voice journey still needs an authorized
  live call.

# Live Work v2.1 Acceptance Coverage

Status: **IN_PROGRESS**. This table maps all LV21-001—064 cases to the current
working-tree evidence. `PASS` means only that the named deterministic assertion
passed at the listed test boundary; it does not mean provider, Rust persistence,
permission, or device acceptance passed. `PARTIAL` identifies a related test
whose boundary or scenario is narrower. `NOT RUN` means no adequate automated
case has run for this acceptance row.

## Candidate

- Base commit: `f9543be51a2eea4f5010dd059fed6d68dddb8745` (`origin/main` at task
  worktree creation).
- Candidate: uncommitted working-tree changes based on that commit; there is no
  candidate commit SHA yet.
- All `PASS` entries below refer to tests run from this task worktree. The final
  delivery report records commands and results. No real account, paid endpoint,
  user project, or running Electron instance was used.

## Case mapping

| ID | Status | Evidence and exact case | Production boundary / remaining limitation |
|---|---|---|---|
| LV21-001 | PARTIAL | `packages/host-runtime/src/live-work/coordinator.test.ts` — “keeps an ingress-time empty turn target instead of stopping a later turn” | Coordinator target capture; no delayed-stop registered-handler integration. |
| LV21-002 | PARTIAL | `coordinator.test.ts` — “rejects a stale steer without falling back to prompt or queue” | Real coordinator, fake WorkPort; production `agentSteer` mapping is not in this case. |
| LV21-003 | PASS | `coordinator.test.ts` — “keeps an ingress-time empty turn target instead of stopping a later turn” | Verifies explicit null stays null; production ingress is exercised separately by the production composition case. |
| LV21-004 | PARTIAL | `operation-ledger.test.ts` — “registers once, reuses an identical provider request, and rejects changed parameters” | Identity/dedup is direct; active target is not changed during a production replay. |
| LV21-005 | PARTIAL | `apps/desktop/test/live-work-scope.test.mjs` — “work scope requires the still-active call binding and a supported local session” | Main scope stays call-bound; no Renderer A→B navigation journey here. |
| LV21-006 | PARTIAL | `packages/agent-host/src/agent-host.test.ts` — “rejects Live admission after the bound workspace identity changes” | Final Host guard is direct; mutation during classifier is not one integrated test. |
| LV21-007 | PARTIAL | `apps/desktop/test/live-work-scope.test.mjs` — “a work session removed while Host metadata is being read cannot pass revalidation” | Session removal is covered; backend change and media continuity are not combined. |
| LV21-008 | PARTIAL | `agent-host.test.ts` — “starts immediately, applies the ceiling, and honors idempotency”; “exempts the paired desktop from the ceiling and rejects stale revisions” | Host policy tests are separate from a Live registered-handler mode-change race. |
| LV21-009 | PASS | `coordinator.test.ts` — “lets a validated stop use its reserved classifier while an ordinary classifier is pending” | Real coordinator with deferred classifier; runtime stop and barrier are observed at the WorkPort boundary. |
| LV21-010 | NOT RUN | No reverse-completion test for two ordinary classifier results. | Ordinary classifier completion order has not been stress-tested. |
| LV21-011 | PASS | `coordinator.test.ts` — “does not let a control scheduling hint directly execute a write intent” | Scheduling hint still requires strict intent validation; classifier is a deterministic fixture. |
| LV21-012 | NOT RUN | No combined negative, undecided, malicious-context and no-side-effect case was run for v2.1. | Existing context/intent tests cover only individual boundaries. |
| LV21-013 | PARTIAL | `coordinator.test.ts` — “does not dispatch a classifier result after the work call closes”; production composition asserts the classifier receives an `AbortSignal` | Coordinator and production resolver seam are covered separately; no assertion proves abort reached a real provider stream. |
| LV21-014 | PASS | `coordinator.test.ts` — “aborts the classifier when its deadline expires and never routes its late result” | Fake timers use a shortened deadline; production default remains 8 seconds. Provider-side physical cancellation is not claimed. |
| LV21-015 | PASS | `coordinator.test.ts` — “bounds a Host snapshot that never resolves” | Fake clock proves the 2-second bound; Host metadata transport remains a fixture. |
| LV21-016 | PASS | `operation-ledger.test.ts` — “caps unresolved admission without counting accepted running work” | Verifies the 16-pending bound and preserves accepted identities. |
| LV21-017 | PARTIAL | `apps/desktop/test/live-work-production-composition.test.mjs` — “production Live WorkBridge reaches AgentHost admission, explicit queue, and exact terminal result” | Real WorkBridge, AgentHost bridge, registered prompt handler and AgentHost; busy is observed before locked admission, not the idle-snapshot/lock-race variant. |
| LV21-018 | PARTIAL | Same production composition case | AgentHost receives one explicit independent item with its voice provenance; queue store/Host RPC are fixtures, not Rust persistence. |
| LV21-019 | PASS | `agent-host.test.ts` — “drains an idle explicit enqueue and preserves voice provenance” | Real AgentHost and runtime fixture; no external queue kick is used. |
| LV21-020 | PASS | `agent-host.test.ts` — “reconciles a restored Live queue entry without releasing its held state” | Real AgentHost restored queue; persistence store is a fixture. |
| LV21-021 | PARTIAL | `packages/agent-host/src/turn-queue.test.ts` queue ordering/capacity cases; `agent-host.test.ts` — “prioritizes a queued turn, reports queue changes, and respects runtime busy state” | Existing in-memory queue behavior is exercised; v2.1 does not retest Rust persistence and restart together. |
| LV21-022 | NOT RUN | No new Live race test for cancellation versus delivery-pending/already-delivered. | Existing AgentHost cancel guard is retained; this integrated race remains open. |
| LV21-023 | PASS | `apps/desktop/test/agent-host-bridge-work-ack.test.mjs` — “AgentHost work controls require explicit structured acknowledgements” | Production Main mapper rejects undefined/empty steer and stop acknowledgements. |
| LV21-024 | PARTIAL | `apps/desktop/test/agent-host-bridge-work-ack.test.mjs`; existing prompt/steer/stop and queue tests | Additive work behavior is covered; the full legacy text-input regression matrix is not rerun in this case. |
| LV21-025 | PARTIAL | `coordinator.test.ts` — “bounds an unresolved dispatch and reconciles it without resubmitting”; `agent-host.test.ts` — “reconciles only the exact session, operation, and user-message identity” | Coordinator retry and exact Host lookup are separate deterministic tests; transport-loss is simulated. |
| LV21-026 | PARTIAL | `coordinator.test.ts` — “reports an authoritative final workspace rejection instead of admission unknown”; AgentHost policy tests | Workspace rejection is covered; queue-full/error mapping through production Main is not combined. |
| LV21-027 | PASS | `coordinator.test.ts` — “keeps a terminal event that arrives before submit returns”; `operation-ledger.test.ts` — “merges delayed acknowledgements monotonically around terminal evidence” | Unknown/late-ACK evidence merges monotonically at coordinator and reducer boundaries. |
| LV21-028 | PARTIAL | `coordinator.test.ts` — “bounds an unresolved dispatch and reconciles it without resubmitting” | Positive exact lookup resolves unknown; a first `not-found` followed by later evidence is not tested. |
| LV21-029 | NOT RUN | No fake-clock test exhausts all reconciliation attempts and asserts timers are cleared. | Production schedule is bounded in code; budget exhaustion remains unverified. |
| LV21-030 | PASS | `agent-host.test.ts` — “does not let a late prompt acknowledgement revive a terminal turn” | Real AgentHost state machine with deferred runtime acknowledgement. |
| LV21-031 | PARTIAL | `agent-host.test.ts` — “queues behind an active turn, drains in order, and aliases runtime ids” | Runtime alias and queue order are covered; an enqueue acknowledgement delayed behind terminal is not independently asserted. |
| LV21-032 | PARTIAL | `agent-host.test.ts` — “reconciles only the exact session, operation, and user-message identity”; `coordinator.test.ts` — duplicate/conflict case | Exact identity matching is covered; a full old-call scoped event-subscription race is not. |
| LV21-033 | PASS | `coordinator.test.ts` — “does not answer a pending terminal result with the admission message” | Query-result keeps admission text separate from pending/unavailable result state. |
| LV21-034 | PARTIAL | `coordinator.test.ts` — “shares one terminal result with every operation attached to the same turn”; existing Live service shared-terminal test | Coordinator result fan-out is tested; one-time automatic feedback is covered separately, not in this production case. |
| LV21-035 | PASS | `apps/desktop/test/live-work-production-composition.test.mjs` — “production Live WorkBridge reaches AgentHost admission, explicit queue, and exact terminal result” | Production result reader retries after terminal persistence lag; Host history is a fixture and returns the exact root assistant on retry. |
| LV21-036 | PARTIAL | Production composition case plus `packages/agent-host/src/agent-host.test.ts` — “replays from a cursor or reports a resync, and paginates history” | Bounded exact-turn paging exists; production fixture does not place the target beyond the first history page. |
| LV21-037 | PASS | `packages/host-runtime/src/live-work/result-summary.test.ts` — “excludes child-agent and tool-associated assistant messages”; “uses an honest status fallback when no final assistant message exists” | Pure result projection excludes ineligible assistant content and has a status fallback. |
| LV21-038 | PARTIAL | `operation-ledger.test.ts` — “merges delayed acknowledgements monotonically around terminal evidence”; existing UI status tests | Terminal ordering is covered; failed/interrupted/canceled across UI and feedback are not one matrix. |
| LV21-039 | PASS | `coordinator.test.ts` — “keeps a stop acknowledgement out of the latest engineering result” | Stop control acknowledgement remains separate; query returns the associated task result. |
| LV21-040 | PARTIAL | `coordinator.test.ts` — “answers a result query from the recorded operation without starting another turn”; feedback scheduler deduplication tests | No second task is created; explicit repeat-query versus one automatic notification is not integrated here. |
| LV21-041 | PARTIAL | `live-work-production-composition.test.mjs` — production bridge/handler/AgentHost path; `live-work-provider-integration.test.mjs` Codex parser/encoder case | Codex parser/encoder and real Main mapping are exercised separately; DataChannel controller/RTC adapter instance is not. |
| LV21-042 | NOT RUN | No Gemini Adapter → production Bridge → registered handler composition case. | Existing Gemini protocol fixture does not instantiate its concrete adapter. |
| LV21-043 | NOT RUN | No Realtime GA Adapter → production Bridge composition case. | Existing GA parser/encoder coverage is not an adapter integration. |
| LV21-044 | NOT RUN | No Realtime compat-v1 Adapter → production Bridge composition case. | Existing compat parser/encoder coverage is not an adapter integration. |
| LV21-045 | PARTIAL | `packages/voice-runtime/src/live/protocol.test.ts` malformed/duplicate event cases | Protocol parsing has local tests; socket/WebRTC disconnect and reordering through concrete adapters are not. |
| LV21-046 | PARTIAL | Existing `apps/desktop/test/live-voice-controller.test.mjs` control lifecycle tests; `agent-host-bridge-work-ack.test.mjs` strict response mapping | Duplicate/delayed Codex control ACK delivery is not tested end to end. |
| LV21-047 | PARTIAL | `coordinator.test.ts` — “does not dispatch if the local provider receipt was not sent” | Coordinator has no-side-effect behavior; concrete adapter send failure is not instantiated. |
| LV21-048 | NOT RUN | No 20-cycle repeated start/end/failure cleanup test was run. | Adapter, media lease, and pending-ACK leak audit remains open. |
| LV21-049 | PARTIAL | `live-work-production-composition.test.mjs` — production registered `agentPrompt` handler persists the original `messageId` and `voiceOrigin` | Registered handler and Host mock are real; Rust durable persistence is not reached. |
| LV21-050 | NOT RUN | No Rust queue restart/migration test was run in this v2.1 candidate. | Existing v2 migration tests are historical evidence only. |
| LV21-051 | NOT RUN | No authorized MCP tool through the production Agent tool/permission gateway was exercised. | Local MCP HTTP disablement was not tested. |
| LV21-052 | NOT RUN | No plugin tool removal/permission-denial integration was run. | Existing plugin permission gateway is unchanged. |
| LV21-053 | NOT RUN | No voice “approve” candidate with forbidden Plan/Goal/AskTool operation spies was run. | Permission non-escalation remains an acceptance gap. |
| LV21-054 | PARTIAL | `packages/voice-runtime/src/live/protocol.test.ts` strict declared-argument parsing; coordinator strict intent parsing test | Extra provider fields are rejected at protocol boundaries; four concrete adapters are not composed. |
| LV21-055 | PARTIAL | `agent-host.test.ts` queue/admission tests; production composition call-close cleanup | Accepted work ownership survives Host lifecycle tests; hangup/new-call stale-result separation is not integrated. |
| LV21-056 | NOT RUN | No independent Live and coding credential invalidation case was run. | Authentication remains outside this deterministic work test. |
| LV21-057 | NOT RUN | No Gemini generation + PCM-drain concurrency test was run. | Concrete Gemini adapter remains untested here. |
| LV21-058 | NOT RUN | No Realtime VAD and Host feedback mutual-exclusion composition was run. | Concrete response tracker path remains outside the new tests. |
| LV21-059 | PARTIAL | `packages/voice-runtime/src/live/response-tracker.test.ts` interruption epoch tests | Late audio/completion behavior is covered separately from Live Work feedback. |
| LV21-060 | PARTIAL | `apps/desktop/test/live-work-operations.test.mjs` terminal projection; `LiveWorkOperations.tsx` failure-code display | UI component state rendering was not expanded to a full A/T state-transition interaction test. |
| LV21-061 | PARTIAL | `packages/host-runtime/src/live-work/context.test.ts` opt-in/history boundaries; protocol tests | No cross-DTO/log sentinel test covers auth headers, SDP, and transcript together. |
| LV21-062 | PARTIAL | Existing Live service mute/playback/announcement tests and Host work tests | Media mute, automatic announcements, and Host stop are verified at separate boundaries. |
| LV21-063 | PARTIAL | `coordinator.test.ts` — classifier close, bounded dispatch close; production composition closes the exact result reader | Scope cleanup has deterministic seams; provider ACK and all observer types are not tested in one lifecycle case. |
| LV21-064 | PARTIAL | This matrix, `live-work-w2-coverage.md`, `live-work-evidence.md`, `live-work-session.md`, and `04-e2e-test-plan.md` | Documentation/check coverage can pass; full W2 and device acceptance intentionally remain incomplete. |

## Boundary summary

The strongest v2.1 integration test instantiates production
`createLiveWorkBridge`, `createAgentHostBridge`, the registered `agentPrompt`
handler, and the real `AgentHost`. It uses a fake host-core RPC, sidecar
runtime prompt, classifier completion, and provider wire input/output. It does
not establish real Rust persistence, MCP/plugin permission behavior, concrete
Gemini/Realtime transports, Codex DataChannel transport, real accounts, or
human audibility. Those gaps remain `PARTIAL`, `NOT RUN`, or device-matrix
pending as listed above.

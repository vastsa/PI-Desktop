# Live Work W2 Acceptance Coverage Audit

Original audit baseline: phase-2 request candidate after merging `origin/main`
at `8fcca3d25c98`. This v2.1 refresh adds evidence from the uncommitted
working-tree candidate based on `f9543be51a2eea4f5010dd059fed6d68dddb8745`;
it does not replace the historical base SHA or claim a committed candidate.
The v2 work-integration specification defines W2-001—W2-096.

Status means:

- **Direct** — a test asserts the named behavior at the listed local boundary.
- **Partial** — a related seam or invariant is tested, but the complete scenario
  in the acceptance row is not.
- **Gap** — this audit found no direct automated test for the named scenario.

These labels describe test mapping, not implementation completion or a claim
that a real provider/device journey passed. A mocked external boundary is
called out where relevant.

| ID | Status | Test mapping or uncovered assertion |
|---|---|---|
| W2-001 | Direct | `apps/desktop/test/live-voice-service.test.mjs` — “Live call follows prepare, connect, mute, in-memory transcript, reject-only delegation, and end” |
| W2-002 | Partial | `apps/desktop/test/live-voice-service.test.mjs` — “an explicitly bound work call forwards only the declared tool candidate to its fixed work scope”; host-side session resolution is covered separately, not through the real window selection path |
| W2-003 | Partial | `apps/desktop/test/live-voice-permission.test.mjs` — “Live Voice media permission requires the trusted main frame and an active microphone lease”; work-binding and delegation owner spoof cases are not combined in this test |
| W2-004 | Gap | No test currently switches the visible session from A to B and asserts that work remains bound to A |
| W2-005 | Direct | `apps/desktop/test/live-work-scope.test.mjs` — “a work session removed while Host metadata is being read cannot pass revalidation” |
| W2-006 | Gap | No test changes project membership or tightens the bound session mode during classification |
| W2-007 | Direct | `apps/desktop/test/live-work-scope.test.mjs` — “work scope requires the still-active call binding and a supported local session” |
| W2-008 | Gap | No test proves Live credentials remain separate from the bound session’s configured coding provider |
| W2-009 | Partial | `apps/desktop/test/live-voice-controller.test.mjs` — “renderer and Main complete a Codex Live user path without invoking an Agent”; work-enabled Codex delegation is covered by the new wire/coordinator/AgentHost fixture, but not through WebRTC DataChannel transport |
| W2-010 | Partial | `packages/voice-runtime/src/live/protocol.test.ts` — “parses only the declared work tool arguments and builds provider-native single receipts”; actual WebSocket adapter lifecycle is not exercised |
| W2-011 | Partial | `packages/voice-runtime/src/live/protocol.test.ts` covers the 16-call parser limit; repeated multi-call adapter handling and replay are not asserted together |
| W2-012 | Partial | `packages/voice-runtime/src/live/protocol.test.ts` parses `response.function_call_arguments.done`; duplicate `output_item.done` delivery through the concrete adapter is not tested |
| W2-013 | Partial | `packages/voice-runtime/src/live/protocol.test.ts` — “keeps GA and compat-v1 session fields and audio events distinct”; concrete adapter setup and authentication paths are not exercised together |
| W2-014 | Partial | `packages/voice-runtime/src/live/protocol.test.ts` rejects extra `sessionId` and blank instructions; unknown-tool and malformed-wire zero-side-effect behavior through each adapter is not one fixture |
| W2-015 | Partial | `packages/host-runtime/src/live-work/coordinator.test.ts` — “delivers a received receipt before classifying and submits the original text once”; it checks ordering, not the specified receipt latency budget under a deliberately slow classifier/Agent |
| W2-016 | Partial | `packages/host-runtime/src/live-work/coordinator.test.ts` — “does not dispatch if the local provider receipt was not sent”; adapter socket send failures are not exercised |
| W2-017 | Partial | `packages/host-runtime/src/live-work/coordinator.test.ts` preserves the original request text, but does not assert classification preserves the example’s conditional constraint |
| W2-018 | Gap | No negative test proves a code-related conversational remark creates no work side effect |
| W2-019 | Direct | `packages/host-runtime/src/live-work/coordinator.test.ts` — “answers a result query from the recorded operation without starting another turn” |
| W2-020 | Gap | No test covers a negated or undecided request remaining non-executable |
| W2-021 | Gap | No test proves “stop speaking” changes announcement policy without stopping work |
| W2-022 | Gap | No test covers ambiguous “stop” while speech and work are both active |
| W2-023 | Partial | `packages/host-runtime/src/live-work/coordinator.test.ts` — “fails closed on malformed classifier output and validates exact intent fields”; timeout and missing-model cases are not covered by this test |
| W2-024 | Partial | `packages/host-runtime/src/live-work/coordinator.test.ts` — “asks for clarification when a busy new task has no explicit relationship”; untrusted history injection is not asserted here |
| W2-025 | Partial | `apps/desktop/test/live-work-production-composition.test.mjs` now exercises production `createLiveWorkBridge` → `createAgentHostBridge` → registered `agentPrompt` handler → real AgentHost with a fake Host RPC/sidecar; the four-profile parser fixture still uses its own WorkPort and concrete adapters are not instantiated |
| W2-026 | Gap | No positive end-to-end test proves a valid steer stays on the captured active turn |
| W2-027 | Direct | `packages/host-runtime/src/live-work/coordinator.test.ts` — “rejects a stale steer without falling back to prompt or queue” |
| W2-028 | Direct | `packages/agent-runtime/src/turn-target.test.ts` — “rejects missing or replaced active turns when an exact target was supplied” |
| W2-029 | Gap | No Voice work test covers a Runtime `accepted: false` steer result or finalizing turn |
| W2-030 | Partial | `apps/desktop/test/live-work-provider-integration.test.mjs` asserts the user message and `voiceOrigin` reach the AgentHost Runtime prompt; `packages/agent-host/src/agent-host.test.ts` covers a queued voice-provenance turn, but persistence through the production registered handler is not asserted in the same flow |
| W2-031 | Direct | `crates/host-core/src/turn_queue.rs` — `voice_origin_and_user_message_identity_roundtrip_through_queue`; old-row compatibility is covered by `v19_queue_upgrade_preserves_existing_entries` |
| W2-032 | Partial | The pure-call regression test covers reject-only delegation; no assertion explicitly pairs final transcript/self-commitment input with zero turn creation |
| W2-033 | Partial | Coordinator routing case plus `live-work-production-composition.test.mjs` exercise explicit queue routing into real AgentHost; its queue store is backed by a Host RPC fixture, not Rust persistence |
| W2-034 | Partial | `packages/agent-host/src/agent-host.test.ts` — “drains an idle explicit enqueue and preserves voice provenance” and “queues behind an active turn, drains in order, and aliases runtime ids”; production Live composition also admits an independent voice-origin entry, but does not use Rust durable storage |
| W2-035 | Partial | `packages/agent-host/src/turn-queue.test.ts` — “keeps arrival order, positions, and the per-session bound”; Voice error recovery at queue capacity is not covered |
| W2-036 | Partial | `packages/agent-host/src/agent-host.test.ts` — “cancels a queued collaboration message without dispatching it”; Voice operation-reference cancellation is not covered |
| W2-037 | Gap | No Voice test races queue removal against delivery-pending or already-consumed state |
| W2-038 | Gap | No test verifies graceful stop reports “requested” before authoritative terminal state |
| W2-039 | Partial | `packages/agent-runtime/src/turn-target.test.ts` proves exact-target rejection; an immediate-abort race through the active-run owner is not covered end to end |
| W2-040 | Gap | No test races a slow new-work classifier against a later accepted stop request |
| W2-041 | Direct | `packages/host-runtime/src/live-work/coordinator.test.ts` — “deduplicates the same provider request and rejects parameter conflicts” |
| W2-042 | Direct | Same coordinator case asserts changed parameters under one provider ID are rejected |
| W2-043 | Gap | No test distinguishes a user-confirmed repeat from an accidental duplicate request |
| W2-044 | Gap | No test resolves concurrent classifiers in reverse order and asserts admission ordering |
| W2-045 | Direct | `packages/host-runtime/src/live-work/coordinator.test.ts` — “keeps a terminal event that arrives before submit returns” |
| W2-046 | Partial | `packages/agent-host/src/agent-host.test.ts` — “queues behind an active turn, drains in order, and aliases runtime ids”; Voice operation updates and single feedback are not part of that assertion |
| W2-047 | Direct | `packages/host-runtime/src/live-work/coordinator.test.ts` — “bounds an unresolved dispatch and reconciles it without resubmitting”; `packages/agent-host/src/agent-host.test.ts` — “reconciles only the exact session, operation, and user-message identity” |
| W2-048 | Partial | `packages/host-runtime/src/live-work/operation-ledger.test.ts` — “preserves all accepted identities up to the call limit”; process restart/replay behavior is not tested in the same case |
| W2-049 | Direct | `packages/host-runtime/src/live-work/context.test.ts` — “never includes transcript or prior voice input while sharing is disabled” |
| W2-050 | Direct | `packages/host-runtime/src/live-work/context.test.ts` — “shares only bounded plain user and assistant text when explicitly enabled” |
| W2-051 | Partial | `packages/host-runtime/src/live-work/context.test.ts` bounds context and preserves the instruction; a long-Unicode UTF-8 boundary case is not explicit |
| W2-052 | Gap | No test puts a critical negation beyond the instruction-size limit and asserts rejection |
| W2-053 | Partial | `packages/agent-host/src/agent-host.test.ts` — “reconciles only a matching optimistic user item and ignores duplicate, unknown and wrong-turn acknowledgements”; typed-input context projection is not covered |
| W2-054 | Partial | `packages/agent-host/src/agent-host.test.ts` covers voice provenance and duplicate acknowledgements; a Voice-origin echo producing zero new candidate is not tested |
| W2-055 | Gap | No test covers session identity or transcript lookup failure during classifier-context construction |
| W2-056 | Gap | No credential/header/SDP sentinel test verifies filtering across DTO, diagnostics, and Host feedback |
| W2-057 | Partial | `packages/agent-host/src/agent-host.test.ts` — “provides live work state without reading transcript history”; disagreement with a false Renderer running flag is not simulated |
| W2-058 | Partial | `packages/agent-host/src/agent-host.test.ts` maps message/tool events and turn terminals separately; no Voice feedback test asserts tool/message/subagent completion alone cannot settle a work operation |
| W2-059 | Partial | AgentHost tests cover completed, interrupted, and failed turn events separately; a single Live work projection matrix for failed/interrupted/canceled is absent |
| W2-060 | Direct | `packages/host-runtime/src/live-work/result-summary.test.ts` — “uses an honest status fallback when no final assistant message exists” |
| W2-061 | Direct | `packages/host-runtime/src/live-work/result-summary.test.ts` — “uses only the latest assistant message from the exact terminal turn”; `apps/desktop/test/live-work-production-composition.test.mjs` delays final-message visibility until a bounded production Bridge reread |
| W2-062 | Direct | `apps/desktop/test/live-voice-service.test.mjs` — “a shared terminal turn produces one feedback item and updates every linked operation” |
| W2-063 | Direct | `apps/desktop/test/live-voice-service.test.mjs` — “work feedback waits for a quiet window and reports local delivery separately from task execution” |
| W2-064 | Direct | `packages/host-runtime/src/live-work/feedback-scheduler.test.ts` covers playback/user idle, silent mode, explicit queries, speech gap, and coalescing |
| W2-065 | Partial | `packages/agent-host/src/approvals.test.ts` exercises the existing approval broker; a voice-origin task waiting on the original approval UI is not integrated |
| W2-066 | Gap | No Live work test covers immediate task requests in Plan/Goal sessions |
| W2-067 | Gap | No test proves spoken approval text cannot resolve a Plan/Goal or tool permission request |
| W2-068 | Partial | `packages/agent-host/src/agent-host.test.ts` — “relays asktool answers with skip semantics”; it does not test Live feedback/UI behavior for a waiting-input event |
| W2-069 | Gap | No test exercises an authorized MCP/plugin tool from a voice-origin AgentHost turn through the existing permission gateway |
| W2-070 | Gap | No test explicitly disables the MCP HTTP server while exercising the internal work port |
| W2-071 | Partial | `packages/voice-runtime/src/live/protocol.test.ts` rejects extra `sessionId` arguments; a generic desktop-action whitelist attack is not covered |
| W2-072 | Gap | No test independently invalidates Live and coding credentials while an accepted task is running |
| W2-073 | Partial | `packages/host-runtime/src/live-work/coordinator.test.ts` — “lists session choices and opens only a call-scoped selection reference”; page-size and secret/path exclusion are not all asserted there |
| W2-074 | Partial | `apps/desktop/test/live-work-operations.test.mjs` covers opaque-reference panel actions; duplicate-label resolution is not explicitly asserted |
| W2-075 | Direct | `apps/desktop/test/live-work-scope.test.mjs` — “selection references are opaque, call-scoped, short-lived, and removed with the call” |
| W2-076 | Direct | `packages/host-runtime/src/live-work/coordinator.test.ts` — “lists session choices and opens only a call-scoped selection reference”; active work binding is kept by the work-scope implementation |
| W2-077 | Partial | `packages/host-runtime/src/live-work/coordinator.test.ts` — “creates only a project choice and keeps the active call's bound session unchanged”; default model/permission preservation is not asserted |
| W2-078 | Partial | `packages/host-runtime/src/live-work/context.test.ts` verifies opaque references without project paths; arbitrary project-path submission rejection is not tested at the Host boundary |
| W2-079 | Partial | The coordinator create-selection test keeps the active call binding unchanged; no test covers the complete create-then-explicit-new-call user flow |
| W2-080 | Gap | No test covers explicit target reconnection, old pending-candidate withdrawal, and old accepted-task retention together |
| W2-081 | Partial | `packages/host-runtime/src/live-work/coordinator.test.ts` — “does not dispatch a classifier result after the work call closes”; microphone release is tested separately in the service suite |
| W2-082 | Gap | No test ends Live after accepted work and proves the real AgentHost operation/queue continues |
| W2-083 | Partial | `packages/voice-runtime/src/live/protocol.test.ts` parses Gemini tool-call cancellation; adapter behavior before versus after work admission is not tested |
| W2-084 | Gap | No automated test covers lock/hide lifecycle cleanup while accepted work remains active |
| W2-085 | Gap | No test delivers an old feedback or receipt callback after a new call replaces the old one |
| W2-086 | Partial | Operation ledger and feedback scheduler tests bound identities/queues; repeated adapter start/end and detached observer cleanup are not covered together |
| W2-087 | Partial | `packages/voice-runtime/src/live/response-tracker.test.ts` — “cancels active output and drops late audio and completion from an interrupted response”; PCM helpers have separate resampling coverage, but provider interruption paths are not combined in one regression case |
| W2-088 | Partial | `apps/desktop/test/live-voice-service.test.mjs` covers mute/media state and feedback gating; active AgentHost work is not paired with mute in one assertion |
| W2-089 | Partial | `apps/desktop/test/live-voice-controller.test.mjs` covers the existing renderer/Main path; React subscriber unmount ownership is not asserted |
| W2-090 | Partial | `apps/desktop/test/live-work-operations.test.mjs` renders exact terminal summaries; the complete started/queued/waiting/unknown transition sequence is not tested |
| W2-091 | Gap | No test switches the visible session before invoking stop/view and asserts the displayed A/T target is retained |
| W2-092 | Partial | Coordinator tests cover malformed classification, stale steer, and expired selection seams; non-fatal media continuity for each business error is not combined |
| W2-093 | Gap | No test queues Gemini context-only updates until both model generation and PCM playback drain |
| W2-094 | Partial | `packages/voice-runtime/src/live/protocol.test.ts` verifies work-profile declarations and GA/compat separation; adapter capability refusal and UI availability are not integrated |
| W2-095 | Partial | Existing controller, shortcuts, microphone lease, and work-voice tests cover several legacy paths; text prompt/steer/queue and Dictation/Host Speech are not one regression matrix |
| W2-096 | Partial | `apps/desktop/test/live-work-provider-integration.test.mjs` covers four protocol parsers/encoders → coordinator → AgentHost events; `apps/desktop/test/live-work-production-composition.test.mjs` separately reaches production Live WorkBridge, registered `agentPrompt` handler, real AgentHost, and result projection. Runtime/Host-core IO and concrete socket/WebRTC adapter instances remain fixtures or untested |

## Audit summary

The matrix has an explicit row for every W2 acceptance ID. **Direct** and
**Partial** are test mappings only; **Gap** items remain uncovered and should
not be described as passing. The v2.1 refresh maps 20 Direct, 47 Partial, and
29 Gap cases. The production composition fixture improves the Main/handler
evidence for W2-025 and W2-096 but still does not exercise concrete socket or
WebRTC adapters, Rust persistence, real provider models, credentials, or
physical audio. The full v2.1 case mapping is in
[`live-work-v21-coverage.md`](live-work-v21-coverage.md).

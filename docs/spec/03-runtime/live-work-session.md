# Live Voice Work Session Integration

> Status: In progress; acceptance requires the automated and manual evidence
> listed in the delivery plan. Live Voice provider bindings and work-session
> bindings are separate scopes.

## Purpose

Live Voice may submit a bounded work request to a PI-Desktop session through
its existing backend. At call start, the current Composer session is the default
work target when one exists; the user can switch targets by voice during the
call. The Live provider remains a voice interface; the existing Agent Runtime
continues to own file, shell, MCP, plugin, skill, and subagent work under the
target session's current model and permission policy.

## Scope and authorization

- Starting from a Composer with an active session uses that current session as
  the initial `workTarget`. With no active Composer session, the call starts
  unbound and the user can list and select a target by voice. Main resolves the
  renderer's session hint against a fresh Desktop/Native Pi/Remote catalog and
  fails closed when it is missing or ambiguous.
- There is no per-call **Allow work requests** gate or mandatory preselection.
  A voice work request remains only a candidate: the target backend continues
  to enforce its existing identity, admission, permission, and approval rules.
  A provider tool request cannot choose a raw session ID, project path, model,
  mode, or permission.
- Voice selection changes the target only for subsequent requests. Existing
  operations remain associated with their original session; opening another
  session for UI navigation does not silently retarget work.
- Context sharing remains a separate, unchecked-by-default call consent. When
  enabled, only bounded plain-text history from the current work target may be
  read for classification; changing target changes the eligible session.
  When disabled, no prior session messages are read. Context consent grants no
  execution authority and is not persisted.

## Candidate and routing flow

Each provider exposes only `delegate_to_work_session({ instruction })`. Main
validates the tool name and arguments, freezes the call scope, registers a
bounded operation identity, and returns a short `received / not_started`
receipt before intent classification or Agent admission. Identical provider
request IDs are not dispatched twice; changed content under the same ID is
rejected. WebSocket receipts and work feedback are reported as locally sent
only after the socket write callback succeeds. Close, cancellation, send error,
or a one-second write deadline reports undelivered; an undelivered initial
receipt prevents classification and Host admission. This is not evidence that
the remote provider processed the message or that a person heard it.

A read-only one-shot classifier uses the selected work session's configured
model with tools disabled. Its strict output is passed to deterministic
routing. Conversation and status requests do not create turns. A clear
constraint on the observed active turn may steer that exact turn. An explicit
independent task uses the Host-owned queue. Ambiguous routing, stale turns, and
unavailable sessions fail closed; steer failure never falls back to prompt or
queue. A result query reads the latest terminal operation recorded for the
current call, or the explicitly referenced operation, and shows its bounded
summary without starting another turn.

When the bound session has exactly one open AskTool question, the classifier
also receives that question and its own options, and the provider is told the
same bounded question as interaction-required feedback so it can read it out.
The user's answer is routed as a `respond-input` control request, not as work:
it resolves that one question through the Host-owned input path and never
creates, steers, or queues a turn. Every question of the open ask must be
answered exactly once and every chosen label must be one of that question's own
labels; free-text answers, unknown labels, partial answers, and a session with
zero or several open questions are refused with an honest reason and without
retry, and an unresolved dispatch stays unknown instead of being resubmitted.

### Reliability and admission identity

Main captures the active turn synchronously when it registers a provider
candidate. An explicit `null` remains “no observed turn”; stop and steer never
retarget a later turn. Duplicate provider request IDs reuse their original
operation and observation. A validated stop runs on the reserved control
classifier lane and advances a barrier: earlier writes that have not crossed
Host admission are withdrawn, while a write already dispatching remains
unknown until read-only Host evidence resolves it.

Ordinary new work uses reject-if-busy admission. Only an explicit queue intent
or a classifier-confirmed independent task enters the Host queue. AgentHost
rechecks Main's private workspace identity against fresh session metadata at
the final turn/queue admission boundary. A mismatch returns `WORKSPACE_CHANGED`
before a prompt or queue entry is created. An idle explicit enqueue asks
AgentHost to drain its existing queue; restored held entries remain held.

Classifier calls have an 8-second deadline and receive cancellation; snapshot
reads and individual Host dispatch waits are bounded. If a Host write has
already been issued and its result is not known, the operation becomes
`unknown`, is checked only through an exact read-only identity lookup, and is
never resubmitted. Closing the call withdraws pre-dispatch candidates but keeps
an in-flight admission `unknown`; accepted work remains Host-owned. The UI
distinguishes classifier-invalid, classifier-timeout, caller-withdrawn,
receipt-undelivered, scope-changed, Host-rejected, and dispatch-unknown states.

Admission summaries and terminal results are separate. A matching terminal
event can settle unknown admission and cannot be downgraded by a late ACK.
Task results are associated only with write operations on the exact turn; a
stop operation retains its control acknowledgement and stores the stopped
turn as a separate `targetTurnId`; the stop row does not become a task
execution/result row. An explicit result query through that control operation
resolves to the linked write operation when it exists. The Main result reader
retries bounded history reads for the exact terminal turn and ignores
child/tool messages. It marks the result unavailable when no eligible root
assistant result can be read.

Project and session lookup uses Host metadata and returns at most 20 labeled
choices with opaque, call- and binding-revision-scoped `selectionRef` values.
References expire after 60 seconds and do not expose project paths or session
IDs. Opening a uniquely labeled session navigates through the existing
renderer; duplicate labels require an explicit panel choice. Session creation
is available only for a listed registered project and requires the user's
panel action. Neither opening nor creating a session changes the active work
binding.

## Existing Host and Agent ownership

Work submission uses the existing AgentHost and registered Agent handlers. The
Host queue remains the only queue and applies its existing capacity, order,
delivery, and cancellation behavior. Voice user messages carry an optional
`voiceOrigin` containing the call and operation IDs. Existing messages without
that metadata remain valid.

Stop and abort requests include the observed turn ID and are checked at the
actual run owner. Ending a Live call closes its candidate scope and media but
does not cancel work already accepted by the Agent or Host queue. Permission,
Plan, and Goal approvals stay in their existing desktop UI and policy paths; a
spoken "yes" is never an approval. An AskTool question may also be answered by
voice, under the option-only rule below.

Only the Host's authoritative turn-terminal event settles the Live operation.
Message completion, tool output, or a provider response ending is not proof
that the work finished. Missing evidence remains unknown; completion alone
does not imply tests passed.

## UI and current capability boundary

Idle Composer uses the single Live Voice entry and its side-effect-free
preparation surface; there is no second Live Work icon. The current Composer
session is the default target, when present; otherwise the user may choose one
by voice after explicitly starting the call. Start is always an explicit user
action and starts muted. Opening preparation does not start a call, create a
session, read conversation context, or grant backend permissions.

Call Details, opened deliberately from the global compact bar, displays the
current work target, whether bounded context sharing is enabled, current
operation admission/execution state, feedback delivery status, bounded route or
rejection messages, exact terminal summaries, and short-lived project/session
choices. Voice target changes apply only to subsequent requests.
It provides actions to view the bound session, open a listed session, create a
session in a listed project, stop its observed running turn, or cancel its exact
queued item. Creating a session uses the existing defaults and leaves the
current Live binding alone. Closing Details, pressing outside it, or pressing
Escape changes neither the call nor accepted work. Navigating to another page
or session does not hide the global bar or retarget the work binding.

A bound work session that is waiting on the user is surfaced in both Live
surfaces, because the card that decides it lives in that session's own
Composer, not in the call. The compact bar carries a persistent
waiting-for-decision line, and Details shows the pending request itself: the
asktool question text (bounded and plain), the tool awaiting permission, or the
plan awaiting approval, plus an action that opens the exact bound session and
closes Details. Another session's pending request is never attributed to the
bound session, and an unbound call shows nothing. When the backend state says
the session waits but this renderer no longer holds the request (a renderer
reload, or an ask delivered before the renderer subscribed), Details still
offers the same action under a generic wording. The panel and the bar never
answer or approve: they carry no approve or answer control, the request text is
display-only data, and no panel action can resolve a permission, Plan, or
AskTool request. Answering an AskTool question by voice is a separate,
option-only path (see the routing section above).

The compact bar owns Cancel during startup and End/mute during the call;
Ending remains visible through both Main and renderer cleanup even after the
feature is disabled. End remains distinct from stopping an observed task or
canceling an exact queue item. This presentation redesign changes no IPC,
persistence, Host admission, permission, or context-projection contract.

### Work feedback and announcement policy

Host feedback is queued separately from work execution, bounded to eight
items, deduplicated, and coalesced on overflow. Received receipts stay
context-only. Automatic status and result speech waits for provider generation
to finish, user speech to stop, and local playback to be idle; it then applies
a 700 ms quiet window and a three-second minimum speech gap. Feedback older
than 15 seconds remains visible and is delivered as context-only. Silent mode
suppresses automatic speech without stopping work; an explicit status or
result query may still be spoken. Feedback delivery failure is shown
separately and never repeats the work request.

Gemini Live and Realtime use PCM output-credit drain as the local playback
queue signal. Codex work calls route the remote audio element through a local
Web Audio analyser and observe its output samples; if that monitor cannot be
established or its AudioContext is not running, automatic feedback remains
held. This observes renderer audio activity before the output device, not
whether a person heard it. The full provider and device behavior still
requires the manual matrix in the delivery plan.

## Privacy and resource limits

- No provider-supplied path, session identity, raw IPC operation, permission
  flag, or arbitrary tool schema crosses the work boundary.
- Context projection includes only bounded plain user/assistant text after
  filtering tool output, attachments, and prior voice-origin messages.
- Live captions are transient and are not inserted as work-session messages.
- Call cancellation controls only unaccepted candidates and Live feedback; it
  is not an Agent cancellation signal.
- Per-call candidate identities and operation views are bounded and discarded
  when the call closes. Existing Host persistence owns accepted queue entries
  and user-message provenance.

## Validation references

The implementation and test evidence are tracked in
[`../../implementation/live-work-evidence.md`](../../implementation/live-work-evidence.md).
The target-selection decision is recorded in [ADR 0313](../../adr/0313-live-voice-default-session-target.md).
The representative user path and automated coverage status are listed in
[`../06-delivery/04-e2e-test-plan.md`](../06-delivery/04-e2e-test-plan.md).

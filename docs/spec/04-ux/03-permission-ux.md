# 03. Permission UX

## 1. Goal

Make high-risk local actions visible, interruptible, and predictable.

## 2. Mode matrix

| Mode | Read/Glob/Grep | BrowserPreview | Write/Edit | Bash | Plugins |
|---|---|---|---|---|---|
| Agent | allow | allow | permission policy | permission policy | registered risk policy |
| Plan | allow | allow | deny | `ask`/`accept-edits`: confirm; `auto`: allow | deny |
| Goal | allow | allow | deny | `ask`/`accept-edits`: confirm; `auto`: allow | deny |

The Read/Glob/Grep `allow` cells apply to paths inside the session workspace
and scratch roots. An explicit path outside both roots is an exception:
`auto` allows it, while `ask` and `accept-edits` show the same inline card as
other permission-gated tools. The card's argument preview includes the
requested path, and the external result remains absolute in the transcript.

Decision source: **D003/D189/D190/D195 (ADR 0057)**.

Plan and Goal keep this permission-mode control visible. Plan exposes the
effective permission choice; Goal shows the same chip geometry with a fixed
Auto label in the Composer and does not open a menu. Goal's approval card is
the separate place to choose the execution permission for the approved run.
They are contract intents, not strict read-only security profiles: a Bash
command can mutate workspace or scratch state under Auto. Write/Edit/plugin
tools are denied by the host before a permission card, regardless of grants or
Auto.

## 3. Decision types

- `allow-once`
- `allow-session` (scoped by toolName, **D006**)
- `deny`

No `allow-always` in MVP.

## 4. Permission card states

```text
pending → allowed_once
pending → allowed_session
pending → denied
pending → timeout_denied
```

- A request is keyed by both `sessionId` and `requestId`.
- A session without subagents has at most one pending request, because its
  agent loop is paused. Parallel delegates (§6a) can put more than one in
  flight; different sessions still wait for independent approvals.
- Replacing or resolving one request never removes another session's request
  or a newer request in the same session.

## 5. Timeout

- Default timeout: **120 seconds**
- On timeout: auto `deny`
- UI shows timeout state explicitly
- Agent receives tool error result: user denied / timed out

## 6. Card content requirements

Must show:

1. tool name
2. risk level
3. short reason
4. args preview (redacted if needed)
5. workspace context
6. actions: Allow once / Allow for session / Deny

The card is rendered inline only in its originating session's transcript.
Background requests remain pending without opening an overlay, changing the
active page/project/session, or moving keyboard focus. Opening that session
reveals its card with the original absolute countdown deadline.

Resolving a request never initiates navigation. Any resulting tool artifact is
recorded in the same session's retained work-panel context. If that session is
backgrounded before completion, the artifact must not open or resize the
visible panel; explicitly returning to the session restores its retained panel
open state, tabs, active tab, and Browser resource without a transient panel
open/close cycle in the intervening conversation.

## 6a. Queued requests from parallel delegates (D201, ADR 0062)

Parallel subagents can each stop on a gated tool at the same moment, so a
session holds a **queue** of pending requests, oldest first, not a single slot.
The alternative — a stack of cards for calls the user cannot tell apart — is not
answerable.

- Only the head of the queue is rendered and answerable. The rest wait
  invisibly; their delegates stay blocked, which is the intended back-pressure.
- Answers are matched by `requestId`, never by position, so a late answer can
  only clear the request it answered and can never resolve a successor.
- A request the host closed itself (expiry, cancelled tool call) is removed by
  `toolCallId` from anywhere in the queue, so a card that was never shown still
  leaves. The 120s deadline (§5) runs from arrival for every request, queued or
  not — a request can therefore expire while waiting, and the host's own denial
  is what the delegate sees.
- Abort denies the **whole** queue, not just the visible card: a queued delegate
  would otherwise keep its tool call alive behind a stop the user already asked
  for.
- A session with nothing pending has no queue at all, so "does this session need
  attention" stays a presence check and the sidebar indicator is unchanged.

The card adds two lines of provenance when they apply, on top of §6:

- who asked — "Asked by the `<agent>` subagent" — present only for a delegate's
  request, so a parent's own request looks exactly as it does today;
- how many wait behind it — "N more request(s) are waiting" — so answering does
  not look like it finished the session's questions.

Session grants are unchanged and still per `toolName` per session: a delegate's
"Allow for session" also covers the parent and the other delegates
(`03-runtime/03-tools-and-permissions.md` §10.2).

## 7. Composer interaction while pending

- user may continue editing text
- sending another prompt or changing active-session mode/provider/model/permission
  is blocked while a `pending` Plan or Goal approval exists
- For a pending Plan or Goal proposal specifically, the existing draft is preserved and
  the prompt becomes read-only. Composer mode, thinking, permission, model, and
  send controls are disabled; the approval surface's Approve and Reject actions
  remain enabled.
- the left-of-input Composer Agent/Plan/Goal chip and Composer model × reasoning
  picker re-enable when the
  host closes the approval as rejected, expired, or interrupted; terminal
  proposal snapshots are not gates
- Abort concurrently cancels the turn and explicitly denies the matching host
  permission request; late cleanup cannot clear a replacement request
- another session remains independently editable/runnable and its own pending
  request is unaffected

## 8. Session grants surface

Active session grants (toolName, grantedAt, clear action) remain runtime-owned.
A durable grants-management surface is deferred until a host-backed settings
schema exists; Settings must not render a control that cannot persist or affect
the permission runtime.

## 9. Plan and Goal contract approval card

Plan and Goal approval are not generic tool permission cards. They are rendered
inline in the originating session after `SubmitPlan(...)` or `SubmitGoal(...)`
causes host-core to preserve the exact Markdown bytes in a new immutable
`.pi/plan/*.md` or `.pi/goal/*.md` artifact.

The card shows only the structured title and an opener for the exact artifact
path. It does not render the submitted question/description, status, or
approval validity/deadline. It offers only:

- **Approve** with an explicit target permission mode (`Ask`, `Accept edits`,
  or `Auto`; the last selected mode is remembered on this device and is the
  default for the next approval)
- **Reject**, which stops the run and leaves the contract state active; a later
  turn must submit a new complete snapshot/artifact

The card has distinct `pending`, `resolving`, `approved`, `queued`, `running`,
`rejected`, `expired`, and `interrupted` states. Approval is enabled only for a
matching live proposal/session/turn/tool-call/version request and the deadline
is exactly 30 minutes from creation. Renderer state retains the latest
proposal/execution snapshot per session only for the current renderer lifetime,
driven by live Host events; only `pending` is actionable or a Composer gate.
Renderer reload may restore a still-pending row without resetting its deadline
while the same Host remains alive, but does not rehydrate rejected, expired,
approved/completed, or interrupted terminal cards. Such a card may remain
visible and non-actionable only until reload. Startup interruption marks pending
and queued/running work interrupted
before RPC service, offers no stale action, and never replays it. Expiry uses
`PLAN_APPROVAL_TIMEOUT`. An already-approved interrupted run keeps the session
in Agent; the UI is not required to present its interrupted terminal snapshot
after a full Host/app restart.

## 10. Acceptance

1. Plan and Goal deny Write/Edit/plugins in every permission mode
2. Plan and Goal Bash prompt under Ask and Accept edits and run without confirmation
   under Auto, with the mutation tradeoff visible
3. Agent mode uses the normal high-risk permission policy
4. timeout becomes deny in UI + tool result
5. allow-session suppresses repeat prompts for same toolName only
6. concurrent session requests remain isolated and never take over the visible
   conversation or its work panel; post-approval artifacts remain assigned to
   the request's originating session
7. Plan/Goal approval displays only the title and artifact opener, remembers the
   selected permission mode for the next approval on this device, and sends that
   mode only on approval; no question/description, validity/deadline, status,
   inline Markdown/hash/byte-size, or revision/feedback action is rendered
8. reject, expiry, abort, crash, stale response, and persistence failure close
   pending Plan/Goal work in its contract state with no execution capability; a
   later prompt may revise and submit a new immutable artifact
9. host restart interrupts pending/queued/running work without replay or stale
   action and keeps already-approved interrupted sessions in Agent; no terminal
   card restoration is required after restart

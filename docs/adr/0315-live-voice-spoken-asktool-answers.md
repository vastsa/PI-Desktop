# ADR 0315: A Spoken Answer Selects Among an Open asktool Question's Own Options

- Status: Accepted for implementation
- Date: 2026-10-01
- Related: Live Voice Work Session Integration, [ADR 0313](0313-live-voice-default-session-target.md), ADR 0311, ADR 0310

## Context

A Live Voice work call could already report that the bound session is waiting on
an asktool question, but it could not act on it: the answer existed only in that
session's own Composer card, and a user talking through a call had to leave the
call flow, find the session, and answer by hand. The Live Voice Work Session
spec accordingly said that "Permission, Plan, Goal, and AskTool decisions stay
in their existing UI and policy paths".

Those two kinds of wait are not the same decision:

- A permission, Plan, or Goal approval grants *authority*. The voice provider
  must never be able to obtain authority the user did not grant in the desktop
  UI, and spoken agreement is not approval.
- An asktool question is the agent asking the user to choose. The agent itself
  produced the question and its options, so the answer cannot widen the agent's
  authority beyond the choices it already offered the user.

## Decision

- Add one classifier intent, `respond-input`, whose payload is
  `{ answers: [{ questionIndex, options[] }] }`: one entry per question of the
  session's open asktool question, each naming the chosen option labels.
- Live Voice may resolve the bound session's open asktool question through the
  same Host input path the desktop card uses. Nothing else changes: permission,
  Plan, and Goal approvals remain desktop-UI decisions, and a spoken "yes" is
  never approval.
- A spoken answer may only select among the labels the question itself offered.
  There is no free-text answer. Every question must be answered exactly once;
  a partial answer is refused because the Host reads a missing answer as
  "skipped" and the user never said that.
- Fail closed and report honestly when: the session has no open question, it has
  more than one open question (the answer cannot be attributed), a label does
  not match, a question index is missing, repeated, or out of range, or the
  input is malformed. A refusal is never retried and points the user at the
  desktop card. An unanswered dispatch stays `unknown` and is never resubmitted.
- The question and its own options are delivered to the live provider as
  interaction-required work feedback so it can read them out, and the same
  bounded question is part of the classifier input, so the option labels the
  answer is checked against are the ones the user heard.
- Bounds: at most 8 questions, 8 options per question, 300 characters per
  question, 120 characters per option, and a feedback message that stays inside
  the existing delivery budget, truncated on question boundaries.
- The resolution goes through the Host-owned input path, so the input's
  `input.resolved` event records who answered and the operation is a control
  acknowledgement, not a task or a result row.

## Alternatives considered

- **A provider function per adapter** (`answer_pending_question`): rejected. It
  needs three separate wire declarations for the same validation, while the
  existing delegation/instruction channel already carries the request and the
  work classifier already owns intent interpretation.
- **Free-text spoken answers**: rejected. Unbounded model-authored content would
  reach a question the user may never have been asked, and it could not be
  validated against anything the session actually offers.
- **Keep answers desktop-only**: rejected as the state the user reported. The
  call could announce a wait it could not act on, which forced the user to hunt
  for the card mid-call.

## Consequences

- An asktool question can be answered hands-free during a work call, while
  permission, Plan, and Goal approvals keep their desktop-only decision path.
- Residual risk: a provider (or a spoofed audio source) could answer a question
  as if the user had. The blast radius is bounded to choosing among options the
  agent already offered the user, it requires exactly one open asktool question,
  it never grants authority, it is recorded with voice provenance in the
  session, and it is rejectable at the card's own resolution boundary.
- Remote and Native Pi sessions are unchanged: this path is Electron Main plus
  the local AgentHost input path, and both remote backends keep their own
  approval and input transports.
- The live panel and the compact bar still carry no approve or answer control;
  they show the pending request and open the session that owns it.

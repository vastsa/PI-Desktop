# ADR 0315: A Spoken Answer Selects Among an Open asktool Question's Own Options

- Status: Accepted for implementation
- Date: 2026-10-01
- Related: [ADR 0313](0313-live-voice-default-session-target.md), ADR 0310,
  ADR 0311

## Context

A Live Voice work call could report that the bound session was waiting on an
asktool question but could not act on it, so a user talking through a call had to
find the session and answer by hand. A permission, Plan, or Goal approval grants
authority and must stay a desktop-UI decision; an asktool question only asks the
user to choose among options the agent itself produced.

## Decision

Add one classifier intent, `respond-input`, whose payload is
`{ answers: [{ questionIndex, options[] }] }` with one entry per question of the
session's open asktool question, and let Live Voice resolve that question through
the same Host input path the desktop card uses; nothing else changes, so permission,
Plan, and Goal approvals stay desktop-only and a spoken "yes" is never approval. An
answer may only select among the question's own labels, never free text, and every
question must be answered exactly once because the Host reads a missing answer as
skipped. The path fails closed when there is no open question, more than one open
question, a label mismatch, a missing, repeated, or out-of-range index, or
malformed input: the refusal is never retried, it points the user at the desktop
card, and an unanswered dispatch stays `unknown`.

The question and its options reach the live provider as interaction-required work
feedback and are part of the classifier input, so the labels checked are the ones
the user heard. Because resolution goes through the Host-owned input path, its
`input.resolved` event records who answered and the operation is a control
acknowledgement rather than a task or result row.

## Consequences

- An asktool question can be answered hands-free mid-call while approvals keep
  their desktop-only path.
- A provider or spoofed audio source could answer as if it were the user, bounded
  to choosing among offered options, one open question, no authority, recorded
  with voice provenance, and rejectable at the card's resolution boundary.
- Remote and Native Pi sessions keep their own approval and input transports.

## Alternatives

- A provider function per adapter (`answer_pending_question`): rejected because it
  needs three wire declarations for the same validation the existing channel
  already carries.
- Free-text spoken answers: rejected because unverifiable content could reach a
  question the user was never asked.

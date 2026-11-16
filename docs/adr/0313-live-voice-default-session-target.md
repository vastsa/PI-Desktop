# ADR 0313: Default Live Work to the Current Composer Session

- Status: Accepted
- Date: 2026-09-30
- Related: Live Voice Work Session Integration, ADR 0311

## Context

Live Voice must be useful from the current Composer without asking the user to opt
into work requests or pick a session before speaking. The target may be a Desktop,
Native Pi, or Remote session and can change by voice during a call, without
expanding the voice provider's authority or bypassing the target backend's policies.

## Decision

When Composer has an active session it becomes the initial work target; with none,
the call starts unbound and voice can list and select one. A renderer-provided
session id is only a hint: Electron Main resolves it against the fresh combined
session catalog and fails closed when it is missing or ambiguous, and voice
selection travels as call-scoped opaque references, so provider payloads never
choose raw session ids, paths, modes, or permissions. There is no per-call
work-access toggle, because candidates still pass through the selected backend's
identity, admission, authorization, permission, and approval paths. A target switch
applies only to later requests, and bounded history sharing stays a separate,
unchecked consent that grants no execution authority.

## Consequences

- Composer starts are predictable, and an empty target never makes Main guess.
- Permission and approval behavior remains owned by the Desktop, Native Pi, and
  Remote backends; Live Voice exposes no arbitrary IPC or tools.
- Context privacy stays independent of execution authorization.

# ADR 0313: Default Live Work to the Current Composer Session

- Status: Accepted
- Date: 2026-09-30
- Related: Live Voice Work Session Integration, ADR 0311

## Context

Live Voice must be useful from the current Composer without requiring the user
to opt into work requests or select a session before speaking. The target may be
a Desktop, Native Pi, or Remote session, and users may switch targets by voice
during a call.

## Decision

- When Composer has an active session, use it as the initial work target.
- Treat a renderer-provided session ID only as a target hint.
- Do not require a per-call work-access toggle.
- A target switch applies only to subsequent requests.
- Keep bounded history sharing as a separate, unchecked call consent.

## Consequences

- Composer starts are direct and predictable while session selection remains
  available by voice; an empty Composer target never causes implicit guessing.
- Main and backend-specific fixtures must cover fresh resolution, ambiguous or
  stale targets, all three sources, target switching, and fail-closed behavior.
- Permission and approval behavior remains owned by Desktop, Native Pi, and
  Remote backends; Live Voice does not expose arbitrary IPC or tools.
- Context privacy remains independent from execution authorization and must be
  tested separately.

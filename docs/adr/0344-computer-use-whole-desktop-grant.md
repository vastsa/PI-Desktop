# ADR 0344: Computer use grants the whole desktop automatically, and Stop is the boundary

- Status: Accepted (amends ADR 0342 §4 and §6; the rest of ADR 0342 stands)
- Date: 2026-11-04
- Related: D682, ADR 0310, ADR 0342

## Context

ADR 0342 built computer use around one user-picked window, where the picker was the only
way to mint a grant and the model could not name, enumerate, or widen a target, which
fails the capability it exists for: a request like "find the invoice in Mail, then enter
it in the spreadsheet" spans applications. Reducing a security boundary needs its own
decision, so the picker's weight moves to the refusals, the Settings enable switch, and
Stop, while host-core still owns every refusal, the renderer holds no handle or input
primitive, and the absolute refusals stand.

## Decision

`Grant` gains `scope: desktop | window`, where a desktop grant binds to exactly one
unrefused frontmost window and may rebind to any accepted one, while a window grant is
pinned and refuses to move. The agent mints its own grant: on the first call of a session
without a live grant, the `Computer` tool handler in Electron main calls
`computer.grantCreate` with no `targetId`, because enabling the feature is the consent,
and the renderer loses the enumeration and minting channels. Rebinding is a refusal path,
where `computer.inspect` takes an optional `targetId`, re-runs the self-target, denylist,
and elevation checks against a fresh enumeration, and always moves the grant revision so
previous `uid` and `basis` values stop validating, while `computer.act` never binds and an
action aimed at a vanished window is refused with `COMPUTER_STALE_REVISION`. The
observation lists the host enumeration with refused windows and their reason, and the
answer schema gains exactly one kind, `{"kind":"switch","window":"<id>"}`, which spends a
loop step rather than action budget and is re-checked against the host list.
`COMPUTER_USE_DEFAULTS.inputPolicy` becomes `autonomous-in-scope` under every permission
mode, bounded by the action budget, idle expiry, per-action re-validation, and Stop, while
`confirm-each` stays in the contract but unimplemented and its Settings row is removed.
Stop revokes the grant and aborts the turn holding it, and an agent-originated
`grantCreate` within `AGENT_REGRANT_COOLDOWN` is refused with `COMPUTER_STOPPED_BY_USER`
so the next tool call cannot make Stop meaningless, while a user-originated mint clears
the cooldown. PI-Desktop's own windows are never a target, secure input refuses capture
and synthesis, the credential-surface denylist cannot be removed, capture stays opt-in
with `a11y-only` as the default, and the audit trail records grant scope, minter identity,
and `computer.grant.rebound` with the application identity, never window text, typed
values, or pixels.

## Consequences

- The most dangerous capability no longer has a per-use human decision: enabling it means
  the agent may read and operate the user's applications, and the Settings copy says so.
- Prompt injection reaches further, since a hostile window can steer the agent toward
  another application and a user watching one window can be surprised by work in another;
  the step limit, action budget, single-action-per-answer schema, and audit trail bound it.
- Stop aborting the turn stops the agent's current work beyond computer use, and Windows
  and Linux still answer `COMPUTER_PLATFORM_UNSUPPORTED` until the stage 2 backends land.

## Alternatives

- Keep the picker with a "switch target" request: the friction the owner rejected, and
  approval fatigue would make the dialogs meaningless.
- Read the desktop but pin input to one window: tasks span applications, and the model
  would see buttons it may not press.

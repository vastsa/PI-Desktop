# ADR 0344: Computer use grants the whole desktop automatically, and Stop is the boundary

- Status: Accepted
- Date: 2026-11-04
- Decision: D682
- Deciders: PI-Desktop core
- Related: [ADR 0342](0342-os-computer-use-capability.md) ·
  [ADR 0310](0310-local-permission-approvals-without-deadline.md) ·
  [03-runtime/computer-use](../spec/03-runtime/computer-use.md) ·
  [05-security/01-security](../spec/05-security/01-security.md) ·
  [03-runtime/08-error-codes](../spec/03-runtime/08-error-codes.md)

## Context

This amends [ADR 0342](0342-os-computer-use-capability.md) §4 (the user-minted
scope grant) and §6 (the input policy). Everything else in 0342 stands.

[ADR 0342](0342-os-computer-use-capability.md) built computer use around one
user-picked scope grant: the user opened a picker, chose a single window, and the
agent could read and operate that window and nothing else. The picker was the
only way to mint a grant, and the model was deliberately unable to name,
enumerate, or widen a target.

In use, that shape does not deliver the capability the feature exists for. A
real request — "find that invoice in Mail, then enter it in the spreadsheet" —
spans applications. Under a window grant the agent must stop and ask the user to
pick again for each one, which means the user drives the task and the agent
assists with keystrokes. The owner of this product asked for the opposite: no
process selection, and the agent allowed to read everything by default, acting
without per-step confirmation.

This is a reduction in a security boundary, not a refactor, so it needs its own
decision rather than an edit to ADR 0342. What is *not* in question is the rest
of 0342: host-core still owns every refusal, the renderer still never holds a
handle or an input primitive, the loop still runs on its own model binding, and
the two absolute refusals still hold. Those are what make this change survivable.

The weight that the picker used to carry has to land somewhere. It lands on
three things: the refusals, which now run on every window the grant touches
rather than once at mint time; the enable switch in Settings, which becomes the
user's real consent; and Stop, which now has to end a run rather than one call.

## Decision

1. **A grant has a scope, and the default scope is the desktop.** `Grant` gains
   `scope: desktop | window`. A desktop grant is bound to exactly one window at
   a time — the frontmost one the host does not refuse — and may rebind to any
   other window the host does not refuse. A window grant is pinned to the window
   it named and refuses to move; it stays expressible for a caller that has a
   single window to offer, and nothing in the UI mints one today.

2. **The agent mints its own grant; there is no picker.** The `Computer` tool
   handler in Electron main calls `computer.grantCreate` with no `targetId` on
   the first call of a session that has no live grant. Enabling the feature in
   Settings is the consent; the handler carries nothing but the user's own
   settings (capture mode, action budget, idle expiry) and cannot shape what the
   grant covers. The renderer loses both the window-enumeration and the
   grant-minting IPC channels: nothing in the UI picks a target, so nothing in
   the UI needs to be able to.

3. **Rebinding is a refusal path, not a convenience.** `computer.inspect` takes
   an optional `targetId`. Binding it re-runs the self-target check, the
   denylist, and the elevation check against a *fresh* enumeration, and always
   moves the grant revision — so every `uid` and every coordinate `basis` from
   the previous window stops validating. `computer.act` never binds: an action
   lands on the window the preceding inspection described, or it is refused.

4. **A closed window does not end a desktop grant, but it does end the action.**
   If the bound window disappears, a desktop grant falls back to the frontmost
   usable window through the same refusals. Any action already aimed at the old
   window is refused with `COMPUTER_STALE_REVISION` even when the caller pinned
   no revision at all, because the thing it was aimed at is gone.

5. **The model may move between windows, and is told what it may not touch.**
   The observation lists the host's own enumeration — including refused windows
   with their reason — and the answer schema gains exactly one new kind,
   `{"kind":"switch","window":"<id>"}`. A switch spends a loop step, never an
   action budget, and a refused switch is reported to the model as a step
   rather than ending the run. The model still cannot invent a window: the id
   must come from the host's list, and the host re-checks it anyway.

6. **Runs are autonomous by default.** `COMPUTER_USE_DEFAULTS.inputPolicy`
   becomes `autonomous-in-scope`, and `autonomous-in-scope` is available under
   every permission mode rather than requiring `accept-edits` or `auto`. The
   budget, the idle expiry, the per-action re-validation, and Stop are the
   bounds on a run. `confirm-each` remains in the contract but is **not**
   implemented — stage 1 never built the approval card — so the Settings row
   that offered it is removed rather than left to imply a control that narrows
   nothing.

7. **Stop ends the run, not the call.** The indicator's Stop revokes the grant
   *and* aborts the turn that holds it, and host-core records the revocation:
   an agent-originated `grantCreate` within `AGENT_REGRANT_COOLDOWN` (30s) is
   refused with the new `COMPUTER_STOPPED_BY_USER`. Without the cooldown an
   automatic grant would make Stop meaningless — the next tool call in the same
   turn would simply mint another one. A user-originated mint clears it
   immediately; the cooldown otherwise expires on its own.

8. **The absolute refusals and the denylist are unchanged, and now matter
   more.** PI-Desktop's own windows (by pid, parent pid, and app key) are never
   a target, secure input refuses both capture and synthesis, and the built-in
   credential-surface denylist cannot be removed. "The whole desktop" is
   defined as *every window the host does not refuse* — these are not holes in
   the new scope, they are its edges.

9. **Capture stays opt-in.** `a11y-only` remains the default capture mode: a
   desktop-wide grant that screenshotted by default would put arbitrary windows
   into the session transcript. The user turns pixels on in Settings, and the
   handler now actually passes that choice to the grant, which the picker never
   did.

10. **The audit trail follows the scope.** A grant creation records its scope
    and whether the agent or the user minted it; a rebind appends
    `computer.grant.rebound` with the application identity it moved to. No
    window text, no typed values, no pixels — identity and shape only, as
    before.

## Consequences

- The product's most dangerous capability no longer has a per-use human
  decision in front of it. Enabling computer use in Settings now means "this
  agent may read and operate my applications", and the honest mitigations are
  the ones listed above, not a dialog. The Settings copy says so plainly
  instead of describing a handover that no longer happens.
- Prompt injection reaches further. Text read from any window is still data,
  but a hostile window can now try to steer the agent toward *another*
  application rather than only its own. The step limit, the action budget, the
  single-action-per-answer schema, and the audit trail are what bound it; a
  window that asks to be switched away from is just another refusable step.
- A user watching one window can be surprised by the agent working in another.
  The indicator names the window currently bound and updates on every rebind,
  and the drawn cursor moves with it, but there is no longer a moment where the
  user chose that window.
- `confirm-each` is now visibly unbuilt rather than quietly unenforced. That is
  a documentation fix as much as a product one: ADR 0342 and the spec described
  a per-step card that stage 1 never shipped.
- Stop aborting the turn is a behaviour change beyond computer use: pressing it
  stops the agent's current work, not just its screen access. That is what the
  button means to a user who is watching their machine being driven.
- Windows and Linux are unaffected: they still answer
  `COMPUTER_PLATFORM_UNSUPPORTED` until the stage 2 backends land, and the
  desktop scope is enforced in the platform-independent policy layer, so they
  inherit it when they arrive.
- The device gate is unchanged and still open. Nothing here was verified
  against a real application; see
  [computer-use evidence](../implementation/computer-use-evidence.md).

## Alternatives

- **Keep the picker and add a "switch target" request.** The agent would ask,
  the user would approve per window. It preserves the per-use decision, and it
  is exactly the friction the owner rejected: a two-application task becomes a
  sequence of dialogs, and approval fatigue would make the dialogs meaningless
  anyway.
- **Read the whole desktop, but keep input pinned to one picked window.**
  Attractive, because reading is the less dangerous half. It was rejected by the
  owner's decision: the point of the capability is to finish tasks, and the
  tasks span applications. It also produces a confusing model — the agent can
  see a button it may not press.
- **Follow the frontmost window automatically, with no switching.** No
  enumeration and no window ids reach the model, which is tidier. But then the
  agent can only work where the user's focus already is, so the user becomes
  the window manager for the agent — the friction the picker had, in a less
  honest form, and any window that steals focus steals the agent too.
- **Implement `confirm-each` and keep it as the default.** This is the right
  long-term answer for a desktop-wide scope and remains the plan. It was not
  made the default here because the card does not exist: shipping a default that
  silently behaves as autonomous would be worse than naming the gap.
- **Make the Stop cooldown a session-long lock.** Safest, and it leaves the
  user with a capability that stays broken until they find the switch in
  Settings. Thirty seconds plus a turn abort ends the run without turning Stop
  into an undocumented kill switch.

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

## Decision

1. **A grant has a scope, and the default scope is the desktop.** `Grant` gains
   `scope: desktop | window`.

2. **The agent mints its own grant; there is no picker.** The `Computer` tool
   handler in Electron main calls `computer.grantCreate` with no `targetId` on
   the first call of a session that has no live grant.

3. **Rebinding is a refusal path, not a convenience.** `computer.inspect` takes
   an optional `targetId`.

4. **A closed window does not end a desktop grant, but it does end the action.**
   If the bound window disappears, a desktop grant falls back to the frontmost
   usable window through the same refusals.

5. **The model may move between windows, and is told what it may not touch.**
   The observation lists the host's own enumeration — including refused windows
   with their reason — and the answer schema gains exactly one new kind,
   `{"kind":"switch","window":"<id>"}`.

6. **Runs are autonomous by default.** `COMPUTER_USE_DEFAULTS.inputPolicy`
   becomes `autonomous-in-scope`, and `autonomous-in-scope` is available under
   every permission mode rather than requiring `accept-edits` or `auto`.

7. **Stop ends the run, not the call.** The indicator's Stop revokes the grant
   *and* aborts the turn that holds it, and host-core records the revocation: an
   agent-originated `grantCreate` within `AGENT_REGRANT_COOLDOWN` (30s) is
   refused with the new `COMPUTER_STOPPED_BY_USER`.

8. **The absolute refusals and the denylist are unchanged, and now matter
   more.** PI-Desktop's own windows (by pid, parent pid, and app key) are never
   a target, secure input refuses both capture and synthesis, and the built-in
   credential-surface denylist cannot be removed.

9. **Capture stays opt-in.** `a11y-only` remains the default capture mode: a
   desktop-wide grant that screenshotted by default would put arbitrary windows
   into the session transcript.

10. **The audit trail follows the scope.** A grant creation records its scope
    and whether the agent or the user minted it; a rebind appends
    `computer.grant.rebound` with the application identity it moved to.

## Consequences

- The product's most dangerous capability no longer has a per-use human decision
  in front of it.
- Prompt injection reaches further.
- A user watching one window can be surprised by the agent working in another.
- `confirm-each` is now visibly unbuilt rather than quietly unenforced.
- Stop aborting the turn is a behaviour change beyond computer use: pressing it
  stops the agent's current work, not just its screen access.

## Alternatives

- **Keep the picker and add a "switch target" request.** The agent would ask,
  the user would approve per window.
- **Read the whole desktop, but keep input pinned to one picked window.**
  Attractive, because reading is the less dangerous half.
- **Follow the frontmost window automatically, with no switching.** No
  enumeration and no window ids reach the model, which is tidier.
- **Implement `confirm-each` and keep it as the default.** This is the right
  long-term answer for a desktop-wide scope and remains the plan.

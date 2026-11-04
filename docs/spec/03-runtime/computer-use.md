# Computer Use v1

> Status: Design accepted, not implemented. This page is the authoritative
> contract for the capability described in
> [ADR 0340](../../adr/0340-os-computer-use-capability.md). No code in the
> repository implements it yet.

## Scope

Computer Use lets the agent read and operate a native application the user has
explicitly handed to it. It is disabled by default, it is separate from the
embedded `Browser` tool, and it never operates the whole desktop at once: every
call runs against one user-picked scope.

It is reachable by voice. Live Voice remains a voice interface with no new
authority — a spoken request becomes a work request on the bound session
([Live Voice Work Session Integration](live-work-session.md)), the existing
Agent turn calls the tool, and the session's model, permission mode, and
approval cards apply unchanged. Voice-driven computer use is task delegation,
not per-frame teleoperation; a spoken instruction is answered by an agent turn
with observable progress, not by a continuous control loop.

| Surface | Owner | Reach |
|---|---|---|
| `Browser` tool (`pi.browser`, ADR 0170) | Bundled plugin over allowlisted CDP | The embedded `WebContentsView` guest only |
| `Computer` tool (this page) | host-core builtin | One granted native window or application |
| Live Voice | Electron main and renderer | Audio, transcript, and work delegation; no input synthesis |

## Ownership and process model

```text
Renderer (picker UI, indicator)
  → Preload IPC → Electron Main (thin: picker, indicator, tools.execute relay)
    → Rust host-core `computer.*` (windows, accessibility, synthesis, capture,
      grant broker, audit)
```

host-core owns window enumeration, accessibility inspection, event synthesis,
screen capture, the grant broker, the action budget, and the audit record. The
renderer never receives a native window handle, a native element reference, or
an input primitive; it receives only the picker's display list and the
indicator's grant view. The agent sidecar reaches the capability exclusively
through `tools.execute` on the existing `host.proxy` allowlist — no new proxy
method is added, and `computer.*` is not a plugin host API and does not appear
in the plugin permissions matrix.

## Grant and scope

A **scope grant** is the unit of authority. Only the user mints one, and only
through the host-driven picker.

| Field | Meaning |
|---|---|
| `grantId` | Identity of this grant; appears in every tool result and audit row |
| `target` | Exactly one window, or one application's windows, chosen in the picker |
| `revision` | Incremented whenever the measured target geometry or identity changes |
| `inputPolicy` | `confirm-each` or `autonomous-in-scope` |
| `capture` | `a11y-only` or `a11y-and-pixels` |
| `actionBudget` | Remaining input actions before the grant closes |
| `idleExpiry` | Wall-clock bound; a grant with no action closes itself |

Rules:

- The model cannot name, enumerate, request by title, or widen a target. There
  is no "list windows" and no "switch target" action. A call that resolves
  outside the granted scope is an error, not a prompt to expand.
- There is at most one active grant per desktop instance, mirroring the single
  Live Voice call slot. A grant belongs to the session and turn chain that owns
  it; a subagent inherits the active grant and cannot create a second one.
- Creating a grant is an explicit desktop-UI decision with no automatic
  deadline (ADR 0310). Permission mode `auto` does not mint grants, and a
  spoken request cannot: a call may ask for one, which raises the card in the
  main window while the floating call bar reports that the app needs attention.
- The user can always revoke: the indicator's Stop, the global shortcut, closing
  the target, or disabling the feature. Revocation is immediate and terminates
  an in-flight action's remaining steps.
- Grants are never persisted. A restart, a renderer reload, or a window
  navigation leaves no grant behind.

## Absolute refusals

These two refusals are not reachable by any permission mode, setting, grant
option, or `auto` policy:

1. **The capability never targets PI-Desktop's own windows** — approval cards,
   settings, secrets surfaces, the Live Voice widget, plugin views. Synthetic
   input into this application is a direct permission-broker bypass.
2. **Capture and synthesis both refuse while the OS reports a secure input
   state, or while the focused element is a password field.** The refusal is
   reported as a code; the field's content never reaches a snapshot, a
   screenshot, or a log.

A user-editable application denylist sits on top of these. Its built-in
credential-surface entries — the platform keychain and credential UI, and the
OS authentication dialogs — cannot be removed.

## Tool contract

`Computer` is a builtin high-risk tool, not a plugin tool, so its blast radius
cannot be expressed as a permission a plugin author may request. Plan and Goal
hard-deny it before permission evaluation, exactly like `Write` and `Edit`: it
mutates state outside the workspace that the host cannot snapshot, diff, or roll
back.

| Action | Risk | Behavior |
|---|---|---|
| `describe_scope` | low | Returns the grant view: target label, revision, policy, capture mode, remaining budget |
| `inspect` | low | Structured accessibility tree of the scope: role, name, value presence, enabled, focused, bounds, per-grant opaque `uid` |
| `screenshot` | low | Scope-cropped, downscaled image plus a `basis` token; refused under an `a11y-only` grant |
| `act` | high | One bounded batch of input addressed by `uid`, or by coordinates against a `basis` |
| `wait` | low | Bounded wait for a scope condition (element present, enabled, text changed) with an explicit timeout |

`act` supports `click`, `double_click`, `right_click`, `set_value`,
`press_keys`, `scroll`, and `select`. Each is dispatched through the platform
accessibility action when one exists, and falls back to synthesis only when it
does not.

Element identity is accessibility-first. A `uid` is opaque, minted per grant,
and invalidated by a revision change. `inspect` returns no element values, only
whether a value is present, so reading a field's content is an explicit
`inspect` result field the user can see in the transcript rather than a side
effect of enumeration.

### Coordinates and freshness

Coordinate input exists only as `act` with a `basis`: a token minted by a
`screenshot` of the same scope, carrying the grant revision and the measured
window geometry. The host re-validates the basis immediately before synthesis
and refuses a stale one. Therefore:

- A model can never dispatch a blind click. Without a capture there is no basis,
  and without a basis there are no coordinates.
- A target that moved, resized, changed revision, or lost focus between capture
  and action fails closed instead of clicking whatever took its place.
- Coordinates are scope-relative and clamped to the measured window bounds. A
  coordinate outside them is an error, not a clamped click.

## Permission flow

The permission mode governs the grant, not each keystroke.

| Stage | `ask` | `accept-edits` | `auto` |
|---|---|---|---|
| Create a grant | confirm (desktop UI) | confirm (desktop UI) | confirm (desktop UI) |
| `inspect`, `screenshot`, `describe_scope` in an active grant | allow | allow | allow |
| `act` under `confirm-each` | confirm per batch | confirm per batch | confirm per batch |
| `act` under `autonomous-in-scope` | unavailable | allow | allow |
| Plan / Goal | hard deny | hard deny | hard deny |

`confirm-each` is the default and the only input policy available under `ask`.
`autonomous-in-scope` requires explicit opt-in at grant time. Both policies stay
inside the action budget, the idle expiry, the per-action scope re-validation,
and the kill switch. An `allow-session` grant for `Computer` does not exist: the
scope grant already is the session-scoped decision, and a tool-name grant would
outlive the target it was approved for.

## Platform support

| Platform | Inspection and input | Capture | Notes |
|---|---|---|---|
| macOS | `AXUIElement` behind the Accessibility TCC grant | ScreenCaptureKit behind the Screen Recording TCC grant | Secure input state refuses both |
| Windows | UI Automation plus `SendInput` | Desktop Duplication / window capture | A window owned by a higher-integrity process is refused, never silently dropped |
| Linux / X11 | AT-SPI plus XTEST, best effort | X11 capture | Requires an accessibility bus; absent toolkit support is reported, not guessed |
| Linux / Wayland | Input refused | Portal screen cast | No portable synthetic input exists; capture stays available |

Any platform or stage that is not implemented reports an explicit unsupported
code. A missing capability is never a hang and never a no-op reported as
success.

## Settings and UX surface

- Computer Use is off by default. Enabling it does not create a grant, request
  an OS permission, capture a frame, or enumerate a window.
- A doctor view reports per-platform OS permission state (Screen Recording,
  Accessibility, accessibility bus, session type) and distinguishes "not
  requested", "denied", and "unsupported on this platform". A denied TCC grant
  must not be presented as a broken feature.
- The target picker is host-driven and shows the display list only while it is
  open. It is the only way to choose a target.
- The grant indicator is visible for the whole life of a grant, names the
  target, shows the remaining budget and the capture mode, and carries Stop. It
  stays visible while the app is in the background, and the Live Voice call bar
  reflects an active grant.
- The grant card states, before approval, which capture mode is being approved
  and that `a11y-and-pixels` means screenshots of the target may enter the
  session transcript.

Component-level wording for the picker, the indicator, the grant card, and the
doctor view lands with the implementing change.

## Audit and privacy

Every grant and every action is audited through the existing `audit.*` sink:
grant identity, target identity, action kind, element role and `uid`, and
outcome. Typed text is recorded as a length, never as a value. Pixels are never
written to the audit log.

Screenshots that reach the model are tool images on the existing lossless
tool-image storage path, cropped to the granted scope and downscaled; under
`a11y-and-pixels` they therefore persist in the session transcript, which is
why `a11y-only` exists and why the grant card names the choice. Captured pixels,
accessibility values, and typed text are untrusted input: text read from a
window is data, never an instruction that can change the agent's scope, tools,
grant, or permissions.

## Error codes

Codes are registered in [08-error-codes](08-error-codes.md) §3.10 under the
`COMPUTER_` prefix. The contract is that each distinct refusal is separately
attributable: feature disabled, no grant, scope violation, stale basis, stale
revision, budget exhausted, grant expired, self-target refused, secure input
refused, denylisted target, OS permission missing, elevated target, platform
unsupported, element not found or not actionable, and timeout.

## Verification and limits

- Automated coverage must include, before any of this ships: the self-target
  refusal, the secure-input refusal, stale-basis and stale-revision rejection,
  coordinate clamping, budget and expiry closure, single-grant exclusivity,
  Plan/Goal denial, and the unsupported-platform path.
- The accessibility tree, the synthesis path, and the capture path are
  platform-specific and cannot be proven by fixtures. Real-device acceptance
  per platform is a separate, explicitly authorized matrix, and a green fixture
  suite is not a device pass.
- E2E scenarios are listed in
  [04-e2e-test-plan](../06-delivery/04-e2e-test-plan.md) under the
  `E2E-COMPUTER-USE-` prefix.

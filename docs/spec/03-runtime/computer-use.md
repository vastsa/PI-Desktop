# Computer Use v1

> Status: Stage 1 implemented, device-unverified. This page is the
> authoritative contract for the capability described in
> [ADR 0342](../../adr/0342-os-computer-use-capability.md). The agent is the
> only caller; the spoken entry point is specified here and built in stage 3.
> The refusals, the loop, and the tool's own paths are unit-covered; no real
> application has been driven, and Windows and Linux report
> `COMPUTER_PLATFORM_UNSUPPORTED` until stage 2. See
> [computer-use evidence](../../implementation/computer-use-evidence.md).

## Scope

Computer Use lets the agent read and operate a native application the user has
explicitly handed to it. It is disabled by default, it is separate from the
embedded `Browser` tool, and it never operates the whole desktop at once: every
call runs against one user-picked scope.

The spoken entry point is deliberately not wired in stage 1. When it lands,
Live Voice gains no authority of its own — a spoken request becomes a work
request on the bound session
([Live Voice Work Session Integration](live-work-session.md)), the existing
Agent turn calls the tool, and the session's model, permission mode, and
approval cards apply unchanged. Voice-driven computer use will be task
delegation, not per-frame teleoperation.

| Surface | Owner | Reach |
|---|---|---|
| `Browser` tool (`pi.browser`, ADR 0170) | Bundled plugin over allowlisted CDP | The embedded `WebContentsView` guest only |
| `Computer` tool (this page) | Electron main, gated by host-core | One granted native window or application |
| Live Voice | Electron main and renderer | Audio, transcript, and work delegation; no input synthesis |

## Ownership and process model

```text
Renderer (picker, indicator, cursor overlay)
  → Preload IPC → Electron Main
       Computer tool handler, bounded loop, bound-model call,
       scope-cropped capture, overlay driver
    → Rust host-core `computer.*`
       targets, accessibility, synthesis, grant broker, re-validation, audit
```

host-core owns target enumeration, accessibility inspection, event synthesis,
the grant broker, the action budget, the per-action re-validation, and the audit
record. It is the only component that can refuse. The loop and the capture sit
in Electron main because the loop needs a model provider and the capture needs
Chromium, and host-core carries neither ([05-host-core-rust](05-host-core-rust.md) §3).

The renderer never receives a native window handle, a native element reference,
or an input primitive; it receives the picker's display list, the indicator's
grant view, and the overlay's draw commands. The agent sidecar reaches the tool
exclusively through `tools.execute` on the existing `host.proxy` allowlist — no
new proxy method is added, and `computer.*` is not a plugin host API and does
not appear in the plugin permissions matrix.

`Computer` follows the `GenerateImages` shape: host-core classifies it `high`
and performs the permission evaluation through `tools.execute`, and the handler
in main runs only after the host authorises the call.

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

The agent calls it with one natural-language `instruction` and an optional
`maxSteps`; `observeOnly` returns a description of the scope without acting. It
takes no `uid`, no coordinate, and no target: addressing is the inner loop's
job, and the target is the grant's. The result is a bounded summary naming what
changed, how many steps ran, and why the loop stopped — not a step-by-step
transcript.

Underneath, main drives these host operations. They are not agent-facing.

| Host operation | Risk | Behavior |
|---|---|---|
| `computer.capabilities` | low | Backend identity, fidelity, per-platform OS permission state, session type |
| `computer.requestPermission` | low | Ask the OS for Accessibility from the trusted Settings window; returns capabilities, never a scope grant; unsupported backends refuse |
| `computer.listTargets` | low | Pickable windows for the picker only; refused targets are listed with their reason, never silently dropped |
| `computer.grantCreate` / `grantRevoke` / `grantDescribe` | low | Mint, revoke, and read the single active grant; minting requires the user's picker choice |
| `computer.inspect` | low | Structured accessibility tree of the scope: role, name, value presence, enabled, focused, bounds, per-grant opaque `uid`, declared fidelity |
| `computer.act` | high | One validated action addressed by `uid`, or by coordinates against a `basis`, after re-measuring the scope |

`computer.act` supports `click`, `double_click`, `right_click`, `set_value`,
`press_keys`, `scroll`, and `select`. Each is dispatched through the platform
accessibility action when one exists, and falls back to a window-targeted event
only when it does not. Capture is performed in main over Chromium's
`desktopCapturer`, cropped to the geometry host-core measured, and is refused
under an `a11y-only` grant.

Element identity is accessibility-first. A `uid` is opaque, minted per grant,
and invalidated by a revision change. `inspect` returns no element values, only
whether a value is present, so reading a field's content is an explicit
`inspect` result field the user can see in the transcript rather than a side
effect of enumeration.

### Coordinates and freshness

Coordinate input exists only as `computer.act` with a `basis`: the grant
revision plus the window geometry a capture of the same scope was taken
against. The host re-measures and re-validates the basis immediately before
synthesis and refuses a stale one. Therefore:

- A model can never dispatch a blind click. Without a capture there is no basis,
  and without a basis there are no coordinates.
- A target that moved, resized, changed revision, or lost focus between capture
  and action fails closed instead of clicking whatever took its place.
- Coordinates are scope-relative and clamped to the measured window bounds. A
  coordinate outside them is an error, not a clamped click.

## The bound model and the loop

Computer Use carries its own model binding — one `{ providerId, modelId }` the
user picks in settings from the existing provider rows, following the
`imageGeneration` precedent. The conversation model is not used to drive the
machine, and there is no silent fallback to it: with no binding configured the
tool reports a configuration error. The user decides which model may operate
their computer, and what that costs.

The loop is a pure module in `packages/computer-use`, independent of Electron:

1. Observe: the accessibility tree for the scope, plus a scope-cropped capture
   when the grant allows pixels, plus the grant view.
2. Decide: one request to the bound model, which must answer with exactly one
   action against a strict schema, or `done`, or `ask`.
3. Validate: the schema, then the `uid` against the current tree, the
   coordinates against the measured geometry, the grant revision, and the
   remaining budget. Anything outside the schema is a refusal, not an attempt.
4. Act: one `computer.act`, then observe again.

The loop stops on `done`, on the step limit (the call's `maxSteps` clamped by
the grant's action budget), on revocation, on expiry, or on repeated failure of
the same step. Model prose never reaches a tool result unparsed: the summary is
assembled from what the loop actually did. Nothing in the model's answer can
widen the scope, change the target, raise the budget, or disable a refusal.

## The agent's cursor is drawn, not stolen

Actions are dispatched through accessibility actions or window-targeted events,
so the real system cursor never warps. The user keeps their mouse and keyboard
while the agent works, and a platform path that could only act by warping the
real pointer is refused rather than taken.

A separate frameless, transparent, click-through, always-on-top overlay window
draws the agent's own cursor: it travels to the element about to be acted on and
shows a press when the action is dispatched. The overlay is visualization only.
It owns no part of the action, never receives input (it is created with mouse
events ignored), and a failure to draw it neither blocks an action nor stands in
for one. It is also not the source of truth for where an action landed — the
host's re-measurement is, and the overlay follows it. The overlay closes with
the grant.

## Permission flow

The permission mode governs the grant, not each keystroke.

| Stage | `ask` | `accept-edits` | `auto` |
|---|---|---|---|
| Create a grant | confirm (desktop UI) | confirm (desktop UI) | confirm (desktop UI) |
| Inspect, capture, and describe the scope in an active grant | allow | allow | allow |
| An input action under `confirm-each` | confirm per step | confirm per step | confirm per step |
| An input action under `autonomous-in-scope` | unavailable | allow | allow |
| Plan / Goal | hard deny | hard deny | hard deny |

`confirm-each` is the default and the only input policy available under `ask`.
`autonomous-in-scope` requires explicit opt-in at grant time. Both policies stay
inside the action budget, the idle expiry, the per-action scope re-validation,
and the kill switch. An `allow-session` grant for `Computer` does not exist: the
scope grant already is the session-scoped decision, and a tool-name grant would
outlive the target it was approved for.

## Platform support

All three desktop platforms are in scope. Capture is the same everywhere —
Chromium's `desktopCapturer`, cropped in main to the geometry host-core
measured — so only inspection and input are platform work.

| Platform | Inspection and input | Stage | Notes |
|---|---|---|---|
| macOS | `AXUIElement` actions behind the Accessibility TCC grant; `CGEventPostToPid` for keys into the granted app | 1 | Hand-declared framework FFI, no new crates; secure input refuses both capture and input |
| Windows | UI Automation patterns, with window-targeted messages as the fallback | 2 | A window owned by a higher-integrity process is refused, never silently dropped |
| Linux / X11 | AT-SPI actions, best effort | 2 | Requires an accessibility bus; absent toolkit support is reported, not guessed |
| Linux / Wayland | Input refused | — | No portable synthetic input exists; capture stays available through the portal |

A platform whose backend is not built yet reports
`COMPUTER_PLATFORM_UNSUPPORTED` from every operation that would need it, and
`computer.capabilities` says so before the user tries. A backend whose fidelity
is partial declares that in its `inspect` result rather than returning an empty
tree that reads like an empty window. A missing capability is never a hang and
never a no-op reported as success.

## Settings and UX surface

- Computer Use is off by default. Enabling it does not create a grant, request
  an OS permission, capture a frame, or enumerate a window.
- The model binding is explicit. Settings offers the provider rows the user
  already configured; an enabled feature with no binding is a visible
  unconfigured state, not a silent fallback to the conversation model.
- A doctor view reports per-platform OS permission state (accessibility,
  capture, accessibility bus, session type) and distinguishes "not requested",
  "denied", and "unsupported on this platform". A denied TCC grant must not be
  presented as a broken feature.
- On macOS, missing Accessibility is a keyboard-accessible button in Settings,
  available even while Computer Use is off. Only clicking it invokes
  `pi-desktop/computer/permission/request` → `computer.requestPermission` →
  `AXIsProcessTrustedWithOptions` with the OS prompt option. If still untrusted,
  main opens the fixed Accessibility pane in System Settings; the user must
  enable the switch. This never grants trust automatically or hands over a
  target. macOS cannot distinguish an unrequested grant from a denied grant
  through its trust query, so both report `not-requested` until granted.
- Requests show busy/disabled feedback and cannot run twice concurrently.
  Failures, including failure to open System Settings, are visible with an error
  code and may be retried. Returning focus or making the page visible rechecks
  capabilities without prompting. Stale reads cannot overwrite a request result;
  unmount removes listeners and discards pending results. Granted and unsupported
  permission states remain labels, not request buttons. The request IPC rejects
  non-main-window senders, and no `host.proxy` allowlist entry is added.
- The target picker is host-driven and shows the display list only while it is
  open. It is the only way to choose a target.
- The grant indicator is visible for the whole life of a grant, names the
  target, shows the remaining budget and the capture mode, and carries Stop. It
  stays visible while the app is in the background.
- The grant card states, before approval, which capture mode is being approved
  and that `a11y-and-pixels` means screenshots of the target may enter the
  session transcript.
- The cursor overlay appears with the first action of a grant and closes with
  the grant.

Component-level wording for the picker, the indicator, the grant card, the
overlay, and the doctor view lands with the implementing change.

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
attributable: feature disabled, no binding, no grant, scope violation, stale
basis, stale revision, budget exhausted, grant expired, self-target refused,
secure input refused, denylisted target, OS permission missing, elevated
target, platform unsupported, element not found or not actionable, a model
answer outside the action schema, and timeout.

## Verification and limits

- Automated coverage must include, before any of this ships: the self-target
  refusal, the secure-input refusal, stale-basis and stale-revision rejection,
  coordinate clamping, budget and expiry closure, single-grant exclusivity,
  Plan/Goal denial, the unsupported-platform path, the missing-binding path,
  and a model answer outside the action schema.
- The loop is covered without a provider: the model call is injected, so the
  schema, the validation, the step limits, and the stop conditions are unit
  tested against scripted answers including malformed and adversarial ones.
- The accessibility tree, the synthesis path, and the capture path are
  platform-specific and cannot be proven by fixtures. Real-device acceptance
  per platform is a separate, explicitly authorized matrix, and a green fixture
  suite is not a device pass.
- E2E scenarios are listed in
  [04-e2e-test-plan](../06-delivery/04-e2e-test-plan.md) under the
  `E2E-COMPUTER-USE-` prefix.

# Computer Use v1

> Status: Stage 1 implemented, device-unverified. This page is the
> authoritative contract for the capability described in
> [ADR 0342](../../adr/0342-os-computer-use-capability.md) and amended by
> [ADR 0344](../../adr/0344-computer-use-whole-desktop-grant.md). The agent is
> the only caller; the spoken entry point is specified here and built in
> stage 3. The refusals, the loop, and the tool's own paths are unit-covered;
> no real application has been driven, and Windows and Linux report
> `COMPUTER_PLATFORM_UNSUPPORTED` until stage 2. See
> [computer-use evidence](../../implementation/computer-use-evidence.md).

## Scope

Computer Use lets the agent read and operate the native applications on the
user's machine. It is disabled by default and it is separate from the embedded
`Browser` tool. Enabling it in Settings is the authorisation: from then on the
agent may start a desktop-wide grant itself, work in one window at a time, and
move between windows the host does not refuse (ADR 0344). The user is not asked
which window, and the capability's bounds are the refusals, the action budget,
the idle expiry, and Stop.

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
| `Computer` tool (this page) | Electron main, gated by host-core | Every native window the host does not refuse, one bound at a time |
| Live Voice | Electron main and renderer | Audio, transcript, and work delegation; no input synthesis |

## Ownership and process model

```text
Renderer (indicator with Stop, cursor overlay)
  → Preload IPC → Electron Main
       Computer tool handler, automatic grant request, bounded loop,
       bound-model call, scope-cropped capture, overlay driver
    → Rust host-core `computer.*`
       targets, accessibility, synthesis, grant broker, window binding,
       re-validation, Stop cooldown, audit
```

host-core owns target enumeration, accessibility inspection, event synthesis,
the grant broker, which window a grant is bound to, the action budget, the
per-action re-validation, and the audit record. It is the only component that
can refuse. The loop and the capture sit in Electron main because the loop needs
a model provider and the capture needs Chromium, and host-core carries neither
([05-host-core-rust](05-host-core-rust.md) §3).

The renderer never receives a native window handle, a native element reference,
or an input primitive; it receives the indicator's grant view and the overlay's
draw commands, and it cannot mint a grant or enumerate windows at all. The agent
sidecar reaches the tool exclusively through `tools.execute` on the existing
`host.proxy` allowlist — no new proxy method is added, and `computer.*` is not a
plugin host API and does not appear in the plugin permissions matrix.

`Computer` follows the `GenerateImages` shape: host-core classifies it `high`
and performs the permission evaluation through `tools.execute`, and the handler
in main runs only after the host authorises the call.

## Grant and scope

A **scope grant** is the unit of authority. Since ADR 0344 the `Computer` tool
handler mints it automatically, with no target, on the first call of a session
that has no live grant.

| Field | Meaning |
|---|---|
| `grantId` | Identity of this grant; appears in every tool result and audit row |
| `scope` | `desktop` (automatic, rebindable) or `window` (pinned to one window) |
| `target` | The one window bound right now — never the whole scope |
| `revision` | Incremented whenever the bound window's geometry or identity changes, including every rebind |
| `inputPolicy` | `autonomous-in-scope` (default) or `confirm-each` (specified, not built) |
| `capture` | `a11y-only` (default) or `a11y-and-pixels` |
| `actionBudget` | Remaining input actions before the grant closes |
| `idleExpiry` | Wall-clock bound; a grant with no action closes itself |

Rules:

- A `desktop` grant starts bound to the frontmost window the host does not
  refuse, and may be rebound to any other window the host does not refuse. A
  `window` grant is pinned: a rebind request is a scope violation. Nothing in
  the UI mints a `window` grant today.
- Binding runs the full refusal set — self-target, denylist, elevation — against
  a fresh enumeration, and always moves the revision, so every `uid` and
  coordinate `basis` from the previous window stops validating. `computer.act`
  never binds; it acts on the window the last inspection described or refuses.
- If the bound window disappears, a `desktop` grant falls back to the frontmost
  usable window and an action already in flight is refused with
  `COMPUTER_STALE_REVISION`, even when the caller pinned no revision. A `window`
  grant is revoked instead: nothing it described still exists.
- The model may ask to switch to a window the host listed, and may not invent
  one. It cannot widen the scope, raise a budget, or disable a refusal, and a
  refused window reported to it is a step, not a retry loop.
- There is at most one active grant per desktop instance, mirroring the single
  Live Voice call slot. A grant belongs to the session and turn chain that owns
  it; a subagent inherits the active grant and cannot create a second one.
- Enabling the feature is the user's decision and has no automatic deadline
  (ADR 0310). Every permission mode behaves the same way. When the spoken path
  lands (stage 3) it adds no authority of its own: a spoken request becomes a
  work request on a session, and that session's turn gets the same automatic
  grant and the same refusals as a typed one.
- The user can always revoke: the indicator's Stop, closing the target, or
  disabling the feature. Stop revokes the grant **and** aborts the turn that
  holds it, and host-core refuses an agent-minted grant with
  `COMPUTER_STOPPED_BY_USER` for 30 seconds afterwards — otherwise the next
  tool call in the same turn would simply mint another grant. A user-minted
  grant clears the cooldown immediately.
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

These refusals define the desktop scope rather than punching holes in it: "the
whole desktop" means every window the host does not refuse, re-checked on every
bind, so a refused window never becomes reachable by waiting or by switching.

## Tool contract

`Computer` is a builtin high-risk tool, not a plugin tool, so its blast radius
cannot be expressed as a permission a plugin author may request. Plan and Goal
hard-deny it before permission evaluation, exactly like `Write` and `Edit`: it
mutates state outside the workspace that the host cannot snapshot, diff, or roll
back.

The agent calls it with one natural-language `instruction` and an optional
`maxSteps`; `observeOnly` returns a description of the scope without acting. It
takes no `uid`, no coordinate, and no window: addressing is the inner loop's
job, and which window is bound is the host's. The result is a bounded summary naming what
changed, how many steps ran, and why the loop stopped — not a step-by-step
transcript.

Underneath, main drives these host operations. They are not agent-facing.

| Host operation | Risk | Behavior |
|---|---|---|
| `computer.capabilities` | low | Backend identity, fidelity, per-platform OS permission state, session type |
| `computer.requestPermission` | low | Ask the OS for Accessibility from the trusted Settings window; returns capabilities, never a scope grant; unsupported backends refuse |
| `computer.listTargets` | low | Every enumerable window, with refused ones carrying their reason, never silently dropped; main shows it to the loop, never to the renderer |
| `computer.grantCreate` / `grantRevoke` / `grantDescribe` | low | Mint, revoke, and read the single active grant; `origin: agent` is subject to the Stop cooldown, and an absent `targetId` mints the desktop scope |
| `computer.inspect` | low | Structured accessibility tree of the bound window: role, name, value presence, enabled, focused, bounds, per-grant opaque `uid`, declared fidelity; an optional `targetId` binds another window first |
| `computer.act` | high | One validated action addressed by `uid`, or by coordinates against a `basis`, after re-measuring the bound window |

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

1. Observe: the accessibility tree for the bound window, the host's window list
   with its refusals, a scope-cropped capture when the grant allows pixels, and
   the grant view.
2. Decide: one request to the bound model, which must answer with exactly one
   action against a strict schema, or `switch`, or `done`, or `ask`.
3. Validate: the schema, then the `uid` against the current tree, the
   coordinates against the measured geometry, the grant revision, and the
   remaining budget. Anything outside the schema is a refusal, not an attempt.
4. Act: one `computer.act`, then observe again. A `switch` instead re-observes
   through the host with a `targetId`: it spends a loop step, never an action
   budget, and a refusal from the host is recorded as that step rather than
   ending the run.

The loop stops on `done`, on the step limit (the call's `maxSteps` clamped by
the grant's action budget), on revocation, on expiry, or on repeated failure of
the same step. Model prose never reaches a tool result unparsed: the summary is
assembled from what the loop actually did, and a switch is never counted as
work done on the machine. Nothing in the model's answer can widen the scope,
reach a refused window, raise the budget, or disable a refusal.

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

The Settings switch governs the capability; the permission mode does not narrow
it (ADR 0344).

| Stage | `ask` | `accept-edits` | `auto` |
|---|---|---|---|
| Create a grant | automatic, on the agent's first call | automatic | automatic |
| Inspect, capture, switch window, and describe the scope | allow | allow | allow |
| An input action under `autonomous-in-scope` (default) | allow | allow | allow |
| An input action under `confirm-each` | not implemented | not implemented | not implemented |
| A new grant within 30s of Stop | `COMPUTER_STOPPED_BY_USER` | same | same |
| Plan / Goal | hard deny | hard deny | hard deny |

`autonomous-in-scope` is the default under every mode. `confirm-each` stays in
the settings contract but has no approval card behind it, so Settings does not
offer it: a control that narrows nothing would misdescribe the capability. Runs
stay inside the action budget, the idle expiry, the per-action re-validation,
and Stop. An `allow-session` grant for `Computer` does not exist: the scope
grant already is the session-scoped decision.

## Platform support

All three desktop platforms are in scope. Capture is the same everywhere —
Chromium's `desktopCapturer`, cropped in main to the geometry host-core
measured — so only inspection and input are platform work.

| Platform | Inspection and input | Stage | Notes |
|---|---|---|---|
| macOS | `AXUIElement` actions behind the Accessibility TCC grant; `CGEventPostToPid` for keys into the granted app | 1 | Hand-declared framework FFI, no new crates; secure input refuses both capture and input. The accessibility window is joined to the `CGWindowList` entry by window id through `_AXUIElementGetWindow`, resolved with `dlsym` and falling back to a geometry match (D683) — the window server and accessibility disagree about a window's frame whenever Stage Manager shows a thumbnail, so geometry alone refuses every off-stage window. A grant's geometry is accessibility's frame, because element bounds, the coordinate clamp, the drawn cursor, and the capture crop are all in it |
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

- Computer Use is off by default. Enabling it does not itself request an OS
  permission, capture a frame, or enumerate a window — but it does authorise the
  agent to start a desktop-wide grant on its next `Computer` call.
- The card is last in Settings → Behavior, after Session defaults and
  Execution. It shows
  controls and actionable status without card/row descriptions or a static
  scope note. Permission diagnostics and the missing-model hint remain visible.
  The scope is not selectable: one window at a time, the agent may switch,
  PI-Desktop's own windows and credential surfaces are never reachable, and
  Stop ends the run. There is no input-approval row while `confirm-each` has
  no card behind it.
- The model binding is explicit. Settings offers the provider rows the user
  already configured; an enabled feature with no binding is a visible
  unconfigured state, not a silent fallback to the conversation model.
- A doctor view reports per-platform OS permission state (accessibility,
  capture, accessibility bus, session type) and distinguishes "not requested",
  "denied", and "unsupported on this platform". A denied TCC grant must not be
  presented as a broken feature.
- On macOS, missing Accessibility is a keyboard-accessible button in Settings,
  available even while Computer Use is off. Only clicking it invokes
  `pi-desktop/computer/permission/request`. Main checks and prompts the app's
  own TCC identity using `systemPreferences.isTrustedAccessibilityClient`.
  The host's `computer.requestPermission` remains a backend-only API; desktop
  settings does not prompt through the differently-attributed Rust process.
  If still untrusted,
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
- Desktop capabilities add optional `applicationAccessibility`, queried afresh in
  main. `accessibility` retains its existing meaning: the backend's OS trust.
  Settings uses the app state when present, falling back to the backend field for
  older hosts. If the app is granted but the backend is not, show the granted
  badge with an explicit backend-permission diagnostic. The main-process reading
  is display-only: it is never sent to host-core as authority and cannot bypass
  its inspection, grant, or input checks. Adhoc builds can have distinct app and
  executable-path identities in TCC; a checked app entry is not evidence that
  the backend can act.
- After a request remains ungranted, poll capabilities once per second for up
  to 60 ticks while the page is visible. Never prompt from a poll. Stop the
  timer on app authorization or unmount. Focus/visibility rechecks remain active
  after polling expires, and pending requests are never duplicated.
- There is no target picker and no grant card. The renderer cannot enumerate
  windows or mint a grant, so neither surface exists to be bypassed.
- The grant indicator is visible for the whole life of a grant, names the window
  bound right now and follows every rebind, shows the remaining budget and the
  capture mode, and carries Stop. It stays visible while the app is in the
  background, and it is absent whenever no grant is live.
- Stop revokes the grant and aborts the turn that holds it when that turn
  belongs to the session on screen. It never aborts another session's work.
- The cursor overlay appears with the first observation of a grant, re-frames
  the window on a switch, and closes with the grant.

Component-level wording for the indicator, the overlay, and the doctor view
lands with the implementing change.

## Audit and privacy

Every grant, rebind, and action is audited through the existing `audit.*` sink:
grant identity, scope, who minted it (`agent` or `user`), target identity,
action kind, element role and `uid`, and outcome. A rebind appends
`computer.grant.rebound` with the application it moved to, so the trail shows
which applications a desktop grant actually touched. Typed text is recorded as a
length, never as a value. Pixels are never written to the audit log.

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
- The desktop scope adds: the frontmost-usable bind, a desktop with no usable
  window, a rebind re-applying every refusal, a window grant refusing a rebind,
  the closed-window fallback refusing the in-flight action, and the Stop
  cooldown refusing an agent-minted grant while allowing a user-minted one.
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

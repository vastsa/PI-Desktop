# ADR 0340: Built-in computer use is a host-owned capability behind a user-picked scope grant

- Status: Proposed
- Date: 2026-11-04
- Deciders: PI-Desktop core
- Related: [ADR 0170](0170-work-panel-browser-as-bundled-plugin.md) ·
  [ADR 0211](0211-plan-safe-plugin-actions.md) ·
  [ADR 0310](0310-local-permission-approvals-without-deadline.md) ·
  [ADR 0313](0313-live-voice-default-session-target.md) ·
  [ADR 0315](0315-live-voice-spoken-asktool-answers.md) ·
  [03-runtime/computer-use](../spec/03-runtime/computer-use.md) ·
  [03-runtime/03-tools-and-permissions](../spec/03-runtime/03-tools-and-permissions.md) ·
  [05-security/01-security](../spec/05-security/01-security.md)

## Context

The agent can drive web content: `pi.browser` owns a `WebContentsView` guest and
the bundled `Browser` tool reaches it over an allowlisted subset of CDP, using
the accessibility tree for element identity and `click(uid)` / `fill(uid)` for
input. Everything outside that guest is unreachable. The agent cannot read a
native window, cannot drive a desktop application, and cannot finish a task that
leaves the browser.

Live Voice is already a full real-time voice path with a work binding: a spoken
request reaches a session through `delegate_to_work_session`, a read-only
classifier routes it, and the existing Agent Runtime executes it under the
target session's model and permission policy. What a user can ask for by voice
is therefore exactly the set of tools the agent has — which stops at the
workspace and the embedded browser.

"Computer Use browser takeover" is item 9 of the MVP non-goals. That list froze
what the *MVP* would not ship; the product is now released software at `0.21.0`
with a plugin permission matrix, a durable permission broker, an audit log, and
a floating call surface. The request is no longer "let the model take over the
browser" but "give the agent a bounded, revocable, auditable way to operate the
machine, and let the user ask for it out loud".

Nothing in the repository supports it today. There is no screen capture, no
synthetic input, no window enumeration, and no accessibility client on any
platform; `enigo`, `robotjs`, and `nut-js` are absent by design. So this is not
an extension of an existing boundary — it is a new one, and the dangerous part
is not the capture. It is that synthetic input is indistinguishable from the
user: it can approve dialogs, including this application's own permission cards.

## Decision

1. **Computer use is a host-core capability, not a plugin, a renderer feature,
   or a Live Voice feature.** `crates/host-core` gains a `computer.*` RPC domain
   and owns window enumeration, accessibility inspection, event synthesis,
   screen capture, the grant broker, and the audit record. Electron main keeps
   exactly two jobs: it renders the host-driven target picker and the grant
   indicator, and it forwards `tools.execute`. The renderer never receives a
   window handle, a native element reference, or an input primitive, and the
   agent sidecar reaches the capability only through the existing `host.proxy`
   `tools.execute` allowlist entry — no new proxy method is introduced.

2. **One high-risk builtin tool, `Computer`.** It is a builtin like `Bash`, not
   a bundled-plugin tool, because its blast radius must not be expressible as a
   plugin permission a plugin author can request. `computer.*` is not a public
   plugin host API and is not added to the plugin permissions matrix. The tool
   exposes `inspect`, `screenshot`, `act`, `wait`, and `describe_scope`; it
   exposes no "list windows", no "focus application", and no "switch target".

3. **Accessibility first, pixels as an explicit fallback.** `inspect` returns a
   structured tree for the granted scope — role, name, value presence, enabled,
   focused, bounds, and a per-grant opaque `uid` — and `act` addresses elements
   by `uid`, dispatched through the platform accessibility action where one
   exists (`AXUIElement` actions, UIA patterns, AT-SPI actions). Coordinate
   input exists only as `act` with a `basis`: a token minted by a `screenshot`
   of the same scope, carrying the scope revision and the measured window
   geometry. The host re-validates the basis immediately before synthesis and
   refuses a stale one. A model can therefore never dispatch a blind click, and
   a window that moved between capture and action fails closed instead of
   clicking whatever took its place.

4. **A scope grant is the unit of authority, and only the user can mint one.**
   A grant names exactly one target — one window, or one application's windows —
   chosen by the user in a host-driven picker. It carries a revision, an action
   budget, an idle expiry, and an input policy. The model cannot name, request
   by title, enumerate, or widen a target; a tool call outside the granted scope
   is an error, not a prompt to expand. There is at most one active grant per
   desktop instance, mirroring the single Live Voice call slot, and a grant is
   bound to the session and the turn chain that owns it, so a subagent inherits
   the active grant but cannot create a second one.

5. **Two refusals are absolute and not reachable by any permission mode,
   setting, grant, or `auto` policy.** First, the capability never targets
   PI-Desktop's own windows — its approval cards, its settings, its secrets
   surfaces, its Live Voice widget — because synthetic input into this
   application is a direct permission-broker bypass. Second, capture and
   synthesis both refuse while the OS reports a secure input state or the
   focused element is a password field. A user-editable application denylist
   sits on top of these two, and the built-in credential-surface entries in it
   cannot be removed.

6. **The permission mode governs the grant, not each keystroke.** Creating a
   grant is always an explicit desktop-UI decision with no deadline, like every
   other local approval (ADR 0310); `auto` does not mint grants, and a spoken
   request cannot. Within an active grant, `inspect` and `screenshot` need no
   further approval. Input actions follow the grant's input policy:
   `confirm-each` (the default, and the only option under `ask`) raises an
   approval card per input batch, while `autonomous-in-scope` requires explicit
   opt-in at grant time and is offered only under `accept-edits` and `auto`.
   Both policies stay inside the action budget, the idle expiry, the scope
   re-validation, and a kill switch the user can always reach: the indicator's
   Stop, a global shortcut, and revoking the grant.

7. **Plan and Goal hard-deny `Computer` before permission evaluation**, exactly
   like `Write` and `Edit`. It is not plan-safe: it mutates state outside the
   workspace that the host cannot snapshot, diff, or roll back.

8. **Voice reaches computer use only through the path that already exists.**
   Live Voice stays a voice interface with no new authority: a spoken request
   becomes `delegate_to_work_session`, the classifier routes it, and the Agent
   turn calls `Computer` under the target session's policy. Grant creation and
   every approval card remain desktop-UI decisions, consistent with ADR 0315; a
   call may *request* a grant, which surfaces in the main window while the
   floating call bar reports that the app needs attention. Progress and results
   are spoken through the existing work-feedback channel. Voice-driven computer
   use is therefore task-level delegation, not per-frame teleoperation, and the
   spec says so rather than implying a latency it cannot deliver.

9. **Supported platforms are declared, and the unsupported ones fail closed.**
   macOS uses ScreenCaptureKit and `AXUIElement` behind the Screen Recording
   and Accessibility TCC grants. Windows uses UI Automation and `SendInput`, and
   refuses a window owned by a higher-integrity process instead of silently
   dropping events. Linux/X11 is best-effort over AT-SPI and XTEST. Wayland has
   no portable synthetic input, so input is refused there with an explicit code
   while capture stays available through the portal. Every one of these is a
   distinct error code, never a hang and never a no-op reported as success.

10. **Every grant and every action is audited; content is not.** The existing
    `audit.*` sink records the grant identity, target identity, action kind,
    element role and `uid`, and outcome. Typed text is recorded as a length, not
    a value, and pixels are never written to the audit log. Screenshots that
    reach the model are tool images and follow the existing lossless tool-image
    storage path, cropped to the granted scope and downscaled; an `a11y-only`
    grant captures no pixels at all, and the grant card states which of the two
    the user is approving before they approve it.

11. **Delivery is staged, and each stage is independently shippable.** Stage 1:
    host capability, grant broker, indicator, audit, `inspect`/`act` on macOS.
    Stage 2: `screenshot` and basis-bound coordinate input. Stage 3: Windows
    UIA, then Linux/X11. Stage 4: the voice-facing refinements — spoken grant
    requests, spoken progress, and the call-bar attention state. Non-goal item 9
    is amended, not deleted: unattended full-desktop takeover and any
    model-chosen target remain non-goals.

## Consequences

- A new, genuinely dangerous privilege enters the product. It is mitigated by
  structure rather than by prompting: a single user-picked target, a revision
  checked per action, two absolute refusals, a budget, an expiry, one grant per
  instance, and an audit trail. The two refusals in decision 5 are the ones that
  must be covered by tests before any of this ships.
- host-core gains its first platform-specific native surface beyond process
  spawning, and with it three per-OS implementations and new native
  dependencies, against a supply-chain rule that prefers few reviewed deps. The
  capability must compile to a clean "unsupported on this platform" on any
  target that is not implemented yet.
- The product acquires OS permission prompts it never had. A doctor view has to
  report Screen Recording and Accessibility state per platform, because a denied
  TCC grant is indistinguishable from a broken feature from the user's side.
- Screenshots of the user's desktop can now enter a session transcript and
  therefore SQLite. That is a real privacy change; `a11y-only` grants exist so a
  user can take the capability without it.
- Live Voice gains no code-level authority, but it does gain a reachable
  consequence: a sentence spoken into a call can move a mouse. The call surface
  must make the active grant visible from the floating bar.
- Four UX surfaces are added: the target picker, the grant indicator with Stop,
  the grant card with its policy and capture choice, and the settings doctor.
  Their component-level wording lands with the implementing change, not here.

## Alternatives

- **Extend the `Browser` tool to the whole desktop.** It is a bundled plugin on
  a public permission; any plugin declaring `browser.cdp` would inherit desktop
  input. Rejected.
- **Expose computer use as a plugin host API.** It makes the most dangerous
  privilege in the product requestable by a third-party manifest, and plugin
  grants are reviewed once at install rather than per target. Rejected.
- **Pixels only, with a computer-use provider model choosing coordinates.** It
  works anywhere, including canvas and custom-drawn UI, but every step ships the
  user's screen to a provider, costs a vision call per action, and breaks on any
  reflow. Kept as the explicit fallback in decision 3 instead of the default.
- **Accessibility only, with no capture at all.** Safest, and it is exactly what
  an `a11y-only` grant is. As the only mode it cannot operate canvas apps,
  remote desktops, or custom toolkits, so the capability would under-deliver on
  the request. Rejected as the sole mode.
- **A real-time voice teleoperation loop driving input directly from Live
  Voice.** Lowest latency, and it bypasses the classifier, the session policy,
  the approval cards, and the transcript — the entire reason the work path is
  safe. Rejected.
- **Let the model pick the target window.** Removes the picker friction, and
  with it the only guarantee that the agent operates on what the user meant.
  Rejected.

# ADR 0342: Built-in computer use is a host-owned capability behind a user-picked scope grant

- Status: Accepted; §4 and §8 amended by
  [ADR 0344](0344-computer-use-whole-desktop-grant.md)
- Date: 2026-11-04
- Decision: D681
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
machine" — on all three desktop platforms, driven by a model the user picks,
and without ever taking the mouse out of the user's hand. The spoken entry
point is specified here and built later; the agent is the first caller.

Nothing in the repository supports it today. There is no screen capture, no
synthetic input, no window enumeration, and no accessibility client on any
platform; `enigo`, `robotjs`, and `nut-js` are absent by design. So this is not
an extension of an existing boundary — it is a new one, and the dangerous part
is not the capture. It is that synthetic input is indistinguishable from the
user: it can approve dialogs, including this application's own permission cards.

## Decision

1. **Native authority is host-core's; the decision loop is not.** `crates/host-core`
   gains a `computer.*` RPC domain and owns target enumeration, accessibility
   inspection, event synthesis, the grant broker, the per-action re-validation,
   and the audit record — it is the only component that can refuse. The
   perceive-decide-act loop and screen capture live above it, because the loop
   needs a model provider and capture needs Chromium, and host-core carries
   neither (`05-host-core-rust` §3). The renderer never receives a window
   handle, a native element reference, or an input primitive, and the agent
   sidecar reaches the capability only through the existing `host.proxy`
   `tools.execute` allowlist entry — no new proxy method is introduced.

2. **One high-risk tool, `Computer`, gated by the host and executed above it.**
   It follows the `GenerateImages` shape: host-core classifies it `high`,
   `tools.execute` performs the permission evaluation, and the handler runs in
   Electron main once the host authorises. It is not a plugin tool, so its
   blast radius cannot be expressed as a permission a plugin author may
   request; `computer.*` is not a public plugin host API and is not added to
   the plugin permissions matrix. The tool takes a natural-language instruction
   plus optional explicit steps; it exposes no "list windows", no "focus
   application", and no "switch target".

3. **Accessibility first, pixels as an explicit fallback.** `computer.inspect`
   returns a structured tree for the granted scope — role, name, value
   presence, enabled, focused, bounds, and a per-grant opaque `uid` — and every
   action addresses an element by `uid`, dispatched through the platform
   accessibility action where one exists (`AXUIElement` actions, UIA patterns,
   AT-SPI actions). Capture is scope-cropped and produces a `basis`: the grant
   revision plus the measured window geometry it was taken against. Coordinate
   input exists only with a `basis`, which the host re-validates by re-measuring
   immediately before synthesis and refuses when it no longer matches. A model
   can therefore never dispatch a blind click, and a window that moved between
   capture and action fails closed instead of clicking whatever took its place.

4. **A scope grant is the unit of authority, and only the user can mint one.**
   *(Amended by [ADR 0344](0344-computer-use-whole-desktop-grant.md): the grant
   is minted automatically and covers the desktop, one window bound at a time;
   the picker is gone and the model may switch between windows the host does
   not refuse. The revision, budget, expiry, single-grant rule, and session
   ownership below are unchanged.)*
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

6. **The permission mode governs the grant, not each keystroke.**
   *(Amended by [ADR 0344](0344-computer-use-whole-desktop-grant.md):
   `autonomous-in-scope` is the default under every mode, `confirm-each` is
   specified but unbuilt, and Stop both revokes the grant and aborts the turn,
   with a cooldown on the agent's next automatic mint.)* Creating a
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

8. **The agent is the only caller in the first release; voice comes later.**
   The spoken path is specified and deliberately not built: Live Voice would
   reach `Computer` as an ordinary work request through the existing
   delegate/classifier/Agent-turn path and would gain no authority of its own,
   but nothing in the first release wires it, and the voice feature ships
   unchanged. Grant creation and every approval card remain desktop-UI
   decisions, consistent with ADR 0315, which is also why a call could never
   mint a grant on its own.

9. **The agent's own model does not have to drive the machine.** Computer use
   carries its own model binding — one `{ providerId, modelId }` the user picks
   in settings from the existing provider rows, following the
   `imageGeneration` precedent — and a bounded perceive-decide-act loop uses
   that model to turn one instruction into validated steps. The loop is a pure
   module in `packages/computer-use`: it receives an observation (the
   accessibility tree, and a capture when the grant allows pixels), asks the
   bound model for one action against a strict schema, and refuses anything
   that is not in that schema. The main agent sees a bounded summary, not a
   step-by-step transcript of the inner loop. With no binding configured the
   tool reports a configuration error instead of silently falling back to the
   conversation model, because the user chose which model may operate their
   computer.

10. **The agent's pointer is drawn, not stolen.** Every action is dispatched
    through an accessibility action or a window-targeted event, so the real
    system cursor never warps and the user keeps their mouse and keyboard
    while the agent works. A separate frameless, transparent, click-through
    always-on-top overlay window draws a virtual cursor that travels to the
    element the agent is about to act on and shows a press when it acts. The
    overlay is visualization only: it owns no part of the action, cannot
    receive input, and a failure to draw it never blocks or silently replaces
    an action. A platform path that could only act by warping the real pointer
    is refused rather than taken.

11. **Supported platforms are declared, and the unsupported ones fail closed.**
    macOS uses `AXUIElement` behind the Accessibility TCC grant, with
    `CGEventPostToPid` for key input into the granted application only. Windows
    uses UI Automation with window-targeted messages, and refuses a window
    owned by a higher-integrity process instead of silently dropping events.
    Linux/X11 is best-effort over AT-SPI. Wayland has no portable synthetic
    input, so input is refused there with an explicit code while capture stays
    available through the portal. Capture itself is Chromium's
    `desktopCapturer`, scope-cropped in main, which is the one part of the
    capability that is already cross-platform. Every unsupported path is a
    distinct error code, never a hang and never a no-op reported as success.
    A backend whose fidelity is partial says so in its own `inspect` result
    rather than returning an empty tree that reads like an empty window.

12. **Every grant and every action is audited; content is not.** The existing
    `audit.*` sink records the grant identity, target identity, action kind,
    element role and `uid`, and outcome. Typed text is recorded as a length, not
    a value, and pixels are never written to the audit log. Screenshots that
    reach the model are tool images and follow the existing lossless tool-image
    storage path, cropped to the granted scope and downscaled; an `a11y-only`
    grant captures no pixels at all, and the grant card states which of the two
    the user is approving before they approve it.

13. **Delivery is staged, and each stage is independently shippable.** Stage 1
    is the MVP: contracts, the grant broker and its refusals, the macOS
    backend, the bounded loop with its own model binding, the virtual-cursor
    overlay, the picker, the indicator, settings, and audit — agent-callable,
    no voice. Stage 2 adds the Windows and Linux backends behind the same
    contract and the same refusals, each with its own dependency review and
    per-platform device acceptance. Stage 3 adds the voice-facing refinements.
    Non-goal item 9 is amended, not deleted: unattended full-desktop takeover
    and any model-chosen target remain non-goals.

## Consequences

- A new, genuinely dangerous privilege enters the product. It is mitigated by
  structure rather than by prompting: a single user-picked target, a revision
  checked per action, two absolute refusals, a budget, an expiry, one grant per
  instance, and an audit trail. The two refusals in decision 5 are the ones that
  must be covered by tests before any of this ships.
- host-core gains its first platform-specific native surface beyond process
  spawning, and with it three per-OS implementations. The macOS backend is
  written as hand-declared framework FFI rather than new crates, so the
  supply-chain rule that prefers few reviewed dependencies survives the first
  stage; each later backend carries its own dependency review. The capability
  must compile to a clean "unsupported on this platform" on any target that is
  not implemented yet, and a backend with partial fidelity must say so.
- The inner loop spends tokens on a model the conversation did not choose, so
  the bound model, its step count, and its cost are the user's decision and
  have to be visible: the binding is explicit in settings, the loop is bounded
  by the grant's action budget, and the tool result names how many steps ran.
- A drawn cursor is not the system cursor, so it can disagree with reality — a
  window that moves mid-step leaves the overlay briefly wrong. The overlay is
  therefore never the source of truth for where an action landed; the host's
  re-measurement is, and the overlay follows it.
- The product acquires OS permission prompts it never had. A doctor view has to
  report Screen Recording and Accessibility state per platform, because a denied
  TCC grant is indistinguishable from a broken feature from the user's side.
  The desktop app and its child can have different TCC attribution, especially
  in adhoc builds. Settings queries and requests the app's trust in Electron
  main; the optional `applicationAccessibility` field is display-only. Native
  trust remains host-core's `accessibility` reading and all input refusals stay
  there. A disagreement must be shown explicitly, not resolved by copying an
  app-level grant into native authority. This retains the ownership decision
  above and adds no input path or sidecar proxy permission.
- Screenshots of the user's desktop can now enter a session transcript and
  therefore SQLite. That is a real privacy change; `a11y-only` grants exist so a
  user can take the capability without it.
- Live Voice is untouched in this stage. When stage 3 wires it, a sentence
  spoken into a call becomes able to move a drawn cursor, and the call surface
  will have to make the active grant visible from the floating bar.
- Five UX surfaces are added: the target picker, the grant indicator with Stop,
  the grant card with its policy and capture choice, the settings page with the
  model binding and the permission doctor, and the cursor overlay.

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
- **Drive the real system pointer with `SendInput`/XTEST/`CGWarpMouseCursorPosition`.**
  It is the shortest path to "it clicks things" and works against any toolkit,
  but it fights the user for their own mouse, cannot run while they work, and
  makes a runaway loop physically hard to stop. Rejected in favour of
  accessibility actions plus a drawn cursor (decision 10).
- **Reuse the conversation model for the loop.** One less setting, and no
  second provider call, but it forces a vision-capable chat model on everyone
  and spends the conversation's context on screenshots. Rejected in favour of
  an explicit binding (decision 9).
- **Run the loop inside host-core.** It would keep one owner for the whole
  capability, but host-core deliberately holds no provider SDK and no Chromium,
  so it can neither call the bound model nor capture a window. Rejected.
- **Put the loop in the renderer, next to the overlay it drives.** The renderer
  is the one process that must never hold this authority. Rejected.

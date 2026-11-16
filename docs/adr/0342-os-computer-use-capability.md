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

The agent drives web content only: `pi.browser` owns a `WebContentsView` guest and
the bundled `Browser` tool reaches it over an allowlisted CDP subset. Everything
outside that guest is unreachable, and because Live Voice reaches the Agent Runtime
through `delegate_to_work_session`, what a user can ask for is exactly the agent's
tool set — which stops at the workspace and the embedded browser.

"Computer Use browser takeover" was item 9 of the MVP non-goals, which froze only
what the MVP would not ship. The request now is a bounded, revocable, auditable way
to operate the machine, driven by a model the user picks, without taking the mouse
out of the user's hand. Nothing supports it today — there is no capture, synthetic
input, window enumeration, or accessibility client, and `enigo`, `robotjs`, and
`nut-js` are absent by design. The dangerous part is not capture: synthetic input
is indistinguishable from the user and can approve dialogs, including this
application's own permission cards.

## Decision

1. **Native authority is host-core's; the decision loop is not.** `crates/host-core`
   gains a `computer.*` RPC domain owning target enumeration, accessibility
   inspection, event synthesis, the grant broker, per-action re-validation, and the
   audit record — the only component that can refuse. The perceive-decide-act loop
   and capture live above it, needing a model provider and Chromium
   (`05-host-core-rust` §3). The renderer never receives a window handle, native
   element, or input primitive, and the sidecar reaches it only through the existing
   `host.proxy` `tools.execute` entry.
2. **One high-risk tool, `Computer`, gated by the host and executed above it.** Host
   classification marks it `high`, `tools.execute` evaluates the permission, and the
   handler runs in Electron main after authorisation. It is not a plugin tool, so no
   manifest can request that blast radius, and `computer.*` is not a public plugin
   API. It takes an instruction plus optional steps and exposes no list, focus, or
   switch-target operation.
3. **Accessibility first, pixels as an explicit fallback.** `computer.inspect`
   returns a structured tree for the granted scope — role, name, value presence,
   enabled, focused, bounds, and a per-grant opaque `uid` — and actions address a
   `uid` through the platform accessibility action (`AXUIElement`, UIA patterns,
   AT-SPI). Capture is scope-cropped and produces a `basis` of grant revision plus
   measured window geometry, re-validated immediately before coordinate synthesis and
   refused on mismatch, so a blind click is impossible and a moved window fails
   closed.
4. **A scope grant is the unit of authority, and only the user can mint one.**
   *(Amended by [ADR 0344](0344-computer-use-whole-desktop-grant.md): the grant is
   minted automatically for the desktop, one window bound at a time, and the picker is
   gone; the revision, budget, expiry, single-grant rule, and session ownership below
   stand.)* A grant names exactly one user-chosen target and carries a revision, an
   action budget, an idle expiry, and an input policy. The model cannot name,
   request by title, enumerate, or widen a target, and a call outside scope is an
   error rather than a prompt to expand. At most one grant is active per instance,
   mirroring the single Live Voice slot, bound to the session and turn chain that
   owns it, so a subagent inherits it but cannot mint a second.
5. **Two refusals are absolute and reachable by no permission mode, setting, grant,
   or `auto` policy.** The capability never targets PI-Desktop's own windows —
   approval cards, settings, secrets surfaces, Live Voice widget — because input
   there is a direct permission-broker bypass. Capture and synthesis both refuse
   while the OS reports a secure input state or the focused element is a password
   field. A user-editable application denylist sits on top, with non-removable
   credential-surface entries.
6. **The permission mode governs the grant, not each keystroke.** *(Amended by
   [ADR 0344](0344-computer-use-whole-desktop-grant.md): `autonomous-in-scope` is the
   default under every mode, `confirm-each` is specified but unbuilt, and Stop both
   revokes the grant and aborts the turn.)* Minting is always an explicit desktop-UI
   decision with no deadline (ADR 0310); `auto` does not mint grants and neither does
   a spoken request. Inside a grant `inspect` and `screenshot` need no approval,
   while input follows the grant policy — `confirm-each` raises a card per input
   batch and `autonomous-in-scope` requires opt-in at mint time — always inside the
   budget, the expiry, scope re-validation, and a kill switch: the indicator's Stop,
   a global shortcut, and revocation.
7. **Plan and Goal hard-deny `Computer` before permission evaluation**, like `Write`
   and `Edit`: it mutates state outside the workspace that the host cannot snapshot,
   diff, or roll back.
8. **The agent is the only caller in the first release; voice comes later.** Live
   Voice would reach `Computer` as an ordinary work request and gain no authority of
   its own, but nothing wires it yet, and grant creation plus every approval card stay
   desktop-UI decisions (ADR 0315).
9. **The agent's own model need not drive the machine.** Computer use carries its own
   `{ providerId, modelId }` binding after the `imageGeneration` precedent, and a
   bounded perceive-decide-act loop turns one instruction into validated steps. The
   loop is a pure module in `packages/computer-use` that receives an observation,
   asks for one action against a strict schema, and refuses anything else; the main
   agent sees a bounded summary. With no binding the tool reports a configuration
   error instead of falling back to the conversation model.
10. **The agent's pointer is drawn, not stolen.** Actions dispatch through an
    accessibility action or a window-targeted event, so the real cursor never warps
    and the user keeps their mouse and keyboard. A frameless, transparent,
    click-through, always-on-top overlay draws a virtual cursor; it owns no part of
    the action, receives no input, and its failure never blocks one. A path that
    could only act by warping the real pointer is refused.
11. **Supported platforms are declared, and the rest fail closed.** macOS uses
    `AXUIElement` behind the Accessibility TCC grant with `CGEventPostToPid` for key
    input into the granted application; Windows uses UI Automation with
    window-targeted messages and refuses higher-integrity windows; Linux/X11 is
    best-effort over AT-SPI; Wayland refuses input with an explicit code while
    capture stays available through the portal. Capture is Chromium's
    `desktopCapturer`, scope-cropped in main. Every unsupported path is a distinct
    error code, never a hang or a silent no-op, and a partial-fidelity backend says
    so in its own `inspect` result.
12. **Every grant and action is audited; content is not.** The `audit.*` sink records
    grant identity, target identity, action kind, element role and `uid`, and the
    outcome. Typed text is recorded as a length, never a value, and pixels never
    enter the audit log; screenshots follow the existing lossless tool-image path,
    and an `a11y-only` grant captures no pixels, which the grant card states before
    approval.
13. **Delivery is staged and each stage ships independently.** Stage 1 is the MVP:
    contracts, grant broker and refusals, the macOS backend, the bounded loop with its
    binding, the overlay, the picker, the indicator, settings, and audit.
    Stage 2 adds Windows and Linux behind the same contract and refusals, Stage 3 the
    voice-facing refinements. Non-goal item 9 is amended, not deleted: unattended
    full-desktop takeover and model-chosen targets remain non-goals.

## Consequences

- A genuinely dangerous privilege enters the product, mitigated by structure rather
  than prompting: one user-picked target, a revision checked per action, two absolute
  refusals, a budget, an expiry, one grant per instance, and an audit trail. The
  refusals in decision 5 must be covered by tests before shipping.
- host-core gains its first platform-specific native surface beyond process
  spawning; the macOS backend uses hand-declared framework FFI rather than new
  crates, each later backend carries its own dependency review, and unimplemented
  targets must compile to a clean "unsupported on this platform".
- The loop spends tokens on a model the conversation did not choose, so the binding,
  step count, and cost must be visible: the binding is explicit, the loop is bounded
  by the grant budget, and the tool result names the steps run.
- A drawn cursor can disagree with reality when a window moves mid-step, so the
  overlay is never the source of truth; the host's re-measurement is.
- The product acquires OS permission prompts it never had, so a doctor view reports
  Screen Recording and Accessibility state per platform. Native trust stays
  host-core's `accessibility` reading; an application-level grant is display-only and
  a disagreement is shown rather than copied into native authority.
- Screenshots of the desktop can enter a transcript and therefore SQLite — a real
  privacy change that `a11y-only` grants avoid — and five UX surfaces are added:
  target picker, grant indicator with Stop, grant card, settings page with binding
  and doctor, and the cursor overlay.

## Alternatives

- **Extend the `Browser` tool to the whole desktop.** Any plugin declaring
  `browser.cdp` would inherit desktop input. Rejected.
- **Expose computer use as a plugin host API.** Makes the most dangerous privilege
  requestable by a manifest reviewed once at install. Rejected.
- **Pixels only, with the model choosing coordinates.** Ships the screen to a
  provider every step and breaks on reflow; kept as the fallback in decision 3.
- **Accessibility only, with no capture.** Exactly what an `a11y-only` grant is, but
  it cannot operate canvas apps or custom toolkits.
- **A real-time voice teleoperation loop driving input directly.** Bypasses the
  classifier, session policy, approval cards, and transcript. Rejected.
- **Let the model pick the target window.** Removes the only guarantee that the agent
  operates on what the user meant. Rejected.
- **Drive the real system pointer with `SendInput`/XTEST/`CGWarpMouseCursorPosition`.**
  Fights the user for their mouse and is hard to stop; rejected.
- **Reuse the conversation model, or run the loop in host-core or the renderer.**
  Forces a vision chat model on everyone, or gives the authority to a component with
  no provider SDK and no Chromium, or to the process that must never hold it.
  Rejected.

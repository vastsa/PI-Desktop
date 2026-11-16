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
input. Everything outside that guest is unreachable.

## Decision

1. **Native authority is host-core's; the decision loop is not.**
   `crates/host-core` gains a `computer.*` RPC domain and owns target
   enumeration, accessibility inspection, event synthesis, the grant broker, the
   per-action re-validation, and the audit record — it is the only component
   that can refuse.

2. **One high-risk tool, `Computer`, gated by the host and executed above it.**
   It follows the `GenerateImages` shape: host-core classifies it `high`,
   `tools.execute` performs the permission evaluation, and the handler runs in
   Electron main once the host authorises.

3. **Accessibility first, pixels as an explicit fallback.** `computer.inspect`
   returns a structured tree for the granted scope — role, name, value presence,
   enabled, focused, bounds, and a per-grant opaque `uid` — and every action
   addresses an element by `uid`, dispatched through the platform accessibility
   action where one exists (`AXUIElement` actions, UIA patterns, AT-SPI
   actions).

4. **A scope grant is the unit of authority, and only the user can mint one.**
   *(Amended by [ADR 0344](0344-computer-use-whole-desktop-grant.md): the grant
   is minted automatically and covers the desktop, one window bound at a time;
   the picker is gone and the model may switch between windows the host does not
   refuse. The revision, budget, expiry, single-grant rule, and session
   ownership below are unchanged.)* A grant names exactly one target — one
   window, or one application's windows — chosen by the user in a host-driven
   picker.

5. **Two refusals are absolute and not reachable by any permission mode,
   setting, grant, or `auto` policy.** First, the capability never targets
   PI-Desktop's own windows — its approval cards, its settings, its secrets
   surfaces, its Live Voice widget — because synthetic input into this
   application is a direct permission-broker bypass.

6. **The permission mode governs the grant, not each keystroke.** *(Amended by
   [ADR 0344](0344-computer-use-whole-desktop-grant.md): `autonomous-in-scope`
   is the default under every mode, `confirm-each` is specified but unbuilt, and
   Stop both revokes the grant and aborts the turn, with a cooldown on the
   agent's next automatic mint.)* Creating a grant is always an explicit
   desktop-UI decision with no deadline, like every other local approval (ADR
   0310); `auto` does not mint grants, and a spoken request cannot.

7. **Plan and Goal hard-deny `Computer` before permission evaluation**, exactly
   like `Write` and `Edit`.

8. **The agent is the only caller in the first release; voice comes later.** The
   spoken path is specified and deliberately not built: Live Voice would reach
   `Computer` as an ordinary work request through the existing
   delegate/classifier/Agent-turn path and would gain no authority of its own,
   but nothing in the first release wires it, and the voice feature ships
   unchanged.

9. **The agent's own model does not have to drive the machine.** Computer use
   carries its own model binding — one `{ providerId, modelId }` the user picks
   in settings from the existing provider rows, following the `imageGeneration`
   precedent — and a bounded perceive-decide-act loop uses that model to turn
   one instruction into validated steps.

10. **The agent's pointer is drawn, not stolen.** Every action is dispatched
    through an accessibility action or a window-targeted event, so the real
    system cursor never warps and the user keeps their mouse and keyboard while
    the agent works.

11. **Supported platforms are declared, and the unsupported ones fail closed.**
    macOS uses `AXUIElement` behind the Accessibility TCC grant, with
    `CGEventPostToPid` for key input into the granted application only.

12. **Every grant and every action is audited; content is not.** The existing
    `audit.*` sink records the grant identity, target identity, action kind,
    element role and `uid`, and outcome.

13. **Delivery is staged, and each stage is independently shippable.** Stage 1
    is the MVP: contracts, the grant broker and its refusals, the macOS backend,
    the bounded loop with its own model binding, the virtual-cursor overlay, the
    picker, the indicator, settings, and audit — agent-callable, no voice.

## Consequences

- A new, genuinely dangerous privilege enters the product.
- host-core gains its first platform-specific native surface beyond process
  spawning, and with it three per-OS implementations.
- The inner loop spends tokens on a model the conversation did not choose, so
  the bound model, its step count, and its cost are the user's decision and have
  to be visible: the binding is explicit in settings, the loop is bounded by the
  grant's action budget, and the tool result names how many steps ran.
- A drawn cursor is not the system cursor, so it can disagree with reality — a
  window that moves mid-step leaves the overlay briefly wrong.
- The product acquires OS permission prompts it never had.

## Alternatives

- **Extend the `Browser` tool to the whole desktop.** It is a bundled plugin on
  a public permission; any plugin declaring `browser.cdp` would inherit desktop
  input.
- **Expose computer use as a plugin host API.** It makes the most dangerous
  privilege in the product requestable by a third-party manifest, and plugin
  grants are reviewed once at install rather than per target.
- **Pixels only, with a computer-use provider model choosing coordinates.** It
  works anywhere, including canvas and custom-drawn UI, but every step ships the
  user's screen to a provider, costs a vision call per action, and breaks on any
  reflow.
- **Accessibility only, with no capture at all.** Safest, and it is exactly what
  an `a11y-only` grant is.

# Computer Use Stage 1 Evidence

What was built for [ADR 0342](../adr/0342-os-computer-use-capability.md) stage 1
and [ADR 0344](../adr/0344-computer-use-whole-desktop-grant.md), and — more
importantly — what has *not* been verified. This file contains no window titles,
no captured pixels, and no credentials.

## Shape

| Layer | Where | State |
|---|---|---|
| Contracts, settings, error codes | `packages/shared/src/computer-use.ts`, `errors.ts`, `protocol.ts` | Implemented, unit-covered |
| Refusals, grant broker, desktop scope and binding | `crates/host-core/src/computer/` | Implemented, unit-covered |
| macOS backend (`AXUIElement`, `CGWindowList`, `CGEventPostToPid`) | `crates/host-core/src/computer/macos/` (`mod.rs` behaviour, `ffi.rs` C surface) | Implemented, compiled, **no device run** |
| Windows and Linux backends | `crates/host-core/src/computer/backend.rs` | Explicit unsupported backend; stage 2 |
| `computer.*` RPC, Stop cooldown, audit | `crates/host-core/src/rpc/computer_rpc.rs` | Implemented, not covered by an RPC-level test (the cooldown rule itself is, as `policy::agent_mint_allowed`) |
| Bounded loop, action schema, window switch | `packages/computer-use/` | Implemented, unit-covered |
| `Computer` tool, automatic grant, capture, overlay driver | `apps/desktop/electron/main/computer-use/` | Implemented, refusal and mint paths unit-covered |
| Tool declaration and host gate | `packages/agent-runtime/src/computer-use/tool.ts`, `packages/host-runtime/src/agent-sidecar.ts` | Implemented |
| Indicator with Stop, settings, drawn cursor | `apps/desktop/src/features/computer-use/`, `features/settings/computer-use/` | Implemented, **not exercised by a UI test** |
| Target picker and grant card | — | Removed by ADR 0344; the renderer can no longer enumerate windows or mint a grant |

## What ran

| Check | Result |
|---|---|
| `cargo test -p host-core --locked` | 1160 passed, 1 ignored |
| `cargo clippy -p host-core --all-targets` | No new warnings (one pre-existing in `transcripts.rs`) |
| `cargo fmt -p host-core -- --check` | Clean |
| `pnpm build:js` | Passed |
| `pnpm --filter @pi-desktop/shared test` | 1378 passed (6 new) |
| `pnpm --filter @pi-desktop/computer-use test` | 27 passed |
| `pnpm --filter @pi-desktop/i18n test` | 31 passed |
| `pnpm --filter @pi-desktop/desktop typecheck` | Clean |
| `pnpm docs:check` / `check-locales` | Clean on this branch except the pre-existing duplicate ADR 0339, fixed separately |

## What ran on a device

macOS 15 (Darwin 24.6), Accessibility granted to the probing process, Stage
Manager active, Screen Recording **not** granted. Driven by
`PI_DESKTOP_COMPUTER_USE_DEVICE=1 node scripts/e2e-computer-use-device.mjs`
against the real host binary and a throwaway data dir, with
`--act-app`/`--deny` for the input and denylist checks. 15 / 15 checks passed.

| Checked against real windows | Result |
|---|---|
| Backend identity and Accessibility trust | `macos-ax`, `granted` |
| Window enumeration, with our own window listed and refused | our window was frontmost and refused `self` |
| The automatic desktop grant binds the frontmost *usable* window | bound the first window that was neither ours nor unreadable |
| Real accessibility tree | 15–400 nodes across six applications, `fidelity: full` |
| No element value ever leaves the host | no node carried a value field |
| Rebind to another application's window | revision moved; the pre-rebind revision then refused an action |
| Self-target, denylist, and unknown-window binds | `COMPUTER_SELF_TARGET_REFUSED`, `COMPUTER_TARGET_DENYLISTED`, `COMPUTER_SCOPE_VIOLATION` |
| One real action | `set_value` through the platform accessibility action; the document's text changed and the budget went 40 → 39 |
| Stop cooldown | an agent mint refused `COMPUTER_STOPPED_BY_USER`; a user mint cleared it |

The run found two defects, both now fixed:

- **The accessibility window could not be matched to the window-server
  window.** `window_matches` joined the two by geometry, and under Stage
  Manager `CGWindowList` reports an off-stage window's *thumbnail* frame while
  accessibility reports its real frame — measured on the device as `37,607
  121x137` against `219,44 1568x1125` for the same window. Every window except
  the one on stage was therefore refused `COMPUTER_SCOPE_VIOLATION`, which made
  the capability unusable in practice. The join is now the window id from
  `_AXUIElementGetWindow`, resolved with `dlsym` so a system without it falls
  back to the geometry match. The same wrong geometry reached `measure`, so a
  grant's bounds — and with them coordinate clamping, the `basis`, the drawn
  cursor, and the capture crop — now come from accessibility's frame.
- **A failed read left the grant on the window it could not read.** The bind
  succeeded, the inspection failed, and the grant stayed moved, so a later
  action was aimed at a window the caller had never seen. `inspect_bound`
  restores the previous binding on failure and keeps the revision bump.

## What did not run, and what that means

- **The Electron half is unproven on a device.** The automatic mint through the
  `Computer` tool, the indicator, Stop aborting the owning turn, the drawn
  cursor overlay, and the bounded loop against a real model all need the app
  running with a configured provider; none of that was exercised. The device
  probe talks to host-core directly.
- **No pixels were captured.** Screen Recording is not granted on the probing
  machine, so `a11y-and-pixels` grants, the scope-cropped capture, and the
  tool-image path remain unverified.
- **Secure input was not forced.** The refusal is unit-covered, but no password
  field was focused during a device run.
- **`CGEventPostToPid` never ran.** The one device action took the accessibility
  path, which is the preferred one; the window-targeted event fallback (and the
  chord table behind `press_keys`) is still fixture-only.
- **Windows and Linux have no backend yet.** They compile to the unsupported
  backend, so every operation there answers
  `COMPUTER_PLATFORM_UNSUPPORTED` rather than failing oddly. Stage 2 adds UIA
  and AT-SPI with their own dependency review and device matrix.
- **No UI test covers the indicator, its Stop, or the drawn cursor.**
  Repository policy reserves `verify:ui:*` for an explicit request. In
  particular, Stop aborting the owning turn has only been reasoned about, not
  clicked.
- **`confirm-each` has no approval card and never did.** It stays in the
  settings contract, is no longer offered in Settings, and selecting it through
  a settings write narrows nothing today. ADR 0342 described a per-step card
  that stage 1 did not build; ADR 0344 names the gap instead of implying it is
  closed.
- **The closed-window fallback is fixture-only.** Binding, the refusals, and
  the Stop cooldown now have device evidence; deliberately closing the bound
  window mid-action does not.
- **No provider call was made.** The loop's model request is covered by
  injected, scripted answers only; no computer-use model was configured and no
  token was spent.
- **The audit trail was not inspected in a running app.** The append calls are
  in place and shaped to carry identity without content, but no log file was
  read back to confirm that.

## Residual risk

The dangerous surface is the macOS backend, because it is the only code here
that can move another application. Its refusals are enforced one layer above it
in `policy.rs`, which *is* covered: self-target, secure input, stale basis,
stale revision, coordinate clamping, budget, expiry, single-grant exclusivity,
rebind refusals, and the credential denylist all have tests that fail closed —
and the device run above exercised the self-target, denylist, unknown-window,
stale-revision, and cooldown refusals against real windows.

ADR 0344 raises the stakes on exactly that layer. With no picker in front of
the capability, the refusals are the only thing standing between an enabled
feature and arbitrary windows, and they now run on every bind rather than once.

What the device run also showed is where the risk actually lives: not in a lost
refusal, but in the platform join. Both defects it found were "the host cannot
tell which window this is", and the second one let the grant sit on a window
nobody had read. The window-id join removes the ambiguity, but it rests on an
undocumented symbol (`_AXUIElementGetWindow`, D683): if a future macOS drops
it, the geometry fallback returns the product to the state this run found —
usable only for the window on stage. That is the thing to re-run the probe for
after every macOS upgrade.

Still open before this can be called verified end to end: the Electron half
(automatic mint through the tool, indicator, Stop aborting the turn, drawn
cursor, the loop against a real model), capture under a Screen Recording grant,
secure input on a device, and the `press_keys` / window-event fallback path.

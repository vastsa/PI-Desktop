# Computer Use Stage 1 Evidence

What was built for [ADR 0340](../adr/0340-os-computer-use-capability.md) stage 1,
and — more importantly — what has *not* been verified. This file contains no
window titles, no captured pixels, and no credentials.

## Shape

| Layer | Where | State |
|---|---|---|
| Contracts, settings, error codes | `packages/shared/src/computer-use.ts`, `errors.ts`, `protocol.ts` | Implemented, unit-covered |
| Refusals, grant broker, platform contract | `crates/host-core/src/computer/` | Implemented, unit-covered |
| macOS backend (`AXUIElement`, `CGWindowList`, `CGEventPostToPid`) | `crates/host-core/src/computer/macos/` (`mod.rs` behaviour, `ffi.rs` C surface) | Implemented, compiled, **no device run** |
| Windows and Linux backends | `crates/host-core/src/computer/backend.rs` | Explicit unsupported backend; stage 2 |
| `computer.*` RPC and audit | `crates/host-core/src/rpc/computer_rpc.rs` | Implemented, not covered by an RPC-level test |
| Bounded loop and action schema | `packages/computer-use/` | Implemented, unit-covered |
| `Computer` tool, capture, overlay driver | `apps/desktop/electron/main/computer-use/` | Implemented, refusal paths unit-covered |
| Tool declaration and host gate | `packages/agent-runtime/src/computer-use/tool.ts`, `packages/host-runtime/src/agent-sidecar.ts` | Implemented |
| Picker, indicator, settings, drawn cursor | `apps/desktop/src/features/computer-use/`, `features/settings/computer-use/` | Implemented, **not exercised by a UI test** |

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

## What did not run, and what that means

- **No real application was ever driven.** No `AXUIElement` action, no
  `CGEventPostToPid` key, no `desktopCapturer` frame, and no macOS
  Accessibility prompt was triggered on this machine. The macOS backend is
  compiled and its pure parts (element id round-trip, chord table, action
  mapping) are unit-tested; everything that touches a live window is unproven.
- **Windows and Linux have no backend yet.** They compile to the unsupported
  backend, so every operation there answers
  `COMPUTER_PLATFORM_UNSUPPORTED` rather than failing oddly. Stage 2 adds UIA
  and AT-SPI with their own dependency review and device matrix.
- **No UI test covers the picker, the indicator, the grant card, or the drawn
  cursor.** Repository policy reserves `verify:ui:*` for an explicit request,
  and the five `E2E-COMPUTER-USE-*` scenarios are `NOT RUN`.
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
and the credential denylist all have tests that fail closed. What remains
unproven is whether the backend can actually drive a real window — a bug there
shows up as "nothing happens", not as a lost refusal.

A device run on macOS is the next gate: enable the feature, bind a model, hand
over a window, and confirm the drawn cursor, one accessibility press, the audit
line, and Stop. Until that happens, treat stage 1 as implemented and unverified.

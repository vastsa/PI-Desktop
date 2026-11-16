# ADR 0223: Context Usage Display Preference

- Status: Accepted
- Date: 2026-09-11
- Amends: ADR 0184
- Related: [04-ux/06-settings-ia](../spec/04-ux/06-settings-ia.md) · [04-ux/08-component-spec](../spec/04-ux/08-component-spec.md) · [08-meta/decisions-log](../spec/08-meta/decisions-log.md) (D398) · E2E-250

## Context

The composer toolbar's context usage inspector introduced by ADR 0184 (D347)
always led with remaining capacity, in the trigger ring, popover heading, tooltip,
and `aria-label`. Some users find used capacity more intuitive, especially when the
remaining figure sits close to the total window and gives little signal at a
glance.

## Decision

1. `AppSettings.contextUsageDisplay` of type
   `ContextUsageDisplay = "remaining" | "used"` chooses which figure the inspector
   leads with, and `"remaining"` stays the default and the fallback for absent or
   unrecognized values.
2. With `"used"`, the ring arc, trigger label, popover heading, tooltip, and
   `aria-label` all report used capacity, and the ring fills proportionally to the
   used ratio.
3. Warning and critical colors stay keyed to remaining capacity in both modes, so a
   ring reading used capacity still warns when little space remains.
4. Settings → AI → Defaults gains a segmented Remaining / Used row.
5. The change is renderer-only: no protocol, storage schema, or IPC change, and
   host-core preserves the unknown settings key across upgrades.

## Consequences

- Both mental models are available, and the default behavior is unchanged.
- A fuller ring means more context consumed, which is the correct reading.
- Color semantics stay stable, so the warning signal is never ambiguous.

## Alternatives

- Boolean toggle: rejected, a segmented control reads clearer for mutually
  exclusive modes and the union type can grow.
- Color thresholds following the display mode: rejected, it would show a safe ring
  while almost no context remains.

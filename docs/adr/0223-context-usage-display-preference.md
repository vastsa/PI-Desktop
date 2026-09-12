# ADR 0223: Context Usage Display Preference

- Status: Accepted
- Date: 2026-09-11
- Deciders: PI-Desktop desktop UI maintainers
- Amends: 0184
- Related: [04-ux/06-settings-ia](../spec/04-ux/06-settings-ia.md) ·
  [04-ux/08-component-spec](../spec/04-ux/08-component-spec.md) ·
  [08-meta/decisions-log](../spec/08-meta/decisions-log.md) (D398) ·
  E2E-250

## Context

The composer toolbar's context usage inspector (ADR 0184 / D347) always leads
with the remaining-capacity figure: the trigger ring, popover heading,
tooltip, and `aria-label` all show the remaining token count and percentage.
Some users find the used-capacity figure more intuitive — especially when
context is lightly loaded and the remaining number is close to the total
window, which provides little signal at a glance.

## Decision

1. A new setting `AppSettings.contextUsageDisplay` (`ContextUsageDisplay =
   "remaining" | "used"`) lets the user choose which figure the context
   inspector leads with. The default (and fallback for absent or
   unrecognised values) is `"remaining"`, preserving the existing behaviour.
2. When `contextUsageDisplay` is `"used"`, the composer toolbar ring's
   arc length (`strokeDashoffset`), the trigger percentage and token label,
   the popover heading, the tooltip, and the `aria-label` all switch to
   the used-capacity pair instead of the remaining pair. The ring fills
   proportionally to `usedRatio` rather than `remainingRatio`.
3. Warning and critical color thresholds remain based on **remaining**
   capacity (remaining ≤ 25 % → warning, ≤ 10 % → critical) regardless
   of the display mode. A display reading "used 78 %" still turns warning
   colour because only 22 % remains.
4. Settings → AI → Defaults gains a `ContextUsageDisplayRow` (segmented
   control: Remaining / Used) placed after the Link open destination row
   and before the Enter-to-send row.
5. The change is renderer-only: no protocol, storage schema, host-side
   migration, or IPC change. The host-core settings merge preserves
   unknown keys, so persisted `contextUsageDisplay` values survive across
   upgrades without a schema bump.

## Consequences

- Users who prefer a "how much have I spent" mental model get a consistent
  display; users who prefer the original "how much is left" model see no
  change by default.
- The ring arc direction flips visually when switching to `"used"`, which
  is the correct correspondence: a fuller ring means more context consumed.
- Color semantics stay stable across modes, so the warning/critical signal
  is never ambiguous regardless of the chosen display direction.
- No host or storage change means no migration risk and no protocol version
  bump.

## Rejected alternatives

- **Boolean toggle (show-used: true/false):** a two-value segmented control
  reads clearer than a checkbox for mutually exclusive display modes, and
  the `ContextUsageDisplay` union type leaves room for future modes without
  a type rename.
- **Color thresholds also follow display mode:** rejected; it would make a
  "used 90 %" ring green despite only 10 % remaining, which is dangerously
  misleading. Remaining capacity is the safety signal and must stay
  authoritative for color.

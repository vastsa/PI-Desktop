# ADR 0173: Plugin-owned token usage dashboard

- Status: Accepted
- Date: 2026-09-07
- Deciders: PI-Desktop core
- Related: D103, D331, D335, ADR 0171, `04-ux/06-settings-ia.md`,
  E2E-186, marketplace plugin `pi.token-insights`

## Context

ADR 0171 added host-owned completed-turn token history and a Settings → Usage
destination. The marketplace plugin `pi.token-insights` already ships a private
local dashboard (heatmap, KPIs, filters, streaks, agent tool) across PI-Desktop,
Claude Code, Codex, and OpenCode.

## Decision

1. **Settings has no Usage destination.** Preferences is General, AI, and
   Shortcuts.
2. **`pi.token-insights` is the user-facing dashboard.** Command palette
   keywords (`usage`, `tokens`, `用量`) open that plugin.
3. **Host persistence stays.** Electron still sums parent `message_end` usages
   plus `turn_end.subagentUsage` into `session.endTurn.usage`.
4. **The plugin may fold host completed-turn remainders** into its PI-Desktop
   fact cube when those totals exceed transcript assistant `meta.usage`, so
   subagent spend is visible without double-counting JSONL messages.

## Consequences

- Users who want a heatmap install or open Token Insights.
- Historical turns from before Electron sent `usage` may still be zero in the
  host RPC; the plugin's JSONL scan remains the backfill for those days.
- A later first-party plugin API wrapping `stats.getTokenUsageHistory` is a
  separate change.

## Alternatives

- Keep Settings → Usage beside the plugin: rejected (duplicate IA).
- Delete host turn persistence: rejected (D331 accounting).
- Let the plugin replace JSONL with the turns table: rejected (loses per-message
  model/provider rankings and pre-persistence history).

# ADR 0173: Plugin-owned token usage dashboard

- Status: Accepted
- Date: 2026-09-07
- Related: D002, D103, D331, D335, ADR 0171

## Context

ADR 0171 added host-owned completed-turn token history and a Settings → Usage
destination, but the marketplace plugin `pi.token-insights` already ships a local
dashboard across PI-Desktop, Claude Code, Codex, and OpenCode, so keeping both
duplicated a weaker PI-Desktop-only matrix inside Preferences.

## Decision

1. Settings has no Usage destination: Preferences is General, AI, and Shortcuts,
   and search does not index a usage tab.
2. `pi.token-insights` is the user-facing dashboard, and command palette keywords
   (`usage`, `tokens`, `用量`) open that plugin.
3. Host persistence stays: Electron still sums parent `message_end` usages plus
   `turn_end.subagentUsage` into `session.endTurn.usage`, and
   `stats.getTokenUsageHistory` remains an additive host RPC / IPC for local
   rollups, not a Settings page.
4. The plugin may fold host completed-turn remainders into its fact cube where they
   exceed transcript assistant `meta.usage`, so subagent spend is visible without
   double-counting; it never rewrites `message.usage`.

## Consequences

- Users who want a heatmap install or open Token Insights.
- Historical turns may still be zero in the host RPC; the plugin's JSONL scan
  backfills those days.

## Alternatives

- Keep Settings → Usage beside the plugin: duplicates the IA.
- Delete host turn persistence: loses D331 accounting.

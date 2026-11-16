# ADR 0334: OpenAI Fast mode as a per-session switch gated by model settings

- Status: Accepted
- Date: 2026-10-17
- Related: [ADR 0329](0329-session-worktree-isolation.md) ·
  [03-runtime/11-provider-model-system](../spec/03-runtime/11-provider-model-system.md) ·
  issue #1657

## Context

OpenAI's faster priority tier, Fast mode, is the Responses body field
`service_tier: "priority"` (the Codex backend rejects `"fast"`) and it costs more
in plan limits or per-token price, while PI-Desktop never asked for a tier.
pi-ai's adapters already accept `serviceTier` and price the reported tier, but
`streamSimple` dropped the option. Issue #1657 asks for the speed-up and
maintainers asked that the capability be configured in model settings.

## Decision

1. **Model settings own capability.** `ModelBinding.fastModeAllowed` is an
   opt-in stored in the existing provider `config_json` like
   `nativeWebSearch`, needing no migration, enabled only for the
   `openai_codex_responses` and `responses` wires including relays, with a hint
   naming that wire's cost.
2. **`/fast` owns the session switch.** The `builtin.session.fast` builtin
   toggles a persisted `sessions.fast_mode` column (schema v27, additive), and
   `session.create` / `session.configure` accept an optional `fastMode` where
   omission keeps the stored value, forks copy it, scheduled runs and delegated
   workers start off, and a draft carries it into the session its first prompt
   creates.
3. **`/fast` only works on a configured model.** When the selected wire cannot
   carry the tier or the model is not allowed, `/fast` stores nothing and points
   to Settings → Models → Advanced, and a stale switch is inert because launch
   also requires the opt-in.
4. **The launcher resolves; the runtime only stamps the wire.** Launch sends
   `fastMode: true` only when the session switch is on and the binding allows it,
   and the runtime passes `serviceTier: "priority"` on main turns whose resolved
   wire is `openai-codex-responses` or `openai-responses`; subagents, compaction,
   and one-shot plugin requests keep the default tier, and a trusted extension
   switching to its own model clears the switch until the next launch.

## Consequences

- Schema v27 adds one column, and older apps refuse a v27 database as newer.
- The capability can be wrong for a relay that ignores or rebills the field, so
  the settings hint states that risk and the user owns the opt-in.
- The Composer model chip shows a Fast mark while the switch is on for an
  allowed model, keeping the cost visible at send time.

## Alternatives

- A per-model switch without session state: it turns a per-conversation cost
  into a global one for every conversation on that model.
- A hard-coded official-host-only rule: it excludes relays the user knows
  support the field and hides the decision in code.

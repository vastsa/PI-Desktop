# ADR 0334: OpenAI Fast mode as a per-session switch gated by model settings

- Status: Accepted
- Date: 2026-10-17
- Deciders: PI-Desktop maintainers
- Related: [ADR 0329](0329-session-worktree-isolation.md) ·
  [03-runtime/11-provider-model-system](../spec/03-runtime/11-provider-model-system.md) ·
  [04-ux/04-builtin-commands](../spec/04-ux/04-builtin-commands.md) ·
  issue #1657 · E2E-FAST-MODE

## Context

OpenAI serves a faster priority tier that Codex CLI and the OpenAI API call
Fast mode. On the wire it is the Responses body field `service_tier:
"priority"`; the Codex backend rejects `"fast"`. The tier costs more: a ChatGPT
subscription spends its plan limits faster, and the OpenAI API bills a higher
per-token price. PI-Desktop never asked for a tier. pi-ai's Responses and
Codex adapters already accept `serviceTier` and price the tier the response
reports, but `streamSimple` dropped the option while building its base options.

The cost is a decision about one conversation, while whether an endpoint
honors the field is something only the user knows for a relay. Issue #1657 asks
for the subscription speed-up; maintainers asked that capability be configured
in model settings.

## Decision

1. **Model settings own capability.** `ModelBinding.fastModeAllowed` is an
   opt-in, stored in the existing provider `config_json` like
   `nativeWebSearch`, so it needs no migration. The checkbox is enabled only
   for Responses wires (`openai_codex_responses`, `responses`), including
   relays; its hint names the cost on that wire.
2. **`/fast` owns the session switch.** A new builtin `builtin.session.fast`
   (`/fast`) toggles a persisted `sessions.fast_mode` column (schema v25,
   additive, v24 backup). `session.create` and `session.configure` accept an
   optional boolean `fastMode`; omission keeps the stored value. Forks copy it;
   scheduled runs and delegated workers start off. A draft carries it into the
   session its first prompt creates. Remote sessions refuse it.
3. **`/fast` only works on a configured model.** When the selected model's
   wire cannot carry the tier or the model is not allowed, `/fast` stores
   nothing and points to Settings → Models → Advanced, in either direction. A
   stale stored switch on such a model is inert because launch also requires
   the opt-in.
4. **The launcher resolves; the runtime only stamps the wire.** Session launch
   sends `fastMode: true` to the sidecar only when the session switch is on and
   the user's stored binding allows it. The runtime passes pi-ai's native
   `serviceTier: "priority"` on main turns whose resolved wire is
   `openai-codex-responses` or `openai-responses`; the existing pi-ai patch
   forwards `serviceTier` through `streamSimple`, so the adapters also apply
   their own tier pricing. Subagents, compaction, and one-shot plugin requests
   build their own options and keep the default tier.

## Alternatives

- **Per-model switch only (no session state).** Avoids a migration, but turns
  a per-conversation cost into a global one: enabling Fast for one task speeds
  up and costs every conversation on that model.
- **Hard-coded capability rule (official OpenAI host only).** Removes a
  setting, but excludes relays the user knows support the field and hides the
  decision in code.
- **Generic request-parameter injection with presets.** More flexible, but an
  arbitrary body-field channel needs its own validation and permission story,
  which is larger than this need.

## Consequences

- Schema v25 adds one column; older apps opening a v25 database refuse it as
  newer, the existing downgrade behavior.
- The capability can be wrong for a relay that ignores or rebills the field;
  the settings hint states that risk, and the user owns the opt-in.
- The Composer model chip shows a Fast mark while the switch is on for an
  allowed model, so the cost is visible at send time.

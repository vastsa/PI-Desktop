# ADR 0174: Host-owned plugin completions and session context

- Status: Accepted
- Date: 2026-09-07
- Deciders: PI-Desktop core
- Related: D019, D015, D018, D336, ADR 0005, ADR 0008, ADR 0121, ADR 0170,
  `07-plugins/03-plugin-api.md`, `07-plugins/13-plugin-permissions-matrix.md`

## Context

Pi CLI extensions can let an executor model call a zero-parameter reviewer tool, with
the host serializing the resolved LLM context and running a one-shot completion on a
stronger reviewer under the user's existing credentials.

Desktop plugins can register tools, commands, settings, and skills, but cannot list
authenticated models, read the session's model-facing transcript, or spend quota on a
side completion. A plugin calling providers itself would need secrets (forbidden,
D018) or a pasted key, and D019 denied session-summary access by default, while
composer `prompt/enhance` already proves a host-owned one-shot path that never hands
a secret to the renderer.

## Decision

1. **Three public plugin APIs**, gated by new permissions: `models.list` (medium)
   returns ready `(providerId, modelId)` rows without secrets; `session.read` (high)
   lets `pi.session.getLlmContext()` return a bounded, compaction-aware projection of
   the **in-flight tool session**, identified by `plugins.execute` rather than a
   plugin-supplied id (D333); `agent.complete` (high) runs
   `pi.agent.complete({ modelKey, thinkingLevel, system, messages,
   includeSessionContext })` as a host-owned one-shot with `tools: []`, where
   `includeSessionContext: true` also needs `session.read`.
2. **Host owns credentials and the wire call.** The plugin process never receives an
   API key, OAuth refresh token, or `ModelAuth`; completions reuse
   `resolveAgentRuntimeLaunch`.
3. **Session context is a projection, not a dump**: subagent rows are omitted, the
   plugin's own in-flight call is stripped from the tail, compaction summaries
   replace pre-checkpoint history, tool results are truncated, and the payload is
   capped. Audit logs record plugin id, model key, sizes, and usage, never transcript
   text.
4. **Rate and size brakes**: eight `agent.complete` calls per plugin per rolling 60s,
   system prompt ≤ 32 KiB, messages ≤ 200k characters, and a 90s completion budget
   under the 110s plugin-tool timeout.
5. **`session:modelChanged` is a host event** pushed after a `session.configure` that
   changes provider, model, or thinking level. D019 is amended, not withdrawn:
   session content stays denied without `session.read`, while tool-exec context may
   carry `modelKey` and `thinkingLevel` because those are configuration. No bundled
   Advisor ships.

No host-protocol or storage schema bump; completions are Electron-local.

## Consequences

- Third-party plugins can build reviewer tools without keys, but `session.read` plus
  `agent.complete` is a legitimate conversation-exfiltration channel to another
  model the user pays for, so install UI must show both permissions and their help
  text.
- Plugin tools keep the D015 prefix, Plan/Goal still hard-deny them, and one-shot
  spend is audited on the plugin call rather than merged into the parent usage chip
  (ADR 0171).

## Alternatives

- Load the npm Pi CLI extension in the sidecar: it is not the Pi TUI extension host
  and the CLI command needs a TTY.
- Let plugins call providers through `net.fetch`: needs secrets in settings and skips
  host retry, OAuth, and audit.
- Give plugins an arbitrary `sessionId`: a plugin could read every conversation.

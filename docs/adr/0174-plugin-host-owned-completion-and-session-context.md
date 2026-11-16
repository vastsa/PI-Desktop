# ADR 0174: Host-owned plugin completions and session context

- Status: Accepted
- Date: 2026-09-07
- Deciders: PI-Desktop core
- Related: D019, D015, D018, D336, ADR 0005, ADR 0008, ADR 0121, ADR 0170,
  `07-plugins/03-plugin-api.md`, `07-plugins/13-plugin-permissions-matrix.md`

## Context

Pi CLI extensions can let an executor model call a zero-parameter reviewer tool.
The host serializes the resolved LLM context and runs a one-shot completion
against a stronger reviewer using the user's existing credentials.

- list the models the user has authenticated
- read the current session's model-facing transcript
- spend the user's provider quota on a side completion

## Decision

1. **Three public plugin APIs**, gated by new permissions:
   - `models.list` (medium) — `pi.models.list()` returns ready `(providerId,
     modelId)` rows.
   - `session.read` (high) — `pi.session.getLlmContext()` returns a bounded,
     compaction-aware projection of the **in-flight tool session**.
   - `agent.complete` (high) — `pi.agent.complete({ modelKey, thinkingLevel,
     system, messages, includeSessionContext })` runs a host-owned one-shot
     completion with `tools: []` through the same credential resolver as agent
     turns and prompt enhancement.

2. **Host owns credentials and the wire call.** The plugin process never
   receives an API key, OAuth refresh token, or short-lived `ModelAuth`.

3. **Session context is a projection, not a dump.** Subagent rows are omitted.

4. **Rate and size brakes.** Eight `agent.complete` calls per plugin per rolling
   60s.

5. **`session:modelChanged` is a host event** pushed after a successful
   `session.configure` that changes provider, model, or thinking level.

6. **D019 is amended, not withdrawn.** Session content remains denied until
   `session.read` is declared and granted.

7. **Bundled Advisor is temporarily not shipped.** The public APIs remain
   available to explicitly installed plugins, but PI-Desktop does not bundle a
   first-party reviewer command, panel, skill, or agent tool for now.

No host-protocol or storage schema bump. Completions are Electron-local, like
`prompt/enhance`.

## Consequences

- Third-party plugins can build reviewer / second-opinion tools without holding
  keys.
- `session.read` + `agent.complete` is a legitimate conversation-exfil channel
  to another model the user already pays for.
- Plugin tools keep the D015 prefix.
- One-shot completion spend is audited on the plugin call and is not merged into
  the parent assistant usage chip (ADR 0171).

## Alternatives rejected

### Load the npm Pi CLI extension in the sidecar

The sidecar is not the Pi TUI extension host.

### Let the plugin call providers through `net.fetch`

Would require secrets in plugin settings (D018) or a user-pasted key, and would
skip host retry, OAuth, and audit.

### First-party reviewer tool instead of a plugin

Deferred for now: the bundled reviewer experience is temporarily removed while
the public host APIs remain available for explicitly installed plugins.

### Give plugins an arbitrary `sessionId` argument

Rejected: a plugin could read every open conversation.

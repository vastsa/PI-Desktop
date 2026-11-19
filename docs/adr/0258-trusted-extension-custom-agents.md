# ADR 0258: Trusted extensions may provide custom agents

- Status: Accepted for implementation
- Date: 2026-09-15
- Decision: D426
- Related: ADR 0214, ADR 0215, `07-plugins/16-trusted-extensions.md`, Issue #401

## Context

Trusted extensions run beside the Agent runtime and are the right surface for
providers no built-in pi-ai adapter can represent (issue #401, e.g. Command Code with
its own endpoint and auth). The pinned pi-coding-agent API has `registerProvider` but
no `registerAgent`, and its registry assumes coding-agent-owned credentials and model
persistence, which would bypass the product's session binding and secret ownership.

## Decision

1. Add a `registerAgent` ExtensionAPI member: an id, bounded model metadata, and
   either a `stream` or `complete` implementation, with the plugin owning endpoint,
   authentication, request serialization, and response conversion.
2. Register inside the Agent sidecar. The host receives only the opaque provider
   id/model id and persists the binding through `session.configure`, so registration
   is session-scoped, removed with the runtime, and limited to trusted extensions
   holding the high-risk `agent.extension` grant.
3. Use namespaced `extension-agent:<encoded-agent-key>` provider ids: later turns pass
   the binding as a placeholder provider, and the sidecar reloads the extension and
   reactivates that implementation.
4. Expose a read-only model registry projection — models and auth availability, never
   host API keys, secret refs, OAuth tokens, provider headers, or internals.
5. `registerProvider` accepts the same plugin-owned streaming shape as a compatibility
   alias, and the host writes no provider registration into the Host database or
   global defaults.

## Consequences

- Similar integrations ship their own auth and wire protocol without an app release or
  new Rust transport, while model selection stays host-owned and observable through
  `session:modelChanged`.
- Custom agents stay out of the ordinary provider Settings picker, and `registerAgent`
  being PI-Desktop-specific means upstream pi upgrades must preserve or translate it.

## Alternatives

- Expose `ModelRegistry` directly: it leaks credential resolution.
- Write custom providers into Rust/SQLite: the plugin owns them.
- Register an executable subagent: deferred; this covers LLM transport only.

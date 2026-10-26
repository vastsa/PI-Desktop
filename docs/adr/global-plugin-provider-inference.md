# ADR: Global plugin provider inference

- Status: Accepted
- Date: 2026-10-25
- Related: [ADR 0259](0259-plugin-declared-providers.md), [model preferences](plugin-provider-user-model-preferences.md), [plugin API](../spec/07-plugins/03-plugin-api.md#global-provider-inference-adapters)

## Context

Manifest-declared providers already have stable Host-owned identities and native
model settings. Compatible transports cannot represent every proprietary service.
Session-local trusted extensions can register custom agents, but do not provide a
global model for the main Agent, delegation and image tools. Loading plugin code
into the trusted agent sidecar would unnecessarily combine their authority.

## Decision

Extend `contributes.providers` with an optional versioned `adapter` declaration
and export `providerAdapters[contributionId]` from the existing plugin entry
module. Keep the identity `plugin:<pluginId>:<contributionId>`, native model
preferences, Host credentials and persistence. No parallel provider registry or
new database schema is introduced. Existing declarations retain compatible
transports and trusted-extension agents retain their session scope.

Require a separate high-risk `provider.inference` grant together with
`provider.register`. Registration alone must not grant transcript or credential
access. The adapter can receive the selected model's canonical request and only
its own request key/headers and bounded encrypted OAuth routing metadata;
refresh tokens remain on the existing OAuth path.
Grant disclosure must describe these data flows. The existing plugin utility
process isolates lifecycle and failures, but is not an OS security sandbox.

A Host broker binds calls to the authorized session/provider/model and runtime
generation. Narrow reverse RPC serves main and delegated models through the
same binding mechanism. Chat uses bounded open/next/close pulls; image requests
reuse native reference-image loading and scratch output handling. Version, JSON,
size, operation and image-signature validation apply at the boundary. Unload,
crash, cancellation and disposal invalidate pending work and late results.

The native Agent owns local tool execution and delegation. Adapters emit tool
requests, not executable Host actions. Capability restrictions distinguish chat,
image input and generation; user preferences cannot expand the declaration.
Custom inference does not automatically retry or fall back to another provider,
preventing an ambiguous failure from silently causing duplicate paid requests.

Project manifest-owned operation defaults and per-model restrictions into
read-only `ProviderPublic.pluginModelOperations`, separate from user preferences.
OAuth image eligibility follows that explicit capability rather than a built-in
vendor allowlist. Preserve ordinary OAuth restrictions for non-adapter accounts.
Store optional JSON `requestData` with the encrypted OAuth credential (16 KiB,
depth 64). Share refresh singleflight with ordinary auth; only the authorized
adapter receives this data, never public configuration or the Agent sidecar.

## Consequences

- Plugin models work through native Settings, main sessions, subagents and
  supported image generation without moving agent execution into the renderer.
- Existing SDK declarations are backward-compatible; adapter version 1 is an
  opt-in public contract. Future incompatible protocols require another version.
- Users must trust adapter code with the selected conversation and scoped
  credentials. Host-mediated network APIs retain their existing permission and
  domain checks; raw Node APIs are not falsely described as sandboxed.
- Bounded payloads and timeouts can reject very large or slow workloads. Limits
  are specified alongside the executable SDK contract rather than hidden retries.
- Tests use local plugin subprocess fixtures, not paid providers or user profiles.

## Alternatives

Promoting trusted-extension agents was rejected because it conflates session
execution with a global provider and expands trusted sidecar access. A parallel
plugin-owned catalog was rejected because model identity, persistence and
selection would acquire competing sources of truth. Requiring every service to
imitate an existing HTTP protocol was rejected because it cannot cover the
approved proprietary-adapter use case.

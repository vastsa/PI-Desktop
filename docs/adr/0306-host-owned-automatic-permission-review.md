# ADR 0306: Host-owned automatic permission review

- Status: Accepted for implementation
- Date: 2026-09-23
- Amends: ADR 0057's tool-wide session-grant scope
- Related: ADR 0254, ADR 0284

## Context

Desktop already owns Ask, Accept edits, Auto, and permission cards. Repeated
prompts encourage broad tool-wide session grants. Independent Pi completions
are available, but delegating authorization to the executing model would mix
execution intent with permission authority. Native Pi sessions deliberately
disable tools until a separate permission bridge exists.

## Decision

Keep permission policy and execution admission in Rust host-core. Add automatic
review as a reviewer of otherwise-pending requests, independent of permission
mode. Share review coordination through host-runtime and use a no-tool Pi
completion behind agent-runtime's existing provider boundary. Electron remains
an adapter. Automatic review can grant only the current action; uncertainty or
failure returns to the existing human approval boundary.

Expose one editable reviewer policy initialized from the shared built-in
default, rather than a default-plus-custom overlay. This makes the policy the
user sees the one sent to the reviewer and avoids ambiguous precedence.
Host admission constraints and the structured response protocol remain outside
that editable policy. Saving a change invalidates old-policy authorization;
audit identifies the effective policy without retaining its raw custom text.

Replace tool-wide grants with explicit action scopes and caller identities,
with host-owned invalidation and visible revocation. Admit host-local execution
through the same authority and consume single-use execution permits. Keep
native Pi JSONL, no-tools continuation, and SDK pin unchanged. The executable
contract is [permission review](../spec/03-runtime/23-permission-auto-review.md),
not this decision record.

## Alternatives

- A fourth permission mode would conflate who reviews an action with which
  capabilities may execute; independent reviewer selection preserves Auto.
- An ordinary tool-capable subagent could recursively request authorization
  or change the environment it is assessing. The reviewer has no tools.
- Implementing OS and plugin sandboxing in the same increment would combine
  platform containment and authorization lifecycle changes. Isolation remains
  separately tracked and must not be claimed by this feature.

## Consequences

Approval adds model latency and cost, is opt-in, and depends on model quality.
It does not provide an OS security boundary. Exact grants are narrower but may
prompt more often when commands change. Host/runtime protocol and persisted
configuration need compatibility handling, while native Pi data needs none.
SDK upgrades must pass adapter contract tests before deployment. Open PR #457
proposes a separate user-defined deny overlay; this change does not implement
or replace that contributor's feature.

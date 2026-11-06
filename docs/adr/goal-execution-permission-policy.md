# ADR: Goal execution permission policy

- Status: Implemented candidate; autonomous integration depends on the behavior-preserving foundation
- Decision ID: `goal-execution-permission-policy`
- Related: [tools and permissions](../spec/03-runtime/03-tools-and-permissions.md)
- Review context: [PR 1999 maintainer request](https://github.com/vastsa/PI-Desktop/pull/1999#issuecomment-6676698692)

## Context

Legacy Goal shares Plan's contract-mode tool restrictions. PR 1999 proposes a
user-authorized autonomous Goal that can perform Agent work across execution
rounds. Changing that policy together with six storage upgrades and the UI makes
the authority change difficult to review independently.

Tool membership, permission approval and execution authority are different rules:

- Membership determines which tools a host execution may use.
- Approval applies the existing Ask, Accept edits, Auto, risk, session-grant and
  external-path rules to an eligible tool.
- Authority determines whether this session and execution may perform work now.
  A tool policy is not an execution claim, permission grant or resume request.

## Decision

Expose Host-internal `ToolPermissionPolicy` values, `Agent` and `Contract`, to the
permission evaluator instead of passing a session-mode string into that evaluator.
The policy type is not serialized and is not a model, plugin, IPC or RPC argument.
The existing Contract membership and plan-safe plugin exception live in one small
module. A membership denial still precedes risk, Auto, grants and scratch handling.
Plugin execution continues to enforce the individual plan-safe action.

### Safe foundation

The foundation selects policies only through `for_legacy_mode`: Plan and legacy
Goal select Contract, and other existing modes retain their prior mapping. Both
production permission-evaluation callers use the Host's persisted session mode.
The Goal Write/Edit/plugin hard deny therefore remains in effect when this part
lands alone. It adds no Goal startup, continuation, storage, migration or UI.

Risk classification, approval cards, session grants, path resolution, native tool
scope grants, cancellation and plugin sandboxes are unchanged. A request's claimed
mode cannot select the policy. Existing permission payloads and schema versions
are unchanged.

### Autonomous Goal activation in the dependent feature

The dependent Goal feature selects the already-tested Agent policy for work
owned by the trusted Host execution pipeline. Both permission-evaluation callers
use `for_execution_mode` after resolving the actual execution mode and validating
any Goal binding, not a Composer preference, model argument or restored prompt.
The Host's existing direct-owner native tool ingress remains subject to its own
ordinary permission rules; it must not create autonomous authority.

The feature must preserve these conditions:

1. Only explicit user-owner startup or resume authorizes autonomy. Model progress,
   summaries, editing a goal and selecting an input mode cannot do so.
2. A bound Goal round must belong to the session, remain live and unsettled, and
   satisfy the authoritative Goal lifecycle. New admission cannot use closeout
   credentials. Stop, cancel, replacement and recovery cannot revive old work.
3. Agent membership does not select Auto. Each operation still follows the
   session's effective permission mode, path policy and tool-specific guards.
4. Goal remains Goal for execution-time Computer and scheduled-tool restrictions.
   Selecting an Agent permission profile must not relabel the execution as Agent
   or make those tools callable through a retained reference.
5. Pause permits only bounded handoff and accounting, not substantive tools or
   new rounds. Removing a goal may convert only an eligible already-running
   conversation; it cannot authorize another Goal round.
6. Historical Plan/Goal approvals remain readable without being converted into
   permission to start an autonomous loop.

This is the permission decision to review first. The dependent feature supplies
and tests the claim, lifecycle and mode-selection producers. The foundation alone
does not enable autonomous Goal; the integration activates it with those producers.

## Alternatives

- Keep all Goal executions Contract-only: preserves the old behavior, but cannot
  provide the requested Agent-like autonomous work.
- Globally exempt the string `goal` in the permission manager: obscures who chose
  the policy and combines policy approval with storage/runtime implementation.
- Pretend Goal work is ordinary Agent work: loses the mode needed for explicit
  lifecycle, Computer and scheduling restrictions.
- Add a temporary enable flag: creates another source of authority and a second
  path to test. A typed policy boundary needs no such flag.

## Consequences

The foundation is independently mergeable without widening production behavior.
The Goal feature is a dependent review unit, not an alternative permission engine.
Reviewers can examine the membership/approval matrix before reviewing persistence
and UI, and then examine the explicit Host policy selection in the integration.
No process screenshots, generated galleries or machine-specific verification
reports are required in the source tree to explain this decision.

The preserved contracts are checked by the existing permission tests and the
legacy Goal native-RPC denial path. A differential membership matrix covers the
pre-split allowlist, including absent/empty/nonempty plan-safe actions. Separate
checks prove Agent membership does not bypass Ask or external-path approval.

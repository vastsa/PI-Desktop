# ADR 0350: Parent-directed recovery of a stalled child provider attempt

- Status: Implemented candidate
- Date: 2026-11-04
- Deciders: PI-Desktop maintainers
- Related: ADR 0089 (delegation ownership), ADR 0279 (resumable chains),
  ADR 0348 (ordered user commands), decisions-log D328
- Revisits: D328's withdrawal of idle/duration watchdogs. This decision adds
  observation and an explicit parent action; it does not restore timed delegate
  cancellation or automatic model selection.

## Context

A live child can wait indefinitely for a provider that has stopped emitting
stream events. TaskStop loses that live attempt, while Task resume is a separate
operation for settled chains and intentionally rejects a model override. The
parent needs bounded evidence of a provider stall and an authorized way to
continue the same child with another configured provider/model.

## Decision

1. Observe each physical provider attempt. Expose its phase, attempt identity,
   start time, last provider-event time, stalled flag, and pending recovery in
   TaskList/TaskWait. All provider events, including thinking, refresh activity.
   A provider attempt becomes stalled after 120000 ms without events. Tool
   execution, retry backoff, idle time, and total delegate duration are excluded.
2. Add parent-only `TaskRecover({ delegationId, model })` in Agent mode. The
   target must be a live child owned by this parent's current runtime and turn,
   with a currently stalled provider attempt. User-owned chains, other sessions,
   settled/stopped children, nested delegation, and concurrent duplicate recovery
   are rejected. `Task(resume, model)` remains invalid.
3. Resolve the exact target key freshly through Main, requiring current
   `availableForSubagents` opt-in. Cached Task grants, definition pins, and parent
   inheritance cannot bypass this check. Reject the unchanged binding. Prepare
   model, thinking, transport, and credentials before interrupting anything.
   Revalidate ownership, epoch, cancellation, and attempt activity after awaits.
4. Abort and detach only the stalled provider request. Drain/ignore late events
   and callbacks so they cannot refresh progress, start tools, or mutate state.
   Install the prepared binding atomically and continue carried context, removing
   only the controlled failed provider request. Completed tools are not replayed,
   queued user messages stay ordered, and normal Stop/settlement/report ownership
   remains authoritative. Record old/new model keys in the recovery result.
5. TaskWait wakes for each newly stalled selected attempt once. Repeated waits
   do not spin on the same observation. The parent decides whether to recover,
   wait, or stop; no timer chooses a model, cancels a delegate, or injects a new
   parent request. Temporary watchers belong to their wait/run and are cleaned up.

## Consequences

Recovery is deliberately limited to local runtime-owned children with fresh
model authorization. A silent tool or a settled failure does not qualify. An
active child can change providers without changing its identity, replaying side
effects, or changing the parent model. This adds a tool contract and lifecycle
metadata, requiring controlled-clock, loopback-provider, authorization-race,
late-event, and full parent-to-child recovery coverage.

## Alternatives considered

- Automatically choose a fallback after a timer: rejected because silence alone
  does not identify the desired provider, budget, or cancellation decision.
- Permit model changes through Task resume: rejected because a live attempt and
  a settled-chain continuation have different lifecycle and authorization needs.
- Abort the child and start a fresh one: rejected because it loses continuation
  context and risks repeating completed tool side effects.

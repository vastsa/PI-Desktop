# ADR: Steering waits for confirmed tool settlement

- Status: Accepted
- Date: 2026-11-06
- Supersedes: started-tool behavior in ADR active-turn-steering
- Issue: https://github.com/vastsa/PI-Desktop/issues/2131

## Context

An indefinitely running tool prevents accepted steering from reaching the model.
Continuing before a mutating operation stops can cause conflicting side effects.

## Decision

Accepted steering requests cancellation of local foreground Bash and read
operations owned by the current turn. The model receives the input only after
the operations settle; steering does not use Stop's bounded grace period.

Remote workspace calls cannot acknowledge remote settlement through their
existing abort path, so steering does not cancel them. Other started operations
settle normally.

## Consequences

A hung or unreachable Host may still require Stop.

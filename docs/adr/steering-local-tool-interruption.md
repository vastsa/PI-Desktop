# Steering waits for confirmed tool settlement

- Status: Accepted
- Date: 2026-11-06
- Supersedes: started-tool behavior in ADR active-turn-steering
- Issue: https://github.com/vastsa/PI-Desktop/issues/2131

## Decision

Accepted steering requests cancellation of local foreground Bash and read
operations owned by the current turn. The model receives the input only after
the operations settle; steering does not use Stop's bounded grace period.
Unstarted calls are skipped and their batch reservations are released.
TaskWait yields while delegates continue, and background commands are retained.

Remote workspace calls cannot acknowledge remote settlement through their
existing abort path, so steering does not cancel them. Other started operations
settle normally. A shell lifecycle failure, remote failure, or uncertain external
timeout does not prove settlement and waits for explicit Stop. The UI reports the
pending operation. Already completed work is not rolled back.

## Consequences

A hung or unreachable Host may still require Stop. Steering retains the same
turn, model, workspace and permissions, and never starts an independent turn.
The Host's existing cancellation and process ownership remain authoritative.

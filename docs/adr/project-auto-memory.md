# ADR: Unified project memory with opt-in agent writes

- Status: Accepted for implementation
- Date: 2026-09-23
- Amends: ADR 0234 and ADR 0249

## Context

Project memory is host-owned context shared across chats in a logical project.
Users need the agent to record durable preferences during conversation and need
a single place to review or delete them. Distinguishing entries by author would
create competing memory collections and different behavior for equivalent notes.
Turning off recording should stop new agent changes without discarding the
usefulness of existing notes. Concurrent editing still requires protection.

## Decision

Reuse the existing project/path and logical-group memory records as the only
body storage. There is no manual/automatic entry category, source label or
source-based write permission. Existing plain-text and structured records stay
readable, and existing memory APIs remain compatible. A local project-level
recording flag, off by default, controls agent additions, updates and deletions.

The agent reads and edits the same collection as the user. The Host resolves
scope from the launching session and validates the current binding, recording
permission, execution mode, capacity and entry preconditions. Agent updates
modify one entry and preserve unrelated notes. Editor Save validates ownership
and the complete previous snapshot before atomically replacing its draft.
Conflicts keep stored data intact and leave the draft available for recovery.
The existing 32 KiB rendered-memory limit applies without author-based limits.

Every user turn refreshes this collection and injects it once as untrusted
project context. Disabling recording removes the write tool and write guidance,
but existing notes remain usable until the user edits or deletes them. Deleting
a note cannot retract already-sent context or historical tool messages.
Refresh failures remain diagnosable, clear stale memory for that turn and do
not make ordinary chat unavailable. Stale, cancelled or disposed requests
cannot overwrite the next turn's state.

The editor has one list, one Save, and shared controls without source badges.
Cancel discards note drafts. The recording switch takes effect immediately and
is not reverted by Cancel. All entries follow existing project-memory sync
eligibility and conflict semantics, including agent-written notes. Recording
permission is a local opt-in and is not automatically enabled on another device.

The agent may record clearly expressed durable preferences or corrections,
including explicit remember/forget requests. Policy excludes secrets, one-off
task details and preferences inferred from untrusted tool output. No background
extraction model, scheduled provider call or file/index store is introduced.

## Alternatives

- Separate user and agent collections protect one author's notes from the other,
  but expose unnecessary categories and make the off switch ambiguous.
- Disable all recall along with recording: a valid total-memory switch, but not
  the recording-only control required here.
- File-based memory or background extraction add persistence, permission, cost
  and lifecycle surfaces outside the requested phase.

## Consequences

- Existing user notes remain available, and enabling recording allows the agent
  to update any relevant entry under the same CAS protection as other entries.
- Disabling recording never hides or excludes saved context from later turns.
- Configuration sync no longer distinguishes how an entry was written; existing
  project-memory eligibility determines what syncs. No new sync service is added.
- Legacy/group transitions, concurrent user and agent edits, disabled reads and
  writes, restart, project isolation and actual editor actions require tests.

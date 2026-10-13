# ADR: Bounded collaboration context

- Status: Proposed
- Date: 2026-10-12
- Related: ADR 0312, ADR 0279, ADR 0165

## Context

The session checklist survives in Host storage, but continuation and compaction
can leave the model without its current state. Delegate transcripts already
persist for review and resume, while the parent receives only final reports.
Selected evidence should be reusable without automatically replaying a child's
entire context or restoring removed peer messaging.

## Decision

Refresh the existing Host Todo snapshot before request budget checks, including
approved execution and in-run continuation. Keep a bounded `session_todos`
section independent of product, extension, and temporary recovery instructions.
Use the existing chronological system journal and compaction checkpoint to
record changes. Cleared lists retain a short empty-state revision; unavailable
snapshots replace an existing section with a notice. Both revoke stale items;
optional read failure does not prevent an otherwise valid model request.

Extend `TaskList` with an optional delegation id, literal search, message-id
cursor and bounded limit. Resolve only chains in the current session's existing
registry/transcript, using the same chain selection as resume. Return visible
assistant text and text tool results, with pagination and per-page/per-entry
limits. Exclude thinking, images, attachments, arbitrary arguments and system
rows. The parent can pass selected evidence in another ordinary `Task` brief.

## Consequences

- Rust keeps exclusive Todo/SQLite ownership; Node keeps execution ownership.
- No model/provider dependency, database migration, new tool, RPC, peer channel,
  renderer state or permission mechanism is added.
- No-argument TaskList remains compatible. Traces are requested evidence, not
  instructions or authorization; running results are partial and missing cursors
  require restarting pagination. Compaction does not delete the durable trace.
- Checklist reads add one local Host RPC per model turn. Text truncation bounds
  restoration cost; full checklist text remains available in the existing dock.
- Remote Todo parity and raw provider request/response recording remain separate.

## Verification

`runtime-collaboration-context.test.ts` covers the real model tool path, restart,
compaction, updates/clear, read failure, cancellation, mode preservation,
recovery prompts, search/paging and current-session isolation. Pure trace tests
cover output limits and literal search. `e2e-collaboration-context.mjs` runs the
candidate runtime and pi against loopback SSE and real Host persistence in
temporary HOME/data/workspace directories, including Host restart and clear.

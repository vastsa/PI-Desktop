# ADR: Shell workspace review evidence

- Status: Accepted
- Date: 2026-09-20
- Amends: [ADR 0043](0043-message-owned-review-snapshots-and-rollback.md)

## Context

A task can write files to scratch and copy them into the workspace through Bash
(or PowerShell under the Bash protocol name). Write/Edit-only review omits those
actual deliverables. Parsing shell command strings cannot reliably identify
mutations, and a final Git diff includes changes that preceded the task.

## Decision

Host-core captures bounded before/after evidence around an admitted Bash
execution. It observes regular files inside the authorized workspace using the
existing ignore policy, excludes scratch and host data roots, and does not
follow symlinks. File enumeration, retained bytes, and emitted diff evidence are
bounded. Unreadable, oversized or unvisited paths are unknown, not absent;
partial scans must never fabricate additions or deletions.

The host serializes its Bash, Write and Edit execution for the same canonical
workspace across sessions. The guard covers preparation, tool execution and
finalization, while different workspaces remain independent. External programs
can still mutate files during an interval; this is interval evidence rather
than an OS-level attribution audit. Rollback retains the existing post-hash
conflict guard.

Each changed file uses the existing version-1 ReviewChange and independent
snapshot identifier. A shell result adds `root: "workspace"`, `reviews: []`,
and `reviewCapture: { status: "complete" | "partial" | "unavailable" }` to its
structured details. These additive fields leave stdout, stderr, exit status,
error and cancellation semantics intact. Captured mutations survive a nonzero
exit, timeout or cancellation. Denied commands do not execute or create capture
evidence. A complete no-op has an empty array and renders no file summary.

The legacy singular `review` remains readable. Consumers select each record by
snapshot id; rollback updates only that record in its original tool message,
including records produced by a delegate and persisted in the parent session.
Turn summaries assign delegate evidence through each raw message's original
`parentToolCallId`; visual resume-chain merging does not transfer edits between
turns, and delayed delegates are never inferred from time or adjacency. Forking
marks inherited records non-reversible. Existing transcript JSON supports the
additive details without a database migration or protocol version change. Old
shell messages without evidence remain explicitly unavailable; later builds must
not invent historical before content from the current workspace.

## Consequences

- Scratch-to-workspace copy produces durable file records and a turn summary.
- Historical cards survive restart and Git commits independently of Git state.
- Same-workspace mutations trade parallel throughput for unambiguous host-owned
  capture intervals. Reads and operations on different workspaces stay independent.
- Large or ignored workspaces can yield partial evidence; coverage is explicit.
- The visual turn summary groups parent tools plus records owned by attached
  `Task` delegates and reports cumulative active edit counts, not a net
  durable-host-turn diff. Session Review includes the same original message and
  snapshot identities so file selection and rollback remain available.
- Bash-only records beneath an exact `.gradle` directory segment are omitted by
  frontend consumers as incidental build-cache evidence, including old session
  logs. A file named `.gradle`, explicit Write/Edit records, and unrelated binary
  files remain visible.
- Review remains host-owned. The renderer never scans files or writes rollback
  content directly.

## Validation

Cover added/modified/deleted files, pre-existing unchanged dirty files,
scratch-to-workspace copy, no-op commands, nonzero exits after writing,
interruption, bounds, ignored and sensitive files, link replacement, independent
rollback and conflicts. Verify same-workspace serialization across sessions,
legacy and array transcript state updates, fork compatibility and actual mounted
chat rendering with failed Write, scratch Write, Bash multi-file evidence and a
final answer.

# ADR: Append-only review state

- Status: Implemented candidate
- Date: 2026-10-28
- Related: Issue #1836, ADR 0043, ADR 0060, ADR 0127

## Context

Rolling back one historical tool card loaded the complete session and called
`replace_messages` to persist `details.review.state`. This rewrote the entire
transcript and rebuilt every SQLite message index row under the Host state lock.

## Decision

Append a distinct `tool_review_state` line keyed by message and snapshot IDs.
Keep the original message line and all message-window coordinates unchanged.

Cache reuse requires a matching file identity and modification/change-time
stamp. Only a Host-owned append from the proven generation advances an in-memory
prefix's generation without rescanning.

### Rewrite and archive folding

`truncate_from` first calls `get_session`. Its uncapped read reaches
`read_transcript_with_compactions` / `read_transcript_window`, where
`apply_tool_review_states` overlays the appended records before any cut is
chosen.

`fork_session_through` reads the effective records through `read_transcript`;
`activate_message_revision_with_prefix` combines the effective live prefix and
stored branch before `records_and_texts` serializes them. Coverage includes
`truncate_from_folds_review_state_into_the_retained_prefix` and
`tool_review_state_survives_fork_revision_activation_and_deletion`.

### Ordering

File order is the order of record. Review-state records have no timestamp;
`append_line` writes each complete line and syncs it before returning, while the
calling RPC holds the Host state lock.

`equal_length_state_appends_replay_in_file_order_across_cached_reads` uses JSON
whitespace to make valid `active` and `rolledBack` records exactly equal in
serialized length. Each append must still grow the file, add a distinct state
offset, and preserve last-write-wins state through warm and cold reads.

## Consequences

A review update writes only its IDs and state instead of retained history.

The line type is additive to transcript format 2 and requires no database or RPC
migration.

## Alternatives

- Calling `update_message` still copies all historical bytes for a non-tail
  message and therefore leaves the reported review trigger.
- Appending the whole tool message creates a new physical message position.
- A separate metadata file adds another authoritative storage and recovery
  lifecycle; the existing transcript append path already provides durability.

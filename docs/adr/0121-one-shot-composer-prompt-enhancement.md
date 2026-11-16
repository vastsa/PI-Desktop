# ADR 0121: Keep Composer prompt enhancement one-shot and main-owned

- Status: Superseded by ADR 0324
- Date: 2026-08-24
- Updated: 2026-10-08 (feature moved to an optional standalone plugin)
- Related: Issue #14, Issue #562

## Context

The Composer needs a convenient way to improve a draft without sending a
message, changing the conversation transcript, or exposing provider credentials
to the renderer.

## Decision

Prompt enhancement is an allowlisted renderer-to-Electron IPC operation. The
renderer sends the draft and a provider/model/thinking snapshot.

## Consequences

Superseded (Superseded by ADR 0324). The full record is in git history.

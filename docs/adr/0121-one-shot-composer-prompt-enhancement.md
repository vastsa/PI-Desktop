# ADR 0121: Keep Composer prompt enhancement one-shot and main-owned

- Status: Superseded by ADR 0324
- Date: 2026-08-24
- Related: Issue #14, Issue #562

## Context

The Composer needed to improve a draft without sending a message, changing the
transcript, or exposing provider credentials to the renderer.

## Decision

Enhancement was an allowlisted renderer-to-Main IPC operation that sent the draft
with a provider/model/thinking snapshot, and Main resolved credentials and asked
agent-runtime for one completion with no session history, tools, or transcript
side effect, using an overridable user template and a built-in system prompt.

## Consequences

Superseded by ADR 0324, which moved the feature to an optional standalone plugin,
so the typed IPC contract and its shared default templates no longer exist. Main
stayed the only owner of API keys and vendor OAuth resolution.

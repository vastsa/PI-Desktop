# ADR 0121: Keep Composer prompt enhancement one-shot and main-owned

- Status: Accepted
- Date: 2026-08-24
- Related: Issue #14

## Context

The Composer needs a convenient way to improve a draft without sending a
message, changing the conversation transcript, or exposing provider
credentials to the renderer. The feature also needs to honor the model shown
in the Composer while remaining safe when that selection changes during an
in-flight request.

## Decision

Prompt enhancement is an allowlisted renderer-to-Electron IPC operation. The
renderer sends the draft and a provider/model/thinking snapshot. Electron main
validates the draft, resolves the effective provider and credentials through
the existing runtime launch resolver, and calls agent-runtime directly for a
single completion. The completion receives only the static enhancement system
prompt and one `Draft:\n<draft>` user message; it has no session history, tools,
attachments, durable turn, or transcript side effect.

The renderer owns the interaction state: loading, one-level undo, dismissible
classified errors, and an edit-generation guard that discards late results.
The main process remains the only owner of API keys and vendor OAuth
resolution. Provider failures reuse the existing classification and bounded
setup retry behavior; whitespace-only output is a dedicated terminal error.

## Consequences

- Draft improvement is fast and reversible without creating hidden messages or
  agent runs.
- The provider/model snapshot makes the request deterministic relative to the
  visible selector, while main-side fallback keeps stale or incomplete
  snapshots safe.
- The renderer receives only text and classified error data, never secrets.
- The feature has a new typed IPC contract and must keep its UX and E2E
  scenarios synchronized with the runtime behavior.

## Alternatives considered

- Reuse `agent/prompt`: rejected because it persists a user turn, uses the
  conversation context, and starts normal agent lifecycle behavior.
- Run the provider call in the renderer: rejected because credentials and
  vendor OAuth bindings are main-owned security material.
- Store enhancement history: rejected for v1; one exact undo snapshot is
  sufficient and avoids adding persistence ownership.

# ADR response-annotations: Response Annotations as Prompt Attachments
> Superseded by ADR 0268.

- Status: Superseded by ADR 0268
- Date: 2026-09-11
- Amends: D-LOCAL-message-quotes decision 3 (for assistant turns)
- Preserves: D209, D301, D097, D128
- Related: ADR message-quotes-and-side-chats, E2E-CHAT-annotation-attachments,
  E2E-CHAT-annotation-session-state · Amendment: 2026-09-12 (comment editor)

## Context

Quoting as a draft edit copied the model's words into the draft the user was
writing, so "refer to this pass" became indistinguishable from "write this text
myself" and several references collapsed into one unaddressable block.

## Decision

Selecting text in an assistant turn attached a numbered annotation instead of
editing the draft: annotations were renderer-owned session state in capture
order, each with its own comment, sent as a `<response-annotations>` block
ahead of the user's request while the visible draft stayed the user's own words.
The answer body was never decorated by the app — only a model-written
`:codex-annotation{index="N"}` citation rendered as a marker — and a later
amendment replaced the silent attach with a comment editor and an annotation
list disclosure in the composer. No host protocol, storage schema, IPC channel,
or permission changed.

## Consequences

- The model received each annotated pass as a numbered data item while the
  user's prompt stayed exactly what the user typed.
- Annotations were lost on relaunch and after the send that carried them.
- The draft quote from D-LOCAL-message-quotes survived for user messages and
  side-chat handoff.

Superseded by [ADR 0268](0268-remove-quotes-annotations-and-side-chats.md).

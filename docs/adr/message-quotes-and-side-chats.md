# ADR message-quotes-and-side-chats: Message Quotes and Renderer-Owned Side Chats

- Status: Superseded by ADR 0268
- Date: 2026-09-11
- Amends: D209, D301
- Preserves: D097, D128, D134, D154
- Related: [04-ux/09-interaction-patterns.md](../spec/04-ux/09-interaction-patterns.md)

## Context

Long conversations carry earlier prompts and answers the user wants to reuse, and
the only shipped paths were copying by hand or re-pasting into the composer. The
existing `session.fork` (ADR 0023, D134) already produced an independent durable
child, but every dialog that used it activated the child, which is wrong for a
side question because the fork replaces the visible main conversation.

## Decision

Every user message and assistant turn gained a Quote action that prefilled a
Markdown blockquote into the active session's composer draft under the existing
composer-prefill contract, and an Open side chat action that kept a renderer-owned
draft tab until the first Send forked a durable child without activating it. The
feature reused `session.fork`, the existing prompt and abort paths, and the
work-panel surface, with quoted text staying plain draft text under D209's smart
Stop and D301's per-session draft retention.

## Consequences

- Quote prefill, the selection overlay, and the side-chat panel were removed with
  this record, so the composer again offers no quote entry point.
- A child created by a side chat is an ordinary durable session and remains listed,
  searchable, and openable like any other.
- The `session.fork` capability the panel routed to survives and is used by the
  Fork action.

## Superseded by

[ADR 0268](0268-remove-quotes-annotations-and-side-chats.md) removed quotes,
annotations, and side chats.

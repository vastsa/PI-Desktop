# ADR message-quotes-and-side-chats: Message Quotes and Renderer-Owned Side Chats
> Superseded by ADR 0268.

- Status: Superseded by ADR 0268
- Date: 2026-09-11
- Deciders: PI-Desktop runtime and desktop UI maintainers
- Amends: D209, D301
- Preserves: D097, D128, D134, D154
- Related: [04-ux/08-component-spec.md](../spec/04-ux/08-component-spec.md) ·
  [04-ux/09-interaction-patterns.md](../spec/04-ux/09-interaction-patterns.md) ·
  [04-ux/01-ui-ia.md](../spec/04-ux/01-ui-ia.md) ·
  [06-delivery/04-e2e-test-plan.md](../spec/06-delivery/04-e2e-test-plan.md) ·
  E2E-CHAT-quote-prefill, E2E-CHAT-side-chat-fork, E2E-CHAT-side-chat-stream, E2E-CHAT-side-chat-add-to-main, E2E-CHAT-side-chat-promote, E2E-CHAT-side-chat-close ·
  Amendment: D-LOCAL-selection-overlay, E2E-CHAT-selection-markdown

## Context

A long conversation carries earlier prompts and answers the user wants to reuse.

## Decision

1. Every user message and every assistant turn gains a **Quote** action in its
   hover action row, beside Copy, Edit, Delete, Fork, and Retry.

## Consequences

Superseded (Superseded by ADR 0268). The full record is in git history.

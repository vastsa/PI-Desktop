# ADR response-annotations: Response Annotations as Prompt Attachments
> Superseded by ADR 0268.

- Status: Superseded by ADR 0268
- Date: 2026-09-11
- Deciders: PI-Desktop runtime and desktop UI maintainers
- Amends: D-LOCAL-message-quotes decision 3 (for assistant turns)
- Preserves: D209, D301, D097, D128
- Related: [04-ux/08-component-spec.md](../spec/04-ux/08-component-spec.md) ·
  [04-ux/09-interaction-patterns.md](../spec/04-ux/09-interaction-patterns.md) ·
  [03-runtime/11-provider-model-system.md](../spec/03-runtime/11-provider-model-system.md) ·
  ADR message-quotes-and-side-chats · E2E-CHAT-annotation-attachments, E2E-CHAT-annotation-session-state · Amendment: 2026-09-12 (comment editor)

## Context

ADR message-quotes-and-side-chats (D-LOCAL-message-quotes) made quoting a
**draft edit**: the excerpt becomes `> `-prefixed Markdown text inside the
composer, attributed with `chat.quoteSource`.

```text
# Response annotations:
Each item contains text selected from an earlier Codex response and may include a user comment. …
<response-annotations>
[{"text":"…","annotation":"…","source":{…}}]
</response-annotations>

## My request:
…the user's own prompt…
```

## Decision

1. Selecting text inside an **assistant turn** and activating the selection
   overlay's **Add to chat** creates one annotation instead of editing the
   draft. An annotation carries an id, the anchored turn (`messageId`), the
   excerpt (Markdown, capped at 2000 characters with a trailing ellipsis), an
   empty `annotation` comment field, and a creation time.

## Consequences

Superseded (Superseded by ADR 0268). The full record is in git history.

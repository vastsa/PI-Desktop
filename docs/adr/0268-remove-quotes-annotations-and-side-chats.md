# ADR 0268: Remove quotes, annotations, and side chats

- Status: Accepted
- Date: 2026-09-16
- Deciders: PI-Desktop runtime and desktop UI maintainers
- Supersedes: ADR message-quotes-and-side-chats, ADR response-annotations, ADR floating-annotation-index
- Amends: ADR 0254 (its "Amendment: native side-chat forks", 2026-09-14)
- Preserves: D097, D128, D134, D209, D254, D261, D301
- Related: [04-ux/08-component-spec.md](../spec/04-ux/08-component-spec.md) ·
  [04-ux/09-interaction-patterns.md](../spec/04-ux/09-interaction-patterns.md) ·
  [06-delivery/04-e2e-test-plan.md](../spec/06-delivery/04-e2e-test-plan.md)

## Context

Three renderer-owned surfaces grew around the transcript and the composer. ADR
message-quotes-and-side-chats added a **Quote** action to the message action
row, a selected-text overlay, and renderer-owned side chats docked in the work
panel. ADR response-annotations turned Add to chat on an assistant turn into a
numbered annotation attachment carried to the model in a generated
`# Response annotations:` prompt block, and ADR floating-annotation-index added
the floating index, source badges and highlights, and the comment editor. ADR
0254's native side-chat fork amendment made those panels work for `native-pi:`
sessions.

Together they are more surface than the product uses. The overlay and the action
row both had to recover an excerpt from the rendered DOM; annotations added a
second prompt serialization that every display surface (transcript, edit seed,
queue preview) has to reverse; and a side chat is a second session lifecycle
whose only durable artifact — the forked child — `session.fork` already
produces. Copy, edit, fork, and retry cover the rest.

## Decision

1. **Message action row.** Remove **Quote**, **Annotate**, and **Open/Ask in
   side chat** from the hover action row of user messages and assistant turns.
   Copy, Edit and Delete (user messages), Fork, and Retry/Regenerate stay
   unchanged in place, behavior, labels, and shortcuts.
2. **Selection overlay.** Remove the selected-text toolbar entirely: selecting
   text in the transcript no longer floats an action strip. Delete
   `lib/selection-quote.ts`, `lib/chat-quotes.ts`, the `SelectionQuoteButton`
   component and its styles. The composer keeps no quote-prefill path:
   `appendComposerDraftText` and `quoteMessageIntoComposer` and their store
   action go away.
3. **Annotations.** Remove annotations as a feature: the comment editor, the
   floating annotation index, the answer source badges and highlights, the
   composer annotation attachment chip, the annotation store slice, and the
   annotation anchor modules are deleted. A `:codex-annotation{index="N"}`
   directive in an answer is no longer recognized; it renders as the ordinary
   Markdown text it is.
4. **Prompt assembly.** The send path no longer composes a
   `# Response annotations:` block: `api.prompt` and `enqueuePrompt` use the
   user's text as written, with no generated heading, instruction sentence, or
   `<response-annotations>` payload. The display-layer reduction
   `requestTextWithoutAnnotations` is deleted with it, so an older stored prompt
   that already contains the generated block is shown verbatim in the
   transcript, in edit seeds, and in queue previews instead of being reduced
   back to the request.
5. **Side chats.** Remove side chats as a feature: the first-Send draft
   lifecycle that created the child session, the renderer transcript projection
   (`projectSideChatEvent`), the `sidechat:` work-panel tab type and its
   `SideChatTab`, the registration / release / cascade-cleanup rules, and the
   availability blocked-reason reporting are all deleted. `session.fork` stays
   as a capability and the Fork action stays as its only entry point.
6. **Retired identifiers (retired; must never be reused).** Decision IDs
   `D-LOCAL-message-quotes`, `D-LOCAL-selection-overlay`,
   `D-LOCAL-response-annotations`, `D-native-sidechat-stream`, and E2E IDs
   `E2E-CHAT-quote-prefill`, `E2E-CHAT-selection-markdown`,
   `E2E-CHAT-selection-side-chat`, `E2E-CHAT-annotation-attachments`,
   `E2E-CHAT-annotation-session-state`, `E2E-CHAT-annotation-source-index`,
   `E2E-CHAT-annotation-ack-and-steering`, `E2E-CHAT-side-chat-fork`,
   `E2E-CHAT-side-chat-stream`, `E2E-CHAT-side-chat-add-to-main`,
   `E2E-CHAT-side-chat-promote`, `E2E-CHAT-side-chat-close`, and
   `E2E-SESSION-native-side-chat-fork-survives-close` are retired and must
   never be reused for another scenario. The superseded ADR files stay on disk
   as history.
7. **Boundaries.** The host protocol stays v11 and the storage schema stays
   v15: no new IPC channel, no new permission, no protocol or schema bump, and
   no Rust change. `session.fork`, the transcript, the work panel, and the rest
   of the composer keep their existing contracts.

## Preserved behavior

- **D134 / `session.fork`.** Fork still resolves a durable child from an anchor
  message and still activates it, including the `native-pi:` route of ADR 0254;
  ADR 0023 is unchanged. Side chats were a consumer of it, not a part of it.
- **D209 / D301.** Smart Stop still restores the unanswered send's draft, and
  per-session draft slots are untouched. With no prefill and no annotation
  snapshot beside the draft, both paths simply have less to carry.
- **D097 / D128 / D254 / D261.** The work panel keeps role, sizing, identity
  keying, neighbor-close, and per-session switching; losing the `sidechat:` tab
  type removes one resource kind, not the model. Transcript reading ownership
  and the bounded expansion history window are unchanged.
- **The rest of the action row.** Copy, Edit, Delete, Retry/Regenerate, and
  Fork keep their current behavior, tooltips, and accessible names.
- **Child sessions already created.** A session forked earlier from a side chat
  stays an ordinary session in the sidebar, lists, search, and stored history.

## Consequences

- A user loses the shortcut of reusing an earlier prompt or answer inside the
  composer, and loses the panel for asking a side question beside the main
  conversation; reassembling either means copying text or forking a session and
  switching to it.
- A stored prompt written while annotations were enabled can show the generated
  `# Response annotations:` heading and payload as plain text, because every
  display surface now renders the stored string unchanged.
- The renderer sheds roughly 2000 lines — the overlay, quote recovery,
  annotation editor, index, badges, and the whole side-chat lifecycle — plus
  eleven unit-test files and their E2E scenarios.
- Nothing moves across a process boundary: protocol v11, schema v15, the IPC
  surface, the permission set, and the Rust host are untouched.

## Alternatives considered

### Hide the entry points and keep the code

Rejected: dead branches would still own store slices, i18n keys, CSS, and the
generated-block parser, and every later change to the action row or the send
path would have to keep them compiling for nobody.

### Keep a display-layer compatibility downgrade

Rejected: keeping `requestTextWithoutAnnotations` and the directive parser alive
only to prettify old prompts would preserve exactly the second serialization
this ADR removes, and a stored prompt that is not sent is harmless as text.
Old transcripts are readable without it.

### Remove annotations and side chats, keep quotes and the selection overlay

Rejected: the overlay, the quote recovery path, and the composer prefill are the
largest single block of renderer-only code here, and quoting a whole message or
a sentence has an exact substitute in the OS clipboard and the composer.

### Turn side chats into an ordinary child-session tab instead of deleting them

Rejected: that is Fork plus the existing session list; a new docked tab kind
would keep the registration, projection, and cleanup lifecycle while adding a
fourth way to reach the same durable child.

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

ADR message-quotes-and-side-chats (D-LOCAL-message-quotes) made quoting a **draft edit**: the excerpt becomes `> `-prefixed
Markdown text inside the composer, attributed with `chat.quoteSource`. That is
simple and visible, but it copies the model's words into the draft the user is
writing, and it makes "refer to this pass" indistinguishable from "write this
text myself". Reusing several passes mixes excerpts and instructions in one
editable buffer, and a long answer can be quoted only as one block.

The reference implementation (ChatGPT desktop app) solves the same problem with
**annotations**. Selecting text in a response and choosing "Add to chat" attaches
a numbered annotation to that response: the annotated pass gains an inline
numbered marker, the composer shows one annotation attachment, and the next
prompt carries the excerpts in a structured block:

```text
# Response annotations:
Each item contains text selected from an earlier Codex response and may include a user comment. …
<response-annotations>
[{"text":"…","annotation":"…","source":{…}}]
</response-annotations>

## My request:
…the user's own prompt…
```

The user's own words stay the user's own words; the excerpts travel with the
prompt as data, numbered so the model can address `Annotation 1`,
`Annotation 2`, and so on.

## Decision

1. Selecting text inside an **assistant turn** and activating the selection
   overlay's **Add to chat** creates one annotation instead of editing the draft.
   An annotation carries an id, the anchored turn (`messageId`), the excerpt
   (Markdown, capped at 2000 characters with a trailing ellipsis), an empty
   `annotation` comment field, and a creation time.
2. Annotations are **renderer-owned session state**, keyed by session id, in
   capture order. Array order is the numbering: the first annotation is
   `Annotation 1`. Re-annotating an excerpt that is already attached is a no-op,
   so no excerpt is sent twice under two numbers. Annotations are not persisted,
   not sent to the host on their own, and do not survive relaunch.
3. Rendering:
   - The answer body is **never decorated by this app**. An annotation shows up in
     the model's answer only where the model cites it, exactly as in the
     reference: a `:codex-annotation{index="N"}` directive in the answer's source
     becomes a small accent-colored numbered reference (a remark pass turns the
     token into a marker element; the sanitizer keeps the marker scheme on its
     href), whose tooltip is the annotated excerpt and any comment. A marker is
     a reference, not text the user picked: it takes no part in a selection, a
     quote, or a copy, and it never breaks the line it sits in.
   - The composer shows one annotation attachment chip above the input with the
     count (`chat.annotationChip`) whose tooltip lists `N. excerpt` per
     annotation, plus one control that drops them all
     (`chat.clearAnnotations`). The chip is not a draft chip: it never enters the
     editable text, so D209's smart Stop and D301's per-session draft retention
     are untouched. It is also the only place the user's own annotations are
     visible before the model answers.
4. Sending a prompt while annotations exist composes the prompt as the reference
   does: the `# Response annotations:` heading, the instruction sentence, the
   `<response-annotations>` block with `[{"text", "annotation", "source": {"messageId"}}]`
   in numbering order, then `## My request:` and the user's text. The send
   consumes the annotations. The visible draft, the optimistic row, the sidebar
   title, and the composer's edit seed never contain the block; a stored prompt
   that carries one is displayed through `requestTextWithoutAnnotations`, which
   reduces it back to the request.
5. The instruction sentence is the reference's own text, including its
   requirement that the model cite every annotation it addresses with
   `:codex-annotation{index="N"}`; that directive is what renders as the numbered
   reference in decision 3. An app that decorates the answer itself would put
   markers where the model never claimed to answer them, which is also what made
   the first implementation unreadable.
6. Routing stays explicit per surface: the overlay's **Add to chat** annotates an
   assistant turn and keeps D-LOCAL-message-quotes's draft quote for any other row; the assistant
   turn's action row annotates (its selection when there is one, the whole answer
   otherwise); a user message's action row and the side chat's **Add to main
   chat** keep quoting into the draft.
7. i18n keys introduced: `chat.annotate`, `chat.annotationMarker`,
   `chat.annotationChip`, `chat.clearAnnotations`. The overlay's other actions
   (`chat.addToChat`, `chat.askInSideChat`, `chat.copy`) are unchanged.
8. Boundaries: no host protocol bump (v11), no storage schema change (v15), no
   new IPC channel, and no new permission. Annotations are a renderer-side
   projection of the reference contract; the prompt that reaches the model is
   ordinary prompt text.

## Preserved behavior

- D-LOCAL-message-quotes's draft quote is preserved where it is the right model: quoting a **user**
  message, and moving a side chat's newest answer into the main composer. Its
  contract (`> ` blockquote, `chat.quoteSource` attribution, 2000-character cap,
  append-to-draft, focus, no send) is unchanged.
- D209's smart Stop restores the pre-send draft, and D301's per-session draft
  slots are unchanged: annotations are session state beside the draft, so neither
  path has to learn about them.
- The selection overlay's geometry, bounds, follow-on-scroll behavior, actions,
  and read-only-projection exclusion are unchanged (ADR message-quotes-and-side-chats amendment).

## Consequences

- The model receives each annotated pass as a numbered data item, so "address
  annotation 2" is unambiguous, and the user's prompt stays exactly what the user
  typed.
- A user can annotate several passes of one answer, from any turn in the session,
  and then write one instruction that covers them; the composer shows one
  attachment instead of a growing block of quoted text.
- Annotations are lost on relaunch and after the send that carries them; a user
  who wants a durable record can still quote into the draft or copy the pass.
- A stored prompt is longer than what the user typed (the block is part of it),
  which is why every display surface reduces it back to the request first.

## Alternatives considered

- **Keep writing excerpts into the draft (D-LOCAL-message-quotes):** rejected for assistant turns.
  It mixes the model's words into the user's own prompt text, and several
  references become one long editable block with no numbering the model can
  address.
- **Annotate through the host (new RPC or message field):** rejected. The prompt
  block is ordinary prompt text, so no protocol, schema, or permission change is
  needed, and the annotations only have to live as long as the send.
- **Mark the annotated pass inside the answer:** rejected. It would decorate text
  the model has not answered yet, it needs the annotated range to survive every
  re-render (React owns the transcript tree), and a marker placed by excerpt
  lookup lands mid-word whenever the selection ended mid-word — the first
  implementation shipped exactly that damage. The model's own citation is the
  reference's marker.
- **Store the annotations with the message for a persistent list:** rejected for
  now. It would need a storage-schema change and a durable annotation surface;
  the send-scoped attachment matches the reference behavior.

## Amendment (2026-09-12) — the attachment opens a comment editor

The reference attaches an excerpt through a comment entry, not a silent action:
selecting text in a response and choosing Comment opens a compact editor over the
selection with the quote in place. This amendment replaces decision 1's "attaches
with an empty `annotation` field" reading and decision 2's silent duplicate no-op
with that editor; the annotation shape, the prompt block, and every boundary of
decision 8 are unchanged.

- **Add to chat** on an assistant turn, and the turn's annotate action, open the
  comment editor instead of attaching the excerpt immediately. The editor shows
  the excerpt snapshot — the Markdown serialized when the selection was taken,
  before focus moves into the editor and collapses the selection — above a
  multiline, optional comment. **Save** attaches the annotation (or updates the
  one being edited) with `annotation` set to the comment with surrounding
  whitespace trimmed; **Cancel**, **Escape** outside IME composition, and a press
  starting on the backdrop discard it. Dragging selected text onto the backdrop
  does not dismiss it. Escape is consumed before application shortcuts; closing
  restores focus to the trigger or the rich composer if the trigger is gone.
  A save with an empty comment still attaches, so Add to chat keeps working
  as a plain reference. Opening or saving the editor sends nothing: no prompt, no
  session, no transcript row.
- Re-annotating an excerpt that is already attached reopens **that annotation's**
  editor with its stored comment instead of the old silent no-op, so decision 2's
  one-annotation-per-excerpt rule holds while the comment stays editable. Editing
  keeps the annotation's id, position, and excerpt: only `annotation` changes.
- The composer's attachment (decision 3) is now a disclosure. Its count chip is a
  button that opens the session's annotation list: each item shows its number,
  its excerpt, and its comment, with one control to edit it (the same editor,
  seeded with the stored comment) and one to remove just that item; the existing
  control still drops all of them (`chat.clearAnnotations`). The chip's tooltip
  still lists `N. excerpt`, and the list is not draft text.
- The editor belongs to the session it was opened in: a session switch closes it
  rather than carrying a half-written comment into another conversation, and a
  save whose annotation was already sent or removed changes nothing and never
  recreates it.
- i18n keys added: `chat.annotationCommentTitle`,
  `chat.annotationCommentPlaceholder`, `chat.annotationEdit`,
  `chat.annotationRemove`, `chat.annotationReview`. The store actions are
  `openResponseAnnotationEditor`, `saveResponseAnnotationEditor`, and
  `closeResponseAnnotationEditor`, replacing `addResponseAnnotation`.
- Boundaries of decision 8 stand: no host protocol bump, no storage schema
  change, no new IPC channel, no new permission. The comment is ordinary
  `annotation` field content in the existing prompt block.

## Upstream integration amendment (2026-09-14)

The renderer keeps upstream Composer submit/steering hooks and store slices.
Ordinary send/queue snapshots this session's annotation objects and consumes only
unchanged submitted objects after host acknowledgement. Rejection retains them;
concurrent additions and comment edits survive. The internal `enqueuePrompt`
action returns `Promise<boolean>` so the existing composer rejection restoration
also covers queue failures and unexpected pre-host exceptions without replacing
newer input. A per-session in-flight
submission guard rejects duplicate submissions until acknowledgement settles,
including the draft-to-created-session handoff. It does not block other sessions
or steering and always releases on exit. No host API changes.

Upstream Alt+Enter and the steer button remain text-only: annotations wait for the
next ordinary send. Annotation-only steering does nothing. Shift+Enter remains
newline, and the comment editor's Enter/IME semantics remain independent.
Queue previews and edit seeds hide the recognized generated block without changing
stored/wire content. Editing does not rebuild previously consumed attachments;
ordinary retry reuses the stored prompt. See E2E-CHAT-annotation-ack-and-steering.

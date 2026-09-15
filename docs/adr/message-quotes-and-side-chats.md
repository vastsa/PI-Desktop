# ADR message-quotes-and-side-chats: Message Quotes and Renderer-Owned Side Chats

- Status: Accepted
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
Copying them by hand or re-pasting into the composer is the only shipped path,
and re-reading an answer to paraphrase it loses the exact wording the next turn
should reference.

The existing `session.fork` (ADR 0023, D134) already produces an independent
durable child from an anchor message, but every dialog that uses it activates
the child. That is correct for a divergence the user wants to continue, and
wrong for a side question: the fork replaces the visible main conversation, the
main transcript leaves the screen, and coming back costs a session switch.

## Decision

1. Every user message and every assistant turn gains a **Quote** action in its
   hover action row, beside Copy, Edit, Delete, Fork, and Retry.
2. Quote inserts a Markdown blockquote of the message into the composer draft
   of the active session through the existing composer-prefill contract and then
   focuses the composer. It never sends a prompt, never creates a session, and
   writes nothing to the transcript. The excerpt is the live text selection when
   that selection is inside the clicked message row, otherwise the message's own
   text (for an assistant turn, its answer text).
3. Quote text is `> ` per excerpt line, one blank line, then the attribution
   line rendered from `chat.quoteSource` ("Quoted from {{title}}"; Chinese
   "引用自 {{title}}"), where the title is the source session's title. The
   excerpt is capped at 2000 characters with a trailing ellipsis. The quote is
   ordinary draft text: D209's smart Stop still restores an unanswered send and
   D301's per-session draft retention is unchanged. Quoting adds no composer
   chip kind and no file reference.
4. **Open side chat** is offered on an assistant turn (fork anchored at that
   assistant message) and on a user message (fork anchored at that user
   message), with the tooltip and accessible name `chat.startSideChat`. It calls
   the existing `session.fork` with the anchor and does **not** activate the
   child: the main conversation keeps its visible session. The child is durable
   on the host exactly as an ordinary branch and keeps appearing in session
   lists and search.
5. The child is registered as a side chat of the parent session in
   renderer-owned state, and the work panel opens a new `sidechat` resource tab
   bound to the child session id (`id: sidechat:<childSessionId>`). The tab
   reuses the existing docked panel, its width clamp, resize, and
   native-reservation lifecycle, its header switcher, and D128's per-session
   panel-context switch rule.
6. While a side chat is registered, the child's agent events are projected into
   a renderer-owned per-session transcript map from the same event stream the
   active transcript consumes (message and tool start / update / end), reusing
   the existing background-transcript reducer. The panel therefore streams live
   even though the child is never the app's active session.
7. Panel content: a compact header with the side-chat title, "Add to main chat"
   (`sideChat.addToMain`), "Open as a conversation" (`sideChat.openAsSession`),
   and the shared tab-close control; the child's transcript rendered with the
   existing transcript component; the existing permission card and ask card when
   the child requests approval or asks a question (both already resolve by the
   request's own session id), so a child that needs an answer never stalls behind
   an invisible prompt;
   and a compact input (placeholder `sideChat.placeholder`, empty-state line
   `sideChat.empty`) with Send and Stop, where Send targets the child session
   through the existing prompt path and Stop aborts that child session. The tab
   label reuses `sideChat.title`.
8. "Add to main chat" copies the side chat's newest assistant answer into the
   main conversation's composer as a quote of that answer, under the same quote
   contract and 2000-character cap as item 3, attributed to the side chat's
   title. It never sends automatically.
9. "Open as a conversation" activates the child through the normal
   session-selection path, so the full composer, prompt queue, and stop controls
   apply, and releases the side-chat registration and its tab.
10. Closing the tab removes the registration and its transcript projection. The
    child session is not deleted and remains an ordinary session in the sidebar,
    session lists, and search.
11. Side-chat entries are removed when the tab closes, when the child is opened
    as a conversation, and when the parent or child session is deleted.
12. Boundaries: no host protocol bump (v11), no storage-schema change (v15), no
    new IPC channel, and no new permission. The feature reuses `session.fork`,
    the existing prompt and abort paths, and the existing work-panel surface.
    Side chats are renderer-owned and are not persisted across app restarts; the
    durable child session is.
13. i18n keys introduced: `chat.quote`, `chat.quoteSource`,
    `chat.startSideChat`, `sideChat.title`, `sideChat.sessionTitle`,
    `sideChat.placeholder`, `sideChat.empty`, `sideChat.addToMain`,
    `sideChat.openAsSession`. Send reuses `chat.send` and Stop reuses
    `chat.stopGenerating`.

## Preserved behavior

- D097 / D128 / D154 work-panel ownership is unchanged: the panel is still a
  docked, resizable, renderer-owned surface whose resources are opened by their
  trigger, keyed by identity, closed with right-then-left neighbor selection,
  and switched atomically per session. A `sidechat` tab is one more resource in
  that model, not a second panel.
- D209 and D301 are amended only by extension: quoted text is plain draft text,
  so chips keep their canonical-path serialization, smart Stop keeps its
  pre-serialization undo snapshot, and per-session draft slots are unchanged.
  The quote prefill adds one draft source and changes none of those rules.
- D134's fork/edit toolbar behavior is preserved for assistant turns: Fork,
  Edit, and Regenerate still use the same durable anchor and still activate
  their child.
- The child session is an ordinary session for storage, listing, title, search,
  deletion, and remote-control purposes; no side-chat flag is persisted.

## Consequences

- A user can reuse an exact earlier prompt or answer in the next turn without
  leaving the composer, and the quoted text is visible and editable before it is
  sent.
- A side question streams beside the main conversation instead of replacing it;
  the visible session, its transcript, its scroll position, and its retained
  panel context stay where they were.
- The panel loses nothing when the side chat closes: only the renderer-owned
  projection and registration go away, because the child is a durable session.
- Side chats do not survive an app restart as panel state, so a user who wants
  to keep working with the child opens it from the sidebar as an ordinary
  conversation.
- The 2000-character cap bounds how much of a quote can reach the composer and,
  after a send, the prompt context.

## Alternatives considered

- **A new composer chip kind or file reference for quotes:** rejected. A chip
  would need a new serialization kind beside D209/D362 sentinel references for
  no user-visible gain, while plain blockquote text already survives draft
  retention and smart Stop unchanged.
- **Reuse fork-and-activate for side chat:** rejected; that is exactly "Open as
  a conversation". Activating a fork to ask a side question would replace the
  visible main conversation, which is the behavior this feature exists to avoid.
- **Host-owned side-chat storage and RPC:** rejected. A durable child plus a
  temporary renderer-side projection needs no protocol, schema, or permission
  change.
- **Poll `session.get` for the panel's content:** rejected. The existing agent
  event stream already carries message and tool lifecycle, and the
  background-transcript reducer already turns it into rows.
- **Auto-send after "Add to main chat":** rejected. The main composer stays a
  reviewable draft; only the user sends it.
- **Keep the quote action at the end of the message only:** rejected in D-LOCAL-selection-overlay.
  The action row is the right home for quoting a whole message, but quoting a
  sentence, a formula, or a table means reaching the end of the very message the
  user is still reading.

## Amendment (D-LOCAL-selection-overlay, 2026-09-11) — the quote affordance follows the selection

Geometry and behavior follow the ChatGPT desktop app's selected-text overlay; the
excerpt and the side-chat target stay PI-Desktop's own contracts (D-LOCAL-message-quotes).

- Decision 1 stands: every user message and every assistant turn keeps its Quote
  action for the whole message. A non-empty text selection inside a transcript
  row additionally floats **one** overlay above it.
- Placement: the overlay is horizontally centered on the selection's visible
  rect, sits `SELECTION_QUOTE_GAP` (8 px) above that rect, and is clamped into
  its **bounds** on both axes with `SELECTION_QUOTE_MARGIN` (8 px) of slack. The
  bounds are the intersection of every clipping ancestor's rect (the transcript
  scroller is one) with the viewport, capped by the top of the docked composer —
  which floats over the transcript, so the scroller's own bottom edge is not the
  visible bottom. `Composer` publishes the `data-composer-dock` hook for that cap
  instead of the overlay guessing a class name. The overlay is portaled to
  `document.body` and lives in the body-portaled popover layer, so it never
  participates in the transcript's layout or scroll extent.
- The selection has to live in **one** row: a drag that crosses rows raises no
  overlay, and a range whose ends leave the row is clamped back to that row's
  contents before it is quoted.
- While the thread scrolls the overlay **recomputes and follows** the selection
  (it does not hide); a scroll of something unrelated to the selection leaves it
  alone. It also recomputes on selection change, double click, key up, pointer
  up, pointer cancel, and resize, at most once per animation frame, and it hides
  when a press lands outside it or when the selection collapses.
- Actions, in the reference overlay's order: **Add to chat**
  (`chat.addToChat`) writes the excerpt into the active session's composer draft
  through D-LOCAL-message-quotes decision 3's contract and focuses the composer via the existing
  prefill path; **Ask in side chat** (`chat.askInSideChat`) opens the side chat
  anchored at that row (`session.fork` through D-LOCAL-message-quotes decision 4) and sends the
  excerpt as that child's prompt, so the question is answered beside the
  conversation instead of inside it; **Copy** reuses `chat.copy` and writes the
  Markdown to the clipboard. The side-chat action is disabled while the visible
  session is running, because the host refuses a fork mid-turn. Every action
  clears the native selection first, so the overlay does not outlive its own
  click. The overlay is not rendered in a read-only projection (D-LOCAL-message-quotes decision
  12's rule extends to it).
- Decision 3's excerpt is still recovered from the rendered DOM rather than from
  `Selection.toString()`. A range that touches a formula is expanded to the whole
  formula and quoted from KaTeX's `application/x-tex` annotation as `$…$`
  (inline) or `$$…$$` (display); a code block becomes a fence whose delimiter
  outgrows the longest backtick run inside it and keeps its language; inline code
  keeps its backticks; a table row becomes one `a | b` line; task checkboxes
  become `[x] `/`[ ] `; transcript chrome (action rows, copy buttons) is dropped
  while a file-reference chip keeps its code text. The row action and the overlay
  call that one recovery path, so they cannot drift.
- Two deliberate deviations from the reference implementation, both because the
  quote lands in a **Markdown draft** PI-Desktop renders back: formulas use
  `$…$` / `$$…$$` (this renderer parses remark-math, not `\(…\)`), and table
  rows use `a | b` (Markdown) rather than tab-separated text. The reference's
  numbered `annotation` model is not adopted: D-LOCAL-message-quotes decision 3 keeps the excerpt
  as ordinary, visible, editable draft text.
- The 2000-character cap, the `> ` blockquote, the `chat.quoteSource`
  attribution, the append-to-draft behavior, focus, and the no-send/no-session/
  no-transcript-write boundaries are unchanged. i18n keys introduced:
  `chat.addToChat`, `chat.askInSideChat` (Copy reuses `chat.copy`).
- Boundaries remain those of D-LOCAL-message-quotes decision 12: no host protocol bump, no storage
  schema change, no new IPC channel, no new permission. The overlay is
  renderer-only and holds no durable state beyond the existing composer draft.
- Covered by E2E-CHAT-quote-prefill (overlay placement, follow, and actions), E2E-CHAT-selection-markdown (formula,
  table, code, and inline-code recovery), and E2E-CHAT-selection-side-chat (ask in side chat).

## Upstream integration amendment (2026-09-14)

Side-chat registrations use the upstream work-panel tab strip and launcher.
Closing the final tab leaves the launcher open; closing a side chat removes only
its registration/projection, never its durable child or unrelated tabs. The
shared upstream delta-aware transcript reducer also feeds docked children.
Registered transcripts persist across tab switches; compact draft and scroll
state are component-local and may reset on remount. No restart persistence or
native-session unification is introduced.

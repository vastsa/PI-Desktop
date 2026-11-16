# ADR 0137: Retained Session Panes

- Status: Accepted
- Date: 2026-08-30
- Related: ADR 0120, ADR 0127, ADR 0130, D142, D162, D261, D317, D324
- Amends: D162 (the dimmed keep-alive frame), ADR 0130 clause 4 and clause 5
  (per-session window reset and first-commit hydration), D162's
  "activation resets manual-scroll state" rule for revisits

## Context

D162 kept the last settled transcript mounted, but the store held one `messages`
array for the active session and one `ChatTranscript` instance served every
session, so a switch replaced the array, reset scroll, window, and hydration by
hand, remounted every row, and reparsed Markdown for content already in memory.
The kept frame was dimmed behind a progress track, scroll position was never the
destination pane's own, and two-stage progressive hydration ran on every switch.

## Decision

1. `ChatSurface` mounts one `SessionPane` per retained session id, keyed by
   session id. A pane owns its transcript DOM, scroll position, and mounted-row
   window for its lifetime, so a switch is a visibility swap, not a rebuild.
2. Retention is a bounded LRU of three panes: the visible one plus the two most
   recently visited. `retainedSessionIds` holds that order in the store and
   eviction unmounts the oldest pane.
3. An inactive pane stays mounted, hidden with `visibility: hidden` and
   `content-visibility: hidden`, `aria-hidden`, and non-interactive. It is
   explicitly not `display: none`, which destroys the layout box that holds
   `scrollTop`.
4. `messages` remains the live projection of the store-active session, and a
   bounded `retainedTranscripts` record gives every pane its own snapshot, so no
   pane renders another session's rows.
5. A warm switch reveals the destination pane immediately from retained content,
   with no dim, skeleton, or remount, and the revalidated transcript lands in the
   same pane afterwards without a visible change. For a running session, or a
   completed reply the durable page has not caught up to, revalidation stitches
   the bounded durable page onto the live snapshot in chronological order.
6. A cold switch keeps the currently visible pane showing its own session until
   the destination commits, marked only by the thin progress track; the opacity
   dim is removed entirely.
7. DOM retention is per pane, reading retention is per session. Runtime
   bookmarks keep a message id, viewport offset, window budget, and disclosure
   choices independently of eviction or project switches, hold no message bodies
   or DOM, and are released on session deletion or renderer and app restart.
8. First-commit hydration is per pane and local, so the cross-session spacer, its
   rAF expansion, and its re-anchor are deleted, while ADR 0130's trailing window,
   two-stage escalation, and prepend anchor stay inside a pane.
9. The composer mounts once for the whole chat surface with its per-session draft
   cache, and stays non-interactive while the visible pane is not yet the
   store-active session, so a prompt cannot be sent to the session being left.

No IPC, storage, host protocol, or pagination change; panes are a renderer-side
presentation bound, not a second cache.

## Consequences

- A revisit within the budget costs no Markdown parse, no tokenization, and no
  scroll correction, at the cost of at most two extra mounted transcripts, each
  bounded by ADR 0130's window.
- Callers must keep three invariants: cross-session events update only their own
  snapshot, deleting a session or leaving the project releases its pane, and a
  hidden pane performs no reading work because its scroller reports the top.
- Per-session scroll retention supersedes the older activation reset for revisits;
  an evicted session rebuilds a bounded pane but restores its reading bookmark.

## Alternatives

- Replace `messages` with a per-session message map: rejected because a single
  transcript instance still swaps content, so remount and rebuild survive.
- Retain every visited session's pane: rejected because unbounded panes restore
  exactly the retention ADR 0130 removed.

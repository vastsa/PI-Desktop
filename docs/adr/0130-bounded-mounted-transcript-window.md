# ADR 0130: Bounded Mounted Transcript Window

- Status: Accepted
- Date: 2026-08-27
- Deciders: PI-Desktop core
- Related: D261, D269, E2E-159, ADR 0120, ADR 0127, D247, D258, D108,
  `04-ux/08-component-spec.md`
- Amended by: D269 (history continuation and boundary-driven escalation)

## Context

ADR 0120 bounded the transcript payload that crosses the IPC boundary, and ADR
0127 / D258 bounded the cost of locating a page inside the JSONL file. Both
addressed session *activation*.

- React element trees for every row,
- a parsed Markdown AST per settled block,
- Shiki `LineCache` token arrays per code fence,
- the DOM nodes themselves.

## Decision

1. The mounted history is a **trailing window** over the loaded history, not all
   of it.
2. Reaching the top **escalates in two stages**.
3. Window growth and a fetched page take the **same pre-paint message anchor**.
4. The window **resets per session** and is clamped to the loaded history, so a
   grown budget inherited from the previous session for one frame cannot
   over-mount.
5. The hydration spacer stays **scoped to the first commit**.
6. The conversation minimap's **message dashes** are built from the **mounted
   entries** (`transcriptEntryMessages`).
6a. **Amended by D269.** Withheld history is represented explicitly instead of
silently: while loaded rows sit above the window (`hiddenAbove > 0`) or the host
reports an older page (`hasMoreBefore`), the rail stays mounted and shows one
dotted earlier-history continuation, even when the mounted tail has fewer than
two message markers or does not overflow one viewport. The continuation runs the
same two-stage escalation as clause 2, so it is always actionable; D108's
two-marker-plus-overflow rule resumes once no earlier history remains. 6b.
7. The entry projection arrays are memoized on `entries`, so a re-render that
   changed no message hands `TranscriptHistory` a reference-equal array and its
   comparator bails on identity instead of deep-walking the mounted rows.

No IPC, storage, host protocol, or pagination change.
`SESSION_TRANSCRIPT_PAGE_SIZE` and the `session.get` window contract are
untouched.

## Alternatives considered

- **Rely on `content-visibility` alone:** rejected.
- **Full virtualization with measured row offsets:** rejected for now.
- **Unmount whole rows by distance in both directions:** rejected for the
  original row window because removing addressable geometry interferes with
  pinned-follow.
- **Cap the loaded history instead, discarding older pages from the store:**
  rejected.

## Consequences

- The initial row window limits cold mounting, but expands as the reader moves
  backward.
- Upward travel through a long session costs one frame per growth step before
  pagination resumes.
- The browser's native find-in-page reaches only mounted rows.
- Newly mounted rows briefly use the `contain-intrinsic-size` fallback height
  before their real size is known, so the scrollbar thumb settles as they enter
  view.

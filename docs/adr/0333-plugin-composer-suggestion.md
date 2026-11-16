# ADR 0333: A plugin-owned suggestion in the Composer placeholder

- Status: Accepted
- Date: 2026-10-24
- Related: [ADR 0324](0324-plugin-owned-composer-prompt-enhancement.md) ·
  [ADR 0331](0331-plugin-session-follow-and-work-panel-reveal.md) ·
  [07-plugins/03-plugin-api](../spec/07-plugins/03-plugin-api.md)

## Context

After a turn ends a plugin often knows what the user would plausibly type next,
but its only surfaces are announcements that interrupt (toast, notification,
work-panel view) or a rewrite of text the user already wrote
(`composer.transform`). A suggestion must be visible where the user is looking
and trivial to ignore, yet producing one is slow — listen for
`session:turnEnded`, read with `pi.session.getLlmContext`, run a
`pi.agent.complete` — so by the time text arrives the user may have typed,
switched session, or started another turn.

## Decision

1. Add `pi.composer.suggest({ sessionId, turnId?, text, ttlMs? })` and
   `pi.composer.clearSuggestion({ sessionId? })` under a new `composer.suggest`
   permission, where `suggest` resolves `{ shown: true }` or
   `{ shown: false, reason }` with `session-not-visible`, `draft-not-empty`,
   `stale-turn`, `replaced`, or `unsupported`, and only malformed input throws
   `INVALID_PARAMS`.
2. Split the decision by ownership: main refuses what it can see without the
   renderer, meaning a session that is not on screen or a `turnId` a later
   `onTurnStarted` overtook, then relays the rest and waits for the renderer,
   which refuses a missing or blocked composer and a draft with text or an
   attachment over a dedicated invoke. Main never writes renderer state.
3. Model the suggestion as a slot beside the draft, not inside it: the text is
   drawn in the existing `.composer-placeholder` layer while `value` is empty,
   `Tab` writes it into the draft, and `Esc`, a first character, a send, a
   session switch, a new turn, a plugin stop, a reload, or a window close drops
   it, with one suggestion per session and a newer offer replacing the older one.
4. Keep the existing key owners: an open `@` / `/` completion list keeps `Tab`
   and `Esc`, and the suggestion acts only when neither claims the key, decided
   by a pure function so ordering is testable without a DOM.
5. Draw it brighter than the shell placeholder with a `Tab` / `Esc` hint on one
   ellipsized line, announce it once through an `sr-only` polite live region, and
   leave `aria-placeholder` describing the input.
6. Classify `composer.suggest` as medium risk and confirm it at install: it
   cannot read the draft, cannot send, and cannot outlive an empty draft.

## Consequences

- A plugin can propose the next message where the user is looking without a
  notification or panel, and learns immediately whether it was taken up.
- The shell keeps the composer authoritative, since a suggestion is decorative
  state the Composer discards on its own terms and a plugin cannot promote.
- The answer costs one renderer round trip with a bounded 2 s wait reporting
  `unsupported` rather than hanging, text is capped at 200 characters after
  whitespace folding, and no manifest schema, host-core schema, or persisted
  format changes.

## Alternatives considered

- Let a plugin renderer module set the suggestion directly: the SDK has no
  process → renderer-module channel for text produced by a long completion.
- Store the suggestion as a draft value the user deletes: it makes plugin text
  indistinguishable from typed text and breaks the empty-draft invariant.
- Report `shown` optimistically: `draft-not-empty` and `session-not-visible` are
  exactly the cases where a guess would be wrong.

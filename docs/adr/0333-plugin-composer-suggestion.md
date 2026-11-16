# ADR 0333: A plugin-owned suggestion in the Composer placeholder

- Status: Accepted
- Date: 2026-10-24
- Deciders: PI-Desktop maintainers
- Related: [ADR 0324](0324-plugin-owned-composer-prompt-enhancement.md) ·
  [ADR 0331](0331-plugin-session-follow-and-work-panel-reveal.md) ·
  [07-plugins/03-plugin-api](../spec/07-plugins/03-plugin-api.md) ·
  [07-plugins/13-plugin-permissions-matrix](../spec/07-plugins/13-plugin-permissions-matrix.md)

## Context

After a turn ends, a plugin often knows something the user would plausibly type
next: a follow-up question, a "continue" instruction, a correction. The only
surfaces a plugin has today are announcements that interrupt (a toast, a
notification, a work-panel view) or a rewrite of text the user already wrote
(`composer.transform`).

## Decision

1. Add `pi.composer.suggest({ sessionId, turnId?, text, ttlMs? })` and
   `pi.composer.clearSuggestion({ sessionId? })` to the Plugin SDK, gated by the
   new `composer.suggest` permission.
2. Split the decision by ownership instead of centralizing it:
   - Main refuses what it can see without the renderer — a session that is not
     the one on screen, and a `turnId` that a later `onTurnStarted` overtook —
     and relays the rest, then waits for the renderer's answer.
   - The renderer refuses the rest — no composer, a blocked composer, a draft
     with text or an attachment — and answers over a dedicated invoke.
Main never writes renderer state; it sends a message, exactly like
`pi.ui.revealView` (ADR 0331).
3. Model the suggestion as a slot beside the draft, not inside it.
4. Keep the existing key owners.
5. Draw it brighter than the shell's own placeholder (62% primary ink versus 72%
   secondary) with a `Tab` / `Esc` hint beside it, on one line with an ellipsis,
   and announce it once through an `sr-only` polite live region.
6. Classify `composer.suggest` as **medium** risk and confirm it at install.

## Consequences

- A plugin can propose the next message where the user is already looking,
  without a notification, a bubble, or a panel, and it learns immediately
  whether the suggestion was taken up.
- The shell keeps the composer authoritative: a suggestion is decorative state
  that the Composer discards on its own terms and that a plugin cannot promote
  into a draft.
- The answer to `suggest` costs one renderer round trip and a bounded wait
  (`answerTimeoutMs`, 2 s).
- Suggestion text is capped at 200 characters after line breaks and runs of
  whitespace are folded, so a plugin that asked for a paragraph still gets a
  usable result instead of an error it cannot repair inside a turn.
- The permission list, the manifest schema page, the permissions matrix, the
  plugin API spec, and the nine shipped catalogs all gain one entry; no plugin
  manifest schema version, host-core schema, or persisted format changes.

## Alternatives considered

### Let the plugin's own renderer module call `pi.dispatch("composer.setSuggestion")`

Rejected as the primary path.

### A message, a toast, or an inline transcript row

Rejected: all three interrupt or occupy transcript space for a hint the user may
ignore, and none of them can become the user's own text.

### Store the suggestion as a draft value the user deletes

Rejected: it makes plugin text indistinguishable from typed text, breaks the
"empty draft" invariant other features rely on, and would let a suggestion be
sent without an explicit accept.

### Report `shown` optimistically and clear later

Rejected: the point of the answer is that the plugin can stop spending
completions on a user who is not looking at that session.

### Change `aria-placeholder` while a suggestion is shown

Rejected: the field's purpose does not change with the suggestion, and a
placeholder change is announced differently across screen readers.

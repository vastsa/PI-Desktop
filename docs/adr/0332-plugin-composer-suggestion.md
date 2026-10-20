# ADR 0332: A plugin-owned suggestion in the Composer placeholder

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
(`composer.transform`). None of them fits a suggestion: it must be visible where
the user is already looking, carried by no chrome, and trivial to ignore.

The pipeline that produces such a line is the expensive part. A plugin listens
for `session:turnEnded`, reads the session with `pi.session.getLlmContext`, runs
its own `pi.agent.complete` (up to 90 s), and only then has text. So "generate"
and "show" are seconds apart, and in that window the user may have typed,
switched session, started another turn, or uninstalled the plugin. Any contract
that assumes the composer is unchanged when the answer arrives is wrong.

The host already owns every piece needed to make this safe: the renderer owns
the draft and the placeholder layer, `activeTurns` owns turn identity, and
`composer.transform` (ADR 0324) established the permission, audit, and refusal
vocabulary for plugin text that reaches the Composer.

## Decision

1. Add `pi.composer.suggest({ sessionId, turnId?, text, ttlMs? })` and
   `pi.composer.clearSuggestion({ sessionId? })` to the Plugin SDK, gated by the
   new `composer.suggest` permission. `suggest` resolves
   `{ shown: true }` or `{ shown: false, reason }` with
   `session-not-visible` / `draft-not-empty` / `stale-turn` / `replaced` /
   `unsupported`. Only malformed input throws (`INVALID_PARAMS`).
2. Split the decision by ownership instead of centralizing it:
   - Main refuses what it can see without the renderer — a session that is not
     the one on screen, and a `turnId` that a later `onTurnStarted` overtook —
     and relays the rest, then waits for the renderer's answer.
   - The renderer refuses the rest — no composer, a blocked composer, a draft
     with text or an attachment — and answers over a dedicated invoke. The
     plugin receives that answer, so a miss is data it can log rather than an
     exception.
   Main never writes renderer state; it sends a message, exactly like
   `pi.ui.revealView` (ADR 0331).
3. Model the suggestion as a slot beside the draft, not inside it. The text is
   drawn in the existing `.composer-placeholder` layer while `value` is empty, so
   no new overlay can cover a message. `Tab` writes it into the draft (caret at
   the end, focus in the input, staged references kept); `Esc` drops it; a first
   character, a send, a session switch, a new turn, a plugin stop, a reload or a
   window close drops it too. One suggestion exists per session, and a newer
   offer replaces the older one.
4. Keep the existing key owners. A `@` / `/` completion list keeps `Tab`, and an
   open list keeps the first `Esc`; the suggestion acts only when neither claims
   the key. The keys live in a pure decision function so that ordering is
   testable without a DOM.
5. Draw it brighter than the shell's own placeholder (62% primary ink versus
   72% secondary) with a `Tab` / `Esc` hint beside it, on one line with an
   ellipsis, and announce it once through an `sr-only` polite live region.
   `aria-placeholder` keeps describing the input, because the suggestion is not
   what the field is for.
6. Classify `composer.suggest` as **medium** risk and confirm it at install. It
   cannot read the draft, cannot send, and cannot outlive an empty draft, but it
   can put text in front of a user who may accept it with one key — the same
   trust shape as `composer.transform`.

## Consequences

- A plugin can propose the next message where the user is already looking,
  without a notification, a bubble, or a panel, and it learns immediately
  whether the suggestion was taken up.
- The shell keeps the composer authoritative: a suggestion is decorative state
  that the Composer discards on its own terms and that a plugin cannot promote
  into a draft.
- The answer to `suggest` costs one renderer round trip and a bounded wait
  (`answerTimeoutMs`, 2 s). A window that is gone, hung, or reloading answers
  nothing, and the caller is told `unsupported` instead of being left to hang.
- Suggestion text is capped at 200 characters after line breaks and runs of
  whitespace are folded, so a plugin that asked for a paragraph still gets a
  usable result instead of an error it cannot repair inside a turn.
- The permission list, the manifest schema page, the permissions matrix, the
  plugin API spec, and the nine shipped catalogs all gain one entry; no plugin
  manifest schema version, host-core schema, or persisted format changes.
- Plugins that never declare `composer.suggest` are unaffected: the namespace
  exists, the permission is not granted, and the call fails closed with
  `PERMISSION_DENIED` exactly like every other ungranted host API.

## Alternatives considered

### Let the plugin's own renderer module call `pi.dispatch("composer.setSuggestion")`

Rejected as the primary path. The text is produced by the plugin *process*
after a 90 s completion, and there is no process → renderer-module channel in
the SDK, so a renderer module would have to poll or the process would have to
own a second, invented transport. The process already has an established host
API route, and the reverse direction (a renderer module asking its own process
for an answer) is already `plugin.call`.

### A message, a toast, or an inline transcript row

Rejected: all three interrupt or occupy transcript space for a hint the user
may ignore, and none of them can become the user's own text.

### Store the suggestion as a draft value the user deletes

Rejected: it makes plugin text indistinguishable from typed text, breaks the
"empty draft" invariant other features rely on, and would let a suggestion be
sent without an explicit accept.

### Report `shown` optimistically and clear later

Rejected: the point of the answer is that the plugin can stop spending
completions on a user who is not looking at that session. `draft-not-empty` and
`session-not-visible` are exactly the cases where a guess would be wrong.

### Change `aria-placeholder` while a suggestion is shown

Rejected: the field's purpose does not change with the suggestion, and a
placeholder change is announced differently across screen readers. A polite
live region says the line once without re-describing the input.

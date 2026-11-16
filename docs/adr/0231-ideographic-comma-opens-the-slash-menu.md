# ADR 0231: Ideographic Comma Opens the Composer Slash Menu

- Status: Accepted
- Date: 2026-09-11
- Amends: D123, D139, ADR 0024

## Context

The composer `/` menu mirrors the pi CLI grammar, where the trigger is an ASCII
`/` as the very first character of the draft. A Chinese IME produces `、`
(U+3001, ideographic comma) for that keystroke, so the user must switch input
methods to reach the command menu. In-flight IME composition is already ignored
(D139), leaving only the alias missing.

## Decision

A `、` committed as the first character of an empty draft is rewritten to `/`
before trigger detection, after which the draft is an ordinary slash invocation
with the same menu, filtering, and send path. Only that position is rewritten:
the draft must have been empty before the keystroke, so a later `、` inside
existing text stays ordinary punctuation. The rewrite is a pure string function
in the shared composer-trigger module, and the `@` file menu is unaffected.

## Consequences

- Chinese IME users reach `/new`, `/compact`, mode aliases, template and plugin
  commands, and Skills without leaving the input method.
- A message genuinely starting with `、` in an empty composer is rewritten,
  which keeps the substitution visible instead of altering text mid-sentence.
- No IPC, storage, or autocomplete-source change is required.

## Alternatives

- Accept `、` as another trigger in `detectTrigger`: rejected, the draft would
  keep a character the send path must understand.
- Rewrite every `、`: rejected, it corrupts ordinary prose.

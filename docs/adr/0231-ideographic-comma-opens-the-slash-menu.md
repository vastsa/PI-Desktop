# ADR 0231: Ideographic Comma Opens the Composer Slash Menu

- Status: Accepted
- Date: 2026-09-11
- Deciders: PI-Desktop desktop UI maintainers
- Amends: D123, D139, ADR 0024

## Context

The composer `/` menu mirrors the pi CLI grammar: the trigger is the ASCII `/`
as the very first character of the draft. A Chinese IME produces `、` (U+3001,
ideographic comma) for that keystroke, so a user writing in Chinese has to
switch to ASCII input before they can reach the command menu, then switch back.
The menu already ignores in-flight IME composition (D139), so the missing piece
is only the alias itself.

Every other trigger character in the grammar is deliberate: `@` opens the file
menu, and a `/` anywhere but the first character is ordinary prose. The alias
must not turn legitimate punctuation into commands.

## Decision

1. A `、` committed as the first character of an empty composer draft is
   rewritten to `/` before trigger detection runs. Afterwards the draft is an
   ordinary slash invocation: the same menu opens, the same filtering applies,
   and the same send path handles it.
2. Only that position is rewritten. The composer requires the draft to have been
   empty before the keystroke, so a `、` that appears later — including at the
   start of a draft that already holds text — stays ordinary punctuation.
3. The rewrite is a pure string function in the shared composer-trigger module,
   unit tested next to the trigger grammar it feeds. The `@` file menu is
   unaffected.

## Consequences

- A Chinese IME user reaches `/new`, `/compact`, the mode aliases, template
  commands, plugin commands, and Skills without leaving the input method.
- A message that genuinely starts with `、` in an empty composer is rewritten.
  The menu opens with `/` and the user can keep typing prose, which keeps the
  substitution visible instead of silently altering text mid-sentence.
- No IPC, storage, or autocomplete-source change is required.

## Alternatives considered

- **Accept `、` as an additional trigger character in `detectTrigger`:** rejected
  because the draft would keep a character the send path and transcript chip
  would then have to understand, and the menu would open on a mark the pi CLI
  grammar does not define.
- **Rewrite on every `、`, not just the first character:** rejected because it
  would corrupt ordinary prose, where `、` is the standard list separator.
- **A toolbar button for commands:** rejected as a duplicate entry point to a
  menu that already exists (see D123).

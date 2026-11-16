# ADR 0131: Spill Large Composer Text Pastes into Session Scratch

- Status: Accepted
- Date: 2026-08-28
- Deciders: PI-Desktop core
- Related: Issue #20, D262, ADR 0059, ADR 0070, ADR 0124

## Context

Native textarea paste is useful for short prompts, but very large pasted blocks
make the composer difficult to edit and inflate the visible prompt. The
application already has a bounded Electron-to-main paste bridge and a
session-owned scratch directory for clipboard files.

## Decision

1. Add the persisted `largePasteThreshold` app setting.
2. A text-only paste above the threshold is intercepted by the Composer and sent
   through the existing `composer/pasteFiles` bridge as one UTF-8 `text/plain`
   file.
3. The Composer inserts `@<temporary-name> ` at the original selection and
   stores a renderer-only token-to-canonical-path mapping with the draft.
4. The mapping remains session-scoped, survives project/workspace switches for
   its owning session, participates in draft caching and unanswered smart-Stop
   restoration, and is removed when the token is removed from the text.
5. Clipboard files and images keep their existing compact chip and structured
   attachment flow.

## Consequences

- Large pasted blocks no longer occupy the editable prompt body; the user sees a
  compact, addressable reference at the exact paste position.
- The agent can read the exact saved bytes through the canonical scratch path,
  while the project tree, artifact store, and host protocol schema remain
  unchanged.
- The setting is backward-compatible because older app settings gain the default
  through host normalization rather than a database migration.
- The renderer must retain a small amount of draft metadata to distinguish a
  generated inline token from user-authored `@` text and to avoid duplicate
  serialization.

## Alternatives considered

- **Keep all text inline:** rejected because large blocks remain difficult to
  edit and unnecessarily enlarge prompt content.
- **Write directly into the workspace:** rejected because a paste is transient
  input and must not dirty the user's project.
- **Use a chip only:** rejected because the requested affordance is an inline
  reference at the paste location, and the surrounding draft must remain
  readable.
- **Send the token as a basename or append a second path:** rejected because
  scratch files require their canonical path and either option can be ambiguous
  or duplicate the same input.

## Amendment (2026-09-14): text representation selected beside generated image copies

ADR 0059's #138 amendment can select a text representation for a paste that also
carries `image/*` copies, which is what Word supplies for a copied selection.
That selected text uses this decision's `largePasteThreshold`, so short text
stays editable inline and larger text spills into session scratch as before.

# ADR 0131: Spill Large Composer Text Pastes into Session Scratch

- Status: Accepted
- Date: 2026-08-28
- Related: Issue #20, D262, ADR 0059, ADR 0070, ADR 0124

## Context

Large pasted text blocks make the composer hard to edit and inflate the visible
prompt, while the application already has a bounded Electron-to-main paste bridge
and a session-owned scratch directory. A solution must preserve the exact bytes,
work at a mid-draft caret, leave the project untouched, and stay addressable by
the existing `@path` file semantics.

## Decision

A persisted `largePasteThreshold` app setting (default 600 characters) leaves
shorter text-only pastes on native textarea behavior. A longer one is intercepted
by the Composer, sent through the existing `composer/pasteFiles` bridge as one
UTF-8 `text/plain` file under the session's scratch `pasted/` directory, and
replaced at the original selection by an inline `@<temporary-name> ` token backed
by a renderer-only token-to-canonical-path mapping held with the draft.

The mapping is session-scoped, survives project switches and unanswered smart-Stop
restoration for its owning session, is resolved in place exactly once before
dispatch rather than appended as a second reference, and is dropped with the
token. Clipboard files and images keep their existing compact chip and structured
attachment flow.

## Consequences

- Large blocks leave the editable prompt body and appear as a compact reference at
  the paste position, while the agent reads the exact bytes from the canonical
  scratch path.
- The project tree, artifact store, and host protocol schema are unchanged, and
  older app settings gain the default through host normalization.
- The renderer must retain draft metadata to tell a generated token from
  user-authored `@` text and to avoid duplicate serialization.

## Alternatives considered

- Keep all text inline: large blocks stay hard to edit and enlarge prompt content.
- Write directly into the workspace: a paste is transient input and must not dirty
  the user's project.

## Amendment (2026-09-14)

ADR 0059's #138 amendment can select a text representation beside generated
`image/*` copies, as Word supplies for a copied selection; that text uses this
decision's `largePasteThreshold`, so short text stays inline and larger text
spills into session scratch.

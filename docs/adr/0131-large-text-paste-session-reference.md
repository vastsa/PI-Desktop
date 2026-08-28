# ADR 0131: Spill Large Composer Text Pastes into Session Scratch

- Status: Accepted
- Date: 2026-08-28
- Deciders: PI-Desktop core
- Related: Issue #20, D262, ADR 0059, ADR 0070, ADR 0124

## Context

Native textarea paste is useful for short prompts, but very large pasted
blocks make the composer difficult to edit and inflate the visible prompt. The
application already has a bounded Electron-to-main paste bridge and a
session-owned scratch directory for clipboard files. The solution must preserve
the exact pasted bytes, work when the caret is in the middle of a draft, avoid
mutating the project, and keep the model-facing prompt addressable by the
existing `@path` file semantics.

## Decision

1. Add the persisted `largePasteThreshold` app setting. It defaults to 600
   characters and accepts integer values from 1 through 1,000,000. Text-only
   pastes at or below the threshold retain native textarea behavior.
2. A text-only paste above the threshold is intercepted by the Composer and
   sent through the existing `composer/pasteFiles` bridge as one UTF-8
   `text/plain` file. Electron main validates the durable session and stores
   it under `<data_dir>/scratch/<sessionId>/pasted/` using the existing bounded,
   sanitized, unique-file policy.
3. The Composer inserts `@<temporary-name> ` at the original selection and
   stores a renderer-only token-to-canonical-path mapping with the draft. The
   token remains visible inline, so the prefix and suffix of an existing draft
   remain editable. It is resolved in place exactly once immediately before
   dispatch; it is not appended as a second reference and is not included as a
   duplicate structured attachment.
4. The mapping remains session-scoped, survives project/workspace switches for
   its owning session, participates in draft caching and unanswered smart-Stop
   restoration, and is removed when the token is removed from the text. Session
   scratch lifecycle and cleanup remain the existing host-owned behavior.
5. Clipboard files and images keep their existing compact chip and structured
   attachment flow. This decision changes only text-only pastes above the
   configured threshold.

## Consequences

- Large pasted blocks no longer occupy the editable prompt body; the user sees
  a compact, addressable reference at the exact paste position.
- The agent can read the exact saved bytes through the canonical scratch path,
  while the project tree, artifact store, and host protocol schema remain
  unchanged.
- The setting is backward-compatible because older app settings gain the
  default through host normalization rather than a database migration.
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
  scratch files require their canonical path and either option can be
  ambiguous or duplicate the same input.

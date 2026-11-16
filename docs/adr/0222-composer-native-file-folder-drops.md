# ADR 0222: Native File and Folder Drops in the Composer

- Status: Accepted
- Date: 2026-09-11
- Amends: ADR 0101 (drag/drop scope)
- Related: D397, ADR 0059, ADR 0070

## Context

The Composer handled clipboard and picker-selected files through the session-scoped
scratch flow, but native file-system drops still fell to the browser default, which
could open or navigate away from the app. Folders need different treatment: their
path is useful for `@` completion, while traversing or copying one would be
unbounded and would violate scratch ownership.

## Decision

The Composer shell accepts native drops and prevents the browser default for
transfers containing file items, drawing a non-layout-affecting accent outline
during drag-over. The preload exposes only `webUtils.getPathForFile` for the
user-originated dropped `File`, and the renderer classifies folders from
`webkitGetAsEntry()` while keeping OS item order. Regular files travel as bounded
bytes through `composer/pasteFiles` into the session's scratch directory and appear
as removable leaf-name chips, while dropped folders are never read, traversed, or
copied: their complete native path is inserted at the caret as the literal
`@<path>/` form. This is a renderer/preload change only.

## Consequences

- Users can drag files and folders straight into the chat input, with folders kept
  as visible references instead of copies.
- Files keep the same bounded scratch lifecycle and validation as pasted files.
- The renderer gains a path only for a native user drop and uses it as prompt text,
  so no filesystem capability widens.

## Alternatives

- Traverse and copy dropped folders — rejected: unbounded, and a path-display
  gesture would mutate scratch contents.
- Insert only the folder leaf name — rejected: it loses the path needed for `@`
  completion.

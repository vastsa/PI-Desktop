# ADR 0222: Native File and Folder Drops in the Composer

- Status: Accepted
- Date: 2026-09-11
- Deciders: PI-Desktop core
- Amends: ADR 0101 (drag/drop scope)
- Related: D397, ADR 0059, ADR 0070

## Context

The Composer already handles clipboard files and picker-selected files through
the session-scoped scratch flow. Native file-system drag-and-drop was still
left to the browser default, which could open or navigate away from the app.
Folders need different treatment from regular files: showing the source path
is useful for `@` completion, but traversing or copying a folder would be
unbounded and would violate scratch ownership.

## Decision

1. The Composer shell accepts native file-system drops and prevents the browser
   default for transfers containing file items. The whole shell gets an accent
   outline during drag-over; the outline does not change layout.
2. The Electron preload exposes only `webUtils.getPathForFile` for the
   user-originated dropped `File` object. The renderer uses the existing
   `webkitGetAsEntry()` signal to classify folders and keeps the OS item order.
3. Regular dropped files are transferred as bounded bytes through the existing
   `composer/pasteFiles` bridge. They are written below the active session's
   scratch directory and rendered as the existing removable leaf-name chips.
4. Dropped folders are never read, traversed, or copied. Their complete native
   path is inserted at the caret as the literal `@<path>/` directory form.
   Mixed file/folder drops preserve order, surrounding draft text, focus, and
   the caret across the asynchronous file save.
5. This is a renderer/preload interaction change only. It adds no host RPC
   method, protocol message, workspace write, or durable storage schema.

## Security and boundary notes

- The renderer receives a source path only for a native user drop and uses it
  as visible prompt text; it does not gain arbitrary filesystem read or write
  access.
- Folder drops do not enumerate entries or transfer bytes, so a large folder
  cannot turn into an unbounded scratch operation.
- Regular files retain the existing main-process size, name, session, and
  scratch-root validation from ADR 0059.

## Alternatives considered

- **Traverse and copy dropped folders:** rejected because it is unbounded and
  would make a path-display gesture mutate session scratch contents.
- **Insert only the folder leaf name:** rejected because it loses the path
  needed to disambiguate and continue `@` completion.
- **Add a new main-process folder IPC:** rejected because the preload path
  bridge supplies the source path for this user-originated gesture without
  widening filesystem capabilities or adding a protocol surface.
- **Keep the browser default:** rejected because dropping a file or folder
  could navigate or open the dropped resource instead of editing the prompt.

## Consequences

- Users can drag files and folders directly into the chat input.
- Files have the same bounded scratch lifecycle and attachment metadata as
  pasted files; folders remain visible references without being copied.
- The Composer's existing draft and chip persistence logic remains the single
  source of truth for mixed asynchronous drops.

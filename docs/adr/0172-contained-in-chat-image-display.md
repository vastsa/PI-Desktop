# ADR 0172: Contained in-chat image display

- Status: Accepted
- Date: 2026-09-07
- Related: ADR 0019, ADR 0163, ADR 0169, decisions D320/D334, E2E-187
- Amends: the `fs/read` workspace-only clause of the desktop IPC spec

## Context

Pasted and uploaded images are stored as extension-less `attachments/<sha256>`
blobs under the data directory. Local Markdown images are workspace-relative.
The renderer origin cannot load those files, so history turns showed a chip
instead of the picture. Opening an `attachments/<sha256>` chip through
`fs/open` also failed because the path was treated as workspace-relative.

A generic "any absolute regular file" read channel would let the renderer
exfiltrate arbitrary disk contents.

## Decision

1. Keep `fs/list` workspace-only. Extend `fs/read`, `fs/reveal`, and `fs/open`
   so they share `resolveOpenablePath`: workspace-relative paths, absolute
   paths already inside the workspace / `<data_dir>/scratch/` /
   `<data_dir>/attachments/`, and content-addressed `attachments/<sha256>`
   refs. Reads additionally `realpath` the target and re-check containment.
2. Add renderer-only `fs/readImageDataUrl({ref, mimeType?})`. It returns a
   bounded image data URL or `missing` / `notImage` / `tooLarge` and never
   returns non-image bytes. It is not a plugin host API; plugins keep
   `fs.readPreview`.
3. A known image extension always wins over a client-supplied `mimeType`.
   Extension-less attachment blobs accept only the existing `IMAGE_MIME`
   allowlist. Arbitrary `image/*` values are ignored.
4. Chat thumbnails and local Markdown images load through that channel.
   Clicking a resolved image opens the host files viewer on the same ref.

## Consequences

- History attachments and local Markdown images render inline when the file
  is still present and under the cap.
- `/etc/passwd` and other outside-root paths stay unreadable even with a
  spoofed `mimeType`.
- Plugin Files views remain workspace-scoped; transcript artifacts still use
  the host `file:` tab.

## Alternatives rejected

### New unbounded absolute-path read

Rejected because the renderer IPC is not a user-click gate.

### Reuse `fs.readPreview` from the chat renderer

Rejected because that API is plugin-scoped to the workspace root and cannot
see `attachments/<sha256>` blobs.

## References

- `apps/desktop/electron/main/fs-panel.ts`
- `apps/desktop/src/lib/use-referenced-image-data-url.ts`
- `docs/spec/03-runtime/01-ipc-protocol.md`

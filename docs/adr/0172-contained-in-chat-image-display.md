# ADR 0172: Contained in-chat image display

- Status: Accepted
- Date: 2026-09-07
- Related: ADR 0019, ADR 0163, ADR 0169, decisions D320/D334
- Amends: the `fs/read` workspace-only clause of the desktop IPC spec

## Context

Pasted and uploaded images are extension-less `attachments/<sha256>` blobs under the
data directory and local Markdown images are workspace-relative, so the renderer
origin could load neither and showed a chip instead of the picture. A generic
absolute-path read channel would let the renderer exfiltrate arbitrary disk
contents.

## Decision

1. `fs/list` stays workspace-only, while `fs/read`, `fs/reveal`, and `fs/open` share
   `resolveOpenablePath`: workspace-relative paths, absolute paths already inside the
   workspace, `<data_dir>/scratch/`, or `<data_dir>/attachments/`, and
   content-addressed `attachments/<sha256>` refs, with reads re-checking realpath
   containment.
2. A renderer-only `fs/readImageDataUrl({ref, mimeType?})` returns a bounded data URL
   or `missing` / `notImage` / `tooLarge` and never non-image bytes.
3. A known image extension always wins over a client-supplied `mimeType`, and
   extension-less blobs accept only the `IMAGE_MIME` allowlist.
4. Chat thumbnails and local Markdown images load through that channel, and clicking
   a resolved image opens the host files viewer.

## Consequences

- Attachments and local Markdown images render inline while the file exists and stays
  under the cap.
- Paths outside the allowed roots stay unreadable even with a spoofed `mimeType`.
- Plugin Files views remain workspace-scoped.

## Alternatives

- New unbounded absolute-path read — rejected: renderer IPC is not a user-click gate.

# ADR 0163: Transcript File References Render as Previewable Chips

- Status: Accepted
- Date: 2026-09-05
- Related: D124, D209, D320, ADR 0024, ADR 0070, ADR 0019

## Context

Composer references are compact leaf-name chips (ADR 0070) but serialize to
canonical `@path` text on send, and the transcript painted those tokens as full
paths that crowded the bubble while clicking one opened a viewer that cannot
render HTML or open PDF and OS-handled types.

## Decision

The transcript parses serialized `@path` tokens, quoted or unquoted, relative or
absolute, and renders each as a chip with a file-family icon, ellipsized leaf
name, and the canonical path in tooltip and accessible name, while HTTP(S) URLs
stay inline links. A workspace `.html` / `.htm` chip opens the work-panel
browser, any other allowed file opens through the read-only
`pi-desktop/fs/open` channel, which accepts relative paths inside the workspace
and absolute paths only under the workspace, `<data_dir>/scratch/`, or
`<data_dir>/attachments/`.

## Consequences

- Sent turns show the same file nodes as the composer, with in-app HTML preview
  and OS handling for other suffixes.
- Main gains one allowlisted open channel confined to existing containment
  roots, with no host protocol or storage change.

## Alternatives

- Always open in the files tab: rejected, HTML needs a page preview and many
  suffixes need an OS handler.

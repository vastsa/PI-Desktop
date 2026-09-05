# ADR 0163: Transcript File References Render as Previewable Chips

- Status: Accepted
- Date: 2026-09-05
- Deciders: PI-Desktop core
- Related: D124, D209, D320, ADR 0024, ADR 0070, ADR 0019

## Context

Composer file references are compact leaf-name chips in the draft (ADR 0070).
On send they serialize to canonical `@path` / `@"path with spaces"` text so
the agent can Read them. The transcript then painted those tokens as full
paths, which crowded the user bubble and hid the node the user had just
placed in the input.

Clicking a path opened the work-panel files viewer, which cannot render HTML
as a page and cannot open PDF, office, or other OS-handled types. Scratch
absolute paths also failed the workspace-relative preview gate, so pasted
files were not clickable at all.

## Decision

1. The transcript parses serialized `@path` tokens (quoted and unquoted,
   relative and absolute) and renders each as a compact chip matching the
   composer node: file-family icon, ellipsized leaf name, canonical path in
   the tooltip and accessible name. HTTP(S) URLs stay inline text links.
2. Clicking a workspace `.html` / `.htm` chip opens the work-panel browser
   (existing local-file preview). Clicking any other allowed file opens it
   with the OS default application for that suffix via a new read-only
   Electron channel `pi-desktop/fs/open`.
3. `fs/open` resolves relative paths inside the current workspace and
   absolute paths only when they already live under the workspace, 
   `<data_dir>/scratch/`, or `<data_dir>/attachments/`. Traversal, `~`, and
   paths outside those roots are rejected. No host-protocol or storage
   schema change.
4. Structured message attachments that are not already represented by an
   inline `@path` chip use the same chip and click contract. Tool-row
   summaries keep the existing work-panel files/URL preview.

## Alternatives considered

- **Keep full-path text links:** rejected because it undoes ADR 0070's
  compact display the moment the user sends.
- **Always open in the files tab:** rejected because HTML should preview as
  a page and many suffixes need the OS handler.
- **Always `shell.openPath`:** rejected for workspace HTML, which already
  has a live-reloading in-app browser.

## Consequences

- Sent user turns show the same file nodes as the composer.
- Users can preview HTML in-app and open other files with the default app.
- Main gains one allowlisted open channel with the same containment roots
  as scratch/workspace file tools.

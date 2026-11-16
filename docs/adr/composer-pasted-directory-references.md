# ADR: Composer pasted directory references

- Status: Accepted
- Date: 2026-11-03
- Related: ADR 0059, ADR 0070

## Context

A directory has no regular-file bytes, and Chromium can omit its clipboard `File`,
so copying its tree into scratch would build an expensive, stale snapshot. A pasted
folder still has to reach the model without being snapshotted.

## Decision

On an explicit native-file paste, Electron main captures bounded clipboard file
metadata itself, because it reads each platform's native format and accepts no
renderer-supplied paths. Directories become typed draft references rendered as
removable folder cards above the editable text, while mixed regular files register
[live file references](composer-local-file-references.md) through the sender-bound
one-shot selection. Directory references serialize as escaped
`<dir>absolute/path</dir>` markers plus one instruction to inspect the directory
structure and read relevant files, so they never enter binary attachment transport,
previews, or snapshots. They grant no new filesystem access, existing tool
permissions apply, and removing a card removes its prompt hint.

## Consequences

- Image and text paste and the existing directory-drop choice are unchanged.
- Clipboard metadata is read only for a paste gesture and never enters clipboard
  history; drafts retain paths, not contents.
- The JSON reference shape gains an additive directory kind; host protocol and
  schema versions are unchanged.

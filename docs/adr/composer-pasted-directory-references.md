# ADR: Composer pasted directory references

- Status: Accepted
- Date: 2026-11-03
- Related: ADR 0059, ADR 0070

## Context

A directory has no regular-file bytes, and Chromium can omit its clipboard File.
Copying its tree into scratch would create an expensive and stale snapshot.

## Decision

On an explicit native-file paste, Electron main captures bounded native
clipboard file metadata. Directories become typed draft references and removable
folder cards above the editable text, with a name, localized Folder label and
full-path tooltip.

Directory references serialize as escaped `<dir>absolute/path</dir>` markers
plus one instruction to inspect directory structure and read relevant files as
needed for the current request. They never enter binary attachment transport,
previews, recursive copies or file snapshots.

## Consequences

Generated image/text paste and the existing directory-drop choice remain.

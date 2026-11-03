# Composer pasted directory references

- Status: Accepted
- Date: 2026-11-03
- Related: ADR 0059, ADR 0070

## Context

A directory has no regular-file bytes, and Chromium can omit its clipboard File.
Copying its tree into scratch would create an expensive and stale snapshot.

## Decision

On an explicit native-file paste, Electron main captures bounded native clipboard
file metadata. Directories become typed draft references and atomic removable
folder cards with a name, localized Folder label and full-path tooltip. Mixed
regular files use the existing sender-bound one-shot import capability. Main
captures the selection before filesystem awaits and accepts no renderer paths.
The bridge is main-window-only and blocked from MCP/plugin callers.

Directory references serialize as escaped `<dir>absolute/path</dir>` markers plus
one instruction to inspect directory structure and read relevant files as needed
for the current request. They never enter binary attachment transport, previews,
recursive copies or file snapshots. References grant no new filesystem access;
existing tool permission checks apply. Removing a card removes its prompt hint.

## Consequences

Normal file/image/text paste and the existing directory-drop choice remain.
Clipboard file metadata is read only for a paste gesture, never polled or added
to clipboard history. Draft/history metadata retains directory paths rather than
contents. Directories may change or disappear before later use. The existing JSON
reference shape gains the additive directory kind; Host protocol and database
schema versions remain unchanged.

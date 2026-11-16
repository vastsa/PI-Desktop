# ADR 0109: Open Files entries with the OS-associated application

- Status: Accepted
- Date: 2026-08-20
- Related: [ADR 0105](0105-files-as-a-bundled-plugin.md) · [ADR 0088](0088-declared-file-scope-for-plugins.md) · E2E-153

## Context

The bundled `pi.files` view can inspect text in its isolated viewer, but images,
documents, and archives are better handled by the operating system's associated
application. `shell.openExternal` accepts only web and mail URLs, so converting
a workspace path into a `file:` URL would either weaken that boundary or hand
the plugin an unscoped file opener.

## Decision

Add `pi.fs.openDefault(pathFromRoot)` and the matching panel bridge channel
`fs.openDefault`, covered by the existing `fs.read` permission. The host
resolves the root-relative path through the complete read gate (declared root,
real-path containment, protected paths, deny list, and declared scope or user
consent) and accepts existing regular files only. Electron Main then calls
`shell.openPath`, so the operating system chooses the association; the plugin
never receives an absolute path and cannot pick an executable or command line.
The bundled Files view offers the action from its selected-file viewer, and both
success and failure are audited by plugin id and root-relative path. The change
is additive, so desktop IPC and host protocol versions and the
`shell.openExternal` URL restrictions are unchanged.

## Consequences

- Files can hand off content the in-app text viewer cannot render.
- The default application may copy, transform, or sync the file, at the user's
  explicit request.
- Plugins with `fs.read` still cannot open credentials, protected app data,
  arbitrary absolute paths, or directories, and a failed handoff returns
  `OPEN_FAILED`.

## Alternatives

- Reuse `shell.openExternal` with a `file:` URL: rejected, it blurs URL egress
  with local file access and weakens scope enforcement.
- A private bundled-plugin IPC channel: rejected, it recreates the exception
  ADR 0105 removed.

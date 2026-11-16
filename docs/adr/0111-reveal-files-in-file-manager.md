# ADR 0111: Reveal Files in the OS File Manager

- Status: Accepted
- Date: 2026-08-22
- Related: ADR 0105, ADR 0109, E2E-153

## Context

The bundled `pi.files` viewer handed the selected file to the OS-associated
application, a handoff that fails for some file types and platforms and does not
match the intent of locating a file in the project.

## Decision

Add `pi.fs.reveal(pathFromRoot)` with the panel bridge channel `fs.reveal`, gated by
the existing `fs.read` permission plus the declared file-scope checks: root
containment, symlink resolution, protected paths, deny-list, and manifest scope or
consent. Only existing regular files are accepted, Electron Main calls
`shell.showItemInFolder` after the gate, the viewer replaces its header action with
**Show in folder**, and `fs.openDefault` stays an additive public API for the
associated-application handoff. Reveals are audited with plugin id and
root-relative path; no desktop IPC or host-core protocol version changes.

## Consequences

- A file can be located without depending on a file association.
- Credentials, protected app data, and files outside the workspace or the plugin's
  declared read scope cannot be revealed.
- Third-party plugins get the same bounded operation.

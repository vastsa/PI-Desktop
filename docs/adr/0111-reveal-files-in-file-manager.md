# ADR 0111: Reveal Files in the OS File Manager

- Status: Accepted
- Date: 2026-08-22
- Deciders: PI-Desktop maintainers
- Related: [ADR 0105](0105-files-as-a-bundled-plugin.md) ·
  [ADR 0109](0109-open-files-with-the-os-associated-application.md) ·
  [07-plugins/03-plugin-api](../spec/07-plugins/03-plugin-api.md) · E2E-153

## Context

The bundled `pi.files` viewer previously used its header action to open the
selected file with the operating system's associated application. That handoff
is not reliable for every file type or platform, and it does not match the
primary browsing intent of locating the file in the project.

## Decision

1. Add `pi.fs.reveal(pathFromRoot)` and the matching panel bridge channel
   `fs.reveal`.
2. Gate the operation with the existing `fs.read` permission and the complete
   declared file-scope checks: root containment, symlink resolution, protected
   paths, deny-list, and manifest scope or consent.
3. Electron Main calls `shell.showItemInFolder` after the gate.
4. The bundled Files viewer replaces its header action with **Show in folder**
   and reports a localized toast if the reveal fails.
5. Successful and failed reveals are audited with the plugin id and
   root-relative path.

## Consequences

- A selected file can be located without depending on a file association.
- The action cannot reveal credentials, protected app data, files outside the
  workspace or selected root, or files outside the plugin's declared read scope.
- Third-party plugins can use the same bounded operation as the bundled Files
  plugin; no private bundled-plugin capability is introduced.

# `pi.office`

`pi.office` is the bundled DOCX editor for PI-Desktop. It extracts the
browser-rendered editor from GenOffice and adapts its file lifecycle to the
PI plugin view bridge.

The plugin deliberately does not ship the GenOffice Electron shell, AI
providers, account flows, remote services, MCP integrations, or network
access. The view receives a path from the host, asks the plugin process for
DOCX bytes, and saves through `office.save` with an optimistic
`mtime/size/SHA-256` check.

The editor bundle is generated from the pinned upstream commit recorded in
`UPSTREAM.md`. Keep the generated files and provenance record together when
updating the upstream editor.

Font attribution and license texts are kept beside the generated assets in
`FONTS-README.md`, `LICENSE-OFL.txt`, and `LICENSE-UNICODE.txt`.

The editor supports 25%–200% zoom. Work-panel view recreation is synchronized
after plugin reloads so the native Office surface does not leave the host panel
in a stale, non-interactive state.

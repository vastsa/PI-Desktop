# SVG attachment input

This supplements [the agent runtime](02-agent-runtime.md) and
[model-aware image transport](../../adr/0101-model-aware-image-attachments.md)
for issue #946. It does not change the model capability decision, protocol,
storage schema, or attachment-root permissions.

## Transport contract

SVG is a file attachment, not a raw model-image payload. Recognize it by the
`image/svg+xml` MIME essence (case-insensitive, ignoring parameters) or a `.svg`
filename/path (case-insensitive). SVG metadata takes precedence over a stale
`kind: "image"` or conflicting raster MIME label. This rule does not infer that
other image formats are universally supported by every provider.

Clipboard persistence supplies `.svg` when an SVG has no filename extension.
Native-picker imports, project-path attachments, retries, and history restore
use the same classification. SVG bytes are preserved; no rasterization, script
execution, or external resource fetching is introduced.

The live prompt gets the existing safe `@path` file reference instead of inline
base64. Legacy content-addressed SVG attachments retain their durable reference
and get a readable copy in the owning session's scratch `replayed/` directory.
History hydration also clears any stale transient image data, including when a
reference cannot be resolved. It does not rewrite the stored transcript or
remove the original attachment. A missing or forbidden live attachment still
fails the existing path boundary; this fix must not turn that failure into an
unvalidated file reference.

Raster classification, vision capability checks, the inline size bound, and
non-vision file fallback retain their existing behavior.

## E2E-ATTACHMENTS-svg-file-fallback

- **Preconditions:** Isolated desktop profile and workspace; local mock provider
  with image input enabled; SVG and PNG fixtures; no live provider credentials.
- **Steps:** Paste SVG, import it through the native picker, and drop a project
  SVG into the composer. Send each with text, then send SVG and PNG together.
  Retry a legacy SVG attachment and reopen a session whose stored SVG is marked
  as an image. Repeat with image input disabled. Attempt an outside-root path.
- **Expected:** SVG remains readable as a file and never appears in a provider
  image block; PNG still uses the existing vision transport when enabled.
  Original bytes and unrelated prompt text are preserved. Legacy SVG is safely
  replayed through session scratch. Forbidden paths remain rejected.
- **Specs:** This document; 03-runtime/02-agent-runtime.
- **Acceptance:** Attachment transport and session-root confinement.
- **Milestone:** Maintenance.
- **Status:** Service-level regression coverage in
  `apps/desktop/test/svg-attachments.test.mjs`; full Electron/provider-boundary
  E2E remains required before declaring desktop integration verified.

Run the service regressions after building the workspace dependencies:

```sh
node --test apps/desktop/test/svg-attachments.test.mjs
```

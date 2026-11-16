# ADR 0101: Model-aware image attachment transport

- Status: Accepted
- Date: 2026-08-18
- Amends: D197, ADR 0059, ADR 0070
- Amended by: D361 (inline bound is 10 MB), D392 / ADR 0218 (binding image-input
  overrides)

## Context

Clipboard images were materialized, but the composer reduced every file to
`@<path>` text, so a vision model received a filesystem reference instead of an
image block. The capability signal must come from the same model catalog pi-ai
uses to serialize provider requests, and it must stay ownerless of binary data
in the transcript.

## Decision

The composer draft stays textual, with each file reference keeping kind, name,
MIME type, and source path as structured metadata, and vision capability is
resolved from the exact pi-ai model record: only `model.input.includes("image")`
enables image transport, while unknown and custom ids stay non-vision. Electron
main remains the attachment boundary, validating each source path against the
session scratch root, the session-bound project root, or the content-addressed
attachment root, storing images as `attachments/<sha256>` and persisting only
the reference and metadata in `UiMessage`. For a vision model within the 10 MB
per-image inline limit, the image crosses the sidecar as transient base64 and
becomes a pi-ai image block that is never persisted; otherwise the prompt
receives a safe `@path` fallback, with replayed content-store images copied into
the session scratch `replayed/` directory first. Restored vision history also
carries a fixed aggregate raw-image budget, newest attachments first, with
older images falling back to the path form and the current prompt row excluded
from hydration. The composer status row and the model picker expose the same
authoritative vision capability.

## Consequences

- Vision-capable models inspect pasted images with no model-specific renderer
  path, while text-only models keep the file-tool workflow.
- Image bytes are deduplicated and survive retry, fork, and runtime recreation
  without living in the transcript.
- Reference-only persistence leaves attachment garbage collection for a later
  storage task without changing the message contract.

## Alternatives

- Always send `@path` text: rejected, it cannot satisfy vision models.
- Persist base64 in messages: rejected, it makes reloads and SQLite growth
  unbounded across the persistence boundary.

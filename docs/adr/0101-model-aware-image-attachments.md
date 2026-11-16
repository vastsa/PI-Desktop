# ADR 0101: Model-aware image attachment transport

- Status: Accepted
- Date: 2026-08-18
- Deciders: PI-Desktop runtime and desktop UI maintainers
- Amends: D197, ADR 0059, ADR 0070
- Amended by: D361 (inline bound is 10 MB, matching MiniMax's OpenAI-compatible cap), D392 / ADR 0218 (binding image-input overrides)

## Context

Clipboard images were materialized successfully, but the composer reduced every
file to `@<path>` text. A model that supports image input therefore received a
filesystem reference instead of an image block.

## Decision

1. Keep the composer draft compact and textual.
2. Resolve vision capability from the exact pi-ai model record.
3. Electron main remains the attachment boundary.
4. For a vision-capable model, an image within the 10 MB inline limit crosses
   the sidecar only as transient base64 data and becomes a pi-ai image content
   block.
5. For a non-vision model, an unknown model, or an image above the per-image
   inline limit, the prompt receives a safe `@path` fallback.
6. Restored vision history has a 30 MB aggregate raw-image-byte budget in
   addition to the 10 MB per-image limit.
7. The Composer shows a compact accessible status row when an image is attached:
   it states whether the selected model can receive visual input.

## Consequences

- GPT/vision-capable models can inspect pasted images without requiring a
  model-specific renderer implementation.
- Text-only and non-vision models retain the existing file-tool workflow.
- Image bytes are deduplicated and can survive retry, fork, and runtime
  recreation without putting binary data in the transcript.
- Restored sessions preserve historical vision blocks regardless of age while
  the images fit within one fixed aggregate budget; over-budget history has a
  deterministic memory ceiling and a safe path fallback for older images.
- Attachment garbage collection remains a later storage task; references are
  content-addressed so it can be added without changing the message contract.

## Rejected alternatives

- **Always send `@path` text:** preserves non-vision behavior but cannot satisfy
  vision models.
- **Trust renderer/provider discovery flags:** can advertise a capability that
  the runtime adapter cannot serialize and would make unknown models unsafe to
  classify.
- **Persist base64 in messages:** makes reloads and SQLite/JSONL growth
  unbounded and crosses the persistence boundary unnecessarily.

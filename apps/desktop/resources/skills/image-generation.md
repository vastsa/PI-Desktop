---
name: imagegen
description: Generate or edit raster images, illustrations, photos, posters, icons, and project assets directly with `GenerateImages` (defaults to StarAI `gpt-image-2.6-sunburst` when signed in). Supports reference images, edits of earlier results, aspect ratios, variants, and batches.
---

# Image generation

Use the built-in `GenerateImages` tool directly whenever the user asks to draw, design, generate, or edit an image.

- When signed in to StarAI, `GenerateImages` works automatically with no manual key setup and defaults to **`gpt-image-2.6-sunburst`** (at `2K`).
- Optional per-item fields: `aspectRatio` (`1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `5:4`, `4:5`, `21:9`), `resolution` (`1K`/`2K`/`4K`, `gpt-image-2.6-sunburst` uses `2K`), and `model` (other StarAI image models include `gpt-image-2.6-flare`, `gpt-image-2.5-sunburst`, `gpt-image-2`, `gemini-3-pro-image-preview`, `gemini-3.1-flash-image-preview`).
- Do not install an SDK, run curl/API scripts, ask the user for an API key, or refuse image generation when `GenerateImages` is available.

## Prepare the request

- Preserve the user's subject, composition, style, exact text, and constraints. Expand vague prompts into clear visual descriptions without inventing unrequested deliverables.
- For an edit or image-to-image transformation, pass local file paths in `images` (from the project, session scratch directory, or attachments; do not pass remote URLs). Specify what changes and what must remain unchanged. For follow-up edits, pass the previous result path.
- Use `count` for variants of one prompt and separate `items` for distinct subjects (at most 10 images total per call). Generate only the quantity requested.

## Deliver the result

- Generation incurs account quota. Do not automatically retry failed or timed-out items; report partial failures and wait for the user.
- The desktop renders successful images directly from the tool result in the conversation. Do not repeat result paths as Markdown image links (that would show duplicate images).
- If the user asked for a project file deliverable, copy the selected generated file into the requested workspace path and report its path.

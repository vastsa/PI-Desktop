---
name: imagegen
description: Generate or edit raster images, illustrations, photos, banners, and project assets with the configured image model. Supports reference images, edits of earlier results, variants, and batches. Prefer existing code-native tools for SVG/CSS edits.
---

# Image generation

Use the desktop `GenerateImages` tool. The user selects its provider and model
under Settings → Models → Image generation model; this is independent of the chat
model. If ToolSearch is available and GenerateImages is not loaded, discover it
there first. Do not install an SDK, run an API script, ask for a key in chat, or
substitute the conversation model.

## Prepare the request

- Preserve the requested subject, composition, style, exact text, and constraints.
  Add useful detail to a vague prompt without inventing additional deliverables.
- For a project asset, include its intended use and required framing. Prefer the
  existing SVG/CSS asset system for changes to code-native icons or diagrams.
- For an edit, pass the source file paths as `images` (one to four per item).
  Specify what changes and what must stay unchanged. For a follow-up edit, use
  the previous result path. Inputs must be under the current project, session
  scratch directory, or attachment store. Do not use remote URLs.
- Editing uses OpenAI Images multipart requests and depends on the selected
  model supporting that endpoint. Do not silently replace an edit with a fresh
  generation if it fails. Mask painting is not a desktop UI feature.

## Generate one image or a batch

Call `GenerateImages` with `items`, where each item has `prompt` and optional
`count` (default 1), plus optional `images` for edits. Use one item with `count` for variants of the same prompt;
use separate items for different assets. A batch permits at most 10 images
total. For a larger explicitly requested set, split it into bounded batches.
Generate only the quantity the user asked for; do not add unrequested variants.

Example: two cover variants and one distinct icon:

```json
{"items":[{"prompt":"Editorial cover: a ceramic cup on a quiet desk, warm daylight, no text","count":2},{"prompt":"A small raster illustration of a green leaf on a white background","count":1}]}
```

Generation may incur cost. Do not retry failed or timed-out items automatically,
including after cancellation: the provider may already have processed them.
Report partial success and wait for a user request before retrying. If no image
model is configured, direct the user to Settings → Models; do not select one silently.

## Deliver the result

Results are ordered and contain a status and, for successes, a local image path.
Show the successful images with Markdown image links and report failed items.
The desktop also renders their previews directly from the tool result.

Use available image inspection tools to check the result when possible. Do not
claim to have visually inspected an image if you only received its file path.
For project deliverables, copy the selected image into the requested project
location using existing file/shell tools and update the consuming reference.
Use a new filename unless replacement was requested. Preview-only images may
remain in session storage. Report the final project paths, the prompt used,
and any requested images that did not complete.

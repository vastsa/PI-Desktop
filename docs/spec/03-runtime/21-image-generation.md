# Image generation and editing

The desktop exposes one optional `AppSettings.imageGeneration` binding with
`providerId` and `modelId`. `null` clears it; absent means unconfigured. Host-core
validates and persists it through the existing settings store. No schema bump
is needed. The binding is independent of the conversation default and references
an existing enabled API-key or no-auth provider and one of its configured models.

## Configuration

Model Advanced offers **Set as image model**. A draft selection only takes effect
when the provider form saves; Cancel leaves settings unchanged. Saving a provider
as an image model does not replace the default conversation model. Below the
default model row in the same defaults panel, **Image generation model** is a
read-only summary with the same provider/model typography and a 12px row gap.
It has no Change or Clear actions; replacement uses the provider's Advanced
settings. Missing, disabled, credential-less or removed bindings display only
**Currently unavailable**. OAuth accounts are not eligible; there is no fallback.
The selected provider/model pair is excluded from the default conversation picker,
provider quick-default action, and Composer model menu. Other providers with the
same model ID remain independent. Existing conversation bindings and history are
preserved; a conversation still pinned to the image binding must select a chat
model before sending. Runtime launch also rejects that binding before inference.

## Agent contract

`GenerateImages({items: [{prompt, count?, images?}]})` is an Agent-mode tool.
`count` defaults to 1. Both distinct prompts and same-prompt variants are supported,
with 1–10 output images total. An optional `images` array supplies 1–4 local source
files per item for editing; a previous generated path supports iterative edits.
Prompt length is bounded at 32,000 characters. Unsupported or excessive input is
rejected rather than truncated. Plan and Goal cannot execute the tool.

The bundled `pi-desktop/imagegen` skill is discoverable in ordinary sessions and
loads through the existing Skill tool. It teaches prompting, batches, reference
edits, preserving originals, partial-failure handling and project asset delivery.
It does not grant permission or carry credentials.

The trusted desktop bridge first calls host-core `tools.execute` with the same
identity, arguments and permission scope. Host-core applies the existing high-risk
tool policy and returns authorization only. The bridge executes the image service
only after approval. The host authorization audit is distinct from the actual
sidecar tool result. Runtime cancellation reaches both pending approval and the
network request; host loss or sidecar disposal aborts local work.

## OpenAI Images adapter

Only OpenAI-compatible Images is supported. A root base URL acquires `/v1`; an
explicit path prefix is retained. Generation uses `POST images/generations` with
`model`, `prompt`, `n: 1`. Editing uses `POST images/edits`, multipart image files,
the prompt, model and `n: 1`. No browser mask editor is included. A configured
service may implement generation without editing; its error is reported without
silently switching to generation or another model.
For exact DALL-E 2/3 model IDs, generation requests explicitly ask for
`response_format: b64_json`; the same form field is used for DALL-E edits where
supported. GPT Image and unknown compatible model IDs omit that parameter.
Editing retains binary multipart uploads (`image` for one reference, `image[]`
for multiple), with the transport generating the Content-Type boundary.

Each batch snapshots the binding and provider before dispatch, uses two workers,
and returns results in input order. Each output has a 180-second request budget.
Requests are never automatically retried. Authentication failure stops queued
work. Cancellation stops queued work and aborts active HTTP; it cannot promise the
upstream provider stopped processing or billing. Completed output files survive.

Responses accept exactly one Base64 image or HTTPS image URL per request. JSON and
download bodies are bounded; image files are capped at 16 MiB and restricted to
PNG, JPEG and WebP signatures. Downloads use checked, pinned public DNS addresses,
reject redirects and private destinations, and never receive provider headers.
Input edits accept the session project, that session's scratch directory and the
attachment store after realpath containment. Each edit input set is capped at
32 MiB, with a 64 MiB input cache budget for the batch. Credentials remain outside the renderer and tool results.

## Results and recovery

Each result records index, status (`succeeded`, `failed`, `cancelled`), successful
path/MIME type or a safe error code. New files get unique names in session scratch;
editing never overwrites its source. The tool result and transcript retain file
references, not Base64. Existing bounded image reads and file viewers serve previews.
Thrown local-tool errors preserve stable `errorCode` values across the real
sidecar RPC boundary, independently of ordinary structured tool-result failures.
Existing RPC code, message and data are retained; arbitrary Error properties
are not serialized. The sidecar receiver exposes the code alongside its data.
Successful images and per-item failures render even when only part of a batch
completed. Missing configuration returns a structured error and a Settings → Models
navigation action. The same references render after session reload/restart.
Image results and setup actions remain visible outside the turn's collapsible
process details; opening tool details does not duplicate the image gallery.
Markdown image references to generated absolute paths, including Windows drive
paths, use the existing bounded host image reader. URL sanitization stays enabled;
the host still rejects files outside its permitted workspace/scratch/attachment roots.

Validation: `node scripts/e2e-image-generation.mjs` covers host/stdio/HTTP/storage;
`node scripts/e2e-image-generation-ui.mjs` covers real React/Chromium interactions
with an API-boundary fixture. Unit/service tests cover limits, cancellation,
partial failures, authentication, timeout, unsafe paths, and bounded downloads.
`node scripts/e2e-image-chat.mjs` exercises the full isolated desktop with local
model/image HTTP fixtures: adjacent default settings, composer submission, batch
previews, editing a generated file, collapsed results, and setup navigation.
Live verification is opt-in via `scripts/test-image-generation-live.mjs`, limited
to one generation plus one edit and never a default test command.

# ADR: Trusted extensions use pi's image surface

- Status: Proposed implementation for review
- Related: Issue #658, trusted-extension-host-model-completion, ADR 0258

## Context

Image generation has different input and result shapes from chat completion.
The pinned pi-ai 0.85.1 already supplies ImagesModels, ImagesContext and
AssistantImages, but its only built-in image adapter is OpenRouter. The desired
OpenAI-compatible Images generation/edit endpoints are absent.

## Decision

Add `modelRegistry.generateImages` alongside text `complete`. Reuse pi's
collection, auth and OpenRouter lazy adapter. Implement only the missing
OpenAI-compatible Images adapter, following Codex's standalone generation/edit
paths and JSON image_url inputs. Support explicitly selected multipart editing
for compatible gateways. No fallback, automatic retry, filesystem input or URL
fetching is implied. Provider credentials stay in the Host.

Both operations use the same Host admission, authorization, cancellation and
rate-limit owner. The image operation supplies its own bounded schema, timeout,
adapter and result. Existing text behavior is protected by its original tests.

## Alternatives

Dispatching images through text `complete` was rejected because it would blur
pi's distinct contracts and change the return type of existing consumers.
Reimplementing OpenRouter was rejected because pi already owns that adapter.
Embedding images in the Responses tool loop was rejected for this scope: this
feature is an independent image request, not agent tool orchestration.

## Consequences

Base64 artifacts cross the bounded IPC surface; plugins choose whether and
where to persist them. Disconnect cancels the HTTP request but cannot guarantee
a remote provider refunds work. Mask editing, remote artifact downloads and
image-price estimation remain outside this contract.

## Implementation references

- pi-ai 0.85.1 README, Image Generation; `images-models` and
  `api/openrouter-images.lazy` in the pinned dependency.
- OpenAI Codex `codex-rs/codex-api/src/endpoint/images.rs` and `images.rs`,
  inspected at main during implementation (commit a5290028a2936b91ec9305f6de7780463620ca70).

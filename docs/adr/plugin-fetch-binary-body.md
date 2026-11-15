# ADR: Binary request bodies in host-mediated plugin fetch

- Status: Implemented candidate

## Context

Reference-image and other multipart uploads must preserve arbitrary bytes across
plugin RPC. The existing `body?: string` is text and cannot represent those bytes
without UTF-8 conversion. Older hosts can ignore unknown options, so a plugin
must discover support before sending an upload.

## Decision

Extend the existing `net.fetch` request with `bodyBase64?: string`, mutually
exclusive with `body`. The existing network module validates canonical standard
Base64 and a 16 MiB decoded limit before invoking the transport, then supplies a
Buffer as the raw request body. Empty binary bodies are valid. Multipart encoding
and Content-Type remain the plugin's responsibility; the limit covers the entire
multipart body after Base64 decoding.

Add optional `binaryRequestBody?: true` and `maxBinaryBodyBytes?: number` fields
to the existing network capability response. The network module owns this
response and the enforced limit. The runtime entry only forwards the request and
capability query. Plugins require the binary flag and a sufficient limit; a
version-string heuristic does not prove a development host supports the API.

## Alternatives

- A separate upload method would duplicate permission, egress, redirect, timeout
  and audit ownership for the same HTTP operation.
- UTF-8 strings or serialized Buffer objects would corrupt arbitrary bytes or
  couple the public contract to a particular process-serialization format.
- Streaming upload is a larger lifecycle and backpressure contract than the
  current bounded image-reference use case needs.

## Consequences

- Worker RPC and panel dispatch preserve untrusted binary fields until shared
  validation. Invalid arguments never reach transport; errors omit payloads.
- Uploads retain the existing `net.fetch` grant, domain/`net.anyHost` checks,
  redirect owner, deadline, abort and audit path. No new permission is required.
- Existing text and response contracts stay compatible. Base64 increases IPC
  memory use; both encoded and decoded bounds are checked before decoding.
- Protocol E2E runs real child IPC and loopback HTTP, including a trusted Agent
  tool context, scoped image reads, exact ordered image bytes and denied access.
  Actual provider entitlement and editing quality remain separate validation.
- This implementation does not update an already running Desktop. The host build
  must contain it and the plugin must reload its capability snapshot.

The normative contract is in [the plugin API spec](../spec/07-plugins/03-plugin-api.md)
and acceptance is E2E-PLUGIN-fetch-binary-body.

# ADR: Bounded binary response mode for plugin net.fetch

- Status: accepted
- Date: 2026-11-20

## Context

Plugins that integrate media services sometimes receive result bytes through an HTTP endpoint. The existing `pi.net.fetch` contract returns `bodyText`, which is suitable for JSON and text APIs but corrupts arbitrary media bytes. Reading remote files through a plugin's local filesystem or direct Node networking would bypass the host's permission and egress controls.

## Decision

Add an optional `responseType: "base64"` mode to the host-mediated `pi.net.fetch` API. The host reads the response stream with a bounded byte limit, returns canonical Base64 together with the response content type and byte length, and rejects oversized responses before returning partial data. The default text mode remains unchanged.

The host advertises `binaryResponseBody` and `maxResponseBodyBytes` through `pi.net.getCapabilities`. Plugins must check these capabilities before requesting binary responses. Existing URL validation, egress allowlists, permission checks, redirect handling, timeout ownership and audit behavior apply to both response modes.

## Consequences

Media plugins can download bounded result bytes through the same audited host boundary used for JSON requests. The host owns allocation and size enforcement. Older hosts remain compatible with existing text requests and must be treated as unable to download binary results when the capability is absent. Plugins still own media-type validation, hash verification, persistence and retry semantics.

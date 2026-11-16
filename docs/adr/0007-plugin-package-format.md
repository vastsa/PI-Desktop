# ADR 0007: Plugin distribution package format uses .piplug (zip)

- Status: Accepted
- Date: 2026-07-25

## Context

We need a plugin package format that is convenient for local sharing and
marketplace download.

## Decision

Adopt `.piplug` as the product-level distribution extension. Its contents are a
zip archive, with a `manifest.json` at the root.

## Rationale

1. Simple to implement, cross-platform
2. Easy to do checksum / signing
3. Developer-friendly (can be unzipped and inspected locally)

## Consequences

### Positive
- Lightweight toolchain
- Can share unified verification logic with local directory packages

### Negative
- Must guard against zip slip and oversized-package attacks

## Constraints

- Path safety checks must be performed before installation
- Marketplace packages must provide at least sha256

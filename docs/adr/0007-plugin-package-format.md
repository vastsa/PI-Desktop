# ADR 0007: Plugin distribution package format uses .piplug (zip)

- Status: Accepted
- Date: 2026-07-25

## Context

Plugins need one distributable package format that is easy to share locally,
download from a marketplace, and verify before installation.

## Decision

`.piplug` is the product-level distribution extension; the payload is a zip
archive with `manifest.json` at the root. The same verification logic covers
packages and loose local directories. Path-safety checks run before installation,
and marketplace packages carry at least a sha256 checksum.

## Consequences

- A lightweight toolchain that developers can unzip and inspect.
- Installation must reject zip-slip paths and oversized archives.

## Alternatives

- An opaque single-file bundle: rejected because it is harder to inspect and
  verify before install.
